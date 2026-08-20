use crate::app_settings::VirtualAudioSettings;
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use rodio::cpal;
use rodio::cpal::traits::{DeviceTrait as _, HostTrait as _, StreamTrait as _};
use rodio::mixer::MixerSource;
use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const VIRTUAL_AUDIO_DEVICE_NAME: &str = "MIDIMaster Virtual Audio";
const INPUT_RING_FRAMES: usize = 48_000;
const OUTPUT_RING_FRAMES: usize = 12_000;
const RESAMPLER_LOCAL_FRAMES: usize = 16_384;
const OUTPUT_TARGET_LATENCY: Duration = Duration::from_millis(20);
const OUTPUT_PREFILL_WAIT: Duration = Duration::from_millis(25);
const AUDIO_PIPE_PATH: &str = r"\\.\pipe\MIDIMaster.VirtualAudio.Audio.v1";
const PIPE_BATCH_FRAMES: usize = 480;

#[derive(Clone, Copy, Default)]
struct StereoFrame {
    left: f32,
    right: f32,
}

impl StereoFrame {
    fn lerp(self, next: Self, fraction: f64) -> Self {
        let fraction = fraction as f32;
        Self {
            left: self.left + ((next.left - self.left) * fraction),
            right: self.right + ((next.right - self.right) * fraction),
        }
    }

    fn peak(self) -> f32 {
        self.left.abs().max(self.right.abs()).clamp(0.0, 1.0)
    }
}

#[derive(Default)]
struct RuntimeMetrics {
    microphone_level: AtomicU32,
    output_level: AtomicU32,
    underruns: AtomicU64,
    overruns: AtomicU64,
    callback_failed: AtomicBool,
    last_error: Mutex<Option<String>>,
}

impl RuntimeMetrics {
    fn set_microphone_level(&self, level: f32) {
        self.microphone_level
            .store(level.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    fn set_output_level(&self, level: f32) {
        self.output_level
            .store(level.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    fn microphone_level(&self) -> f32 {
        f32::from_bits(self.microphone_level.load(Ordering::Relaxed))
    }

    fn output_level(&self) -> f32 {
        f32::from_bits(self.output_level.load(Ordering::Relaxed))
    }

    fn fail(&self, error: impl Into<String>) {
        self.callback_failed.store(true, Ordering::Release);
        if let Ok(mut stored) = self.last_error.lock() {
            *stored = Some(error.into());
        }
    }

    fn clear_error(&self) {
        self.callback_failed.store(false, Ordering::Release);
        if let Ok(mut stored) = self.last_error.lock() {
            *stored = None;
        }
    }

    fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|error| error.clone())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VirtualAudioInputDevice {
    pub id: String,
    pub display: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct VirtualAudioRuntimeSnapshot {
    pub running: bool,
    pub microphone_level: f32,
    pub output_level: f32,
    pub underruns: u64,
    pub overruns: u64,
}

struct ActiveRoute {
    _input_stream: cpal::Stream,
    input_device_id: String,
    stop_worker: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
}

impl ActiveRoute {
    fn stop(self) {
        drop(self);
    }
}

impl Drop for ActiveRoute {
    fn drop(&mut self) {
        self.stop_worker.store(true, Ordering::Release);
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

pub struct VirtualAudioRuntime {
    lifecycle: Mutex<()>,
    route: Mutex<Option<ActiveRoute>>,
    settings: Mutex<VirtualAudioSettings>,
    microphone_gain: Arc<AtomicU32>,
    metrics: Arc<RuntimeMetrics>,
    soundboard_source: Arc<Mutex<MixerSource>>,
}

impl VirtualAudioRuntime {
    pub fn new(settings: VirtualAudioSettings, soundboard_source: MixerSource) -> Self {
        let settings = settings.normalized();
        Self {
            lifecycle: Mutex::new(()),
            route: Mutex::new(None),
            settings: Mutex::new(settings.clone()),
            microphone_gain: Arc::new(AtomicU32::new(
                db_to_linear(settings.microphone_gain_db).to_bits(),
            )),
            metrics: Arc::new(RuntimeMetrics::default()),
            soundboard_source: Arc::new(Mutex::new(soundboard_source)),
        }
    }

    pub fn apply_settings(&self, settings: VirtualAudioSettings) -> Result<(), String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "Virtual Audio lifecycle lock failed".to_string())?;
        let normalized = settings.normalized();
        self.microphone_gain.store(
            db_to_linear(normalized.microphone_gain_db).to_bits(),
            Ordering::Release,
        );

        let should_restart = self
            .settings
            .lock()
            .map(|previous| {
                previous.enabled != normalized.enabled
                    || previous.follow_default_input != normalized.follow_default_input
                    || previous.input_device_id != normalized.input_device_id
            })
            .unwrap_or(true);
        if let Ok(mut stored) = self.settings.lock() {
            *stored = normalized.clone();
        }

        if !normalized.enabled {
            self.stop_locked();
            self.metrics.clear_error();
            return Ok(());
        }
        if should_restart {
            self.restart_locked(&normalized)?;
        } else {
            self.refresh_locked()?;
        }
        Ok(())
    }

    pub fn refresh(&self) -> Result<(), String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "Virtual Audio lifecycle lock failed".to_string())?;
        self.refresh_locked()
    }

    fn refresh_locked(&self) -> Result<(), String> {
        let settings = self
            .settings
            .lock()
            .map_err(|_| "Virtual Audio settings lock failed".to_string())?
            .clone();
        if !settings.enabled {
            self.stop_locked();
            return Ok(());
        }

        let selected_id = selected_input_device(&settings)
            .and_then(|device| device.id().map_err(|err| err.to_string()))?
            .to_string();
        let needs_restart = self
            .route
            .lock()
            .map(|route| {
                route
                    .as_ref()
                    .map(|active| active.input_device_id != selected_id)
                    .unwrap_or(true)
            })
            .unwrap_or(true)
            || self.metrics.callback_failed.swap(false, Ordering::AcqRel);
        if needs_restart {
            self.restart_locked(&settings)?;
        }
        Ok(())
    }

    pub fn stop(&self) {
        let _lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.stop_locked();
    }

    fn stop_locked(&self) {
        let active = self.route.lock().ok().and_then(|mut route| route.take());
        if let Some(active) = active {
            active.stop();
        }
        self.metrics.set_microphone_level(0.0);
        self.metrics.set_output_level(0.0);
    }

    pub fn snapshot(&self) -> VirtualAudioRuntimeSnapshot {
        VirtualAudioRuntimeSnapshot {
            running: self
                .route
                .lock()
                .map(|route| route.is_some())
                .unwrap_or(false),
            microphone_level: self.metrics.microphone_level(),
            output_level: self.metrics.output_level(),
            underruns: self.metrics.underruns.load(Ordering::Relaxed),
            overruns: self.metrics.overruns.load(Ordering::Relaxed),
        }
    }

    pub fn last_error(&self) -> Option<String> {
        self.metrics.last_error()
    }

    fn restart_locked(&self, settings: &VirtualAudioSettings) -> Result<(), String> {
        self.stop_locked();
        match start_route(
            settings,
            self.microphone_gain.clone(),
            self.metrics.clone(),
            self.soundboard_source.clone(),
        ) {
            Ok(active) => {
                self.metrics.clear_error();
                let mut route = self
                    .route
                    .lock()
                    .map_err(|_| "Virtual Audio route lock failed".to_string())?;
                *route = Some(active);
                Ok(())
            }
            Err(error) => {
                self.metrics.fail(error.clone());
                Err(error)
            }
        }
    }
}

impl Drop for VirtualAudioRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db.clamp(-96.0, 24.0) / 20.0)
}

pub fn is_virtual_audio_name(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains(&VIRTUAL_AUDIO_DEVICE_NAME.to_ascii_lowercase())
        || normalized.contains("midimaster virtual microphone")
}

fn is_virtual_audio_identity<'a>(parts: impl IntoIterator<Item = &'a str>) -> bool {
    parts.into_iter().any(is_virtual_audio_name)
}

fn is_virtual_audio_device(device: &cpal::Device) -> bool {
    let Ok(description) = device.description() else {
        return false;
    };
    is_virtual_audio_identity(
        std::iter::once(description.name())
            .chain(description.manufacturer())
            .chain(description.driver())
            .chain(description.address())
            .chain(description.extended().iter().map(String::as_str)),
    )
}

pub fn list_input_devices() -> Result<Vec<VirtualAudioInputDevice>, String> {
    let host = cpal::default_host();
    let default_id = host
        .default_input_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());
    let devices = host
        .input_devices()
        .map_err(|err| format!("Unable to list microphone devices: {err}"))?;
    let mut output = Vec::new();
    for device in devices {
        let Ok(id) = device.id() else { continue };
        let display = device_display(&device);
        if is_virtual_audio_device(&device) {
            continue;
        }
        let id = id.to_string();
        output.push(VirtualAudioInputDevice {
            is_default: default_id.as_deref() == Some(id.as_str()),
            id,
            display,
        });
    }
    output.sort_by(|left, right| {
        right.is_default.cmp(&left.is_default).then_with(|| {
            left.display
                .to_lowercase()
                .cmp(&right.display.to_lowercase())
        })
    });
    Ok(output)
}

pub fn virtual_endpoint_present() -> bool {
    let host = cpal::default_host();
    host.input_devices()
        .ok()
        .into_iter()
        .flatten()
        .any(|device| is_virtual_audio_device(&device))
}

fn device_display(device: &cpal::Device) -> String {
    device
        .description()
        .map(|description| description.name().to_string())
        .unwrap_or_else(|_| "Audio device".to_string())
}

fn selected_input_device(settings: &VirtualAudioSettings) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    let device = if settings.follow_default_input {
        let default = host
            .default_input_device()
            .ok_or_else(|| "No default microphone is available".to_string())?;
        if is_virtual_audio_device(&default) {
            host.input_devices()
                .map_err(|err| format!("Unable to list microphone devices: {err}"))?
                .find(|device| !is_virtual_audio_device(device))
                .ok_or_else(|| "No physical microphone is available".to_string())?
        } else {
            default
        }
    } else {
        let id = settings
            .input_device_id
            .as_deref()
            .ok_or_else(|| "Select a microphone for Virtual Audio".to_string())?
            .parse::<cpal::DeviceId>()
            .map_err(|_| "The selected microphone identifier is invalid".to_string())?;
        host.device_by_id(&id)
            .ok_or_else(|| "The selected microphone is unavailable".to_string())?
    };
    if is_virtual_audio_device(&device) {
        return Err("The MIDIMaster virtual endpoint cannot be used as its own microphone".into());
    }
    Ok(device)
}

fn start_route(
    settings: &VirtualAudioSettings,
    microphone_gain: Arc<AtomicU32>,
    metrics: Arc<RuntimeMetrics>,
    soundboard_source: Arc<Mutex<MixerSource>>,
) -> Result<ActiveRoute, String> {
    let input_device = selected_input_device(settings)?;
    let input_device_id = input_device
        .id()
        .map_err(|err| format!("Unable to identify the selected microphone: {err}"))?
        .to_string();
    let input_supported = input_device
        .default_input_config()
        .map_err(|err| format!("Unable to open the selected microphone: {err}"))?;
    let input_format = input_supported.sample_format();
    let input_config: cpal::StreamConfig = input_supported.into();
    let pipe = open_audio_pipe()?;

    let input_ring = HeapRb::<StereoFrame>::new(INPUT_RING_FRAMES);
    let (input_producer, input_consumer) = input_ring.split();
    let output_ring = HeapRb::<StereoFrame>::new(OUTPUT_RING_FRAMES);
    let (output_producer, output_consumer) = output_ring.split();

    let input_rate = input_config.sample_rate as f64;
    let output_rate = 48_000.0;
    let input_stream = build_input_stream(
        &input_device,
        &input_config,
        input_format,
        input_producer,
        microphone_gain,
        metrics.clone(),
    )?;
    let stop_worker = Arc::new(AtomicBool::new(false));
    let worker_stop = stop_worker.clone();
    let worker_metrics = metrics.clone();
    let resampler = std::thread::Builder::new()
        .name("midimaster-virtual-audio-resampler".to_string())
        .spawn(move || {
            resampler_worker(
                input_consumer,
                output_producer,
                input_rate,
                output_rate,
                worker_stop,
                worker_metrics,
            )
        })
        .map_err(|err| format!("Unable to start the Virtual Audio resampler: {err}"))?;

    let transport_stop = stop_worker.clone();
    let transport_metrics = metrics.clone();
    let transport = match std::thread::Builder::new()
        .name("midimaster-virtual-audio-pipe".to_string())
        .spawn(move || {
            pipe_transport_worker(
                output_consumer,
                soundboard_source,
                pipe,
                transport_stop,
                transport_metrics,
            )
        }) {
        Ok(worker) => worker,
        Err(error) => {
            stop_worker.store(true, Ordering::Release);
            let _ = resampler.join();
            return Err(format!(
                "Unable to start the Virtual Audio transport: {error}"
            ));
        }
    };

    let play_result = input_stream
        .play()
        .map_err(|err| format!("Unable to start microphone capture: {err}"));
    if let Err(error) = play_result {
        stop_worker.store(true, Ordering::Release);
        let _ = resampler.join();
        let _ = transport.join();
        return Err(error);
    }
    std::thread::sleep(OUTPUT_PREFILL_WAIT);

    Ok(ActiveRoute {
        _input_stream: input_stream,
        input_device_id,
        stop_worker,
        workers: vec![resampler, transport],
    })
}

fn open_audio_pipe() -> Result<File, String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match OpenOptions::new().write(true).open(AUDIO_PIPE_PATH) {
            Ok(pipe) => return Ok(pipe),
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                return Err(format!(
                    "Unable to connect to the MIDIMaster Virtual Audio service: {error}"
                ));
            }
        }
    }
}

fn pipe_transport_worker(
    mut microphone: HeapCons<StereoFrame>,
    soundboard: Arc<Mutex<MixerSource>>,
    mut pipe: File,
    stop: Arc<AtomicBool>,
    metrics: Arc<RuntimeMetrics>,
) {
    let interval = Duration::from_millis(10);
    let mut deadline = Instant::now();
    let mut payload = Vec::with_capacity(PIPE_BATCH_FRAMES * 4);
    while !stop.load(Ordering::Acquire) {
        deadline += interval;
        payload.clear();
        let mut peak = 0.0_f32;
        let mut soundboard = match soundboard.lock() {
            Ok(source) => source,
            Err(_) => {
                metrics.fail("Virtual soundboard mixer lock failed");
                break;
            }
        };
        for _ in 0..PIPE_BATCH_FRAMES {
            let mic = microphone.try_pop().unwrap_or_default();
            let board_left = soundboard.next().unwrap_or(0.0);
            let board_right = soundboard.next().unwrap_or(0.0);
            let left = (mic.left + board_left).clamp(-1.0, 1.0);
            let right = (mic.right + board_right).clamp(-1.0, 1.0);
            peak = peak.max(left.abs()).max(right.abs());
            payload.extend_from_slice(&((left * i16::MAX as f32).round() as i16).to_le_bytes());
            payload.extend_from_slice(&((right * i16::MAX as f32).round() as i16).to_le_bytes());
        }
        drop(soundboard);
        metrics.set_output_level(peak);
        if let Err(error) = pipe.write_all(&payload) {
            metrics.fail(format!("Virtual Audio service pipe failed: {error}"));
            break;
        }
        let now = Instant::now();
        if now < deadline {
            std::thread::sleep(deadline - now);
        } else if now.duration_since(deadline) > interval {
            deadline = now;
        }
    }
}

fn resampler_worker(
    mut input: HeapCons<StereoFrame>,
    mut output: HeapProd<StereoFrame>,
    input_rate: f64,
    output_rate: f64,
    stop: Arc<AtomicBool>,
    metrics: Arc<RuntimeMetrics>,
) {
    let base_step = input_rate / output_rate.max(1.0);
    let target_fill = ((output_rate * OUTPUT_TARGET_LATENCY.as_secs_f64()) as usize)
        .clamp(256, OUTPUT_RING_FRAMES / 2);
    let mut local = VecDeque::with_capacity(RESAMPLER_LOCAL_FRAMES);
    let mut source_position = 0.0_f64;

    while !stop.load(Ordering::Acquire) {
        while local.len() < RESAMPLER_LOCAL_FRAMES {
            let Some(frame) = input.try_pop() else { break };
            local.push_back(frame);
        }
        if local.len() >= RESAMPLER_LOCAL_FRAMES {
            let drop_count = local.len().saturating_sub(RESAMPLER_LOCAL_FRAMES / 2);
            local.drain(..drop_count);
            metrics
                .overruns
                .fetch_add(drop_count as u64, Ordering::Relaxed);
        }

        let fill = output.occupied_len();
        let normalized_error = (target_fill as f64 - fill as f64) / target_fill as f64;
        let correction = (1.0 - (normalized_error * 0.001)).clamp(0.995, 1.005);
        let step = base_step * correction;

        let mut produced = 0usize;
        while local.len() >= 2 && output.vacant_len() > 0 {
            let current = local[0];
            let next = local[1];
            if output
                .try_push(current.lerp(next, source_position.fract()))
                .is_err()
            {
                break;
            }
            produced += 1;
            source_position += step;
            while source_position >= 1.0 && local.len() > 1 {
                local.pop_front();
                source_position -= 1.0;
            }
        }

        if produced == 0 || output.occupied_len() >= target_fill * 2 {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

trait InputSample: cpal::SizedSample + Copy + Send + 'static {
    fn to_f32(self) -> f32;
}

macro_rules! signed_sample {
    ($type:ty, $scale:expr) => {
        impl InputSample for $type {
            fn to_f32(self) -> f32 {
                (self as f64 / $scale as f64).clamp(-1.0, 1.0) as f32
            }
        }
    };
}

macro_rules! unsigned_sample {
    ($type:ty, $mid:expr) => {
        impl InputSample for $type {
            fn to_f32(self) -> f32 {
                ((self as f64 - $mid as f64) / $mid as f64).clamp(-1.0, 1.0) as f32
            }
        }
    };
}

signed_sample!(i8, i8::MAX);
signed_sample!(i16, i16::MAX);
signed_sample!(i32, i32::MAX);
signed_sample!(i64, i64::MAX);
unsigned_sample!(u8, 128u16);
unsigned_sample!(u16, 32768u32);
unsigned_sample!(u32, 2147483648u64);
unsigned_sample!(u64, 9223372036854775808u128);

impl InputSample for f32 {
    fn to_f32(self) -> f32 {
        self.clamp(-1.0, 1.0)
    }
}

impl InputSample for f64 {
    fn to_f32(self) -> f32 {
        self.clamp(-1.0, 1.0) as f32
    }
}

impl InputSample for cpal::I24 {
    fn to_f32(self) -> f32 {
        (self.inner() as f64 / 8_388_607.0).clamp(-1.0, 1.0) as f32
    }
}

impl InputSample for cpal::U24 {
    fn to_f32(self) -> f32 {
        ((self.inner() as f64 - 8_388_608.0) / 8_388_608.0).clamp(-1.0, 1.0) as f32
    }
}

fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    format: cpal::SampleFormat,
    producer: HeapProd<StereoFrame>,
    microphone_gain: Arc<AtomicU32>,
    metrics: Arc<RuntimeMetrics>,
) -> Result<cpal::Stream, String> {
    macro_rules! build {
        ($type:ty) => {
            build_typed_input_stream::<$type>(device, config, producer, microphone_gain, metrics)
        };
    }
    match format {
        cpal::SampleFormat::I8 => build!(i8),
        cpal::SampleFormat::I16 => build!(i16),
        cpal::SampleFormat::I24 => build!(cpal::I24),
        cpal::SampleFormat::I32 => build!(i32),
        cpal::SampleFormat::I64 => build!(i64),
        cpal::SampleFormat::U8 => build!(u8),
        cpal::SampleFormat::U16 => build!(u16),
        cpal::SampleFormat::U24 => build!(cpal::U24),
        cpal::SampleFormat::U32 => build!(u32),
        cpal::SampleFormat::U64 => build!(u64),
        cpal::SampleFormat::F32 => build!(f32),
        cpal::SampleFormat::F64 => build!(f64),
        other => Err(format!("Unsupported microphone sample format: {other}")),
    }
}

fn build_typed_input_stream<T: InputSample>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut producer: HeapProd<StereoFrame>,
    microphone_gain: Arc<AtomicU32>,
    metrics: Arc<RuntimeMetrics>,
) -> Result<cpal::Stream, String> {
    let channels = usize::from(config.channels).max(1);
    let callback_metrics = metrics.clone();
    let error_metrics = metrics;
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data, _| {
                let gain = f32::from_bits(microphone_gain.load(Ordering::Acquire));
                let mut peak = 0.0_f32;
                let mut dropped = 0u64;
                for samples in data.chunks(channels) {
                    let left = samples.first().map(|sample| sample.to_f32()).unwrap_or(0.0);
                    let right = samples.get(1).map(|sample| sample.to_f32()).unwrap_or(left);
                    let frame = StereoFrame {
                        left: (left * gain).clamp(-1.0, 1.0),
                        right: (right * gain).clamp(-1.0, 1.0),
                    };
                    peak = peak.max(frame.peak());
                    if producer.try_push(frame).is_err() {
                        dropped += 1;
                    }
                }
                callback_metrics.set_microphone_level(peak);
                if dropped > 0 {
                    callback_metrics
                        .overruns
                        .fetch_add(dropped, Ordering::Relaxed);
                }
            },
            move |error| error_metrics.fail(format!("Microphone stream failed: {error}")),
            None,
        )
        .map_err(|err| format!("Unable to create microphone stream: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_gain_matches_expected_reference_points() {
        assert!((db_to_linear(0.0) - 1.0).abs() < 0.0001);
        assert!((db_to_linear(-6.0) - 0.501).abs() < 0.002);
        assert!((db_to_linear(12.0) - 3.981).abs() < 0.01);
    }

    #[test]
    fn virtual_endpoint_name_matching_is_case_insensitive() {
        assert!(is_virtual_audio_name("Speakers (MIDIMaster Virtual Audio)"));
        assert!(is_virtual_audio_name("midimaster virtual audio microphone"));
        assert!(is_virtual_audio_name(
            "Microphone (MIDIMaster Virtual Microphone)"
        ));
        assert!(!is_virtual_audio_name("USB Microphone"));
    }

    #[test]
    fn virtual_endpoint_identity_matches_driver_or_extended_name() {
        assert!(is_virtual_audio_identity([
            "Microphone",
            "MIDIMaster Virtual Microphone",
        ]));
        assert!(is_virtual_audio_identity([
            "Microphone",
            "Microphone (MIDIMaster Virtual Microphone)",
        ]));
        assert!(!is_virtual_audio_identity([
            "Microphone",
            "USB Audio Device",
        ]));
    }

    #[test]
    #[ignore = "requires an installed and attached MIDIMaster Virtual Microphone"]
    fn live_virtual_endpoint_is_recognized() {
        assert!(virtual_endpoint_present());
    }

    #[test]
    #[ignore = "requires an installed service and an available physical microphone"]
    fn live_route_start_refresh_and_stop_remain_responsive() {
        use crate::soundboard::SoundboardService;
        use std::sync::{Arc, Barrier};

        let soundboard = SoundboardService::default();
        let source = soundboard.take_virtual_source().unwrap();
        let runtime = Arc::new(VirtualAudioRuntime::new(
            VirtualAudioSettings::default(),
            source,
        ));
        let settings = VirtualAudioSettings {
            enabled: true,
            ..VirtualAudioSettings::default()
        };
        let barrier = Arc::new(Barrier::new(3));

        let apply_runtime = runtime.clone();
        let apply_barrier = barrier.clone();
        let apply = std::thread::spawn(move || {
            apply_barrier.wait();
            apply_runtime.apply_settings(settings)
        });
        let refresh_runtime = runtime.clone();
        let refresh_barrier = barrier.clone();
        let refresh = std::thread::spawn(move || {
            refresh_barrier.wait();
            refresh_runtime.refresh()
        });

        let started = Instant::now();
        barrier.wait();
        apply.join().unwrap().unwrap();
        refresh.join().unwrap().unwrap();
        assert!(runtime.snapshot().running);
        runtime.stop();
        assert!(!runtime.snapshot().running);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn sample_conversions_preserve_zero_and_extremes() {
        assert_eq!(InputSample::to_f32(0i16), 0.0);
        assert!(InputSample::to_f32(i16::MAX) > 0.99);
        assert!(InputSample::to_f32(i16::MIN) <= -1.0);
    }
}

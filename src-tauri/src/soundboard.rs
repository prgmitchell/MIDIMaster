use crate::model::SoundboardMapping;
use rodio::cpal::traits::{DeviceTrait as _, HostTrait as _};
use rodio::{cpal, Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

pub const MAX_AUDIO_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_AUDIO_DURATION_MS: u64 = 10 * 60 * 1000;
pub const WAVEFORM_BUCKETS: usize = 1024;
const MAX_ANALYSIS_CACHE_ENTRIES: usize = 32;
const PREVIEW_PLAYER_KEY: &str = "__soundboard_preview__";
const SUPPORTED_EXTENSIONS: &[&str] = &["mp3", "wav", "flac", "ogg", "m4a", "mp4", "aac"];

#[derive(Debug, Clone, Copy, Serialize)]
pub struct WaveformPeak {
    pub min: f32,
    pub max: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SoundboardAnalysis {
    pub path: String,
    pub display: String,
    pub duration_ms: u64,
    pub peaks: Vec<WaveformPeak>,
}

#[derive(Clone)]
struct CachedAnalysis {
    size: u64,
    modified: Option<SystemTime>,
    analysis: SoundboardAnalysis,
}

#[derive(Default)]
struct PlaybackState {
    outputs: HashMap<String, OutputState>,
    players: HashMap<String, ActivePlayer>,
}

struct OutputState {
    sink: MixerDeviceSink,
    failed: Arc<AtomicBool>,
}

struct ActivePlayer {
    player: Player,
    output_key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SoundboardOutputDevice {
    pub id: String,
    pub display: String,
    pub is_default: bool,
}

pub struct SoundboardService {
    playback: Mutex<PlaybackState>,
    analysis_cache: Mutex<HashMap<PathBuf, CachedAnalysis>>,
}

impl Default for SoundboardService {
    fn default() -> Self {
        Self {
            playback: Mutex::new(PlaybackState::default()),
            analysis_cache: Mutex::new(HashMap::new()),
        }
    }
}

impl SoundboardService {
    pub fn output_devices() -> Result<Vec<SoundboardOutputDevice>, String> {
        let host = cpal::default_host();
        let default_id = host
            .default_output_device()
            .and_then(|device| device.id().ok())
            .map(|id| id.to_string());
        let devices = host
            .output_devices()
            .map_err(|err| format!("Unable to list playback devices: {err}"))?;
        let mut output = Vec::new();
        for device in devices {
            let Ok(id) = device.id() else { continue };
            let display = device
                .description()
                .map(|description| description.name().to_string())
                .unwrap_or_else(|_| id.to_string());
            let id = id.to_string();
            output.push(SoundboardOutputDevice {
                is_default: default_id.as_deref() == Some(id.as_str()),
                id,
                display,
            });
        }
        output.sort_by(|left, right| {
            left.display
                .to_lowercase()
                .cmp(&right.display.to_lowercase())
        });
        Ok(output)
    }

    pub fn analyze(&self, path: &Path) -> Result<SoundboardAnalysis, String> {
        let canonical = validate_audio_path(path)?;
        let metadata = std::fs::metadata(&canonical).map_err(|err| err.to_string())?;
        let modified = metadata.modified().ok();
        if let Ok(cache) = self.analysis_cache.lock() {
            if let Some(entry) = cache.get(&canonical) {
                if entry.size == metadata.len() && entry.modified == modified {
                    return Ok(entry.analysis.clone());
                }
            }
        }

        let file = File::open(&canonical)
            .map_err(|err| format!("Unable to open the selected audio file: {err}"))?;
        let decoder = Decoder::try_from(file)
            .map_err(|err| format!("Unsupported or invalid audio file: {err}"))?;
        let duration = decoder
            .total_duration()
            .ok_or_else(|| "Unable to determine the audio duration".to_string())?;
        let duration_ms = duration_to_ms(duration);
        if duration_ms == 0 {
            return Err("The selected audio file is empty".to_string());
        }
        if duration_ms > MAX_AUDIO_DURATION_MS {
            return Err("Audio files must be 10 minutes or shorter".to_string());
        }

        let channels = u64::from(decoder.channels().get()).max(1);
        let sample_rate = u64::from(decoder.sample_rate().get()).max(1);
        let total_samples =
            ((duration.as_secs_f64() * sample_rate as f64 * channels as f64).ceil() as u64).max(1);
        let mut peaks = vec![WaveformPeak { min: 0.0, max: 0.0 }; WAVEFORM_BUCKETS];
        for (index, sample) in decoder.enumerate() {
            let bucket = (((index as u64).saturating_mul(WAVEFORM_BUCKETS as u64)) / total_samples)
                .min((WAVEFORM_BUCKETS - 1) as u64) as usize;
            let sample = sample.clamp(-1.0, 1.0);
            peaks[bucket].min = peaks[bucket].min.min(sample);
            peaks[bucket].max = peaks[bucket].max.max(sample);
        }

        let display = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Audio file")
            .to_string();
        let analysis = SoundboardAnalysis {
            path: canonical.to_string_lossy().to_string(),
            display,
            duration_ms,
            peaks,
        };

        if let Ok(mut cache) = self.analysis_cache.lock() {
            if cache.len() >= MAX_ANALYSIS_CACHE_ENTRIES && !cache.contains_key(&canonical) {
                cache.clear();
            }
            cache.insert(
                canonical,
                CachedAnalysis {
                    size: metadata.len(),
                    modified,
                    analysis: analysis.clone(),
                },
            );
        }
        Ok(analysis)
    }

    pub fn play_binding(
        &self,
        binding_id: &str,
        mapping: &SoundboardMapping,
    ) -> Result<(), String> {
        self.play(binding_id, mapping)
    }

    pub fn play_preview(&self, mapping: &SoundboardMapping) -> Result<(), String> {
        self.play(PREVIEW_PLAYER_KEY, mapping)
    }

    pub fn set_preview_volume(&self, volume: f32) {
        if let Ok(playback) = self.playback.lock() {
            if let Some(player) = playback.players.get(PREVIEW_PLAYER_KEY) {
                player.player.set_volume(normalize_volume(volume));
            }
        }
    }

    pub fn set_preview_paused(&self, paused: bool) {
        if let Ok(playback) = self.playback.lock() {
            if let Some(player) = playback.players.get(PREVIEW_PLAYER_KEY) {
                if paused {
                    player.player.pause();
                } else {
                    player.player.play();
                }
            }
        }
    }

    pub fn stop_preview(&self) {
        if let Ok(mut playback) = self.playback.lock() {
            if let Some(player) = playback.players.remove(PREVIEW_PLAYER_KEY) {
                player.player.stop();
            }
        }
    }

    pub fn stop_all(&self) {
        if let Ok(mut playback) = self.playback.lock() {
            for (_, player) in playback.players.drain() {
                player.player.stop();
            }
            playback.outputs.clear();
        }
    }

    fn play(&self, key: &str, mapping: &SoundboardMapping) -> Result<(), String> {
        let mapping = mapping
            .normalized()
            .ok_or_else(|| "Select an audio file for this Soundboard action".to_string())?;
        let path = validate_audio_path(Path::new(&mapping.path))?;
        let file = File::open(&path).map_err(|err| format!("Unable to open audio file: {err}"))?;
        let decoder = Decoder::try_from(file)
            .map_err(|err| format!("Unsupported or invalid audio file: {err}"))?;
        let duration = decoder
            .total_duration()
            .ok_or_else(|| "Unable to determine the audio duration".to_string())?;
        let duration_ms = duration_to_ms(duration);
        if duration_ms > MAX_AUDIO_DURATION_MS {
            return Err("Audio files must be 10 minutes or shorter".to_string());
        }
        let (start_ms, end_ms) = validated_trim_range(&mapping, duration_ms)?;
        let source = decoder
            .skip_duration(Duration::from_millis(start_ms))
            .take_duration(Duration::from_millis(end_ms - start_ms));

        let mut playback = self
            .playback
            .lock()
            .map_err(|_| "Soundboard playback lock failed".to_string())?;
        let output_key = mapping.output_device_id.as_deref().unwrap_or("__default__");
        let failed_outputs: Vec<String> = playback
            .outputs
            .iter()
            .filter(|(_, output)| output.failed.swap(false, Ordering::AcqRel))
            .map(|(key, _)| key.clone())
            .collect();
        for failed_key in failed_outputs {
            let failed_players: Vec<String> = playback
                .players
                .iter()
                .filter(|(_, player)| player.output_key == failed_key)
                .map(|(key, _)| key.clone())
                .collect();
            for player_key in failed_players {
                if let Some(player) = playback.players.remove(&player_key) {
                    player.player.stop();
                }
            }
            playback.outputs.remove(&failed_key);
        }
        playback.players.retain(|_, player| !player.player.empty());
        if let Some(previous) = playback.players.remove(key) {
            previous.player.stop();
        }
        if !playback.outputs.contains_key(output_key) {
            let failed = Arc::new(AtomicBool::new(false));
            let callback_failed = failed.clone();
            let builder = if let Some(device_id) = mapping.output_device_id.as_deref() {
                let parsed = device_id
                    .parse::<cpal::DeviceId>()
                    .map_err(|_| "The selected Soundboard output device is invalid".to_string())?;
                let device = cpal::default_host().device_by_id(&parsed).ok_or_else(|| {
                    "The selected Soundboard output device is unavailable".to_string()
                })?;
                DeviceSinkBuilder::from_device(device)
                    .map_err(|err| format!("Unable to open the selected playback device: {err}"))?
            } else {
                DeviceSinkBuilder::from_default_device()
                    .map_err(|err| format!("Unable to open the default playback device: {err}"))?
            }
            .with_error_callback(move |err| {
                eprintln!("Soundboard playback device failed: {err}");
                callback_failed.store(true, Ordering::Release);
            });
            let sink = builder
                .open_sink_or_fallback()
                .map_err(|err| format!("Unable to open the playback device: {err}"))?;
            playback
                .outputs
                .insert(output_key.to_string(), OutputState { sink, failed });
        }
        let output = playback
            .outputs
            .get(output_key)
            .ok_or_else(|| "Playback device is unavailable".to_string())?;
        let player = Player::connect_new(output.sink.mixer());
        player.set_volume(normalize_volume(mapping.volume));
        player.set_speed(mapping.speed);
        player.append(source);
        playback.players.insert(
            key.to_string(),
            ActivePlayer {
                player,
                output_key: output_key.to_string(),
            },
        );
        Ok(())
    }
}

pub fn validated_trim_range(
    mapping: &SoundboardMapping,
    duration_ms: u64,
) -> Result<(u64, u64), String> {
    if duration_ms == 0 {
        return Err("The selected audio file is empty".to_string());
    }
    let start = mapping.trim_start_ms;
    let end = mapping.trim_end_ms.unwrap_or(duration_ms);
    if start >= duration_ms || end > duration_ms || end <= start {
        return Err("The Soundboard trim range is invalid for this audio file".to_string());
    }
    Ok((start, end))
}

pub fn should_trigger_from_input(value: f32) -> bool {
    value.is_finite() && value > 0.0
}

fn normalize_volume(volume: f32) -> f32 {
    if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        1.0
    }
}

fn duration_to_ms(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn validate_audio_path(path: &Path) -> Result<PathBuf, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| "The linked Soundboard audio file could not be found".to_string())?;
    if !metadata.is_file() {
        return Err("The selected Soundboard path is not a file".to_string());
    }
    if metadata.len() > MAX_AUDIO_BYTES {
        return Err("Audio files must be 100 MB or smaller".to_string());
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Choose an MP3, WAV, FLAC, OGG, M4A, MP4, or AAC file".to_string());
    }
    path.canonicalize()
        .map_err(|err| format!("Unable to resolve the selected audio file: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek, SeekFrom, Write};
    use std::sync::atomic::AtomicU64;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_path(extension: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "midimaster-soundboard-{}-{}.{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed),
            extension
        ))
    }

    fn write_pcm_wav(path: &Path, sample_rate: u32, samples: &[i16]) {
        let data_len = (samples.len() * 2) as u32;
        let mut file = File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data_len).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16_u32.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&sample_rate.to_le_bytes()).unwrap();
        file.write_all(&(sample_rate * 2).to_le_bytes()).unwrap();
        file.write_all(&2_u16.to_le_bytes()).unwrap();
        file.write_all(&16_u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&data_len.to_le_bytes()).unwrap();
        for sample in samples {
            file.write_all(&sample.to_le_bytes()).unwrap();
        }
    }

    fn write_sparse_pcm_wav(path: &Path, sample_rate: u32, sample_count: u32) {
        let data_len = sample_count * 2;
        let mut file = File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data_len).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16_u32.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&sample_rate.to_le_bytes()).unwrap();
        file.write_all(&(sample_rate * 2).to_le_bytes()).unwrap();
        file.write_all(&2_u16.to_le_bytes()).unwrap();
        file.write_all(&16_u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&data_len.to_le_bytes()).unwrap();
        file.set_len(u64::from(data_len) + 44).unwrap();
    }

    fn mapping(start: u64, end: Option<u64>, volume: f32) -> SoundboardMapping {
        SoundboardMapping {
            path: "sound.wav".to_string(),
            display: "sound.wav".to_string(),
            trim_start_ms: start,
            trim_end_ms: end,
            volume,
            speed: 1.0,
            output_device_id: None,
            output_device_display: None,
        }
    }

    #[test]
    fn trim_range_uses_file_end_when_omitted() {
        assert_eq!(
            validated_trim_range(&mapping(250, None, 1.0), 1_000),
            Ok((250, 1_000))
        );
    }

    #[test]
    fn trim_range_rejects_crossed_or_out_of_bounds_handles() {
        assert!(validated_trim_range(&mapping(800, Some(700), 1.0), 1_000).is_err());
        assert!(validated_trim_range(&mapping(0, Some(1_001), 1.0), 1_000).is_err());
        assert!(validated_trim_range(&mapping(1_000, None, 1.0), 1_000).is_err());
    }

    #[test]
    fn mapping_normalization_clamps_volume_and_repairs_display() {
        let normalized = SoundboardMapping {
            path: " C:\\sounds\\ding.wav ".to_string(),
            display: String::new(),
            trim_start_ms: 10,
            trim_end_ms: Some(10),
            volume: 2.0,
            speed: 3.0,
            output_device_id: Some("  ".to_string()),
            output_device_display: Some(" Speakers ".to_string()),
        }
        .normalized()
        .expect("mapping");
        assert_eq!(normalized.display, "ding.wav");
        assert_eq!(normalized.trim_end_ms, Some(11));
        assert_eq!(normalized.volume, 1.0);
        assert_eq!(normalized.speed, 2.0);
        assert_eq!(normalized.output_device_id, None);
        assert_eq!(normalized.output_device_display, None);
    }

    #[test]
    fn waveform_analysis_returns_fixed_peak_bucket_count() {
        let path = test_path("wav");
        let samples = (0..8_000)
            .map(|index| if index % 2 == 0 { i16::MAX } else { i16::MIN })
            .collect::<Vec<_>>();
        write_pcm_wav(&path, 8_000, &samples);
        let analysis = SoundboardService::default().analyze(&path).unwrap();
        assert_eq!(analysis.duration_ms, 1_000);
        assert_eq!(analysis.peaks.len(), WAVEFORM_BUCKETS);
        assert!(analysis.peaks.iter().any(|peak| peak.min < -0.9));
        assert!(analysis.peaks.iter().any(|peak| peak.max > 0.9));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn analysis_rejects_missing_corrupt_and_oversize_files() {
        let missing = test_path("wav");
        assert!(SoundboardService::default().analyze(&missing).is_err());

        let corrupt = test_path("mp3");
        std::fs::write(&corrupt, b"not audio").unwrap();
        assert!(SoundboardService::default().analyze(&corrupt).is_err());
        std::fs::remove_file(corrupt).unwrap();

        let oversize = test_path("wav");
        let mut file = File::create(&oversize).unwrap();
        file.seek(SeekFrom::Start(MAX_AUDIO_BYTES)).unwrap();
        file.write_all(&[0]).unwrap();
        drop(file);
        assert!(validate_audio_path(&oversize).is_err());
        std::fs::remove_file(oversize).unwrap();
    }

    #[test]
    fn analysis_rejects_audio_longer_than_ten_minutes() {
        let path = test_path("wav");
        write_sparse_pcm_wav(&path, 8_000, 8_000 * 601);
        let error = SoundboardService::default().analyze(&path).unwrap_err();
        assert!(error.contains("10 minutes"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn supported_extensions_are_accepted_before_decode() {
        for extension in SUPPORTED_EXTENSIONS {
            let path = test_path(extension);
            std::fs::write(&path, b"placeholder").unwrap();
            assert!(validate_audio_path(&path).is_ok(), "extension {extension}");
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn soundboard_dispatch_is_press_only() {
        assert!(should_trigger_from_input(1.0));
        assert!(should_trigger_from_input(0.001));
        assert!(!should_trigger_from_input(0.0));
        assert!(!should_trigger_from_input(-1.0));
        assert!(!should_trigger_from_input(f32::NAN));
    }
}

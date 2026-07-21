use crate::midi_event_queue::MidiEventQueueAuditSnapshot;
use crate::model::{MidiEvent, MidiMessageType};
use crate::AppState;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::State;

const MAX_ACTION_SAMPLES: usize = 100_000;
const MAX_INJECTED_MESSAGES: u64 = 1_000_000;
static RESULT_WRITER: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Default)]
struct NativeActionMetrics {
    processing_durations_us: Vec<u64>,
    enqueue_to_action_us: Vec<u64>,
    pending_latest: HashMap<AuditMidiKey, Instant>,
    pending_preserved: VecDeque<(AuditMidiKey, Instant)>,
    expected_latest: HashMap<AuditMidiKey, u8>,
    observed_latest: HashMap<AuditMidiKey, u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct AuditMidiKey {
    device_id: String,
    channel: u8,
    controller: u8,
    msg_type: MidiMessageType,
}

impl From<&MidiEvent> for AuditMidiKey {
    fn from(event: &MidiEvent) -> Self {
        Self {
            device_id: event.device_id.clone(),
            channel: event.channel,
            controller: event.controller,
            msg_type: event.msg_type.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
struct NativeActionSnapshot {
    samples: usize,
    p50_us: u64,
    p95_us: u64,
    p99_us: u64,
    max_us: u64,
}

#[derive(Debug, Serialize)]
struct MidiConvergenceSnapshot {
    controls: usize,
    mismatches: usize,
    converged: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct PerfAuditSnapshot {
    schema_version: u32,
    run_id: String,
    scenario_id: String,
    variant: String,
    network_mode: String,
    active_profile: Option<String>,
    active_binding_count: usize,
    queue: MidiEventQueueAuditSnapshot,
    native_action: NativeActionSnapshot,
    native_processing: NativeActionSnapshot,
    latest_value: MidiConvergenceSnapshot,
}

#[derive(Debug, Serialize)]
pub(crate) struct PerfAuditInjectionResult {
    schema_version: u32,
    message_count: u64,
    rate_per_second: u32,
    control_count: u8,
    message_kind: String,
    scheduled_duration_us: u64,
    queue: MidiEventQueueAuditSnapshot,
}

fn validate_result_metric(metric: &str) -> bool {
    !metric.is_empty()
        && metric.len() <= 120
        && metric.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_.-".contains(&byte)
        })
        && metric.as_bytes()[0].is_ascii_lowercase()
}

fn result_directory() -> Result<Option<PathBuf>, String> {
    let Some(raw) = std::env::var_os("MIDIMASTER_PERF_RESULTS_DIR") else {
        return Ok(None);
    };
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("MIDIMASTER_PERF_RESULTS_DIR must be absolute".to_string());
    }
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(Some(path))
}

fn scalar_dimensions(dimensions: Option<Value>) -> Result<Map<String, Value>, String> {
    let Some(Value::Object(dimensions)) = dimensions else {
        return Ok(Map::new());
    };
    if dimensions.len() > 32
        || dimensions.values().any(|value| {
            !matches!(
                value,
                Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
            )
        })
    {
        return Err("Performance dimensions must contain at most 32 scalar values".to_string());
    }
    Ok(dimensions)
}

fn native_metrics() -> &'static Mutex<NativeActionMetrics> {
    static METRICS: OnceLock<Mutex<NativeActionMetrics>> = OnceLock::new();
    METRICS.get_or_init(|| Mutex::new(NativeActionMetrics::default()))
}

fn preserve_event(event: &MidiEvent) -> bool {
    match event.msg_type {
        MidiMessageType::Note | MidiMessageType::ProgramChange => true,
        MidiMessageType::ControlChange => event.value == 0 || event.value == 127,
        MidiMessageType::PitchBend => false,
    }
}

pub(crate) fn record_midi_enqueue(event: &MidiEvent) {
    if let Ok(mut metrics) = native_metrics().lock() {
        let key = AuditMidiKey::from(event);
        metrics.expected_latest.insert(key.clone(), event.value);
        if preserve_event(event) {
            if metrics.pending_preserved.len() < 2_048 {
                metrics.pending_preserved.push_back((key, Instant::now()));
            }
        } else {
            metrics.pending_latest.insert(key, Instant::now());
        }
    }
}

pub(crate) fn take_midi_enqueue(event: &MidiEvent) -> Option<Instant> {
    let mut metrics = native_metrics().lock().ok()?;
    let key = AuditMidiKey::from(event);
    metrics.observed_latest.insert(key.clone(), event.value);
    if preserve_event(event) {
        let index = metrics
            .pending_preserved
            .iter()
            .position(|(candidate, _)| candidate == &key)?;
        return metrics.pending_preserved.remove(index).map(|(_, at)| at);
    }
    metrics.pending_latest.remove(&key)
}

fn push_bounded(samples: &mut Vec<u64>, duration: Duration) {
    if samples.len() >= MAX_ACTION_SAMPLES {
        let remove_count = MAX_ACTION_SAMPLES / 10;
        samples.drain(..remove_count);
    }
    samples.push(duration.as_micros().min(u64::MAX as u128) as u64);
}

pub(crate) fn record_native_action(processing: Duration, enqueue_to_action: Option<Duration>) {
    if let Ok(mut metrics) = native_metrics().lock() {
        push_bounded(&mut metrics.processing_durations_us, processing);
        if let Some(duration) = enqueue_to_action {
            push_bounded(&mut metrics.enqueue_to_action_us, duration);
        }
    }
}

fn percentile(sorted: &[u64], percentile: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() - 1) as f64 * percentile).ceil() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn duration_snapshot(mut samples: Vec<u64>) -> NativeActionSnapshot {
    samples.sort_unstable();
    NativeActionSnapshot {
        samples: samples.len(),
        p50_us: percentile(&samples, 0.50),
        p95_us: percentile(&samples, 0.95),
        p99_us: percentile(&samples, 0.99),
        max_us: samples.last().copied().unwrap_or_default(),
    }
}

fn native_snapshots() -> (NativeActionSnapshot, NativeActionSnapshot) {
    let (enqueue_to_action, processing) = native_metrics()
        .lock()
        .map(|metrics| {
            (
                metrics.enqueue_to_action_us.clone(),
                metrics.processing_durations_us.clone(),
            )
        })
        .unwrap_or_default();
    (
        duration_snapshot(enqueue_to_action),
        duration_snapshot(processing),
    )
}

fn convergence_snapshot() -> MidiConvergenceSnapshot {
    let Ok(metrics) = native_metrics().lock() else {
        return MidiConvergenceSnapshot {
            controls: 0,
            mismatches: 0,
            converged: false,
        };
    };
    let mismatches = metrics
        .expected_latest
        .iter()
        .filter(|(key, expected)| metrics.observed_latest.get(*key) != Some(*expected))
        .count();
    MidiConvergenceSnapshot {
        controls: metrics.expected_latest.len(),
        mismatches,
        converged: !metrics.expected_latest.is_empty() && mismatches == 0,
    }
}

fn audit_identity(name: &str, fallback: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| fallback.to_string())
}

pub(crate) fn network_is_offline() -> bool {
    std::env::var("MIDIMASTER_PERF_NETWORK_MODE")
        .is_ok_and(|value| value.trim().eq_ignore_ascii_case("offline"))
}

#[tauri::command]
pub(crate) fn perf_audit_record_result(
    metric: String,
    value: f64,
    unit: String,
    kind: String,
    dimensions: Option<Value>,
) -> Result<bool, String> {
    if !validate_result_metric(&metric) || !value.is_finite() {
        return Err("Invalid performance metric or value".to_string());
    }
    if !matches!(
        unit.as_str(),
        "ms" | "bytes" | "percent" | "count" | "bytes_per_second"
    ) {
        return Err("Invalid performance result unit".to_string());
    }
    if !matches!(
        kind.as_str(),
        "milestone" | "operation" | "resource" | "counter"
    ) {
        return Err("Invalid performance result kind".to_string());
    }
    let Some(directory) = result_directory()? else {
        return Ok(false);
    };
    let record = serde_json::json!({
        "schema_version": "1.0.0",
        "run_id": audit_identity("MIDIMASTER_PERF_RUN_ID", "manual"),
        "scenario_id": audit_identity("MIDIMASTER_PERF_SCENARIO_ID", "manual"),
        "variant": audit_identity("MIDIMASTER_PERF_VARIANT", "current"),
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "kind": kind,
        "metric": metric,
        "value": value,
        "unit": unit,
        "commit": Value::Null,
        "build": "perf-audit",
        "dimensions": scalar_dimensions(dimensions)?,
    });
    let encoded = serde_json::to_string(&record).map_err(|error| error.to_string())?;
    let _guard = RESULT_WRITER
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Performance result writer lock poisoned".to_string())?;
    let path = directory.join("frontend.ndjson");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{encoded}").map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn perf_audit_snapshot(state: State<AppState>) -> Result<PerfAuditSnapshot, String> {
    let (active_profile, active_binding_count) = state
        .active_profile
        .lock()
        .map_err(|_| "Active profile lock poisoned".to_string())?
        .as_ref()
        .map(|profile| (Some(profile.name.clone()), profile.bindings.len()))
        .unwrap_or((None, 0));
    let queue = state
        .midi_event_queue
        .lock()
        .map_err(|_| "MIDI queue lock poisoned".to_string())?
        .audit_snapshot();
    let (native_action, native_processing) = native_snapshots();
    Ok(PerfAuditSnapshot {
        schema_version: 1,
        run_id: audit_identity("MIDIMASTER_PERF_RUN_ID", "manual"),
        scenario_id: audit_identity("MIDIMASTER_PERF_SCENARIO_ID", "manual"),
        variant: audit_identity("MIDIMASTER_PERF_VARIANT", "current"),
        network_mode: audit_identity("MIDIMASTER_PERF_NETWORK_MODE", "online"),
        active_profile,
        active_binding_count,
        queue,
        native_action,
        native_processing,
        latest_value: convergence_snapshot(),
    })
}

#[tauri::command]
pub(crate) fn perf_audit_reset(state: State<AppState>) -> Result<(), String> {
    state
        .midi_event_queue
        .lock()
        .map_err(|_| "MIDI queue lock poisoned".to_string())?
        .audit_reset();
    state
        .binding_state
        .lock()
        .map_err(|_| "Binding state lock poisoned".to_string())?
        .clear();
    state
        .feedback_values
        .lock()
        .map_err(|_| "Feedback state lock poisoned".to_string())?
        .clear();
    state
        .binding_action_values
        .lock()
        .map_err(|_| "Action state lock poisoned".to_string())?
        .clear();
    if let Ok(mut metrics) = native_metrics().lock() {
        metrics.processing_durations_us.clear();
        metrics.enqueue_to_action_us.clear();
        metrics.pending_latest.clear();
        metrics.pending_preserved.clear();
        metrics.expected_latest.clear();
        metrics.observed_latest.clear();
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn perf_audit_inject_midi(
    state: State<'_, AppState>,
    message_count: u64,
    rate_per_second: u32,
    control_count: u8,
    message_kind: String,
) -> Result<PerfAuditInjectionResult, String> {
    if message_count == 0 || message_count > MAX_INJECTED_MESSAGES {
        return Err(format!(
            "message_count must be between 1 and {MAX_INJECTED_MESSAGES}"
        ));
    }
    if !(1..=10_000).contains(&rate_per_second) {
        return Err("rate_per_second must be between 1 and 10000".to_string());
    }
    if !(1..=16).contains(&control_count) {
        return Err("control_count must be between 1 and 16".to_string());
    }
    let normalized_kind = message_kind.trim().to_ascii_lowercase();
    if !matches!(normalized_kind.as_str(), "continuous" | "button" | "action") {
        return Err("message_kind must be continuous, button, or action".to_string());
    }

    let started = Instant::now();
    let tick = Duration::from_secs_f64(1.0 / rate_per_second as f64);
    for sequence in 0..message_count {
        if sequence > 0 {
            let deadline = tokio::time::Instant::from_std(started + tick.mul_f64(sequence as f64));
            tokio::time::sleep_until(deadline).await;
        }
        let control_index = (sequence % control_count as u64) as u8;
        let (msg_type, value) = match normalized_kind.as_str() {
            "button" => (
                MidiMessageType::Note,
                if sequence % 2 == 0 { 127 } else { 0 },
            ),
            "action" => (MidiMessageType::ProgramChange, 127),
            _ => (MidiMessageType::ControlChange, (sequence % 126 + 1) as u8),
        };
        let controller = match normalized_kind.as_str() {
            "button" => control_index.saturating_mul(8).saturating_add(4),
            "action" => control_index.saturating_mul(8),
            _ => control_index.saturating_mul(8).saturating_add(1),
        };
        let event = MidiEvent {
            device_id: "perf-midi-input".to_string(),
            channel: controller % 16,
            controller,
            value,
            value_14: None,
            msg_type,
        };
        record_midi_enqueue(&event);
        state
            .midi_event_queue
            .lock()
            .map_err(|_| "MIDI queue lock poisoned".to_string())?
            .enqueue(event);
        crate::background_tasks::notify_midi_event_queued();
    }

    let queue = state
        .midi_event_queue
        .lock()
        .map_err(|_| "MIDI queue lock poisoned".to_string())?
        .audit_snapshot();
    Ok(PerfAuditInjectionResult {
        schema_version: 1,
        message_count,
        rate_per_second,
        control_count,
        message_kind: normalized_kind,
        scheduled_duration_us: started.elapsed().as_micros().min(u64::MAX as u128) as u64,
        queue,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(msg_type: MidiMessageType, controller: u8, value: u8) -> MidiEvent {
        MidiEvent {
            device_id: "perf-midi-input".to_string(),
            channel: 0,
            controller,
            value,
            value_14: None,
            msg_type,
        }
    }

    #[test]
    fn percentiles_are_stable_for_empty_and_populated_samples() {
        assert_eq!(percentile(&[], 0.95), 0);
        assert_eq!(percentile(&[10, 20, 30, 40], 0.50), 30);
        assert_eq!(percentile(&[10, 20, 30, 40], 0.95), 40);
    }

    #[test]
    fn local_result_records_reject_invalid_metrics_and_nested_dimensions() {
        assert!(validate_result_metric("startup.bindings_usable"));
        assert!(!validate_result_metric("Startup Bindings"));
        assert!(
            scalar_dimensions(Some(serde_json::json!({ "window": "main", "count": 2 }))).is_ok()
        );
        assert!(scalar_dimensions(Some(serde_json::json!({ "nested": { "bad": true } }))).is_err());
    }

    #[test]
    fn enqueue_timing_tracks_latest_continuous_and_all_button_events() {
        *native_metrics().lock().expect("metrics") = NativeActionMetrics::default();
        let continuous = event(MidiMessageType::ControlChange, 1, 42);
        record_midi_enqueue(&continuous);
        record_midi_enqueue(&continuous);
        assert!(take_midi_enqueue(&continuous).is_some());
        assert!(take_midi_enqueue(&continuous).is_none());
        let continuous_snapshot = convergence_snapshot();
        assert_eq!(continuous_snapshot.controls, 1);
        assert_eq!(continuous_snapshot.mismatches, 0);
        assert!(continuous_snapshot.converged);

        let button = event(MidiMessageType::Note, 4, 127);
        record_midi_enqueue(&button);
        record_midi_enqueue(&button);
        assert!(take_midi_enqueue(&button).is_some());
        assert!(take_midi_enqueue(&button).is_some());
        assert!(take_midi_enqueue(&button).is_none());
        let final_snapshot = convergence_snapshot();
        assert_eq!(final_snapshot.controls, 2);
        assert_eq!(final_snapshot.mismatches, 0);
        assert!(final_snapshot.converged);
    }
}

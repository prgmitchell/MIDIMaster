use crate::midi_event_queue::MidiEventQueueAuditSnapshot;
use crate::AppState;
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

mod injection;
mod metrics;
mod synthetic;
use metrics::*;
pub(crate) use metrics::{
    annotate_result_payload, record_integration_dispatch, record_local_target_result,
    record_midi_enqueue, record_requested_targets, record_unverified_action, MidiActionScope,
    MidiEnqueueToken,
};
pub(crate) use synthetic::{apply_synthetic_integration, synthetic_targets_enabled};
use tauri::State;

const MAX_INJECTED_MESSAGES: u64 = 1_000_000;
static RESULT_WRITER: OnceLock<Mutex<()>> = OnceLock::new();

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
    queue_dispatch: NativeActionSnapshot,
    latest_value: MidiConvergenceSnapshot,
    dispatched_value: MidiConvergenceSnapshot,
    action_outcomes: ActionOutcomes,
    synthetic_targets: Vec<SyntheticTargetSnapshot>,
    synthetic_targets_enabled: bool,
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
    let native = native_snapshots();
    Ok(PerfAuditSnapshot {
        schema_version: 2,
        run_id: audit_identity("MIDIMASTER_PERF_RUN_ID", "manual"),
        scenario_id: audit_identity("MIDIMASTER_PERF_SCENARIO_ID", "manual"),
        variant: audit_identity("MIDIMASTER_PERF_VARIANT", "current"),
        network_mode: audit_identity("MIDIMASTER_PERF_NETWORK_MODE", "online"),
        active_profile,
        active_binding_count,
        queue,
        native_action: native.native_action,
        native_processing: native.native_processing,
        queue_dispatch: native.queue_dispatch,
        latest_value: native.latest_value,
        dispatched_value: native.dispatched_value,
        action_outcomes: native.action_outcomes,
        synthetic_targets: native.synthetic_targets,
        synthetic_targets_enabled: synthetic_targets_enabled(),
    })
}

#[tauri::command]
pub(crate) fn perf_audit_reset(state: State<AppState>) -> Result<(), String> {
    state.cancel_activity_button_light_holds();
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
    state
        .last_mute_input_active
        .lock()
        .map_err(|_| "Input state lock poisoned".to_string())?
        .clear();
    state
        .mute_transition_until
        .lock()
        .map_err(|_| "Mute transition lock poisoned".to_string())?
        .clear();
    state
        .last_target_mute_state
        .lock()
        .map_err(|_| "Mute state lock poisoned".to_string())?
        .clear();
    reset_metrics();
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
    if !matches!(
        normalized_kind.as_str(),
        "continuous" | "button" | "action" | "pitch_bend"
    ) {
        return Err("message_kind must be continuous, button, action, or pitch_bend".to_string());
    }

    let started = Instant::now();
    let tick = Duration::from_secs_f64(1.0 / rate_per_second as f64);
    for sequence in 0..message_count {
        if sequence > 0 {
            let deadline = tokio::time::Instant::from_std(started + tick.mul_f64(sequence as f64));
            tokio::time::sleep_until(deadline).await;
        }
        let event = injection::injected_event(sequence, control_count, &normalized_kind);
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
        schema_version: 2,
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

    #[test]
    fn local_result_records_reject_invalid_metrics_and_nested_dimensions() {
        assert!(validate_result_metric("startup.bindings_usable"));
        assert!(!validate_result_metric("Startup Bindings"));
        assert!(
            scalar_dimensions(Some(serde_json::json!({ "window": "main", "count": 2 }))).is_ok()
        );
        assert!(scalar_dimensions(Some(serde_json::json!({ "nested": { "bad": true } }))).is_err());
    }
}

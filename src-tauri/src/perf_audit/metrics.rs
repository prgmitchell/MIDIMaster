use crate::model::{MidiEvent, MidiMessageType};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_ACTION_SAMPLES: usize = 100_000;

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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct InputObservation {
    sequence: u64,
    value: u8,
    value_14: Option<u16>,
}

/// Carried by the actual queue entry, so replacements, identical values,
/// overflow and an enqueue during an older drain retain their own identity.
#[derive(Debug)]
pub(crate) struct MidiEnqueueToken {
    generation: u64,
    key: AuditMidiKey,
    input: InputObservation,
    pub(crate) at: Instant,
    enqueued_epoch_ms: f64,
}

#[derive(Default)]
struct NativeActionMetrics {
    generation: u64,
    next_sequence: u64,
    processing_us: Vec<u64>,
    dispatch_us: Vec<u64>,
    applied_us: Vec<u64>,
    expected: HashMap<AuditMidiKey, InputObservation>,
    dispatched: HashMap<AuditMidiKey, InputObservation>,
    applied: HashMap<AuditMidiKey, InputObservation>,
    outcomes: ActionOutcomes,
    synthetic_targets: HashMap<String, SyntheticTargetSnapshot>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub(super) struct ActionOutcomes {
    processed: u64,
    applied: u64,
    dispatched: u64,
    noop: u64,
    errors: u64,
    unverified: u64,
    applied_targets: u64,
    dispatched_targets: u64,
    failed_targets: u64,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct SyntheticTargetSnapshot {
    pub(super) binding_id: String,
    pub(super) target_id: String,
    pub(super) action: String,
    pub(super) value: f32,
    input: Option<InputObservation>,
}

#[derive(Default)]
struct ActionTrace {
    requested: u64,
    applied: u64,
    dispatched: u64,
    errors: u64,
    unverified: bool,
    last_applied: Option<Instant>,
    synthetic_targets: Vec<SyntheticTargetSnapshot>,
    identity: Option<serde_json::Value>,
    enqueued_at: Option<Instant>,
}

thread_local! {
    // Runtime MIDI target execution is synchronous. Async plugin completion
    // deliberately cannot inherit this scope or masquerade as local success.
    static ACTIVE_ACTION: RefCell<Option<ActionTrace>> = const { RefCell::new(None) };
}

fn native_metrics() -> &'static Mutex<NativeActionMetrics> {
    static METRICS: OnceLock<Mutex<NativeActionMetrics>> = OnceLock::new();
    METRICS.get_or_init(|| Mutex::new(NativeActionMetrics::default()))
}

impl NativeActionMetrics {
    fn enqueue(&mut self, event: &MidiEvent, at: Instant) -> MidiEnqueueToken {
        let input = InputObservation {
            sequence: self.next_sequence,
            value: event.value,
            value_14: event.value_14,
        };
        self.next_sequence = self.next_sequence.wrapping_add(1);
        let key = AuditMidiKey::from(event);
        self.expected.insert(key.clone(), input.clone());
        MidiEnqueueToken {
            generation: self.generation,
            key,
            input,
            at,
            enqueued_epoch_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64()
                * 1000.0,
        }
    }

    fn dispatch(&mut self, token: &MidiEnqueueToken, at: Instant) {
        if token.generation != self.generation {
            return;
        }
        self.dispatched
            .insert(token.key.clone(), token.input.clone());
        push_bounded(
            &mut self.dispatch_us,
            at.saturating_duration_since(token.at),
        );
    }

    fn finish(
        &mut self,
        token: &MidiEnqueueToken,
        trace: ActionTrace,
        processing: Duration,
        failed: bool,
    ) {
        if token.generation != self.generation {
            return;
        }
        push_bounded(&mut self.processing_us, processing);
        self.outcomes.processed += 1;
        self.outcomes.applied_targets += trace.applied;
        self.outcomes.dispatched_targets += trace.dispatched;
        self.outcomes.failed_targets += trace.errors;
        let fully_applied = trace.fully_applied(failed);
        if failed || trace.errors > 0 {
            self.outcomes.errors += 1;
        } else if trace.unverified || (trace.applied > 0 && trace.applied < trace.requested) {
            self.outcomes.unverified += 1;
        } else if trace.dispatched > 0 {
            self.outcomes.dispatched += 1;
        } else if fully_applied {
            self.outcomes.applied += 1;
        } else {
            self.outcomes.noop += 1;
        }
        if fully_applied {
            self.applied.insert(token.key.clone(), token.input.clone());
            if let Some(at) = trace.last_applied {
                push_bounded(&mut self.applied_us, at.saturating_duration_since(token.at));
            }
        }
        for mut target in trace.synthetic_targets {
            target.input = Some(token.input.clone());
            self.synthetic_targets.insert(
                format!("{}:{}", target.binding_id, target.target_id),
                target,
            );
        }
    }

    fn snapshot(&self) -> NativeSnapshots {
        let mut synthetic_targets: Vec<_> = self.synthetic_targets.values().cloned().collect();
        synthetic_targets
            .sort_by(|a, b| (&a.binding_id, &a.target_id).cmp(&(&b.binding_id, &b.target_id)));
        NativeSnapshots {
            native_action: duration_snapshot(self.applied_us.clone()),
            native_processing: duration_snapshot(self.processing_us.clone()),
            queue_dispatch: duration_snapshot(self.dispatch_us.clone()),
            latest_value: convergence_snapshot(&self.expected, &self.applied, false),
            dispatched_value: convergence_snapshot(&self.expected, &self.dispatched, true),
            action_outcomes: self.outcomes.clone(),
            synthetic_targets,
        }
    }
}

pub(crate) fn record_midi_enqueue(event: &MidiEvent) -> MidiEnqueueToken {
    native_metrics()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .enqueue(event, Instant::now())
}

pub(crate) struct MidiActionScope {
    token: MidiEnqueueToken,
    started: Instant,
}

impl MidiActionScope {
    pub(crate) fn begin(token: MidiEnqueueToken, dispatched_at: Instant) -> Self {
        let started = Instant::now();
        if let Ok(mut metrics) = native_metrics().lock() {
            metrics.dispatch(&token, dispatched_at);
        }
        ACTIVE_ACTION.with(|active| {
            *active.borrow_mut() = Some(ActionTrace {
                identity: Some(token.identity()),
                enqueued_at: Some(token.at),
                ..Default::default()
            })
        });
        Self { token, started }
    }

    pub(crate) fn finish(self, failed: bool) -> serde_json::Value {
        let trace = ACTIVE_ACTION
            .with(|active| active.borrow_mut().take())
            .unwrap_or_default();
        let processing = self.started.elapsed();
        let mut outcome = self.token.identity();
        outcome["outcome"] = serde_json::json!(if failed || trace.errors > 0 {
            "error"
        } else if trace.unverified || (trace.applied > 0 && trace.applied < trace.requested) {
            "unverified"
        } else if trace.dispatched > 0 {
            "dispatched"
        } else if trace.fully_applied(false) {
            "applied"
        } else {
            "noop"
        });
        outcome["processing_us"] =
            serde_json::json!(processing.as_micros().min(u64::MAX as u128) as u64);
        outcome["enqueue_to_applied_us"] = serde_json::json!(trace
            .fully_applied(failed)
            .then(|| trace.last_applied.map(|at| at
                .saturating_duration_since(self.token.at)
                .as_micros()
                .min(u64::MAX as u128) as u64))
            .flatten());
        if let Ok(mut metrics) = native_metrics().lock() {
            metrics.finish(&self.token, trace, processing, failed);
        }
        outcome
    }
}

impl MidiEnqueueToken {
    pub(crate) fn identity(&self) -> serde_json::Value {
        serde_json::json!({ "device_id": self.key.device_id, "channel": self.key.channel,
            "controller": self.key.controller, "msg_type": self.key.msg_type,
            "sequence": self.input.sequence, "value": self.input.value, "value_14": self.input.value_14,
            "enqueued_epoch_ms": self.enqueued_epoch_ms })
    }
}

impl ActionTrace {
    fn fully_applied(&self, failed: bool) -> bool {
        !failed
            && self.errors == 0
            && self.dispatched == 0
            && !self.unverified
            && self.applied > 0
            && self.applied >= self.requested
    }
}

pub(crate) fn annotate_result_payload(payload: &mut serde_json::Value) {
    ACTIVE_ACTION.with(|active| {
        if let Some(trace) = active.borrow().as_ref() {
            if let Some(mut identity) = trace.identity.clone() {
                identity["applied"] = serde_json::json!(trace.fully_applied(false));
                identity["enqueue_to_emit_us"] = serde_json::json!(trace.enqueued_at.map(|at| at
                    .elapsed()
                    .as_micros()
                    .min(u64::MAX as u128)
                    as u64));
                payload["perf_audit"] = identity;
            }
        }
    });
}

pub(crate) fn record_requested_targets(count: usize) {
    update_trace(|trace| trace.requested += count as u64);
}

fn update_trace(update: impl FnOnce(&mut ActionTrace)) {
    ACTIVE_ACTION.with(|active| {
        if let Some(trace) = active.borrow_mut().as_mut() {
            update(trace);
        }
    });
}

pub(crate) fn record_local_target_result(success: bool) {
    update_trace(|trace| {
        if success {
            trace.applied += 1;
            trace.last_applied = Some(Instant::now());
        } else {
            trace.errors += 1;
        }
    });
}

pub(crate) fn record_integration_dispatch(target_count: usize, success: bool) {
    update_trace(|trace| {
        if success {
            trace.dispatched += target_count as u64;
        } else {
            trace.errors += target_count as u64;
        }
    });
}

pub(crate) fn record_unverified_action() {
    update_trace(|trace| trace.unverified = true);
}

pub(super) fn record_synthetic_target(binding_id: &str, target_id: &str, action: &str, value: f32) {
    update_trace(|trace| {
        trace.applied += 1;
        trace.last_applied = Some(Instant::now());
        trace.synthetic_targets.push(SyntheticTargetSnapshot {
            binding_id: binding_id.to_string(),
            target_id: target_id.to_string(),
            action: action.to_string(),
            value,
            input: None,
        });
    });
}

pub(super) fn reset_metrics() {
    if let Ok(mut metrics) = native_metrics().lock() {
        let generation = metrics.generation.wrapping_add(1);
        *metrics = NativeActionMetrics {
            generation,
            ..Default::default()
        };
    }
}

pub(super) fn native_snapshots() -> NativeSnapshots {
    native_metrics()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .snapshot()
}

#[derive(Debug, Serialize)]
pub(super) struct NativeActionSnapshot {
    samples: usize,
    p50_us: Option<u64>,
    p95_us: Option<u64>,
    p99_us: Option<u64>,
    max_us: Option<u64>,
}

#[derive(Debug, Serialize)]
pub(super) struct MidiConvergenceSnapshot {
    controls: usize,
    mismatches: usize,
    converged: bool,
}

pub(super) struct NativeSnapshots {
    pub(super) native_action: NativeActionSnapshot,
    pub(super) native_processing: NativeActionSnapshot,
    pub(super) queue_dispatch: NativeActionSnapshot,
    pub(super) latest_value: MidiConvergenceSnapshot,
    pub(super) dispatched_value: MidiConvergenceSnapshot,
    pub(super) action_outcomes: ActionOutcomes,
    pub(super) synthetic_targets: Vec<SyntheticTargetSnapshot>,
}

fn push_bounded(samples: &mut Vec<u64>, duration: Duration) {
    if samples.len() >= MAX_ACTION_SAMPLES {
        samples.drain(..MAX_ACTION_SAMPLES / 10);
    }
    samples.push(duration.as_micros().min(u64::MAX as u128) as u64);
}

fn percentile(sorted: &[u64], percentile: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let index = ((sorted.len() - 1) as f64 * percentile).ceil() as usize;
    Some(sorted[index.min(sorted.len() - 1)])
}

fn duration_snapshot(mut samples: Vec<u64>) -> NativeActionSnapshot {
    samples.sort_unstable();
    NativeActionSnapshot {
        samples: samples.len(),
        p50_us: percentile(&samples, 0.50),
        p95_us: percentile(&samples, 0.95),
        p99_us: percentile(&samples, 0.99),
        max_us: samples.last().copied(),
    }
}

fn convergence_snapshot(
    expected: &HashMap<AuditMidiKey, InputObservation>,
    observed: &HashMap<AuditMidiKey, InputObservation>,
    require_sequence: bool,
) -> MidiConvergenceSnapshot {
    let mismatches = expected
        .iter()
        .filter(|(key, expected)| {
            !observed.get(*key).is_some_and(|observed| {
                observed.value == expected.value
                    && observed.value_14 == expected.value_14
                    && (!require_sequence || observed.sequence == expected.sequence)
            })
        })
        .count();
    MidiConvergenceSnapshot {
        controls: expected.len(),
        mismatches,
        converged: !expected.is_empty() && mismatches == 0,
    }
}

#[cfg(test)]
#[path = "metrics_tests.rs"]
mod tests;

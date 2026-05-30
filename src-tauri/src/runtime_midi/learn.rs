use crate::model::{self, LearnedControl, MidiEvent};
use crate::run_logger;
use crate::runtime_helpers::{cc_learn_value_is_definitely_continuous, LearnCandidate};
use crate::AppState;
use std::time::Instant;

pub(super) fn handle_learn_event(state: &AppState, event: &MidiEvent) -> Result<bool, String> {
    let mut learn_pending = state.learn_pending.lock().map_err(|_| "Lock poisoned")?;
    if !*learn_pending {
        return Ok(false);
    }

    run_logger::debug(
        "learn",
        "event_received",
        &format!(
            "device_id={} channel={} controller={} value={} msg_type={:?}",
            event.device_id, event.channel, event.controller, event.value, event.msg_type
        ),
    );
    let msg_type = event.msg_type.clone();
    let base_learned = LearnedControl {
        device_id: event.device_id.clone(),
        channel: event.channel,
        controller: event.controller,
        msg_type: msg_type.clone(),
        control_kind: model::BindingControlKind::Auto,
    };

    if matches!(msg_type, model::MidiMessageType::Note) {
        if let Ok(mut candidate_guard) = state.learn_candidate.lock() {
            let now = Instant::now();
            *candidate_guard = Some(LearnCandidate {
                control: base_learned,
                last_seen_at: now,
                saw_zero: event.value == 0,
                saw_max: event.value == 127,
            });
        }
        return Ok(true);
    }

    if matches!(msg_type, model::MidiMessageType::PitchBend) {
        let mut learned = base_learned.clone();
        learned.control_kind = model::BindingControlKind::Continuous;
        run_logger::info(
            "learn",
            "pitch_bend_classified",
            &format!(
                "device_id={} channel={} controller={} control_kind={:?}",
                learned.device_id, learned.channel, learned.controller, learned.control_kind
            ),
        );
        *learn_pending = false;
        drop(learn_pending);
        if let Ok(mut candidate) = state.learn_candidate.lock() {
            *candidate = None;
        }
        *state.learned_control.lock().map_err(|_| "Lock poisoned")? = Some(learned);
        return Ok(true);
    }

    if cc_learn_value_is_definitely_continuous(event.value) {
        let mut learned = base_learned.clone();
        learned.control_kind = model::BindingControlKind::Continuous;
        run_logger::info(
            "learn",
            "cc_continuous_classified",
            &format!(
                "device_id={} channel={} controller={} value={} control_kind={:?}",
                learned.device_id,
                learned.channel,
                learned.controller,
                event.value,
                learned.control_kind
            ),
        );
        *learn_pending = false;
        drop(learn_pending);
        if let Ok(mut candidate) = state.learn_candidate.lock() {
            *candidate = None;
        }
        *state.learned_control.lock().map_err(|_| "Lock poisoned")? = Some(learned);
        return Ok(true);
    }

    if let Ok(mut candidate_guard) = state.learn_candidate.lock() {
        let now = Instant::now();
        let is_zero = event.value == 0;
        let is_max = event.value == 127;
        match candidate_guard.as_mut() {
            Some(candidate)
                if candidate.control.device_id == base_learned.device_id
                    && candidate.control.channel == base_learned.channel
                    && candidate.control.controller == base_learned.controller
                    && candidate.control.msg_type == base_learned.msg_type =>
            {
                candidate.last_seen_at = now;
                candidate.saw_zero |= is_zero;
                candidate.saw_max |= is_max;
            }
            _ => {
                *candidate_guard = Some(LearnCandidate {
                    control: base_learned,
                    last_seen_at: now,
                    saw_zero: is_zero,
                    saw_max: is_max,
                });
            }
        }
    }
    Ok(true)
}

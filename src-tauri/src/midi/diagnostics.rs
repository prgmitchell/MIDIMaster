use super::*;

pub(super) fn log_midi_input_if_needed(event: &MidiEvent, raw_message: &[u8]) {
    let raw_value = event.value_14.unwrap_or(event.value as u16);
    let max_value = diagnostic_max_value(&event.msg_type);
    let key = MidiDiagnosticKey {
        route: event.device_id.clone(),
        channel: event.channel,
        controller: event.controller,
        msg_type: event.msg_type.clone(),
    };
    let Some(reason) = diagnostic_log_reason(&INPUT_DIAGNOSTICS, key, raw_value, max_value) else {
        return;
    };

    let value_14 = event
        .value_14
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_string());
    run_logger::debug(
        "midi",
        "input_observed",
        &format!(
            "reason={} device_id={} channel={} controller={} value={} value_14={} msg_type={:?} bytes_hex={}",
            reason,
            event.device_id,
            event.channel,
            event.controller,
            event.value,
            value_14,
            event.msg_type,
            format_midi_bytes(raw_message)
        ),
    );
}

pub(super) fn log_feedback_sent_if_needed(
    input_device_id: &str,
    output_device_id: &str,
    channel: u8,
    controller: u8,
    msg_type: &MidiMessageType,
    feedback: &FeedbackMessage,
) {
    let key = MidiDiagnosticKey {
        route: format!("{}->{}", input_device_id, output_device_id),
        channel: feedback.physical_channel,
        controller: feedback.physical_controller,
        msg_type: feedback.physical_msg_type.clone(),
    };
    let Some(reason) = diagnostic_log_reason(
        &FEEDBACK_DIAGNOSTICS,
        key,
        feedback.physical_raw_midi_value,
        diagnostic_max_value(&feedback.physical_msg_type),
    ) else {
        return;
    };

    run_logger::debug(
        "midi",
        "feedback_sent_bytes",
        &format!(
            "reason={} feedback_protocol={} input_device_id={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={}",
            reason,
            feedback.protocol,
            input_device_id,
            output_device_id,
            channel,
            controller,
            msg_type,
            feedback.physical_channel,
            feedback.physical_controller,
            feedback.physical_msg_type,
            feedback.normalized_value,
            feedback.logical_raw_midi_value,
            feedback.physical_raw_midi_value,
            format_midi_bytes(&feedback.logical_bytes),
            format_midi_bytes(&feedback.physical_bytes)
        ),
    );
}

pub(super) fn diagnostic_log_reason(
    diagnostics: &OnceLock<Mutex<HashMap<MidiDiagnosticKey, MidiDiagnosticState>>>,
    key: MidiDiagnosticKey,
    raw_value: u16,
    max_value: u16,
) -> Option<&'static str> {
    let now = Instant::now();
    let mut map = diagnostics
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    let Some(state) = map.get_mut(&key) else {
        map.insert(
            key,
            MidiDiagnosticState {
                last_seen_value: raw_value,
                last_logged_value: raw_value,
                last_logged_at: now,
            },
        );
        return Some("first");
    };

    if state.last_seen_value == raw_value {
        return None;
    }
    state.last_seen_value = raw_value;

    let endpoint = raw_value == 0 || raw_value == max_value;
    let significant_change =
        raw_value.abs_diff(state.last_logged_value) >= diagnostic_significant_delta(max_value);
    let interval_elapsed =
        state.last_logged_at.elapsed().as_millis() >= MIDI_DIAGNOSTIC_MIN_INTERVAL_MS;
    let reason = if endpoint {
        Some("endpoint")
    } else if significant_change || interval_elapsed {
        Some("change")
    } else {
        None
    };

    if reason.is_some() {
        state.last_logged_value = raw_value;
        state.last_logged_at = now;
    }
    reason
}

pub(super) fn diagnostic_max_value(msg_type: &MidiMessageType) -> u16 {
    match msg_type {
        MidiMessageType::PitchBend => 16383,
        MidiMessageType::ControlChange | MidiMessageType::Note | MidiMessageType::ProgramChange => {
            127
        }
    }
}

pub(super) fn diagnostic_significant_delta(max_value: u16) -> u16 {
    if max_value > 127 {
        1024
    } else {
        8
    }
}

pub(super) fn format_midi_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{:02X}", byte))
        .collect::<Vec<_>>()
        .join("-")
}

pub(super) fn should_log_empty_enumeration(
    state: &mut EmptyEnumerationLogState,
    now: Instant,
    interval: Duration,
) -> bool {
    if !state.empty_since_last_non_empty {
        state.empty_since_last_non_empty = true;
        state.last_logged_at = Some(now);
        return true;
    }

    let elapsed = state
        .last_logged_at
        .map(|last| now.duration_since(last))
        .unwrap_or(interval);
    if elapsed >= interval {
        state.last_logged_at = Some(now);
        return true;
    }

    false
}

pub(super) fn should_log_reconnect_skipped(
    last_logged_at: &mut Option<Instant>,
    now: Instant,
    interval: Duration,
) -> bool {
    let elapsed = last_logged_at
        .map(|last| now.duration_since(last))
        .unwrap_or(interval);
    if elapsed >= interval {
        *last_logged_at = Some(now);
        return true;
    }

    false
}

pub(super) fn note_non_empty_enumeration(state: &mut EmptyEnumerationLogState) {
    state.empty_since_last_non_empty = false;
    state.last_logged_at = None;
}

pub(super) fn log_empty_input_enumeration_if_needed() {
    let slot = EMPTY_INPUT_ENUMERATION_LOG_STATE
        .get_or_init(|| Mutex::new(EmptyEnumerationLogState::default()));
    let Ok(mut state) = slot.lock() else {
        return;
    };
    if should_log_empty_enumeration(
        &mut state,
        Instant::now(),
        EMPTY_INPUT_ENUMERATION_LOG_INTERVAL,
    ) {
        run_logger::warn(
            "midi",
            "input_enumeration_empty",
            "retrying input enumeration",
        );
    }
}

pub(super) fn note_non_empty_input_enumeration() {
    let slot = EMPTY_INPUT_ENUMERATION_LOG_STATE
        .get_or_init(|| Mutex::new(EmptyEnumerationLogState::default()));
    if let Ok(mut state) = slot.lock() {
        note_non_empty_enumeration(&mut state);
    }
}

pub(super) fn now_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

pub(super) fn atomic_millis_to_option(value: &AtomicU64) -> Option<u64> {
    match value.load(Ordering::Relaxed) {
        0 => None,
        millis => Some(millis),
    }
}

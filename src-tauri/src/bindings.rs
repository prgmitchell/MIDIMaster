use crate::model::{Binding, MidiEvent, MidiMode, Profile, RelativeFormat};
use std::time::{Duration, Instant};

const RELATIVE_STEP: f32 = 0.02;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BindingKey {
    pub device_id: String,
    pub channel: u8,
    pub controller: u8,
    pub msg_type: crate::model::MidiMessageType,
}

#[derive(Debug, Clone)]
pub struct BindingState {
    pub last_value: f32,
    pub last_update: Instant,
    pub relative_auto_format: Option<RelativeFormat>,
    pub relative_seen_midpoint: bool,
    pub relative_seen_sign_band: bool,
    pub relative_seen_high_negative: bool,
    pub relative_seen_low_negative_hint: bool,
}

impl BindingKey {
    pub fn from_event(event: &MidiEvent) -> Self {
        Self {
            device_id: event.device_id.clone(),
            channel: event.channel,
            controller: event.controller,
            msg_type: event.msg_type.clone(),
        }
    }

    pub fn from_binding(binding: &Binding) -> Self {
        Self {
            device_id: binding.device_id.clone(),
            channel: binding.control.channel,
            controller: binding.control.controller,
            msg_type: binding.control.msg_type.clone(),
        }
    }
}

pub fn find_binding<'a>(profile: &'a Profile, key: &BindingKey) -> Option<&'a Binding> {
    if let Some(exact) = profile
        .bindings
        .iter()
        .find(|binding| BindingKey::from_binding(binding) == *key)
    {
        return Some(exact);
    }

    // Back-compat fallback for profiles saved with a stale MIDI device id.
    // If exactly one binding matches channel+controller, use it.
    // This keeps older bindings functional after device index changes.
    let mut fallback = profile.bindings.iter().filter(|binding| {
        binding.control.channel == key.channel
            && binding.control.controller == key.controller
            && binding.control.msg_type == key.msg_type
    });

    let first = fallback.next()?;
    if fallback.next().is_none() {
        Some(first)
    } else {
        None
    }
}

pub fn apply_midi_event(
    binding: &Binding,
    event: &MidiEvent,
    state: &mut BindingState,
) -> Option<f32> {
    let now = Instant::now();
    if binding.debounce_ms > 0 {
        let debounce = Duration::from_millis(binding.debounce_ms);
        if now.duration_since(state.last_update) < debounce {
            return None;
        }
    }

    let next_value = match binding.mode {
        MidiMode::Absolute => absolute_value(binding, event)?,
        MidiMode::Relative => {
            let delta = relative_delta(binding, event.value, state)?;
            (state.last_value + (delta as f32 * RELATIVE_STEP)).clamp(0.0, 1.0)
        }
    };

    if binding.deadzone > 0.0 && (next_value - state.last_value).abs() < binding.deadzone {
        return None;
    }

    state.last_value = next_value;
    state.last_update = now;
    Some(next_value)
}

fn absolute_value(binding: &Binding, event: &MidiEvent) -> Option<f32> {
    if binding.control.controller == 0xE0 {
        let value_14 = event.value_14?;
        return Some((value_14 as f32) / 16383.0);
    }
    Some((event.value as f32) / 127.0)
}

fn relative_delta(binding: &Binding, value: u8, state: &mut BindingState) -> Option<i8> {
    // Relative format is backend-auto-detected only for now.
    let _ = binding;
    if state.relative_auto_format.is_none() {
        update_auto_relative_detection(value, state);
    }
    if let Some(detected) = &state.relative_auto_format {
        return decode_relative_delta(detected, value);
    }
    decode_relative_delta_auto_fallback(value, state.relative_seen_midpoint)
}

fn update_auto_relative_detection(value: u8, state: &mut BindingState) {
    match value {
        63 => state.relative_seen_low_negative_hint = true,
        64 => state.relative_seen_midpoint = true,
        65..=95 => state.relative_seen_sign_band = true,
        96..=127 => state.relative_seen_high_negative = true,
        _ => {}
    }

    state.relative_auto_format = if state.relative_seen_high_negative {
        // High negative-band values strongly indicate two's-complement
        // (e.g. 127 == -1 on many endless encoders/faders).
        Some(RelativeFormat::TwosComplement)
    } else if state.relative_seen_low_negative_hint {
        // 63 is a common "-1" marker in binary offset mode.
        Some(RelativeFormat::BinaryOffset)
    } else if state.relative_seen_midpoint && state.relative_seen_sign_band {
        // Seeing midpoint + 65..95 usually indicates binary-offset style data.
        Some(RelativeFormat::BinaryOffset)
    } else if state.relative_seen_sign_band {
        // 65..95 without midpoint is most often sign-magnitude.
        Some(RelativeFormat::SignMagnitude)
    } else {
        None
    };
}

fn decode_relative_delta_auto_fallback(value: u8, saw_midpoint: bool) -> Option<i8> {
    match value {
        0 | 64 => Some(0),
        1..=62 => Some(value as i8),
        // Keep this safe for binary-offset controllers even before auto-lock.
        63 => Some(-1),
        // 127 is the problematic "down one" token for many two's-complement devices.
        96..=127 => Some((value as i16 - 128) as i8),
        65..=95 if saw_midpoint => Some((value - 64) as i8),
        65..=95 => Some(-((value - 64) as i8)),
        _ => None,
    }
}

fn decode_relative_delta(format: &RelativeFormat, value: u8) -> Option<i8> {
    match format {
        RelativeFormat::Auto => None,
        RelativeFormat::TwosComplement => decode_twos_complement(value),
        RelativeFormat::BinaryOffset => decode_binary_offset(value),
        RelativeFormat::SignMagnitude => decode_sign_magnitude(value),
    }
}

fn decode_twos_complement(value: u8) -> Option<i8> {
    match value {
        0 | 64 => Some(0),
        1..=63 => Some(value as i8),
        65..=127 => Some((value as i16 - 128) as i8),
        _ => None,
    }
}

fn decode_binary_offset(value: u8) -> Option<i8> {
    match value {
        0 | 64 => Some(0),
        1..=63 => Some(-((64 - value) as i8)),
        65..=127 => Some((value - 64) as i8),
        _ => None,
    }
}

fn decode_sign_magnitude(value: u8) -> Option<i8> {
    match value {
        0 | 64 => Some(0),
        1..=63 => Some(value as i8),
        65..=127 => Some(-((value - 64) as i8)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        BindingAction, BindingControlKind, BindingTarget, MidiControl, MidiMessageType,
    };

    fn sample_binding(mode: MidiMode, relative_format: RelativeFormat) -> Binding {
        Binding {
            id: "test-binding".to_string(),
            name: "Test".to_string(),
            device_id: "midi:0".to_string(),
            control: MidiControl {
                channel: 0,
                controller: 1,
                msg_type: MidiMessageType::ControlChange,
            },
            control_kind: BindingControlKind::Continuous,
            targets: vec![BindingTarget::Master],
            target: BindingTarget::Master,
            action: BindingAction::Volume,
            mode,
            relative_format,
            deadzone: 0.0,
            debounce_ms: 0,
            mute_control: None,
            assign_control: None,
            assign_mode: crate::model::AssignMode::Add,
        }
    }

    fn sample_state(last_value: f32) -> BindingState {
        BindingState {
            last_value,
            last_update: Instant::now()
                .checked_sub(Duration::from_secs(1))
                .unwrap_or_else(Instant::now),
            relative_auto_format: None,
            relative_seen_midpoint: false,
            relative_seen_sign_band: false,
            relative_seen_high_negative: false,
            relative_seen_low_negative_hint: false,
        }
    }

    fn sample_event(value: u8) -> MidiEvent {
        MidiEvent {
            device_id: "midi:0".to_string(),
            channel: 0,
            controller: 1,
            value,
            value_14: None,
            msg_type: MidiMessageType::ControlChange,
        }
    }

    #[test]
    fn relative_format_twos_complement_maps_single_step_down_from_127() {
        let binding = sample_binding(MidiMode::Relative, RelativeFormat::TwosComplement);
        let mut state = sample_state(0.5);
        let next = apply_midi_event(&binding, &sample_event(127), &mut state).expect("value");
        assert!((next - 0.48).abs() < 0.0001);
    }

    #[test]
    fn relative_format_binary_offset_maps_63_to_minus_one() {
        let binding = sample_binding(MidiMode::Relative, RelativeFormat::BinaryOffset);
        let mut state = sample_state(0.5);
        let next = apply_midi_event(&binding, &sample_event(63), &mut state).expect("value");
        assert!((next - 0.48).abs() < 0.0001);
    }

    #[test]
    fn relative_format_sign_magnitude_maps_65_to_minus_one() {
        let binding = sample_binding(MidiMode::Relative, RelativeFormat::SignMagnitude);
        let mut state = sample_state(0.5);
        let next = apply_midi_event(&binding, &sample_event(65), &mut state).expect("value");
        assert!((next - 0.48).abs() < 0.0001);
    }

    #[test]
    fn relative_auto_detect_uses_twos_for_127() {
        let binding = sample_binding(MidiMode::Relative, RelativeFormat::Auto);
        let mut state = sample_state(0.5);
        let next = apply_midi_event(&binding, &sample_event(127), &mut state).expect("value");
        assert!((next - 0.48).abs() < 0.0001);
        assert_eq!(
            state.relative_auto_format,
            Some(RelativeFormat::TwosComplement)
        );
    }
}

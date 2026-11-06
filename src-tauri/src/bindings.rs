use crate::model::{Binding, MidiEvent, MidiMode, RelativeFormat};
use std::time::{Duration, Instant};

const RELATIVE_STEP: f32 = 0.02;
const ABSOLUTE_CC_JITTER_STEP: i16 = 1;
const ABSOLUTE_CC_MOTION_WINDOW: Duration = Duration::from_millis(120);

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
    pub last_absolute_input: Option<u8>,
    pub absolute_input_direction: i8,
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

    if should_suppress_absolute_cc_jitter(binding, event, state, now) {
        return None;
    }

    let value_delta = (next_value - state.last_value).abs();
    if value_delta <= f32::EPSILON && !binding.is_button_binding() {
        return None;
    }

    if binding.deadzone > 0.0 && value_delta < binding.deadzone {
        return None;
    }

    state.last_value = next_value;
    state.last_update = now;
    Some(next_value)
}

fn should_suppress_absolute_cc_jitter(
    binding: &Binding,
    event: &MidiEvent,
    state: &mut BindingState,
    now: Instant,
) -> bool {
    if binding.deadzone > 0.0
        || binding.mode != MidiMode::Absolute
        || event.msg_type != crate::model::MidiMessageType::ControlChange
        || event.value_14.is_some()
        || binding.is_button_binding()
    {
        state.last_absolute_input = None;
        state.absolute_input_direction = 0;
        return false;
    }

    let input = event.value;
    let Some(previous) = state.last_absolute_input else {
        state.last_absolute_input = Some(input);
        state.absolute_input_direction = 0;
        return false;
    };

    let delta = i16::from(input) - i16::from(previous);
    if delta == 0 {
        if now.duration_since(state.last_update) >= ABSOLUTE_CC_MOTION_WINDOW {
            state.absolute_input_direction = 0;
        }
        return true;
    }

    let direction = delta.signum() as i8;
    let adjacent = delta.abs() <= ABSOLUTE_CC_JITTER_STEP;
    let continuing_motion = adjacent
        && state.absolute_input_direction == direction
        && now.duration_since(state.last_update) < ABSOLUTE_CC_MOTION_WINDOW;

    if !adjacent || continuing_motion {
        state.last_absolute_input = Some(input);
        state.absolute_input_direction = direction;
        return false;
    }

    // A single adjacent change after the fader has settled is indistinguishable
    // from analog noise. Hold it until movement travels beyond the jitter band.
    // A return to the accepted value never touches audio or the OSD.
    state.absolute_input_direction = 0;
    true
}

fn absolute_value(binding: &Binding, event: &MidiEvent) -> Option<f32> {
    if binding.control.controller == 0xE0 {
        let value_14 = event.value_14?;
        return Some(crate::fader_curve::apply_fader_curve(
            binding,
            (value_14 as f32) / 16383.0,
        ));
    }
    Some(crate::fader_curve::apply_fader_curve(
        binding,
        (event.value as f32) / 127.0,
    ))
}

fn relative_delta(binding: &Binding, value: u8, state: &mut BindingState) -> Option<i8> {
    if binding.relative_format != RelativeFormat::Auto {
        return decode_relative_delta(&binding.relative_format, value);
    }

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

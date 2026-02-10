use crate::model::{Binding, MidiEvent, MidiMode, Profile};
use std::time::{Duration, Instant};

const RELATIVE_STEP: f32 = 0.02;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BindingKey {
    pub device_id: String,
    pub channel: u8,
    pub controller: u8,
}

#[derive(Debug, Clone)]
pub struct BindingState {
    pub last_value: f32,
    pub last_update: Instant,
}

impl BindingKey {
    pub fn from_event(event: &MidiEvent) -> Self {
        Self {
            device_id: event.device_id.clone(),
            channel: event.channel,
            controller: event.controller,
        }
    }

    pub fn from_binding(binding: &Binding) -> Self {
        Self {
            device_id: binding.device_id.clone(),
            channel: binding.control.channel,
            controller: binding.control.controller,
        }
    }
}

pub fn find_binding<'a>(profile: &'a Profile, key: &BindingKey) -> Option<&'a Binding> {
    profile
        .bindings
        .iter()
        .find(|binding| BindingKey::from_binding(binding) == *key)
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
            let delta = relative_delta(event.value)?;
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

fn relative_delta(value: u8) -> Option<i8> {
    match value {
        0 | 64 => Some(0),
        1..=63 => Some(value as i8),
        65..=127 => Some(-((value - 64) as i8)),
        _ => None,
    }
}

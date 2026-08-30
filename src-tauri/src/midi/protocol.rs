use crate::fader_curve;
use crate::model::{
    AuxiliaryControl, Binding, BindingAction, MidiEvent, MidiMessageType, MidiMode,
};

#[derive(Debug, Clone, PartialEq)]
pub(super) struct FeedbackMessage {
    pub(super) logical_bytes: Vec<u8>,
    pub(super) logical_raw_midi_value: u16,
    pub(super) physical_bytes: Vec<u8>,
    pub(super) physical_messages: Vec<Vec<u8>>,
    pub(super) physical_channel: u8,
    pub(super) physical_controller: u8,
    pub(super) physical_msg_type: MidiMessageType,
    pub(super) physical_raw_midi_value: u16,
    pub(super) normalized_value: f32,
    pub(super) protocol: &'static str,
}

pub(super) struct BindingLightFeedbackSend {
    pub(super) device_id: String,
    pub(super) channel: u8,
    pub(super) controller: u8,
    pub(super) value: f32,
    pub(super) msg_type: MidiMessageType,
    pub(super) use_binding_protocol: bool,
}

fn primary_light_feedback_send(
    binding: &Binding,
    value: f32,
    use_binding_protocol: bool,
) -> BindingLightFeedbackSend {
    BindingLightFeedbackSend {
        device_id: binding.device_id.clone(),
        channel: binding.control.channel,
        controller: binding.control.controller,
        value,
        msg_type: binding.control.msg_type.clone(),
        use_binding_protocol,
    }
}

fn indicator_light_feedback_send(
    indicator: &AuxiliaryControl,
    value: f32,
) -> BindingLightFeedbackSend {
    BindingLightFeedbackSend {
        device_id: indicator.device_id.clone(),
        channel: indicator.channel,
        controller: indicator.controller,
        value,
        msg_type: indicator.msg_type.clone(),
        use_binding_protocol: false,
    }
}

fn light_feedback_send_matches_primary(send: &BindingLightFeedbackSend, binding: &Binding) -> bool {
    send.device_id == binding.device_id
        && send.channel == binding.control.channel
        && send.controller == binding.control.controller
        && send.msg_type == binding.control.msg_type
}

pub(super) fn binding_light_feedback_sends(
    binding: &Binding,
    value: f32,
) -> Vec<BindingLightFeedbackSend> {
    if !binding.feedback_enabled {
        return Vec::new();
    }
    let Some(indicator) = binding.indicator_feedback_control() else {
        return vec![primary_light_feedback_send(binding, value, true)];
    };
    let indicator_send = indicator_light_feedback_send(indicator, value);
    let should_suppress_primary = !light_feedback_send_matches_primary(&indicator_send, binding);
    let mut sends = vec![indicator_send];
    if should_suppress_primary {
        sends.push(primary_light_feedback_send(binding, 0.0, false));
    }
    sends
}

pub(super) fn binding_feedback_send(
    binding: &Binding,
    value: f32,
) -> Option<BindingLightFeedbackSend> {
    let physical_position = if !binding.is_button_binding() && binding.mode == MidiMode::Absolute {
        fader_curve::invert_fader_curve(binding, value)
    } else {
        value
    };
    binding_feedback_position_send(binding, physical_position)
}

pub(super) fn binding_feedback_position_send(
    binding: &Binding,
    physical_position: f32,
) -> Option<BindingLightFeedbackSend> {
    if !binding.feedback_enabled {
        return None;
    }
    if !binding.is_button_binding() {
        if let Some(output) = binding.custom_feedback_output_control() {
            return Some(indicator_light_feedback_send(output, physical_position));
        }
    }
    Some(primary_light_feedback_send(
        binding,
        physical_position,
        true,
    ))
}

#[derive(Debug, Clone, PartialEq)]
struct FeedbackBytes {
    bytes: Vec<u8>,
    messages: Vec<Vec<u8>>,
    channel: u8,
    controller: u8,
    msg_type: MidiMessageType,
    normalized_value: f32,
    raw_midi_value: u16,
}

pub(super) fn build_feedback_message(
    channel: u8,
    controller: u8,
    value: f32,
    msg_type: &MidiMessageType,
    binding: Option<&Binding>,
    output_device_name: &str,
) -> FeedbackMessage {
    let logical = build_direct_feedback_bytes(channel, controller, value, msg_type);
    if let Some(binding) = binding {
        if let Some(physical) =
            build_xtouch_mini_standard_feedback(binding, value, output_device_name)
        {
            return feedback_message(logical, physical, "xtouch_mini_standard_fan");
        }
        if let Some(physical) = build_xtouch_mc_vpot_feedback(binding, value, output_device_name) {
            return feedback_message(logical, physical, "xtouch_mc_vpot_fan");
        }
    }
    FeedbackMessage {
        logical_bytes: logical.bytes.clone(),
        logical_raw_midi_value: logical.raw_midi_value,
        physical_bytes: logical.bytes.clone(),
        physical_messages: logical.messages,
        physical_channel: logical.channel,
        physical_controller: logical.controller,
        physical_msg_type: logical.msg_type,
        physical_raw_midi_value: logical.raw_midi_value,
        normalized_value: logical.normalized_value,
        protocol: "direct",
    }
}

fn feedback_message(
    logical: FeedbackBytes,
    physical: FeedbackBytes,
    protocol: &'static str,
) -> FeedbackMessage {
    FeedbackMessage {
        logical_bytes: logical.bytes,
        logical_raw_midi_value: logical.raw_midi_value,
        physical_bytes: physical.bytes,
        physical_messages: physical.messages,
        physical_channel: physical.channel,
        physical_controller: physical.controller,
        physical_msg_type: physical.msg_type,
        physical_raw_midi_value: physical.raw_midi_value,
        normalized_value: logical.normalized_value,
        protocol,
    }
}

fn build_direct_feedback_bytes(
    channel: u8,
    controller: u8,
    value: f32,
    msg_type: &MidiMessageType,
) -> FeedbackBytes {
    let normalized_value = value.clamp(0.0, 1.0);
    let (bytes, physical_controller, raw_midi_value) = match msg_type {
        MidiMessageType::Note => {
            let raw = (normalized_value * 127.0).round() as u8;
            (
                vec![0x90 | (channel & 0x0F), controller, raw],
                controller,
                raw as u16,
            )
        }
        MidiMessageType::PitchBend => {
            let raw = (normalized_value * 16383.0).round() as u16;
            (
                vec![
                    0xE0 | (channel & 0x0F),
                    (raw & 0x7F) as u8,
                    ((raw >> 7) & 0x7F) as u8,
                ],
                0xE0,
                raw,
            )
        }
        MidiMessageType::ControlChange => {
            let raw = (normalized_value * 127.0).round() as u8;
            (
                vec![0xB0 | (channel & 0x0F), controller, raw],
                controller,
                raw as u16,
            )
        }
        MidiMessageType::ProgramChange => {
            let controller = controller & 0x7F;
            (
                vec![0xC0 | (channel & 0x0F), controller],
                controller,
                controller as u16,
            )
        }
    };
    FeedbackBytes {
        messages: vec![bytes.clone()],
        bytes,
        channel: channel & 0x0F,
        controller: physical_controller,
        msg_type: msg_type.clone(),
        normalized_value,
        raw_midi_value,
    }
}

fn build_xtouch_mini_standard_feedback(
    binding: &Binding,
    value: f32,
    output_device_name: &str,
) -> Option<FeedbackBytes> {
    if !output_device_name
        .to_ascii_uppercase()
        .contains("X-TOUCH MINI")
        || binding.action != BindingAction::Volume
        || binding.is_button_binding()
        || binding.control.msg_type != MidiMessageType::ControlChange
        || !(1..=8).contains(&binding.control.controller)
    {
        return None;
    }
    let normalized_value = value.clamp(0.0, 1.0);
    let channel = binding.control.channel & 0x0F;
    let status = 0xB0 | channel;
    let behavior_controller = binding.control.controller;
    let value_controller = behavior_controller + 8;
    let raw_midi_value = xtouch_mini_standard_ring_value(normalized_value);
    let value_message = vec![status, value_controller, raw_midi_value as u8];
    Some(FeedbackBytes {
        bytes: value_message.clone(),
        messages: vec![vec![status, behavior_controller, 2], value_message],
        channel,
        controller: value_controller,
        msg_type: MidiMessageType::ControlChange,
        normalized_value,
        raw_midi_value,
    })
}

fn build_xtouch_mc_vpot_feedback(
    binding: &Binding,
    value: f32,
    output_device_name: &str,
) -> Option<FeedbackBytes> {
    let normalized_name = output_device_name.to_ascii_uppercase();
    let is_xtouch = normalized_name.contains("X-TOUCH MINI")
        || normalized_name.contains("X-TOUCH-EXT")
        || normalized_name.contains("X-TOUCH EXTENDER");
    if !is_xtouch
        || binding.action != BindingAction::Volume
        || binding.mode != MidiMode::Relative
        || binding.control.msg_type != MidiMessageType::ControlChange
        || binding.control.channel != 0
        || !(16..=23).contains(&binding.control.controller)
    {
        return None;
    }
    let normalized_value = value.clamp(0.0, 1.0);
    let physical_controller = 48 + (binding.control.controller - 16);
    let raw_midi_value = xtouch_mc_vpot_fan_value(normalized_value);
    let bytes = vec![0xB0, physical_controller, raw_midi_value as u8];
    Some(FeedbackBytes {
        messages: vec![bytes.clone()],
        bytes,
        channel: 0,
        controller: physical_controller,
        msg_type: MidiMessageType::ControlChange,
        normalized_value,
        raw_midi_value,
    })
}

fn xtouch_mc_vpot_fan_value(normalized_value: f32) -> u16 {
    let value = normalized_value.clamp(0.0, 1.0);
    if value <= 0.0 {
        return 0;
    }
    0x20 | (value * 11.0).ceil().clamp(1.0, 11.0) as u16
}

fn xtouch_mini_standard_ring_value(normalized_value: f32) -> u16 {
    let value = normalized_value.clamp(0.0, 1.0);
    if value <= 0.0 {
        return 0;
    }
    (value * 13.0).ceil().clamp(1.0, 13.0) as u16
}

pub(super) fn send_feedback_messages<F, E>(
    messages: &[Vec<u8>],
    mut send: F,
) -> std::result::Result<(), E>
where
    F: FnMut(&[u8]) -> std::result::Result<(), E>,
{
    for message in messages {
        send(message)?;
    }
    Ok(())
}

pub(super) fn parse_midi_message(device_id: &str, message: &[u8]) -> Option<MidiEvent> {
    if message.is_empty() {
        return None;
    }
    let command = message[0] & 0xF0;
    let channel = message[0] & 0x0F;
    match command {
        0xB0 if message.len() >= 3 => Some(MidiEvent {
            device_id: device_id.to_string(),
            channel,
            controller: message[1],
            value: message[2],
            value_14: None,
            msg_type: MidiMessageType::ControlChange,
        }),
        0x90 | 0x80 if message.len() >= 3 => Some(MidiEvent {
            device_id: device_id.to_string(),
            channel,
            controller: message[1],
            value: if command == 0x80 { 0 } else { message[2] },
            value_14: None,
            msg_type: MidiMessageType::Note,
        }),
        0xC0 if message.len() >= 2 => Some(MidiEvent {
            device_id: device_id.to_string(),
            channel,
            controller: message[1],
            value: 127,
            value_14: None,
            msg_type: MidiMessageType::ProgramChange,
        }),
        0xE0 if message.len() >= 3 => {
            let value_14 = ((message[2] as u16) << 7) | message[1] as u16;
            Some(MidiEvent {
                device_id: device_id.to_string(),
                channel,
                controller: 0xE0,
                value: message[2],
                value_14: Some(value_14),
                msg_type: MidiMessageType::PitchBend,
            })
        }
        _ => None,
    }
}

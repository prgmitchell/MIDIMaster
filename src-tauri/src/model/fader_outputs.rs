use super::{AuxiliaryControl, Binding, FeedbackMode, MidiMessageType};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FaderOutputKind {
    Feedback,
    Led,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FaderOutput {
    pub id: String,
    pub kind: FaderOutputKind,
    pub control: AuxiliaryControl,
    #[serde(default = "super::control_types::default_feedback_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub feedback_mode: FeedbackMode,
}

impl Binding {
    pub fn uses_audio_feedback(&self) -> bool {
        self.has_led_feedback() && self.feedback_mode == FeedbackMode::AudioReactive
    }

    pub fn has_led_feedback(&self) -> bool {
        if self.is_button_binding() {
            return false;
        }
        if !self.led_enabled {
            let msg_type = self
                .custom_feedback_output_control()
                .map(|control| &control.msg_type)
                .unwrap_or(&self.control.msg_type);
            return self.feedback_enabled
                && self.feedback_mode == FeedbackMode::AudioReactive
                && matches!(
                    msg_type,
                    MidiMessageType::Note | MidiMessageType::ControlChange
                );
        }
        self.led_control.is_none() || self.led_feedback_control().is_some()
    }

    /// Optional LED output is independent of motor/value feedback. Never guess
    /// an LED address from the primary control or accept a motor's Pitch Bend.
    /// ChannelPressure selects a Mackie meter: channel 0, controller = strip 0–7.
    pub fn led_feedback_control(&self) -> Option<&AuxiliaryControl> {
        let led = self.led_control.as_ref()?;
        if !self.led_enabled
            || self.is_button_binding()
            || led.device_id.is_empty()
            || !matches!(
                led.msg_type,
                MidiMessageType::Note
                    | MidiMessageType::ControlChange
                    | MidiMessageType::ChannelPressure
            )
            || (led.msg_type == MidiMessageType::ChannelPressure
                && (led.channel != 0 || led.controller > 7))
        {
            return None;
        }
        let same_address = |control: &AuxiliaryControl| {
            led.device_id == control.device_id
                && led.channel == control.channel
                && led.controller == control.controller
                && led.msg_type == control.msg_type
        };
        let overlaps_value = self.feedback_enabled
            && self
                .custom_feedback_output_control()
                .map(same_address)
                .unwrap_or_else(|| {
                    led.device_id == self.device_id
                        && led.channel == self.control.channel
                        && led.controller == self.control.controller
                        && led.msg_type == self.control.msg_type
                });
        let overlaps_button = self
            .modifier_controls()
            .map(|(_, control, _)| control)
            .any(same_address);
        let overlaps_extra_value = self.additional_feedback_controls().any(same_address);
        (!overlaps_value && !overlaps_button && !overlaps_extra_value).then_some(led)
    }

    pub fn additional_feedback_controls(&self) -> impl Iterator<Item = &AuxiliaryControl> {
        self.additional_outputs.iter().filter_map(|output| {
            (output.enabled
                && output.kind == FaderOutputKind::Feedback
                && !self.is_button_binding()
                && !output.control.device_id.trim().is_empty()
                && output.control.channel < 16
                && output.control.controller < 128
                && matches!(
                    output.control.msg_type,
                    MidiMessageType::Note
                        | MidiMessageType::ControlChange
                        | MidiMessageType::PitchBend
                ))
            .then_some(&output.control)
        })
    }

    pub fn has_value_feedback(&self) -> bool {
        self.feedback_enabled || self.additional_feedback_controls().next().is_some()
    }

    pub fn has_any_led_feedback(&self) -> bool {
        self.has_led_feedback()
            || (!self.is_button_binding()
                && self
                    .additional_outputs
                    .iter()
                    .any(|output| output.enabled && output.kind == FaderOutputKind::Led))
    }

    /// Build independent LED views when the profile changes, never in the meter loop.
    /// The input key and targets stay shared; IDs separate smoothing/send caches.
    pub fn led_output_bindings(&self) -> Vec<Binding> {
        let mut outputs = vec![self.clone()];
        for output in &self.additional_outputs {
            if output.kind != FaderOutputKind::Led || !output.enabled || self.is_button_binding() {
                continue;
            }
            let mut view = self.clone();
            view.id = format!("{}:led:{}", self.id, output.id);
            view.led_enabled = true;
            view.led_control = Some(output.control.clone());
            view.feedback_mode = output.feedback_mode.clone();
            outputs.push(view);
        }
        outputs
    }

    /// Reuse ordinary output cleanup for additional value destinations.
    pub fn value_output_bindings(&self) -> Vec<Binding> {
        let mut primary = self.clone();
        primary.additional_outputs.clear();
        let mut outputs = vec![primary];
        for control in self.additional_feedback_controls() {
            let mut view = self.clone();
            view.additional_outputs.clear();
            view.feedback_enabled = true;
            view.indicator_control = Some(control.clone());
            view.id = format!(
                "{}:feedback:{}:{}:{}",
                self.id, control.device_id, control.channel, control.controller
            );
            outputs.push(view);
        }
        outputs
    }
}

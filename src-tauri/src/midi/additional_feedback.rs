use super::*;

pub(super) fn value_feedback_sends(
    binding: &Binding,
    value: f32,
    physical: bool,
) -> Vec<BindingLightFeedbackSend> {
    let position = if !physical
        && !binding.is_button_binding()
        && binding.mode == crate::model::MidiMode::Absolute
    {
        crate::fader_curve::invert_fader_curve(binding, value)
    } else {
        value
    };
    let mut sends: Vec<_> = binding_feedback_position_send(binding, position)
        .into_iter()
        .collect();
    sends.extend(
        binding
            .additional_feedback_controls()
            .map(|control| BindingLightFeedbackSend {
                device_id: control.device_id.clone(),
                channel: control.channel,
                controller: control.controller,
                msg_type: control.msg_type.clone(),
                value: position,
                use_binding_protocol: false,
            }),
    );
    sends
}

impl MidiManager {
    pub(super) fn send_value_feedback_outputs(
        &mut self,
        binding: &Binding,
        value: f32,
        physical: bool,
    ) -> Result<()> {
        let led_key = self.meter_feedback_key(binding, 0.0);
        let mut result = Ok(());
        for send in value_feedback_sends(binding, value, physical) {
            // Keep the existing automatic ring/meter address suppression for every destination.
            let overlaps_led = led_key.as_ref().is_some_and(|(led_output, led_messages)| {
                self.encoded_feedback_key(binding, &send).is_some_and(
                    |(value_output, value_messages)| {
                        *led_output == value_output
                            && led_messages.iter().any(|led| {
                                value_messages
                                    .iter()
                                    .any(|value| led.get(..2) == value.get(..2))
                            })
                    },
                )
            });
            if !overlaps_led {
                if let Err(error) = self.send_resolved_binding_feedback(binding, Some(send)) {
                    if result.is_ok() {
                        result = Err(error);
                    }
                }
            }
        }
        result
    }
}

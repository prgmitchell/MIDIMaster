use crate::bindings::{BindingKey, BindingState};
use crate::model::{self, AuxiliaryControl, Binding};
use crate::run_logger;
use crate::AppState;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FeedbackControlKey {
    pub device_id: String,
    pub channel: u8,
    pub controller: u8,
    pub msg_type: model::MidiMessageType,
}

impl FeedbackControlKey {
    pub fn from_binding(binding: &Binding) -> Self {
        Self {
            device_id: binding.device_id.clone(),
            channel: binding.control.channel,
            controller: binding.control.controller,
            msg_type: binding.control.msg_type.clone(),
        }
    }

    pub fn from_aux(mapping: &AuxiliaryControl) -> Self {
        Self {
            device_id: mapping.device_id.clone(),
            channel: mapping.channel,
            controller: mapping.controller,
            msg_type: mapping.msg_type.clone(),
        }
    }

    pub fn to_binding_key(&self) -> BindingKey {
        BindingKey {
            device_id: self.device_id.clone(),
            channel: self.channel,
            controller: self.controller,
            msg_type: self.msg_type.clone(),
        }
    }
}

pub struct FeedbackSendOptions<'a> {
    pub value: f32,
    pub silent: bool,
    pub force_hardware_feedback: bool,
    pub context: &'a str,
}

pub fn binding_state_user_active(state: &BindingState, is_note: bool) -> bool {
    if is_note {
        return state.last_value > 0.0;
    }
    state.last_update.elapsed().as_millis() < 500
}

pub fn binding_user_active(state: &AppState, key: &BindingKey, is_note: bool) -> bool {
    if let Ok(states) = state.binding_state.lock() {
        if let Some(st) = states.get(key) {
            return binding_state_user_active(st, is_note);
        }
    }
    false
}

pub fn update_feedback_cache_if_changed(state: &AppState, key: &BindingKey, value: f32) -> bool {
    if let Ok(mut feedback) = state.feedback_values.lock() {
        if let Some(current) = feedback.get(key) {
            if (current - value).abs() < 0.005 {
                return false;
            }
        }
        feedback.insert(key.clone(), value);
        return true;
    }
    true
}

pub fn set_feedback_cache_value(state: &AppState, key: &BindingKey, value: f32) {
    if let Ok(mut feedback) = state.feedback_values.lock() {
        feedback.insert(key.clone(), value);
    }
}

pub fn button_light_feedback_control_key(binding: &Binding) -> FeedbackControlKey {
    binding
        .indicator_feedback_control()
        .map(FeedbackControlKey::from_aux)
        .unwrap_or_else(|| FeedbackControlKey::from_binding(binding))
}

pub fn binding_feedback_control_key(binding: &Binding) -> FeedbackControlKey {
    if binding.is_button_binding() {
        return button_light_feedback_control_key(binding);
    }

    binding
        .custom_feedback_output_control()
        .map(FeedbackControlKey::from_aux)
        .unwrap_or_else(|| FeedbackControlKey::from_binding(binding))
}

fn primary_button_light_suppression_control(
    binding: &Binding,
    output_key: &BindingKey,
) -> Option<FeedbackControlKey> {
    let primary_control = FeedbackControlKey::from_binding(binding);
    if primary_control.to_binding_key() == *output_key {
        None
    } else {
        Some(primary_control)
    }
}

pub fn send_feedback_to_control(
    state: &AppState,
    control: &FeedbackControlKey,
    options: FeedbackSendOptions<'_>,
) {
    let key = control.to_binding_key();
    let is_note = matches!(control.msg_type, model::MidiMessageType::Note);
    let user_active = binding_user_active(state, &key, is_note);

    if user_active && options.silent && !options.force_hardware_feedback {
        run_logger::debug(
            "feedback",
            "silent_ignored_user_active",
            &format!("context={} key={:?}", options.context, key),
        );
        return;
    }

    if !update_feedback_cache_if_changed(state, &key, options.value)
        && !options.force_hardware_feedback
    {
        run_logger::debug(
            "feedback",
            "skipped_unchanged",
            &format!(
                "context={} key={:?} value={}",
                options.context, key, options.value
            ),
        );
        return;
    }

    if !user_active || options.force_hardware_feedback {
        if let Ok(mut midi) = state.midi.lock() {
            let _ = midi.send_feedback(
                &control.device_id,
                control.channel,
                control.controller,
                options.value,
                control.msg_type.clone(),
            );
        }
    }
}

pub fn send_button_light_feedback_to_binding(
    state: &AppState,
    binding: &Binding,
    options: FeedbackSendOptions<'_>,
) {
    let logical_key = BindingKey::from_binding(binding);
    let output_control = button_light_feedback_control_key(binding);
    let output_key = output_control.to_binding_key();
    let is_note = matches!(binding.control.msg_type, model::MidiMessageType::Note);
    let user_active = binding_user_active(state, &logical_key, is_note);

    if user_active && options.silent && !options.force_hardware_feedback {
        run_logger::debug(
            "feedback",
            "button_light_silent_ignored_user_active",
            &format!("context={} key={:?}", options.context, logical_key),
        );
        return;
    }

    if output_key != logical_key {
        set_feedback_cache_value(state, &logical_key, options.value);
    }

    if !update_feedback_cache_if_changed(state, &output_key, options.value)
        && !options.force_hardware_feedback
    {
        run_logger::debug(
            "feedback",
            "button_light_skipped_unchanged",
            &format!(
                "context={} logical_key={:?} output_key={:?} value={}",
                options.context, logical_key, output_key, options.value
            ),
        );
        return;
    }

    if !user_active || options.force_hardware_feedback {
        if let Ok(mut midi) = state.midi.lock() {
            let _ = midi.send_feedback(
                &output_control.device_id,
                output_control.channel,
                output_control.controller,
                options.value,
                output_control.msg_type,
            );
            if let Some(primary_control) =
                primary_button_light_suppression_control(binding, &output_key)
            {
                let _ = midi.send_feedback(
                    &primary_control.device_id,
                    primary_control.channel,
                    primary_control.controller,
                    0.0,
                    primary_control.msg_type,
                );
            }
        }
    }
}

pub fn send_feedback_to_binding(
    state: &AppState,
    binding: &Binding,
    options: FeedbackSendOptions<'_>,
) {
    let logical_key = BindingKey::from_binding(binding);
    let output_control = binding_feedback_control_key(binding);
    let output_key = output_control.to_binding_key();
    let is_note = matches!(binding.control.msg_type, model::MidiMessageType::Note);
    let user_active = binding_user_active(state, &logical_key, is_note);

    if user_active && options.silent && !options.force_hardware_feedback {
        run_logger::debug(
            "feedback",
            "silent_ignored_user_active",
            &format!("context={} key={:?}", options.context, logical_key),
        );
        return;
    }

    if output_key != logical_key {
        set_feedback_cache_value(state, &logical_key, options.value);
    }

    if !update_feedback_cache_if_changed(state, &output_key, options.value)
        && !options.force_hardware_feedback
    {
        run_logger::debug(
            "feedback",
            "skipped_unchanged",
            &format!(
                "context={} logical_key={:?} output_key={:?} value={}",
                options.context, logical_key, output_key, options.value
            ),
        );
        return;
    }

    if !user_active || options.force_hardware_feedback {
        if let Ok(mut midi) = state.midi.lock() {
            let _ = midi.send_binding_feedback(binding, options.value);
        }
    }
}

pub fn targets_overlap(a: &Binding, b: &Binding) -> bool {
    let a_targets = a.normalized_targets();
    let b_targets = b.normalized_targets();
    a_targets
        .iter()
        .any(|target| b_targets.iter().any(|other| other == target))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn button_binding(controller: u8) -> Binding {
        Binding {
            id: "b1".to_string(),
            name: "Binding 1".to_string(),
            macro_name: String::new(),
            device_id: "midi-dev".to_string(),
            control: model::MidiControl {
                channel: 0,
                controller,
                msg_type: model::MidiMessageType::Note,
            },
            control_kind: model::BindingControlKind::Button,
            targets: vec![model::BindingTarget::Hotkey],
            target: model::BindingTarget::Unset,
            action: model::BindingAction::Hotkey,
            mode: model::MidiMode::Absolute,
            relative_format: model::RelativeFormat::Auto,
            fader_curve: model::FaderCurve::Linear,
            custom_curve: Vec::new(),
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: model::MuteBehavior::ToggleOnPress,
            button_light_mode: model::ButtonLightMode::Activity,
            button_light_behavior: model::ButtonLightBehavior::FollowState,
            indicator_control: None,
            mute_control: None,
            assign_control: None,
            assign_mode: model::AssignMode::Add,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
            macro_steps: Vec::new(),
        }
    }

    fn indicator_control(controller: u8) -> model::AuxiliaryControl {
        model::AuxiliaryControl {
            device_id: "midi-dev".to_string(),
            channel: 0,
            controller,
            msg_type: model::MidiMessageType::Note,
            control_kind: model::BindingControlKind::Button,
            mode: model::MidiMode::Absolute,
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: model::MuteBehavior::ToggleOnPress,
        }
    }

    #[test]
    fn custom_indicator_suppresses_primary_button_light() {
        let mut binding = button_binding(21);
        binding.indicator_control = Some(indicator_control(22));
        let output_key = button_light_feedback_control_key(&binding).to_binding_key();

        let suppression =
            primary_button_light_suppression_control(&binding, &output_key).expect("primary off");

        assert_eq!(suppression.controller, 21);
        assert_eq!(suppression.msg_type, model::MidiMessageType::Note);
    }

    #[test]
    fn default_button_light_does_not_suppress_itself() {
        let binding = button_binding(21);
        let output_key = button_light_feedback_control_key(&binding).to_binding_key();

        assert!(primary_button_light_suppression_control(&binding, &output_key).is_none());
    }
}

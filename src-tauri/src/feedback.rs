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
        return state.last_value > 0.5;
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

pub fn send_feedback_to_binding(
    state: &AppState,
    binding: &Binding,
    options: FeedbackSendOptions<'_>,
) {
    let control = FeedbackControlKey::from_binding(binding);
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

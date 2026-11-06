use crate::bindings::{BindingKey, BindingState};
use crate::model::{self, AuxiliaryControl, Binding};
use crate::run_logger;
use crate::AppState;
use std::collections::HashSet;

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

pub fn assign_buttons_feedback(binding: &Binding) -> Vec<(FeedbackControlKey, f32)> {
    let has_real_targets = binding
        .normalized_targets_ref()
        .iter()
        .any(|target| !matches!(target, model::BindingTarget::Unset));
    binding
        .modifier_controls()
        .filter(|(kind, _, _)| *kind == model::FaderModifierKind::Assign)
        .filter_map(|(_, control, _)| {
            if matches!(control.msg_type, model::MidiMessageType::ProgramChange) {
                return None;
            }
            let output = FeedbackControlKey::from_aux(control);
            let conflicts = FeedbackControlKey::from_binding(binding) == output
                || binding.modifier_controls().any(|(kind, candidate, _)| {
                    matches!(
                        kind,
                        model::FaderModifierKind::Mute | model::FaderModifierKind::Solo
                    ) && FeedbackControlKey::from_aux(candidate) == output
                })
                || binding
                    .indicator_control
                    .as_ref()
                    .is_some_and(|candidate| FeedbackControlKey::from_aux(candidate) == output);
            (!conflicts).then_some((output, if has_real_targets { 1.0 } else { 0.0 }))
        })
        .collect()
}

pub fn send_assign_button_feedback(
    state: &AppState,
    binding: &Binding,
    force_hardware_feedback: bool,
    context: &str,
) {
    for (control, value) in assign_buttons_feedback(binding) {
        send_feedback_to_control(
            state,
            &control,
            FeedbackSendOptions {
                value,
                silent: false,
                force_hardware_feedback,
                context,
            },
        );
    }
}

fn assign_feedback_outputs(bindings: &[Binding]) -> HashSet<FeedbackControlKey> {
    bindings
        .iter()
        .flat_map(|binding| {
            assign_buttons_feedback(binding)
                .into_iter()
                .map(|(control, _)| control)
                .chain(
                    binding
                        .modifier_controls()
                        .filter(|(kind, control, _)| {
                            matches!(
                                *kind,
                                model::FaderModifierKind::Mute | model::FaderModifierKind::Solo
                            ) && control.msg_type != model::MidiMessageType::ProgramChange
                        })
                        .map(|(_, control, _)| FeedbackControlKey::from_aux(control)),
                )
        })
        .collect()
}

fn stale_assign_feedback_outputs(
    previous_bindings: &[Binding],
    current_bindings: &[Binding],
) -> HashSet<FeedbackControlKey> {
    let mut current_outputs = assign_feedback_outputs(current_bindings);
    for binding in current_bindings {
        if binding.feedback_enabled {
            current_outputs.insert(binding_feedback_control_key(binding));
        }
        for (_, control, _) in binding.modifier_controls() {
            current_outputs.insert(FeedbackControlKey::from_aux(control));
        }
        if binding.feedback_enabled {
            if let Some(control) = binding.indicator_control.as_ref() {
                current_outputs.insert(FeedbackControlKey::from_aux(control));
            }
        }
    }
    assign_feedback_outputs(previous_bindings)
        .into_iter()
        .filter(|control| !current_outputs.contains(control))
        .collect()
}

pub fn reconcile_assign_feedback_outputs(
    state: &AppState,
    previous_bindings: &[Binding],
    current_bindings: &[Binding],
) {
    for control in stale_assign_feedback_outputs(previous_bindings, current_bindings) {
        let key = control.to_binding_key();
        if let Ok(mut feedback_values) = state.feedback_values.lock() {
            feedback_values.remove(&key);
        }
        if let Ok(mut midi) = state.midi.lock() {
            let _ = midi.send_feedback(
                &control.device_id,
                control.channel,
                control.controller,
                0.0,
                control.msg_type,
            );
        }
    }
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
    if !binding.feedback_enabled {
        return;
    }
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
    if !binding.has_value_feedback() {
        if binding.has_any_led_feedback() {
            set_feedback_cache_value(state, &BindingKey::from_binding(binding), options.value);
        }
        return;
    }
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
    let a_targets = a.normalized_targets_ref();
    let b_targets = b.normalized_targets_ref();
    a_targets
        .iter()
        .any(|target| b_targets.iter().any(|other| other == target))
}

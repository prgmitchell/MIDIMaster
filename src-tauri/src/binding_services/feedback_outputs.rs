use super::*;

pub(super) fn send_resolved_binding_feedback(
    state: &AppState,
    binding: &Binding,
    value: f32,
    silent: bool,
    force_hardware_feedback: bool,
    context: &str,
) {
    if !binding.feedback_enabled {
        return;
    }
    if binding.is_button_binding() {
        feedback::send_button_light_feedback_to_binding(
            state,
            binding,
            FeedbackSendOptions {
                value,
                silent,
                force_hardware_feedback,
                context,
            },
        );
    } else {
        feedback::send_feedback_to_binding(
            state,
            binding,
            FeedbackSendOptions {
                value,
                silent,
                force_hardware_feedback,
                context,
            },
        );
    }
}

pub(super) fn resolved_binding_feedback_control_key(binding: &Binding) -> FeedbackControlKey {
    feedback::binding_feedback_control_key(binding)
}

pub(super) fn binding_has_clearable_feedback_output(binding: &Binding) -> bool {
    if !binding.feedback_enabled {
        return false;
    }
    if binding
        .button_light_feedback_value(Some(false), None)
        .is_some()
    {
        return true;
    }

    !binding.is_button_binding() && binding.custom_feedback_output_control().is_some()
}

pub(super) fn active_feedback_outputs(bindings: &[Binding]) -> HashSet<FeedbackControlKey> {
    bindings
        .iter()
        .filter(|binding| binding_has_clearable_feedback_output(binding))
        .map(resolved_binding_feedback_control_key)
        .collect()
}

pub(super) fn stale_feedback_bindings_for_removed_outputs(
    removed_bindings: &[Binding],
    active_output_keys: &HashSet<FeedbackControlKey>,
) -> Vec<Binding> {
    removed_bindings
        .iter()
        .filter(|binding| binding_has_clearable_feedback_output(binding))
        .filter(|binding| {
            let old_output = resolved_binding_feedback_control_key(binding);
            !active_output_keys.contains(&old_output)
        })
        .cloned()
        .collect()
}

pub(super) fn should_clear_stale_feedback_hardware(
    previous: &Binding,
    replacement: Option<&Binding>,
) -> bool {
    previous.is_button_binding()
        || !replacement
            .is_some_and(|current| current.id == previous.id && !current.feedback_enabled)
}

pub(super) fn clear_binding_feedback_output(
    state: &AppState,
    binding: &Binding,
    clear_hardware: bool,
) {
    let logical_key = BindingKey::from_binding(binding);
    let output_key = resolved_binding_feedback_control_key(binding).to_binding_key();
    if let Ok(mut feedback_values) = state.feedback_values.lock() {
        feedback_values.remove(&logical_key);
        feedback_values.remove(&output_key);
    }
    if clear_hardware {
        if let Ok(mut midi) = state.midi.lock() {
            if binding.is_button_binding() {
                let _ = midi.send_binding_light_feedback(binding, 0.0);
            } else {
                let _ = midi.send_binding_feedback_position(binding, 0.0);
            }
        }
    }
}

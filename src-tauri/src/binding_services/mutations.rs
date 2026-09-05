use super::*;

pub fn add_binding(state: &AppState, binding: Binding) -> Result<(), String> {
    add_binding_to_active_profile(state, binding)
}

pub(crate) fn add_binding_to_active_profile(
    state: &AppState,
    mut binding: Binding,
) -> Result<(), String> {
    run_logger::info(
        "bindings_cmd",
        "add_requested",
        &format!(
            "binding_id={} device_id={} channel={} controller={} action={:?} control_kind={:?} mode={:?} relative_format={:?}",
            binding.id,
            binding.device_id,
            binding.control.channel,
            binding.control.controller,
            binding.action,
            binding.control_kind,
            binding.mode,
            binding.relative_format
        ),
    );
    binding.ensure_targets();
    if binding.targets.is_empty() {
        run_logger::warn(
            "bindings_cmd",
            "add_rejected",
            &format!("binding_id={} reason=no_targets", binding.id),
        );
        return Err("Binding must have at least one target".to_string());
    }
    if binding.targets.len() > 8 {
        run_logger::warn(
            "bindings_cmd",
            "add_rejected",
            &format!("binding_id={} reason=too_many_targets", binding.id),
        );
        return Err("Binding cannot have more than 8 targets".to_string());
    }

    let (saved_profile, stale_feedback_bindings, previous_bindings, feedback_was_reenabled) = {
        let mut profile_guard = state
            .active_profile
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;
        let mut profile = profile_guard
            .as_ref()
            .map(|snapshot| snapshot.profile().clone())
            .unwrap_or(model::Profile {
                name: "Default".to_string(),
                bindings: Vec::new(),
                osd_settings: model::OsdSettings::default(),
                plugin_settings: std::collections::HashMap::new(),
                midi_device_preference: model::MidiDevicePreference::default(),
                midi_device_preference_set: false,
            });
        let previous_bindings = profile.bindings.clone();
        let feedback_was_reenabled = previous_bindings.iter().any(|existing| {
            existing.id == binding.id && !existing.feedback_enabled && binding.feedback_enabled
        });
        let mut removed_bindings = Vec::new();
        profile.bindings.retain(|existing| {
            let remove = existing.id == binding.id
                || (existing.device_id == binding.device_id && existing.control == binding.control);
            if remove {
                removed_bindings.push(existing.clone());
            }
            !remove
        });
        let replacement = binding.clone();
        profile.bindings.push(binding);
        let active_outputs = active_feedback_outputs(&profile.bindings);
        let stale_feedback_bindings: Vec<_> =
            stale_feedback_bindings_for_removed_outputs(&removed_bindings, &active_outputs)
                .into_iter()
                .map(|previous| {
                    let clear_hardware =
                        should_clear_stale_feedback_hardware(&previous, Some(&replacement));
                    (previous, clear_hardware)
                })
                .collect();
        state
            .profile_store
            .save_profile(profile.clone())
            .map_err(|err| err.to_string())?;
        *profile_guard = Some(AppState::profile_snapshot(profile.clone()));
        (
            profile,
            stale_feedback_bindings,
            previous_bindings,
            feedback_was_reenabled,
        )
    };
    state.cancel_activity_button_light_holds();
    for (binding, clear_hardware) in stale_feedback_bindings {
        clear_binding_feedback_output(state, &binding, clear_hardware);
    }
    feedback::reconcile_assign_feedback_outputs(state, &previous_bindings, &saved_profile.bindings);
    state.sync_feedback_values(&saved_profile);
    state.send_idle_button_light_feedback_values(&saved_profile);
    if feedback_was_reenabled {
        if let Some(binding) = saved_profile.bindings.iter().find(|binding| {
            binding.feedback_enabled
                && !binding.is_button_binding()
                && previous_bindings
                    .iter()
                    .any(|previous| previous.id == binding.id && !previous.feedback_enabled)
        }) {
            let key = BindingKey::from_binding(binding);
            let value = state
                .feedback_values
                .lock()
                .ok()
                .and_then(|values| values.get(&key).copied());
            if let Some(value) = value {
                send_resolved_binding_feedback(
                    state,
                    binding,
                    value,
                    false,
                    true,
                    &format!("feedback_reenabled:{}", binding.id),
                );
            }
        }
    }
    run_logger::info(
        "bindings_cmd",
        "add_succeeded",
        &format!(
            "profile={} binding_count={}",
            saved_profile.name,
            saved_profile.bindings.len()
        ),
    );
    Ok(())
}

pub async fn remove_binding(state: &AppState, binding: Binding) -> Result<(), String> {
    run_logger::info(
        "bindings_cmd",
        "remove_requested",
        &format!("binding_id={} device_id={}", binding.id, binding.device_id),
    );
    // Persist a candidate first, then publish it to the background loop.
    let saved_profile = {
        let mut profile_guard = state
            .active_profile
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;

        if let Some(profile) = profile_guard.as_ref() {
            let mut updated = profile.profile().clone();
            updated
                .bindings
                .retain(|existing| existing.id != binding.id);
            state
                .profile_store
                .save_profile(updated.clone())
                .map_err(|err| err.to_string())?;
            *profile_guard = Some(AppState::profile_snapshot(updated.clone()));
            Some(updated)
        } else {
            None
        }
    };

    // Clear internal state only after the profile save succeeds.
    let key = BindingKey::from_binding(&binding);
    let output_key = resolved_binding_feedback_control_key(&binding).to_binding_key();
    if let Ok(mut feedback) = state.feedback_values.lock() {
        feedback.remove(&key);
        feedback.remove(&output_key);
    }
    if let Ok(mut values) = state.binding_action_values.lock() {
        values.remove(&key);
    }
    if let Ok(mut states) = state.binding_state.lock() {
        states.remove(&key);
    }

    // Wait for any pending background loop iterations to finish.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let current_bindings = saved_profile
        .as_ref()
        .map(|profile| profile.bindings.as_slice())
        .unwrap_or(&[]);
    feedback::reconcile_assign_feedback_outputs(
        state,
        std::slice::from_ref(&binding),
        current_bindings,
    );

    // Send 0.0 value to the binding's feedback destination.
    if let Ok(mut midi) = state.midi.lock() {
        if binding.is_button_binding() {
            let _ = midi.send_binding_light_feedback(&binding, 0.0);
        } else {
            let _ = midi.send_binding_feedback_position(&binding, 0.0);
        }
    }

    run_logger::info(
        "bindings_cmd",
        "remove_succeeded",
        &format!(
            "binding_id={} binding_count={}",
            binding.id,
            saved_profile
                .as_ref()
                .map(|profile| profile.bindings.len())
                .unwrap_or(0)
        ),
    );

    Ok(())
}

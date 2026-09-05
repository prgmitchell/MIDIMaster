use super::*;

#[allow(clippy::too_many_arguments)]
pub async fn apply_binding_action(
    app: AppHandle,
    state: &AppState,
    binding_id: String,
    action: Option<model::BindingAction>,
    value: f32,
    silent: Option<bool>,
    source: Option<String>,
    source_sequence: Option<u64>,
) -> Result<(), String> {
    let binding = {
        let profile_guard = state.active_profile.lock().map_err(|_| "Lock poisoned")?;
        let profile = match profile_guard.as_ref() {
            Some(p) => p,
            None => return Ok(()),
        };
        match profile.bindings.iter().find(|b| b.id == binding_id) {
            Some(b) => b.clone(),
            None => return Ok(()),
        }
    };

    let effective_action = action.unwrap_or_else(|| binding.action.clone());
    let targets = binding.normalized_targets_ref();
    if value > 0.0 && binding.is_button_binding() {
        if !matches!(effective_action, model::BindingAction::Macro)
            && targets
                .iter()
                .any(|target| matches!(target, model::BindingTarget::Macro))
        {
            spawn_macro_binding(app.clone(), binding.id.clone(), silent.unwrap_or(false));
        }
        if !matches!(effective_action, model::BindingAction::Soundboard)
            && targets
                .iter()
                .any(|target| matches!(target, model::BindingTarget::Soundboard))
        {
            let sound_result = binding
                .soundboard
                .as_ref()
                .ok_or_else(|| "Select an audio file for this Soundboard action".to_string())
                .and_then(|mapping| state.soundboard.play_binding(&binding.id, mapping));
            if let Err(err) = sound_result {
                let _ = app.emit(
                    "binding_action_error",
                    serde_json::json!({
                        "reason": "soundboard_play_failed",
                        "binding_id": binding.id,
                        "title_key": "dialogs.soundboardPlaybackFailedTitle",
                        "message_key": "dialogs.soundboardPlaybackFailedMessage",
                        "params": { "message": err },
                        "silent": silent,
                    }),
                );
            }
        }
    }
    if matches!(effective_action, model::BindingAction::Macro) {
        if value <= 0.0 {
            return Ok(());
        }
        if !binding.is_button_binding() {
            run_logger::warn(
                "bindings_cmd",
                "macro_non_button_ignored",
                &format!("binding_id={}", binding.id),
            );
            return Ok(());
        }
        return run_macro_binding(app, state, binding, silent.unwrap_or(false)).await;
    }

    if matches!(effective_action, model::BindingAction::Soundboard) {
        if !crate::soundboard::should_trigger_from_input(value) {
            return Ok(());
        }
        if !binding.is_button_binding() {
            return Err("Soundboard actions require a button binding".to_string());
        }
        let mapping = binding
            .soundboard
            .as_ref()
            .ok_or_else(|| "Select an audio file for this Soundboard action".to_string())?;
        if let Err(err) = state.soundboard.play_binding(&binding.id, mapping) {
            let _ = app.emit(
                "binding_action_error",
                serde_json::json!({
                    "reason": "soundboard_play_failed",
                    "binding_id": binding.id,
                    "title_key": "dialogs.soundboardPlaybackFailedTitle",
                    "message_key": "dialogs.soundboardPlaybackFailedMessage",
                    "params": { "message": err },
                    "silent": silent,
                }),
            );
            return Err(err);
        }
        return set_binding_feedback(
            app,
            state,
            binding.id.clone(),
            value,
            Some(effective_action),
            silent,
            None,
            None,
        );
    }

    if !action_can_run_from_command(&effective_action) {
        run_logger::warn(
            "bindings_cmd",
            "apply_binding_action_unsupported",
            &format!("binding_id={} action={:?}", binding.id, effective_action),
        );
        return Ok(());
    }

    if binding_actions::apply_special_button_action(
        &app,
        &binding,
        &effective_action,
        value,
        "bindings_cmd",
    ) {
        if matches!(effective_action, model::BindingAction::SwitchProfile) {
            return Ok(());
        }
        return set_binding_feedback(
            app,
            state,
            binding.id.clone(),
            value,
            Some(effective_action),
            silent,
            None,
            None,
        );
    }

    let outcome = binding_actions::execute_target_action(
        &app,
        state,
        &binding,
        &effective_action,
        value,
        binding_actions::ActionExecutionContext {
            integrations_only: false,
            source: source.as_deref(),
            source_sequence,
            log_target: "bindings_cmd",
            midi_input: None,
        },
    )?;
    if !outcome.applied() {
        run_logger::warn(
            "bindings_cmd",
            "apply_binding_action_no_target_applied",
            &format!("binding_id={} action={:?}", binding.id, effective_action),
        );
        return Ok(());
    }

    set_binding_feedback(
        app,
        state,
        binding.id.clone(),
        value,
        Some(effective_action),
        silent,
        None,
        None,
    )
}

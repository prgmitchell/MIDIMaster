use super::*;

pub fn update_midi_feedback(
    state: &AppState,
    target: model::BindingTarget,
    value: f32,
    binding_id: Option<String>,
    action: Option<model::BindingAction>,
) -> Result<(), String> {
    // Retain the immutable snapshot, then release the profile lock before MIDI I/O.
    let profile = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned")?
        .clone();
    let Some(profile) = profile else {
        return Ok(());
    };
    let matched_bindings = profile.bindings.iter().filter(|binding| {
        let binding_targets = binding.normalized_targets_ref();
        if let Some(ref id) = binding_id {
            binding.id == *id
        } else if let Some(ref act) = action {
            if binding.action != *act {
                false
            } else {
                binding_targets.contains(&target)
            }
        } else {
            binding_targets.contains(&target)
        }
    });

    for binding in matched_bindings {
        let key = BindingKey::from_binding(binding);
        let state_active = if binding.uses_stateful_toggle_feedback() {
            Some(value > 0.5)
        } else {
            None
        };
        let button_light_value = state.button_light_feedback_value(binding, None, state_active);
        let feedback_value = button_light_value.unwrap_or(value);

        let is_note = matches!(binding.control.msg_type, model::MidiMessageType::Note);
        if feedback::binding_user_active(state, &key, is_note) {
            run_logger::debug(
                "bindings_cmd",
                "feedback_skipped_user_active",
                &format!("binding_id={} is_note={}", binding.id, is_note),
            );
            continue;
        }

        if binding.is_button_binding() {
            feedback::send_button_light_feedback_to_binding(
                state,
                binding,
                FeedbackSendOptions {
                    value: feedback_value,
                    silent: false,
                    force_hardware_feedback: false,
                    context: &format!("target_feedback:{}", binding.id),
                },
            );
            run_logger::debug(
                "bindings_cmd",
                "button_light_feedback_sent",
                &format!("binding_id={} value={}", binding.id, feedback_value),
            );
            continue;
        }

        feedback::send_feedback_to_binding(
            state,
            binding,
            FeedbackSendOptions {
                value: feedback_value,
                silent: false,
                force_hardware_feedback: false,
                context: &format!("target_feedback:{}", binding.id),
            },
        );
        run_logger::debug(
            "bindings_cmd",
            "feedback_sent",
            &format!("binding_id={} value={}", binding.id, feedback_value),
        );
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn set_binding_feedback(
    app: AppHandle,
    state: &AppState,
    binding_id: String,
    value: f32,
    action: Option<model::BindingAction>,
    silent: Option<bool>,
    input_value: Option<f32>,
    force_hardware_feedback: Option<bool>,
) -> Result<(), String> {
    // A feedback burst can touch many bindings. Share their published snapshot
    // instead of copying every binding (including macros and target metadata).
    let profile = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned")?
        .clone();
    let Some(profile) = profile else {
        return Ok(());
    };
    let profile_bindings = &profile.bindings;

    let binding = match profile_bindings.iter().find(|b| b.id == binding_id) {
        Some(b) => b,
        None => return Ok(()),
    };
    let primary_target = binding.primary_target_ref();
    let affected_targets = binding.normalized_targets_ref();
    let effective_action = action.clone().unwrap_or_else(|| binding.action.clone());
    let action_matches_binding = action.is_none() || effective_action == binding.action;
    let input_active = input_value.map(|value| value > 0.0);
    let state_active = if binding.uses_stateful_toggle_feedback()
        || matches!(
            effective_action,
            model::BindingAction::ToggleMute | model::BindingAction::ToggleEffect
        ) {
        Some(value > 0.5)
    } else {
        None
    };
    let button_light_value = state.button_light_feedback_value(binding, input_active, state_active);
    let feedback_value = button_light_value.unwrap_or(value);
    if binding.uses_stateful_toggle_feedback()
        || matches!(
            effective_action,
            model::BindingAction::ToggleMute | model::BindingAction::ToggleEffect
        )
    {
        state.set_binding_action_value(&BindingKey::from_binding(binding), value);
    }
    if matches!(effective_action, model::BindingAction::Volume) {
        state.sync_relative_volume_binding_state(binding, value);
    }

    let silent = silent.unwrap_or(false);
    let force_hardware_feedback = force_hardware_feedback.unwrap_or(false);
    if action_matches_binding {
        send_resolved_binding_feedback(
            state,
            binding,
            feedback_value,
            silent,
            force_hardware_feedback,
            &format!("primary:{}", binding.id),
        );
    } else {
        run_logger::debug(
            "bindings_cmd",
            "set_feedback_action_mismatch",
            &format!(
                "binding_id={} binding_action={:?} requested_action={:?}",
                binding.id, binding.action, effective_action
            ),
        );
    }

    // ToggleMute fan-out:
    // - keep existing primary behavior above
    // - also update aux mute controls on affected target owners
    // - and update all ToggleMute bindings on affected targets
    if matches!(effective_action, model::BindingAction::ToggleMute) {
        let mut emitted_controls: HashSet<FeedbackControlKey> = HashSet::new();

        if action_matches_binding && binding.feedback_enabled {
            let emitted_key = resolved_binding_feedback_control_key(binding);
            emitted_controls.insert(emitted_key);
        }

        for candidate in profile_bindings {
            let candidate_targets = candidate.normalized_targets_ref();
            let is_affected = candidate_targets
                .iter()
                .any(|t| affected_targets.iter().any(|affected| affected == t));
            if !is_affected {
                continue;
            }

            if let Some(mute_control) = candidate.mute_control.as_ref() {
                let aux_key = FeedbackControlKey::from_aux(mute_control);
                if emitted_controls.insert(aux_key.clone()) {
                    feedback::send_feedback_to_control(
                        state,
                        &aux_key,
                        FeedbackSendOptions {
                            value,
                            silent,
                            force_hardware_feedback,
                            context: &format!("mute_aux:{}", candidate.id),
                        },
                    );
                }
            }

            if matches!(candidate.action, model::BindingAction::ToggleMute) {
                let primary_key = FeedbackControlKey::from_binding(candidate);
                state.set_binding_action_value(&primary_key.to_binding_key(), value);
                let candidate_button_light_value =
                    state.button_light_feedback_value(candidate, None, Some(value > 0.5));
                let emitted_key = resolved_binding_feedback_control_key(candidate);
                if candidate.feedback_enabled && emitted_controls.insert(emitted_key) {
                    let candidate_value = candidate_button_light_value.unwrap_or(value);
                    send_resolved_binding_feedback(
                        state,
                        candidate,
                        candidate_value,
                        silent,
                        force_hardware_feedback,
                        &format!("toggle_binding:{}", candidate.id),
                    );
                }
            }
        }
    }
    if matches!(effective_action, model::BindingAction::Volume) {
        let mut emitted_controls: HashSet<FeedbackControlKey> = HashSet::new();
        if action_matches_binding && binding.feedback_enabled {
            let emitted_key = resolved_binding_feedback_control_key(binding);
            emitted_controls.insert(emitted_key);
        }
        for candidate in profile_bindings {
            if !matches!(candidate.action, model::BindingAction::Volume) {
                continue;
            }
            if !feedback::targets_overlap(candidate, binding) {
                continue;
            }
            state.sync_relative_volume_binding_state(candidate, value);
            let candidate_button_light_value =
                state.button_light_feedback_value(candidate, input_active, None);
            let emitted_key = resolved_binding_feedback_control_key(candidate);
            if candidate.feedback_enabled && emitted_controls.insert(emitted_key) {
                let candidate_value = candidate_button_light_value.unwrap_or(value);
                send_resolved_binding_feedback(
                    state,
                    candidate,
                    candidate_value,
                    silent,
                    force_hardware_feedback,
                    &format!("volume_binding:{}", candidate.id),
                );
            }
        }
    }

    // Emit UI/OSD updates.
    let settings_enabled = state
        .osd_settings
        .lock()
        .map(|settings| settings.enabled)
        .unwrap_or(true);

    match effective_action {
        model::BindingAction::ToggleMute => {
            let muted = value > 0.5;
            let focus_session = if matches!(&primary_target, model::BindingTarget::Focus) {
                state.audio.focused_session().ok().flatten()
            } else {
                None
            };
            let payload = crate::binding_events::binding_event_payload(
                binding,
                primary_target,
                serde_json::json!({
                  "target": primary_target.clone(),
                  "muted": muted,
                  "action": "toggle_mute",
                  "focus_session": focus_session,
                  "silent": silent
                }),
            );
            let _ = app.emit("mute_update", payload.clone());
            if settings_enabled {
                crate::AppState::emit_osd_update(&app, state, &payload, silent);
            }
        }
        model::BindingAction::Volume => {
            let focus_session = if matches!(&primary_target, model::BindingTarget::Focus) {
                state.audio.focused_session().ok().flatten()
            } else {
                None
            };
            let mut payload = crate::binding_events::binding_event_payload(
                binding,
                primary_target,
                serde_json::json!({
                  "target": primary_target.clone(),
                  "volume": value,
                  "focus_session": focus_session,
                  "silent": silent
                }),
            );
            binding_actions::add_momentary_integration_input_value(
                &mut payload,
                binding,
                &effective_action,
                input_value,
            );
            let _ = app.emit("volume_update", payload.clone());
            if settings_enabled {
                crate::AppState::emit_osd_update(&app, state, &payload, silent);
            }
        }
        _ => {}
    }

    Ok(())
}

pub fn set_integration_connection_state(
    state: &AppState,
    integration_id: String,
    connected: bool,
) -> Result<(), String> {
    let integration_id = integration_id.trim();
    if integration_id.is_empty() {
        return Err("Integration ID is required".to_string());
    }
    if !state.set_integration_connection_state(integration_id, connected) {
        return Ok(());
    }
    let profile = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?
        .clone();
    if let Some(profile) = profile {
        state.sync_feedback_values(&profile);
        state.send_idle_button_light_feedback_values(&profile);
    }
    Ok(())
}

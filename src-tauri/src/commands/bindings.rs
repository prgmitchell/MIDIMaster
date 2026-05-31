use crate::binding_actions::{self, IntegrationBatchTrigger, IntegrationTrigger};
use crate::feedback::{self, FeedbackControlKey, FeedbackSendOptions};
use crate::run_logger;
use crate::{bindings::BindingKey, model, model::Binding, AppState};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

fn apply_binding_action_internal(
    app: &AppHandle,
    state: &AppState,
    binding: &Binding,
    action: model::BindingAction,
    value: f32,
    source: Option<&str>,
    source_sequence: Option<u64>,
) -> Result<bool, String> {
    let targets = binding.normalized_targets();
    if targets.is_empty() {
        return Ok(false);
    }

    let mut any_applied = false;
    let mut integration_volume_batches: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    for (target_index, target) in targets.iter().enumerate() {
        match (&action, target) {
            (model::BindingAction::Volume, model::BindingTarget::Master) => {
                if let Err(err) = state.audio.set_master_volume(value) {
                    run_logger::warn(
                        "bindings_cmd",
                        "apply_action_volume_master_failed",
                        &format!("binding_id={} error={}", binding.id, err),
                    );
                } else {
                    any_applied = true;
                }
            }
            (model::BindingAction::Volume, model::BindingTarget::Focus) => {
                if state.apply_focus_volume_with_retry(&binding.id, value) {
                    any_applied = true;
                }
            }
            (model::BindingAction::Volume, model::BindingTarget::Session { session_id }) => {
                if let Err(err) = state.audio.set_session_volume(session_id, value) {
                    run_logger::warn(
                        "bindings_cmd",
                        "apply_action_volume_session_failed",
                        &format!(
                            "binding_id={} session_id={} error={}",
                            binding.id, session_id, err
                        ),
                    );
                } else {
                    any_applied = true;
                }
            }
            (model::BindingAction::Volume, model::BindingTarget::Application { name, .. }) => {
                if let Err(err) = state.audio.set_application_volume(name, value) {
                    run_logger::warn(
                        "bindings_cmd",
                        "apply_action_volume_application_failed",
                        &format!("binding_id={} app={} error={}", binding.id, name, err),
                    );
                } else {
                    any_applied = true;
                }
            }
            (model::BindingAction::Volume, model::BindingTarget::Device { device_id }) => {
                if let Err(err) = state.audio.set_device_volume(device_id, value) {
                    run_logger::warn(
                        "bindings_cmd",
                        "apply_action_volume_device_failed",
                        &format!(
                            "binding_id={} device_id={} error={}",
                            binding.id, device_id, err
                        ),
                    );
                } else {
                    any_applied = true;
                }
            }
            (
                model::BindingAction::Volume,
                model::BindingTarget::Integration {
                    integration_id,
                    kind,
                    data,
                },
            ) => {
                let group_index = integration_volume_batches
                    .get(integration_id)
                    .map(|items| items.len())
                    .unwrap_or(0);
                integration_volume_batches
                    .entry(integration_id.clone())
                    .or_default()
                    .push(serde_json::json!({
                      "target": {
                        "integration_id": integration_id,
                        "kind": kind,
                        "data": data,
                      },
                      "target_index": group_index,
                      "target_count": 0,
                      "is_primary_target": target_index == 0,
                      "original_target_index": target_index,
                      "binding_target_count": targets.len(),
                    }));
                any_applied = true;
            }
            (model::BindingAction::ToggleMute, model::BindingTarget::Master) => {
                if let Err(err) = state.audio.set_master_mute(value > 0.5) {
                    run_logger::warn(
                        "bindings_cmd",
                        "apply_action_mute_master_failed",
                        &format!("binding_id={} error={}", binding.id, err),
                    );
                } else {
                    any_applied = true;
                }
            }
            (model::BindingAction::ToggleMute, model::BindingTarget::Focus) => {
                if state.audio.focused_session().ok().flatten().is_some() {
                    if let Err(err) = state.audio.set_focused_session_mute(value > 0.5) {
                        run_logger::warn(
                            "bindings_cmd",
                            "apply_action_mute_focus_failed",
                            &format!("binding_id={} error={}", binding.id, err),
                        );
                    } else {
                        any_applied = true;
                    }
                }
            }
            (model::BindingAction::ToggleMute, model::BindingTarget::Session { session_id }) => {
                if let Err(err) = state.audio.set_session_mute(session_id, value > 0.5) {
                    run_logger::warn(
                        "bindings_cmd",
                        "apply_action_mute_session_failed",
                        &format!(
                            "binding_id={} session_id={} error={}",
                            binding.id, session_id, err
                        ),
                    );
                } else {
                    any_applied = true;
                }
            }
            (model::BindingAction::ToggleMute, model::BindingTarget::Application { name, .. }) => {
                if let Err(err) = state.audio.set_application_mute(name, value > 0.5) {
                    run_logger::warn(
                        "bindings_cmd",
                        "apply_action_mute_application_failed",
                        &format!("binding_id={} app={} error={}", binding.id, name, err),
                    );
                } else {
                    any_applied = true;
                }
            }
            (model::BindingAction::ToggleMute, model::BindingTarget::Device { device_id }) => {
                if let Err(err) = state.audio.set_device_mute(device_id, value > 0.5) {
                    run_logger::warn(
                        "bindings_cmd",
                        "apply_action_mute_device_failed",
                        &format!(
                            "binding_id={} device_id={} error={}",
                            binding.id, device_id, err
                        ),
                    );
                } else {
                    any_applied = true;
                }
            }
            (
                action,
                model::BindingTarget::Integration {
                    integration_id,
                    kind,
                    data,
                },
            ) if binding_actions::action_is_stateful_integration_toggle(action) => {
                binding_actions::emit_integration_binding_triggered(
                    app,
                    IntegrationTrigger {
                        binding_id: &binding.id,
                        action,
                        value,
                        target_index,
                        target_count: targets.len(),
                        integration_id,
                        kind,
                        data,
                        source,
                        source_sequence,
                    },
                );
                any_applied = true;
            }
            (
                action,
                model::BindingTarget::Integration {
                    integration_id,
                    kind,
                    data,
                },
            ) if binding_actions::action_is_momentary_integration_action(action) => {
                binding_actions::emit_integration_binding_triggered(
                    app,
                    IntegrationTrigger {
                        binding_id: &binding.id,
                        action,
                        value,
                        target_index,
                        target_count: targets.len(),
                        integration_id,
                        kind,
                        data,
                        source,
                        source_sequence,
                    },
                );
                any_applied = true;
            }
            (
                model::BindingAction::SetDefaultDevice,
                model::BindingTarget::Device { device_id },
            ) => {
                if let Err(err) = state.audio.set_default_device(device_id) {
                    run_logger::warn(
                        "bindings_cmd",
                        "apply_action_set_default_device_failed",
                        &format!(
                            "binding_id={} device_id={} error={}",
                            binding.id, device_id, err
                        ),
                    );
                } else {
                    any_applied = true;
                }
            }
            _ => {}
        }
    }

    if !integration_volume_batches.is_empty() {
        for (integration_id, mut grouped_targets) in integration_volume_batches {
            binding_actions::finalize_grouped_integration_targets(&mut grouped_targets);
            binding_actions::emit_integration_binding_triggered_batch(
                app,
                IntegrationBatchTrigger {
                    binding_id: &binding.id,
                    action: &action,
                    value,
                    integration_id: &integration_id,
                    targets: grouped_targets,
                    source,
                    source_sequence,
                },
            );
        }
    }

    Ok(any_applied)
}

#[tauri::command]
pub fn add_binding(state: State<AppState>, mut binding: Binding) -> Result<(), String> {
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

    let profile_to_save = {
        let mut profile_guard = state
            .active_profile
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;
        let profile = profile_guard.get_or_insert(model::Profile {
            name: "Default".to_string(),
            bindings: Vec::new(),
            osd_settings: model::OsdSettings::default(),
            plugin_settings: std::collections::HashMap::new(),
            midi_device_preference: model::MidiDevicePreference::default(),
        });
        profile.bindings.retain(|existing| {
            existing.id != binding.id
                && !(existing.device_id == binding.device_id && existing.control == binding.control)
        });
        profile.bindings.push(binding);
        state.sync_feedback_values(profile);
        state.send_idle_button_light_feedback_values(profile);
        run_logger::info(
            "bindings_cmd",
            "add_succeeded",
            &format!(
                "profile={} binding_count={}",
                profile.name,
                profile.bindings.len()
            ),
        );
        profile.clone()
    };
    state
        .profile_store
        .save_profile(profile_to_save)
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn remove_binding(state: State<'_, AppState>, binding: Binding) -> Result<(), String> {
    run_logger::info(
        "bindings_cmd",
        "remove_requested",
        &format!("binding_id={} device_id={}", binding.id, binding.device_id),
    );
    // 1. Remove the binding from the active profile FIRST to stop the background loop
    {
        let mut profile_guard = state
            .active_profile
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;

        if let Some(profile) = profile_guard.as_mut() {
            profile
                .bindings
                .retain(|existing| existing.id != binding.id);

            // Save the updated profile to disk
            state
                .profile_store
                .save_profile(profile.clone())
                .map_err(|err| err.to_string())?;
        }
    }

    // 2. Clear internal state
    let key = BindingKey::from_binding(&binding);
    if let Ok(mut feedback) = state.feedback_values.lock() {
        feedback.remove(&key);
    }
    if let Ok(mut values) = state.binding_action_values.lock() {
        values.remove(&key);
    }
    if let Ok(mut states) = state.binding_state.lock() {
        states.remove(&key);
    }

    // 3. Wait for any pending background loop iterations to finish
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 4. Send 0.0 value to the binding's control
    if let Ok(mut midi) = state.midi.lock() {
        let _ = midi.send_binding_feedback(&binding, 0.0);
    }

    Ok(())
}

#[tauri::command]
pub fn update_midi_feedback(
    state: State<AppState>,
    target: model::BindingTarget,
    value: f32,
    binding_id: Option<String>,
    action: Option<model::BindingAction>,
) -> Result<(), String> {
    let profile_guard = state.active_profile.lock().map_err(|_| "Lock poisoned")?;
    let profile = match profile_guard.as_ref() {
        Some(p) => p,
        None => return Ok(()),
    };

    for binding in &profile.bindings {
        let binding_targets = binding.normalized_targets();
        let matches = if let Some(ref id) = binding_id {
            binding.id == *id
        } else if let Some(ref act) = action {
            if binding.action != *act {
                false
            } else {
                binding_targets.contains(&target)
            }
        } else {
            binding_targets.contains(&target)
        };

        if matches {
            let key = BindingKey::from_binding(binding);
            let feedback_value = binding
                .mapped_button_light_feedback_value()
                .or_else(|| binding.idle_button_light_feedback_value())
                .unwrap_or(value);

            let is_note = matches!(binding.control.msg_type, model::MidiMessageType::Note);
            if feedback::binding_user_active(&state, &key, is_note) {
                run_logger::debug(
                    "bindings_cmd",
                    "feedback_skipped_user_active",
                    &format!("binding_id={} is_note={}", binding.id, is_note),
                );
                continue;
            }

            if !feedback::update_feedback_cache_if_changed(&state, &key, feedback_value) {
                run_logger::debug(
                    "bindings_cmd",
                    "feedback_skipped_unchanged",
                    &format!("binding_id={} value={}", binding.id, feedback_value),
                );
                continue;
            }

            // Send the actual MIDI feedback
            if let Ok(mut midi) = state.midi.lock() {
                let _ = midi.send_binding_feedback(binding, feedback_value);
            }
            run_logger::debug(
                "bindings_cmd",
                "feedback_sent",
                &format!("binding_id={} value={}", binding.id, feedback_value),
            );
        }
    }

    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn set_binding_feedback(
    app: AppHandle,
    state: State<AppState>,
    binding_id: String,
    value: f32,
    action: Option<model::BindingAction>,
    silent: Option<bool>,
    input_value: Option<f32>,
    force_hardware_feedback: Option<bool>,
) -> Result<(), String> {
    let profile_guard = state.active_profile.lock().map_err(|_| "Lock poisoned")?;
    let profile = match profile_guard.as_ref() {
        Some(p) => p,
        None => return Ok(()),
    };

    let binding = match profile.bindings.iter().find(|b| b.id == binding_id) {
        Some(b) => b.clone(),
        None => return Ok(()),
    };
    let primary_target = binding.primary_target();
    let affected_targets = binding.normalized_targets();
    let effective_action = action.clone().unwrap_or_else(|| binding.action.clone());
    let action_matches_binding = action.is_none() || effective_action == binding.action;
    let feedback_value = binding
        .mapped_button_light_feedback_value()
        .or_else(|| binding.idle_button_light_feedback_value())
        .unwrap_or(value);
    if binding.uses_stateful_toggle_feedback()
        || matches!(
            effective_action,
            model::BindingAction::ToggleMute | model::BindingAction::ToggleEffect
        )
    {
        state.set_binding_action_value(&BindingKey::from_binding(&binding), value);
    }

    let silent = silent.unwrap_or(false);
    let force_hardware_feedback = force_hardware_feedback.unwrap_or(false);
    if action_matches_binding {
        feedback::send_feedback_to_binding(
            &state,
            &binding,
            FeedbackSendOptions {
                value: feedback_value,
                silent,
                force_hardware_feedback,
                context: &format!("primary:{}", binding.id),
            },
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

        if action_matches_binding {
            emitted_controls.insert(FeedbackControlKey::from_binding(&binding));
        }

        for candidate in &profile.bindings {
            let candidate_targets = candidate.normalized_targets();
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
                        &state,
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
                if emitted_controls.insert(primary_key.clone()) {
                    feedback::send_feedback_to_binding(
                        &state,
                        candidate,
                        FeedbackSendOptions {
                            value,
                            silent,
                            force_hardware_feedback,
                            context: &format!("toggle_binding:{}", candidate.id),
                        },
                    );
                }
            }
        }
    }
    if matches!(effective_action, model::BindingAction::Volume) {
        let mut emitted_controls: HashSet<FeedbackControlKey> = HashSet::new();
        if action_matches_binding {
            emitted_controls.insert(FeedbackControlKey::from_binding(&binding));
        }
        for candidate in &profile.bindings {
            if !matches!(candidate.action, model::BindingAction::Volume) {
                continue;
            }
            if !feedback::targets_overlap(candidate, &binding) {
                continue;
            }
            let primary_key = FeedbackControlKey::from_binding(candidate);
            if emitted_controls.insert(primary_key.clone()) {
                let candidate_value = candidate
                    .mapped_button_light_feedback_value()
                    .or_else(|| candidate.idle_button_light_feedback_value())
                    .unwrap_or(value);
                feedback::send_feedback_to_binding(
                    &state,
                    candidate,
                    FeedbackSendOptions {
                        value: candidate_value,
                        silent,
                        force_hardware_feedback,
                        context: &format!("volume_binding:{}", candidate.id),
                    },
                );
            }
        }
    }

    if let Ok(mut last_update) = state.osd_last_update.lock() {
        *last_update = Some(Instant::now());
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
            let payload = serde_json::json!({
              "target": primary_target,
              "muted": muted,
              "action": "toggle_mute",
              "focus_session": focus_session,
              "binding_id": binding.id,
              "silent": silent
            });
            let _ = app.emit("mute_update", payload.clone());
            if settings_enabled {
                crate::AppState::emit_osd_update(&app, state.inner(), &payload, silent);
            }
        }
        model::BindingAction::Volume => {
            let focus_session = if matches!(&primary_target, model::BindingTarget::Focus) {
                state.audio.focused_session().ok().flatten()
            } else {
                None
            };
            let mut payload = serde_json::json!({
              "target": primary_target,
              "volume": value,
              "focus_session": focus_session,
              "binding_id": binding.id,
              "silent": silent
            });
            binding_actions::add_momentary_integration_input_value(
                &mut payload,
                &binding,
                &effective_action,
                input_value,
            );
            let _ = app.emit("volume_update", payload.clone());
            if settings_enabled {
                crate::AppState::emit_osd_update(&app, state.inner(), &payload, silent);
            }
        }
        _ => {}
    }

    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn apply_binding_action(
    app: AppHandle,
    state: State<AppState>,
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
    if !matches!(
        effective_action,
        model::BindingAction::Volume
            | model::BindingAction::ToggleMute
            | model::BindingAction::ToggleEffect
            | model::BindingAction::SetMainOutputDevice
            | model::BindingAction::SetDefaultDevice
            | model::BindingAction::FocusWindow
            | model::BindingAction::FullScreenshot
            | model::BindingAction::SnipScreenshot
            | model::BindingAction::ToggleScreenRecording
            | model::BindingAction::RunAutoHotkeyScript
    ) {
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

    let any_applied = apply_binding_action_internal(
        &app,
        &state,
        &binding,
        effective_action.clone(),
        value,
        source.as_deref(),
        source_sequence,
    )?;
    if !any_applied {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bindings::BindingState;

    fn binding_state(last_value: f32, elapsed_ms: u64) -> BindingState {
        BindingState {
            last_value,
            last_update: Instant::now()
                .checked_sub(Duration::from_millis(elapsed_ms))
                .unwrap_or_else(Instant::now),
            relative_auto_format: None,
            relative_seen_midpoint: false,
            relative_seen_sign_band: false,
            relative_seen_high_negative: false,
            relative_seen_low_negative_hint: false,
        }
    }

    fn integration_button_binding(action_kind: &str) -> Binding {
        Binding {
            id: "b1".to_string(),
            name: "Binding 1".to_string(),
            device_id: "midi-dev".to_string(),
            control: model::MidiControl {
                channel: 0,
                controller: 7,
                msg_type: model::MidiMessageType::Note,
            },
            control_kind: model::BindingControlKind::Button,
            targets: vec![model::BindingTarget::Integration {
                integration_id: "hue".to_string(),
                kind: "light".to_string(),
                data: serde_json::json!({ "id": "1", "action_kind": action_kind }),
            }],
            target: model::BindingTarget::Unset,
            action: model::BindingAction::Volume,
            mode: model::MidiMode::Absolute,
            relative_format: model::RelativeFormat::Auto,
            fader_curve: model::FaderCurve::Linear,
            custom_curve: Vec::new(),
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: model::MuteBehavior::ToggleOnPress,
            button_light_mode: model::ButtonLightMode::Activity,
            mute_control: None,
            assign_control: None,
            assign_mode: model::AssignMode::Add,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
        }
    }

    #[test]
    fn note_button_is_active_only_while_input_is_pressed() {
        assert!(feedback::binding_state_user_active(
            &binding_state(1.0, 10),
            true
        ));
        assert!(!feedback::binding_state_user_active(
            &binding_state(0.0, 10),
            true
        ));
    }

    #[test]
    fn continuous_control_activity_uses_recent_update_window() {
        assert!(feedback::binding_state_user_active(
            &binding_state(0.0, 100),
            false
        ));
        assert!(!feedback::binding_state_user_active(
            &binding_state(0.0, 700),
            false
        ));
    }

    #[test]
    fn momentary_integration_button_feedback_adds_input_value_without_changing_volume() {
        let binding = integration_button_binding("momentary");
        let mut payload = serde_json::json!({
            "volume": 0.0,
        });

        binding_actions::add_momentary_integration_input_value(
            &mut payload,
            &binding,
            &model::BindingAction::Volume,
            Some(1.0),
        );

        assert_eq!(payload["volume"], serde_json::json!(0.0));
        assert_eq!(payload["input_value"], serde_json::json!(1.0));
    }

    #[test]
    fn momentary_integration_button_feedback_without_input_value_does_not_infer_from_volume() {
        let binding = integration_button_binding("momentary");
        let mut payload = serde_json::json!({
            "volume": 0.75,
        });

        binding_actions::add_momentary_integration_input_value(
            &mut payload,
            &binding,
            &model::BindingAction::Volume,
            None,
        );

        assert_eq!(payload["volume"], serde_json::json!(0.75));
        assert!(payload.get("input_value").is_none());
    }

    #[test]
    fn stateful_integration_button_feedback_does_not_add_input_value() {
        let binding = integration_button_binding("stateful");
        let mut payload = serde_json::json!({
            "volume": 0.0,
        });

        binding_actions::add_momentary_integration_input_value(
            &mut payload,
            &binding,
            &model::BindingAction::Volume,
            None,
        );

        assert!(payload.get("input_value").is_none());
    }
}

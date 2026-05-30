use crate::bindings::BindingKey;
use crate::model::{self, MidiEvent, Profile};
use crate::run_logger;
use crate::{app_state::focused_application_name, AppState};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub(super) fn handle_aux_or_unmatched(
    state: &AppState,
    app: &AppHandle,
    profile: &Profile,
    key: &BindingKey,
    event: &MidiEvent,
) -> Result<(), String> {
    let aux_match = profile.bindings.iter().find_map(|candidate| {
        if let Some(mapping) = candidate.mute_control.as_ref() {
            if AppState::binding_matches_aux(mapping, event) {
                return Some((candidate.clone(), "mute", mapping.clone()));
            }
        }
        if let Some(mapping) = candidate.assign_control.as_ref() {
            if AppState::binding_matches_aux(mapping, event) {
                return Some((candidate.clone(), "assign", mapping.clone()));
            }
        }
        None
    });

    if let Some((owner, role, aux_mapping)) = aux_match {
        let mut targets = owner.normalized_targets();
        targets.retain(|t| *t != model::BindingTarget::Unset);
        if role == "mute" && targets.is_empty() {
            return Ok(());
        }

        if event.value == 0
            && (role != "mute" || aux_mapping.mute_behavior == model::MuteBehavior::ToggleOnPress)
        {
            if role == "mute" {
                let fallback_muted = state
                    .feedback_values
                    .lock()
                    .ok()
                    .and_then(|feedback| feedback.get(key).cloned())
                    .map(|v| v > 0.5)
                    .unwrap_or(false);
                let muted_now = targets
                    .first()
                    .and_then(|target| state.current_target_mute_state(target))
                    .unwrap_or(fallback_muted);
                let midi_arc = state.midi.clone();
                let device_id = aux_mapping.device_id.clone();
                let channel = aux_mapping.channel;
                let controller = aux_mapping.controller;
                let msg_type = aux_mapping.msg_type.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    if let Ok(mut midi) = midi_arc.lock() {
                        let _ = midi.send_feedback(
                            &device_id,
                            channel,
                            controller,
                            if muted_now { 1.0 } else { 0.0 },
                            msg_type,
                        );
                    }
                });
            }
            return Ok(());
        }

        if role == "assign" {
            let focused = state
                .audio
                .focused_session()
                .map_err(|err| err.to_string())?;
            let (app_name, app_display_name, app_icon_data) = if let Some(focused) = focused {
                focused
                    .process_name
                    .as_deref()
                    .and_then(|name| name.strip_suffix(".exe").or(Some(name)))
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty())
                    .map(|name| {
                        (
                            name,
                            Some(focused.display_name.clone()),
                            focused.icon_data.clone(),
                        )
                    })
                    .unwrap_or_else(|| {
                        (
                            focused.display_name.clone(),
                            Some(focused.display_name.clone()),
                            focused.icon_data.clone(),
                        )
                    })
            } else {
                (focused_application_name().unwrap_or_default(), None, None)
            };
            if !app_name.is_empty() {
                let new_target = model::BindingTarget::Application {
                    name: app_name,
                    display_name: app_display_name,
                    icon_data: app_icon_data,
                };
                let already_present = targets.contains(&new_target);
                let should_replace = matches!(owner.assign_mode, model::AssignMode::Replace);
                if should_replace || !already_present {
                    if !should_replace && targets.len() >= 8 {
                        let _ = app.emit(
                            "binding_aux_error",
                            serde_json::json!({
                                "binding_id": owner.id,
                                "kind": "assign",
                                "reason": "target_list_full"
                            }),
                        );
                    } else {
                        let mut updated_targets: Option<Vec<model::BindingTarget>> = None;
                        let mut guard = state
                            .active_profile
                            .lock()
                            .map_err(|_| "Lock poisoned".to_string())?;
                        if let Some(active_profile) = guard.as_mut() {
                            if let Some(stored) = active_profile
                                .bindings
                                .iter_mut()
                                .find(|b| b.id == owner.id)
                            {
                                stored.ensure_targets();
                                if should_replace {
                                    stored.targets = vec![new_target.clone()];
                                    stored.ensure_targets();
                                    updated_targets = Some(stored.normalized_targets());
                                } else if !stored.targets.contains(&new_target) {
                                    stored.targets.push(new_target.clone());
                                    stored.ensure_targets();
                                    updated_targets = Some(stored.normalized_targets());
                                }
                            }
                            if updated_targets.is_some() {
                                state
                                    .profile_store
                                    .save_profile(active_profile.clone())
                                    .map_err(|err| err.to_string())?;
                                state.sync_feedback_values(active_profile);
                                state.send_idle_button_light_feedback_values(active_profile);
                            }
                        }
                        if let Some(updated_targets) = updated_targets {
                            let _ = app.emit(
                                "binding_aux_assign_update",
                                serde_json::json!({
                                    "binding_id": owner.id,
                                    "target": new_target,
                                    "targets": updated_targets
                                }),
                            );
                        }
                    }
                }
            } else {
                let _ = app.emit(
                    "binding_aux_error",
                    serde_json::json!({
                        "binding_id": owner.id,
                        "kind": "assign",
                        "reason": "focused_app_unavailable"
                    }),
                );
            }
            return Ok(());
        }

        let fallback_muted = state
            .feedback_values
            .lock()
            .ok()
            .and_then(|feedback| feedback.get(key).cloned())
            .map(|v| v > 0.5)
            .unwrap_or(false);
        let current_muted = targets
            .first()
            .and_then(|target| state.current_target_mute_state(target))
            .unwrap_or(fallback_muted);
        let previous_input_active =
            if aux_mapping.mute_behavior == model::MuteBehavior::SetFromValue {
                state
                    .last_mute_input_active
                    .lock()
                    .ok()
                    .and_then(|inputs| inputs.get(key).copied())
            } else {
                None
            };
        let Some(next_muted) = AppState::resolve_target_mute_state(
            event.value,
            current_muted,
            aux_mapping.mute_behavior.clone(),
            previous_input_active,
        ) else {
            if aux_mapping.mute_behavior == model::MuteBehavior::SetFromValue {
                if let Ok(mut inputs) = state.last_mute_input_active.lock() {
                    inputs.insert(key.clone(), event.value > 0);
                }
            }
            return Ok(());
        };
        if aux_mapping.mute_behavior == model::MuteBehavior::SetFromValue {
            if let Ok(mut inputs) = state.last_mute_input_active.lock() {
                inputs.insert(key.clone(), event.value > 0);
            }
        }
        for (target_index, target) in targets.iter().enumerate() {
            match target {
                model::BindingTarget::Master => {
                    let _ = state.audio.set_master_mute(next_muted);
                }
                model::BindingTarget::Focus => {
                    let _ = state.audio.set_focused_session_mute(next_muted);
                }
                model::BindingTarget::Session { session_id } => {
                    let _ = state.audio.set_session_mute(session_id, next_muted);
                }
                model::BindingTarget::Application { name, .. } => {
                    let _ = state.audio.set_application_mute(name, next_muted);
                }
                model::BindingTarget::Device { device_id } => {
                    let _ = state.audio.set_device_mute(device_id, next_muted);
                }
                model::BindingTarget::Integration {
                    integration_id,
                    kind,
                    data,
                } => {
                    let payload = serde_json::json!({
                      "binding_id": owner.id,
                      "action": "ToggleMute",
                      "value": if next_muted { 1.0 } else { 0.0 },
                      "target_index": target_index,
                      "target_count": targets.len(),
                      "is_primary_target": target_index == 0,
                      "target": {
                        "integration_id": integration_id,
                        "kind": kind,
                        "data": data,
                      }
                    });
                    let _ = app.emit("integration_binding_triggered", payload);
                }
                _ => {}
            }
        }
        if let Ok(mut feedback) = state.feedback_values.lock() {
            feedback.insert(key.clone(), if next_muted { 1.0 } else { 0.0 });
        }
        state.set_binding_action_value(
            &BindingKey::from_binding(&owner),
            if next_muted { 1.0 } else { 0.0 },
        );
        if let Ok(mut midi) = state.midi.lock() {
            let _ = midi.send_feedback(
                &aux_mapping.device_id,
                aux_mapping.channel,
                aux_mapping.controller,
                if next_muted { 1.0 } else { 0.0 },
                aux_mapping.msg_type.clone(),
            );
        }

        if let Ok(mut last_update) = state.osd_last_update.lock() {
            *last_update = Some(Instant::now());
        }

        let _ = app.emit(
            "binding_aux_mute_update",
            serde_json::json!({
                "binding_id": owner.id,
                "muted": next_muted
            }),
        );

        let settings_enabled = state
            .osd_settings
            .lock()
            .map(|settings| settings.enabled)
            .unwrap_or(true);

        for target in &targets {
            let focus_session = if matches!(target, model::BindingTarget::Focus) {
                state.audio.focused_session().ok().flatten()
            } else {
                None
            };
            let payload = serde_json::json!({
              "target": target,
              "muted": next_muted,
              "action": "toggle_mute",
              "focus_session": focus_session,
              "binding_id": owner.id
            });
            let _ = app.emit("mute_update", payload.clone());

            if settings_enabled {
                AppState::emit_osd_update(app, state, &payload, false);
            }
        }
        return Ok(());
    }

    run_logger::debug(
        "bindings",
        "event_unmatched",
        &format!(
            "device_id={} channel={} controller={} value={} msg_type={:?}",
            event.device_id, event.channel, event.controller, event.value, event.msg_type
        ),
    );
    Ok(())
}

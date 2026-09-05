use crate::bindings::BindingKey;
use crate::model::{self, MidiEvent, Profile};
use crate::{app_state::focused_application_name, AppState};
use crate::{binding_actions, feedback, run_logger};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssignTransition {
    AddFocused,
    ReplaceFocused,
    ClearTargets,
}

fn resolve_assign_transition(
    assign_mode: &model::AssignMode,
    has_real_targets: bool,
) -> AssignTransition {
    match assign_mode {
        model::AssignMode::Replace => AssignTransition::ReplaceFocused,
        model::AssignMode::Clear if has_real_targets => AssignTransition::ClearTargets,
        model::AssignMode::Add | model::AssignMode::Clear => AssignTransition::AddFocused,
    }
}

fn apply_assign_transition(
    binding: &mut model::Binding,
    transition: AssignTransition,
    focused_target: Option<&model::BindingTarget>,
) -> bool {
    binding.ensure_targets();
    match transition {
        AssignTransition::ClearTargets => {
            let was_clear = binding.targets == vec![model::BindingTarget::Unset]
                && binding.target == model::BindingTarget::Unset;
            binding.targets = vec![model::BindingTarget::Unset];
            binding.target = model::BindingTarget::Unset;
            !was_clear
        }
        AssignTransition::ReplaceFocused => {
            let Some(target) = focused_target else {
                return false;
            };
            binding.targets = vec![target.clone()];
            binding.ensure_targets();
            true
        }
        AssignTransition::AddFocused => {
            let Some(target) = focused_target else {
                return false;
            };
            if binding.targets.contains(target) {
                return false;
            }
            binding.targets.push(target.clone());
            binding.ensure_targets();
            true
        }
    }
}

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
        if role == "mute" && !state.binding_has_available_target(&owner) {
            feedback::send_feedback_to_control(
                state,
                &feedback::FeedbackControlKey::from_aux(&aux_mapping),
                feedback::FeedbackSendOptions {
                    value: 0.0,
                    silent: false,
                    force_hardware_feedback: true,
                    context: &format!("mute_unavailable:{}", owner.id),
                },
            );
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
            } else if role == "assign" {
                let current_owner = state
                    .active_profile
                    .lock()
                    .ok()
                    .and_then(|profile| profile.as_ref().map(|snapshot| snapshot.profile().clone()))
                    .and_then(|profile| {
                        profile
                            .bindings
                            .into_iter()
                            .find(|binding| binding.id == owner.id)
                    })
                    .unwrap_or_else(|| owner.clone());
                feedback::send_assign_button_feedback(
                    state,
                    &current_owner,
                    true,
                    &format!("assign_release:{}", current_owner.id),
                );
            }
            return Ok(());
        }

        if role == "assign" {
            let transition = resolve_assign_transition(&owner.assign_mode, !targets.is_empty());
            let new_target = if transition == AssignTransition::ClearTargets {
                None
            } else {
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
                if app_name.is_empty() {
                    let _ = app.emit(
                        "binding_aux_error",
                        serde_json::json!({
                            "binding_id": owner.id,
                            "kind": "assign",
                            "reason": "focused_app_unavailable"
                        }),
                    );
                    return Ok(());
                }
                Some(model::BindingTarget::Application {
                    name: app_name,
                    display_name: app_display_name,
                    icon_data: app_icon_data,
                })
            };

            if transition == AssignTransition::AddFocused
                && new_target
                    .as_ref()
                    .is_some_and(|target| targets.contains(target))
            {
                return Ok(());
            }
            if transition == AssignTransition::AddFocused && targets.len() >= 8 {
                let _ = app.emit(
                    "binding_aux_error",
                    serde_json::json!({
                        "binding_id": owner.id,
                        "kind": "assign",
                        "reason": "target_list_full"
                    }),
                );
                return Ok(());
            }

            let mut updated_targets: Option<Vec<model::BindingTarget>> = None;
            let mut guard = state
                .active_profile
                .lock()
                .map_err(|_| "Lock poisoned".to_string())?;
            if let Some(active_profile) = guard.as_ref() {
                let mut updated_profile = active_profile.profile().clone();
                if let Some(stored) = updated_profile
                    .bindings
                    .iter_mut()
                    .find(|binding| binding.id == owner.id)
                {
                    if apply_assign_transition(stored, transition, new_target.as_ref()) {
                        updated_targets = Some(stored.normalized_targets());
                    }
                }
                if updated_targets.is_some() {
                    state
                        .profile_store
                        .save_profile(updated_profile.clone())
                        .map_err(|err| err.to_string())?;
                    *guard = Some(AppState::profile_snapshot(updated_profile.clone()));
                    state.sync_feedback_values(&updated_profile);
                    state.send_idle_button_light_feedback_values(&updated_profile);
                }
            }
            drop(guard);

            if let Some(updated_targets) = updated_targets {
                let mut payload = serde_json::json!({
                    "binding_id": owner.id,
                    "targets": updated_targets
                });
                if let Some(target) = new_target {
                    payload["target"] = serde_json::json!(target);
                }
                let _ = app.emit("binding_aux_assign_update", payload);
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
        let outcome = binding_actions::execute_target_action(
            app,
            state,
            &owner,
            &model::BindingAction::ToggleMute,
            if next_muted { 1.0 } else { 0.0 },
            binding_actions::ActionExecutionContext::local("bindings"),
        )?;
        if !outcome.applied() {
            run_logger::warn(
                "bindings",
                "aux_mute_no_target_applied",
                &format!("binding_id={} targets={}", owner.id, targets.len()),
            );
            return Ok(());
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

        let owner_targets = owner.normalized_targets_ref();
        let binding_primary_target = outcome
            .applied_target_indices
            .first()
            .and_then(|index| owner_targets.get(*index))
            .cloned();
        for target_index in outcome.applied_target_indices {
            let Some(target) = owner_targets.get(target_index) else {
                continue;
            };
            let focus_session = if matches!(target, model::BindingTarget::Focus) {
                state.audio.focused_session().ok().flatten()
            } else {
                None
            };
            let payload = crate::binding_events::binding_event_payload(
                &owner,
                &binding_primary_target,
                serde_json::json!({
                  "target": target,
                  "muted": next_muted,
                  "action": "toggle_mute",
                  "focus_session": focus_session,
                }),
            );
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

#[cfg(test)]
mod tests {
    use super::*;

    fn assignment_binding(targets: serde_json::Value) -> model::Binding {
        serde_json::from_value(serde_json::json!({
            "id": "assign-test",
            "name": "Assign Test",
            "device_id": "midi-dev",
            "control": {
                "channel": 0,
                "controller": 7,
                "msg_type": "ControlChange"
            },
            "control_kind": "Continuous",
            "targets": targets,
            "action": "Volume",
            "mode": "Absolute",
            "deadzone": 0.0,
            "debounce_ms": 0
        }))
        .expect("test binding should deserialize")
    }

    #[test]
    fn assign_transition_resolves_every_mode_and_target_state() {
        assert_eq!(
            resolve_assign_transition(&model::AssignMode::Add, false),
            AssignTransition::AddFocused
        );
        assert_eq!(
            resolve_assign_transition(&model::AssignMode::Add, true),
            AssignTransition::AddFocused
        );
        assert_eq!(
            resolve_assign_transition(&model::AssignMode::Replace, false),
            AssignTransition::ReplaceFocused
        );
        assert_eq!(
            resolve_assign_transition(&model::AssignMode::Replace, true),
            AssignTransition::ReplaceFocused
        );
        assert_eq!(
            resolve_assign_transition(&model::AssignMode::Clear, false),
            AssignTransition::AddFocused
        );
        assert_eq!(
            resolve_assign_transition(&model::AssignMode::Clear, true),
            AssignTransition::ClearTargets
        );
    }

    #[test]
    fn clear_transition_canonically_clears_modern_and_legacy_targets() {
        let mut binding = assignment_binding(serde_json::json!(["Master", "Focus"]));
        binding.ensure_targets();

        assert!(apply_assign_transition(
            &mut binding,
            AssignTransition::ClearTargets,
            None
        ));
        assert_eq!(binding.targets, vec![model::BindingTarget::Unset]);
        assert_eq!(binding.target, model::BindingTarget::Unset);

        binding.ensure_targets();
        assert_eq!(binding.targets, vec![model::BindingTarget::Unset]);
        assert_eq!(binding.target, model::BindingTarget::Unset);
    }

    #[test]
    fn add_and_replace_transitions_update_targets_as_expected() {
        let mut binding = assignment_binding(serde_json::json!(["Master"]));
        let focused = model::BindingTarget::Application {
            name: "spotify".to_string(),
            display_name: Some("Spotify".to_string()),
            icon_data: None,
        };

        assert!(apply_assign_transition(
            &mut binding,
            AssignTransition::AddFocused,
            Some(&focused)
        ));
        assert_eq!(binding.normalized_targets().len(), 2);
        assert!(!apply_assign_transition(
            &mut binding,
            AssignTransition::AddFocused,
            Some(&focused)
        ));

        assert!(apply_assign_transition(
            &mut binding,
            AssignTransition::ReplaceFocused,
            Some(&focused)
        ));
        assert_eq!(binding.normalized_targets(), vec![focused]);
    }
}

use crate::binding_actions;
use crate::feedback::{self, FeedbackControlKey, FeedbackSendOptions};
use crate::run_logger;
use crate::{bindings::BindingKey, model, model::Binding, AppState};
use futures_util::future::join_all;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

struct RunningMacroGuard {
    running: Arc<Mutex<HashSet<String>>>,
    binding_id: String,
}

impl RunningMacroGuard {
    fn try_start(state: &AppState, binding_id: &str) -> Option<Self> {
        let mut running = state.running_macros.lock().ok()?;
        if !running.insert(binding_id.to_string()) {
            return None;
        }
        Some(Self {
            running: state.running_macros.clone(),
            binding_id: binding_id.to_string(),
        })
    }
}

impl Drop for RunningMacroGuard {
    fn drop(&mut self) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(&self.binding_id);
        }
    }
}

fn send_resolved_binding_feedback(
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

fn resolved_binding_feedback_control_key(binding: &Binding) -> FeedbackControlKey {
    feedback::binding_feedback_control_key(binding)
}

fn binding_has_clearable_feedback_output(binding: &Binding) -> bool {
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

fn active_feedback_outputs(bindings: &[Binding]) -> HashSet<FeedbackControlKey> {
    bindings
        .iter()
        .filter(|binding| binding_has_clearable_feedback_output(binding))
        .map(resolved_binding_feedback_control_key)
        .collect()
}

fn stale_feedback_bindings_for_removed_outputs(
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

fn should_clear_stale_feedback_hardware(previous: &Binding, replacement: Option<&Binding>) -> bool {
    previous.is_button_binding()
        || !replacement
            .is_some_and(|current| current.id == previous.id && !current.feedback_enabled)
}

fn clear_binding_feedback_output(state: &AppState, binding: &Binding, clear_hardware: bool) {
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
                let _ = midi.send_binding_feedback(binding, 0.0);
            }
        }
    }
}

fn action_can_run_from_command(action: &model::BindingAction) -> bool {
    matches!(
        action,
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
            | model::BindingAction::Hotkey
            | model::BindingAction::OpenApplication
            | model::BindingAction::MediaPlayPause
            | model::BindingAction::MediaNextTrack
            | model::BindingAction::MediaPrevTrack
            | model::BindingAction::MediaStop
            | model::BindingAction::SwitchProfile
            | model::BindingAction::Macro
            | model::BindingAction::Soundboard
    )
}

fn action_binding_from_macro_step(parent: &Binding, step: &model::MacroActionStep) -> Binding {
    let mut binding = parent.clone();
    binding.action = step.action.clone();
    binding.targets = step.targets.clone();
    binding.target = binding
        .targets
        .first()
        .cloned()
        .unwrap_or(model::BindingTarget::Unset);
    binding.hotkey = step.hotkey.clone();
    binding.open_application = step.open_application.clone();
    binding.autohotkey_script = step.autohotkey_script.clone();
    binding.macro_steps = Vec::new();
    binding
}

fn resolve_macro_action_value(
    state: &AppState,
    parent: &Binding,
    action_binding: &Binding,
    step: &model::MacroActionStep,
) -> f32 {
    let state_value = step.state.clone();
    match action_binding.action {
        model::BindingAction::Volume => step.value.unwrap_or(1.0).clamp(0.0, 1.0),
        model::BindingAction::ToggleMute => match state_value {
            model::MacroActionState::On | model::MacroActionState::Mute => 1.0,
            model::MacroActionState::Off | model::MacroActionState::Unmute => 0.0,
            model::MacroActionState::Default | model::MacroActionState::Toggle => {
                let key = BindingKey::from_binding(parent);
                let current = state.current_binding_toggle_state(&action_binding.targets, &key);
                if current {
                    0.0
                } else {
                    1.0
                }
            }
        },
        model::BindingAction::ToggleEffect => match state_value {
            model::MacroActionState::Off | model::MacroActionState::Unmute => 0.0,
            model::MacroActionState::Default | model::MacroActionState::Toggle => {
                let key = BindingKey::from_binding(parent);
                let current = state
                    .binding_action_value(&key)
                    .map(|value| value > 0.5)
                    .unwrap_or(false);
                if current {
                    0.0
                } else {
                    1.0
                }
            }
            model::MacroActionState::On | model::MacroActionState::Mute => 1.0,
        },
        _ => step.value.unwrap_or(1.0).clamp(0.0, 1.0),
    }
}

fn apply_action_binding_without_feedback(
    app: &AppHandle,
    state: &AppState,
    binding: &Binding,
    action: model::BindingAction,
    value: f32,
    source: Option<&str>,
    source_sequence: Option<u64>,
) -> Result<bool, String> {
    if !action_can_run_from_command(&action) || matches!(action, model::BindingAction::Macro) {
        run_logger::warn(
            "bindings_cmd",
            "macro_action_unsupported",
            &format!("binding_id={} action={:?}", binding.id, action),
        );
        return Ok(false);
    }

    if binding_actions::apply_special_button_action(app, binding, &action, value, "bindings_cmd") {
        return Ok(true);
    }

    binding_actions::execute_target_action(
        app,
        state,
        binding,
        &action,
        value,
        binding_actions::ActionExecutionContext {
            source,
            source_sequence,
            log_target: "bindings_cmd",
        },
    )
    .map(|outcome| outcome.applied())
}

fn macro_action_config_error(binding: &Binding) -> Option<String> {
    match binding.action {
        model::BindingAction::Hotkey => {
            let keys = binding
                .hotkey
                .as_ref()
                .map(|hotkey| hotkey.keys.len())
                .unwrap_or(0);
            if keys == 0 {
                Some("Hotkey is not configured".to_string())
            } else {
                None
            }
        }
        model::BindingAction::OpenApplication => {
            let path = binding
                .open_application
                .as_ref()
                .map(|mapping| mapping.path.trim())
                .unwrap_or("");
            if path.is_empty() {
                Some("Open Application path is not configured".to_string())
            } else if !Path::new(path).is_file() {
                Some(format!("Application not found: {}", path))
            } else {
                None
            }
        }
        model::BindingAction::RunAutoHotkeyScript => {
            let path = binding
                .autohotkey_script
                .as_ref()
                .map(|mapping| mapping.path.trim())
                .unwrap_or("");
            if path.is_empty() {
                Some("AutoHotkey script path is not configured".to_string())
            } else if !Path::new(path).is_file() {
                Some(format!("AutoHotkey script not found: {}", path))
            } else {
                None
            }
        }
        model::BindingAction::FocusWindow => {
            if binding_actions::binding_focus_target_name(binding).is_none() {
                Some("Focus Window target is not configured".to_string())
            } else {
                None
            }
        }
        _ => None,
    }
}

async fn execute_macro_action_step(
    app: &AppHandle,
    state: &AppState,
    parent: &Binding,
    step: &model::MacroActionStep,
    source_sequence: u64,
) -> Result<(), String> {
    let action_binding = action_binding_from_macro_step(parent, step);
    if let Some(err) = macro_action_config_error(&action_binding) {
        return Err(err);
    }
    let value = resolve_macro_action_value(state, parent, &action_binding, step);
    let applied = apply_action_binding_without_feedback(
        app,
        state,
        &action_binding,
        action_binding.action.clone(),
        value,
        Some("macro"),
        Some(source_sequence),
    )?;

    if matches!(
        action_binding.action,
        model::BindingAction::ToggleMute | model::BindingAction::ToggleEffect
    ) {
        state.set_binding_action_value(&BindingKey::from_binding(parent), value);
    }

    if applied {
        Ok(())
    } else {
        Err(format!(
            "No target handled action {:?}",
            action_binding.action
        ))
    }
}

async fn run_macro_binding(
    app: AppHandle,
    state: &AppState,
    binding: Binding,
    silent: bool,
) -> Result<(), String> {
    if !matches!(binding.action, model::BindingAction::Macro) {
        return Ok(());
    }

    let Some(_guard) = RunningMacroGuard::try_start(state, &binding.id) else {
        run_logger::debug(
            "bindings_cmd",
            "macro_retrigger_ignored",
            &format!("binding_id={}", binding.id),
        );
        return Ok(());
    };

    let steps = model::normalize_macro_steps(&binding.macro_steps);
    if steps.is_empty() {
        run_logger::warn(
            "bindings_cmd",
            "macro_empty",
            &format!("binding_id={}", binding.id),
        );
        return Ok(());
    }

    let mut failures: Vec<String> = Vec::new();
    let mut sequence = 0_u64;
    for (index, step) in steps.iter().enumerate() {
        sequence += 1;
        match step {
            model::MacroStep::Action(action_step) => {
                if let Err(err) =
                    execute_macro_action_step(&app, state, &binding, action_step, sequence).await
                {
                    run_logger::warn(
                        "bindings_cmd",
                        "macro_step_failed",
                        &format!("binding_id={} step={} error={}", binding.id, index + 1, err),
                    );
                    failures.push(format!("Step {}: {}", index + 1, err));
                }
            }
            model::MacroStep::Wait { duration_ms } => {
                tokio::time::sleep(Duration::from_millis(
                    (*duration_ms).min(model::MACRO_MAX_WAIT_MS),
                ))
                .await;
            }
            model::MacroStep::Parallel { steps } => {
                let futures = steps.iter().enumerate().map(|(child_index, action_step)| {
                    let child_sequence = sequence + child_index as u64;
                    execute_macro_action_step(&app, state, &binding, action_step, child_sequence)
                });
                for (child_index, result) in join_all(futures).await.into_iter().enumerate() {
                    if let Err(err) = result {
                        run_logger::warn(
                            "bindings_cmd",
                            "macro_parallel_step_failed",
                            &format!(
                                "binding_id={} step={} child={} error={}",
                                binding.id,
                                index + 1,
                                child_index + 1,
                                err
                            ),
                        );
                        failures.push(format!("Step {}.{}: {}", index + 1, child_index + 1, err));
                    }
                }
                sequence += steps.len() as u64;
            }
        }
    }

    if !failures.is_empty() {
        let _ = app.emit(
            "binding_action_error",
            serde_json::json!({
                "reason": "macro_completed_with_warnings",
                "binding_id": binding.id,
                "title": "Macro Completed with Warnings",
                "message": format!("{} macro step(s) failed. Check the logs for details.", failures.len()),
                "silent": silent,
            }),
        );
    }

    Ok(())
}

pub fn spawn_macro_binding(app: AppHandle, binding_id: String, silent: bool) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let binding = {
            let profile_guard = match state.active_profile.lock() {
                Ok(profile) => profile,
                Err(_) => return,
            };
            let Some(profile) = profile_guard.as_ref() else {
                return;
            };
            match profile
                .bindings
                .iter()
                .find(|binding| binding.id == binding_id)
            {
                Some(binding) => binding.clone(),
                None => return,
            }
        };
        if let Err(err) = run_macro_binding(app.clone(), &state, binding, silent).await {
            run_logger::warn(
                "bindings_cmd",
                "macro_spawn_failed",
                &format!("binding_id={} error={}", binding_id, err),
            );
        }
    });
}

#[tauri::command]
pub fn add_binding(state: State<AppState>, binding: Binding) -> Result<(), String> {
    add_binding_to_active_profile(state.inner(), binding)
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

#[tauri::command]
pub async fn remove_binding(state: State<'_, AppState>, binding: Binding) -> Result<(), String> {
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
        &state,
        std::slice::from_ref(&binding),
        current_bindings,
    );

    // Send 0.0 value to the binding's feedback destination.
    if let Ok(mut midi) = state.midi.lock() {
        if binding.is_button_binding() {
            let _ = midi.send_binding_light_feedback(&binding, 0.0);
        } else {
            let _ = midi.send_binding_feedback(&binding, 0.0);
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

#[tauri::command]
pub fn update_midi_feedback(
    state: State<'_, AppState>,
    target: model::BindingTarget,
    value: f32,
    binding_id: Option<String>,
    action: Option<model::BindingAction>,
) -> Result<(), String> {
    let matched_bindings: Vec<Binding> = {
        let profile_guard = state.active_profile.lock().map_err(|_| "Lock poisoned")?;
        let profile = match profile_guard.as_ref() {
            Some(p) => p,
            None => return Ok(()),
        };

        profile
            .bindings
            .iter()
            .filter(|binding| {
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
            })
            .cloned()
            .collect()
    };

    for binding in matched_bindings {
        let key = BindingKey::from_binding(&binding);
        let state_active = if binding.uses_stateful_toggle_feedback() {
            Some(value > 0.5)
        } else {
            None
        };
        let button_light_value = state.button_light_feedback_value(&binding, None, state_active);
        let feedback_value = button_light_value.unwrap_or(value);

        let is_note = matches!(binding.control.msg_type, model::MidiMessageType::Note);
        if feedback::binding_user_active(&state, &key, is_note) {
            run_logger::debug(
                "bindings_cmd",
                "feedback_skipped_user_active",
                &format!("binding_id={} is_note={}", binding.id, is_note),
            );
            continue;
        }

        if binding.is_button_binding() {
            feedback::send_button_light_feedback_to_binding(
                &state,
                &binding,
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
            &state,
            &binding,
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
    let profile_bindings = {
        let profile_guard = state.active_profile.lock().map_err(|_| "Lock poisoned")?;
        match profile_guard.as_ref() {
            Some(p) => p.bindings.clone(),
            None => return Ok(()),
        }
    };

    let binding = match profile_bindings.iter().find(|b| b.id == binding_id) {
        Some(b) => b.clone(),
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
    let button_light_value =
        state.button_light_feedback_value(&binding, input_active, state_active);
    let feedback_value = button_light_value.unwrap_or(value);
    if binding.uses_stateful_toggle_feedback()
        || matches!(
            effective_action,
            model::BindingAction::ToggleMute | model::BindingAction::ToggleEffect
        )
    {
        state.set_binding_action_value(&BindingKey::from_binding(&binding), value);
    }
    if matches!(effective_action, model::BindingAction::Volume) {
        state.sync_relative_volume_binding_state(&binding, value);
    }

    let silent = silent.unwrap_or(false);
    let force_hardware_feedback = force_hardware_feedback.unwrap_or(false);
    if action_matches_binding {
        send_resolved_binding_feedback(
            &state,
            &binding,
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
            let emitted_key = resolved_binding_feedback_control_key(&binding);
            emitted_controls.insert(emitted_key);
        }

        for candidate in &profile_bindings {
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
                let candidate_button_light_value =
                    state.button_light_feedback_value(candidate, None, Some(value > 0.5));
                let emitted_key = resolved_binding_feedback_control_key(candidate);
                if candidate.feedback_enabled && emitted_controls.insert(emitted_key) {
                    let candidate_value = candidate_button_light_value.unwrap_or(value);
                    send_resolved_binding_feedback(
                        &state,
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
            let emitted_key = resolved_binding_feedback_control_key(&binding);
            emitted_controls.insert(emitted_key);
        }
        for candidate in &profile_bindings {
            if !matches!(candidate.action, model::BindingAction::Volume) {
                continue;
            }
            if !feedback::targets_overlap(candidate, &binding) {
                continue;
            }
            state.sync_relative_volume_binding_state(candidate, value);
            let candidate_button_light_value =
                state.button_light_feedback_value(candidate, input_active, None);
            let emitted_key = resolved_binding_feedback_control_key(candidate);
            if candidate.feedback_enabled && emitted_controls.insert(emitted_key) {
                let candidate_value = candidate_button_light_value.unwrap_or(value);
                send_resolved_binding_feedback(
                    &state,
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
            let payload = serde_json::json!({
              "target": primary_target.clone(),
              "muted": muted,
              "action": "toggle_mute",
              "focus_session": focus_session,
              "binding_id": binding.id,
              "binding_name": binding.name,
              "binding_primary_target": primary_target,
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
              "target": primary_target.clone(),
              "volume": value,
              "focus_session": focus_session,
              "binding_id": binding.id,
              "binding_name": binding.name,
              "binding_primary_target": primary_target,
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
pub fn set_integration_connection_state(
    state: State<'_, AppState>,
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn apply_binding_action(
    app: AppHandle,
    state: State<'_, AppState>,
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
        return run_macro_binding(app, state.inner(), binding, silent.unwrap_or(false)).await;
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
        &state,
        &binding,
        &effective_action,
        value,
        binding_actions::ActionExecutionContext {
            source: source.as_deref(),
            source_sequence,
            log_target: "bindings_cmd",
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
            last_absolute_input: None,
            absolute_input_direction: 0,
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
            macro_name: String::new(),
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
            button_light_behavior: model::ButtonLightBehavior::FollowState,
            feedback_enabled: true,
            indicator_control: None,
            mute_control: None,
            assign_control: None,
            assign_mode: model::AssignMode::Add,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
            soundboard: None,
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
    fn stale_feedback_outputs_include_replaced_indicator_destination() {
        let mut previous = integration_button_binding("stateful");
        previous.control.controller = 21;

        let mut next = previous.clone();
        next.indicator_control = Some(indicator_control(22));

        let active_outputs = active_feedback_outputs(&[next]);
        let stale =
            stale_feedback_bindings_for_removed_outputs(&[previous.clone()], &active_outputs);

        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].id, previous.id);
    }

    #[test]
    fn stale_feedback_outputs_keep_destinations_used_by_other_bindings() {
        let mut previous = integration_button_binding("stateful");
        previous.control.controller = 21;

        let mut next = previous.clone();
        next.indicator_control = Some(indicator_control(22));

        let mut other = integration_button_binding("stateful");
        other.id = "b2".to_string();
        other.control.controller = 30;
        other.indicator_control = Some(indicator_control(21));

        let active_outputs = active_feedback_outputs(&[next, other]);
        let stale = stale_feedback_bindings_for_removed_outputs(&[previous], &active_outputs);

        assert!(stale.is_empty());
    }

    #[test]
    fn resolved_feedback_control_key_uses_indicator_for_button_bindings() {
        let mut binding = integration_button_binding("stateful");
        binding.control.controller = 21;
        binding.indicator_control = Some(indicator_control(22));

        let key = resolved_binding_feedback_control_key(&binding);

        assert_eq!(key.device_id, "midi-dev");
        assert_eq!(key.controller, 22);
        assert_eq!(key.msg_type, model::MidiMessageType::Note);
    }

    #[test]
    fn resolved_feedback_control_key_uses_indicator_for_continuous_bindings() {
        let mut binding = integration_button_binding("stateful");
        binding.control_kind = model::BindingControlKind::Continuous;
        binding.control.controller = 21;
        binding.indicator_control = Some(indicator_control(22));

        let key = resolved_binding_feedback_control_key(&binding);

        assert_eq!(key.device_id, "midi-dev");
        assert_eq!(key.controller, 22);
        assert_eq!(key.msg_type, model::MidiMessageType::Note);
    }

    #[test]
    fn stale_feedback_outputs_include_replaced_continuous_indicator_destination() {
        let mut previous = integration_button_binding("stateful");
        previous.control_kind = model::BindingControlKind::Continuous;
        previous.control.controller = 21;
        previous.indicator_control = Some(indicator_control(22));

        let mut next = previous.clone();
        next.indicator_control = Some(indicator_control(23));

        let active_outputs = active_feedback_outputs(&[next]);
        let stale =
            stale_feedback_bindings_for_removed_outputs(&[previous.clone()], &active_outputs);

        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].id, previous.id);
    }

    #[test]
    fn disabled_bindings_are_not_active_primary_feedback_outputs() {
        let mut binding = integration_button_binding("stateful");
        binding.feedback_enabled = false;
        binding.indicator_control = Some(indicator_control(22));

        assert!(active_feedback_outputs(&[binding]).is_empty());
    }

    #[test]
    fn disabling_button_feedback_clears_hardware_but_disabling_fader_does_not() {
        let button = integration_button_binding("stateful");
        let mut disabled_button = button.clone();
        disabled_button.feedback_enabled = false;
        assert!(should_clear_stale_feedback_hardware(
            &button,
            Some(&disabled_button)
        ));

        let mut fader = integration_button_binding("stateful");
        fader.control_kind = model::BindingControlKind::Continuous;
        let mut disabled_fader = fader.clone();
        disabled_fader.feedback_enabled = false;
        assert!(!should_clear_stale_feedback_hardware(
            &fader,
            Some(&disabled_fader)
        ));
        assert!(should_clear_stale_feedback_hardware(&fader, None));
    }

    #[test]
    fn note_button_is_active_only_while_input_is_pressed() {
        assert!(feedback::binding_state_user_active(
            &binding_state(1.0, 10),
            true
        ));
        assert!(feedback::binding_state_user_active(
            &binding_state(63.0 / 127.0, 10),
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

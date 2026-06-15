use crate::binding_actions::{self, IntegrationBatchTrigger, IntegrationTrigger};
use crate::feedback::{self, FeedbackControlKey, FeedbackSendOptions};
use crate::run_logger;
use crate::{bindings::BindingKey, model, model::Binding, AppState};
use futures_util::future::join_all;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
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
            | model::BindingAction::Macro
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

    apply_binding_action_internal(app, state, binding, action, value, source, source_sequence)
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
            midi_device_preference_set: false,
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
    state: State<'_, AppState>,
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
    if matches!(effective_action, model::BindingAction::Volume) {
        state.sync_relative_volume_binding_state(&binding, value);
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
            state.sync_relative_volume_binding_state(candidate, value);
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
            mute_control: None,
            assign_control: None,
            assign_mode: model::AssignMode::Add,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
            macro_steps: Vec::new(),
        }
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

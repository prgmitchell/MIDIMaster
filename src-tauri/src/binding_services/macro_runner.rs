use super::*;

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

pub(super) fn action_can_run_from_command(action: &model::BindingAction) -> bool {
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

pub(super) fn action_binding_from_macro_step(
    parent: &Binding,
    step: &model::MacroActionStep,
) -> Binding {
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

pub(super) fn resolve_macro_action_value(
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

pub(super) fn apply_action_binding_without_feedback(
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
            midi_input: None,
            integrations_only: false,
        },
    )
    .map(|outcome| outcome.applied())
}

pub(super) fn macro_action_config_error(binding: &Binding) -> Option<String> {
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

pub(super) async fn execute_macro_action_step(
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

pub(super) async fn run_macro_binding(
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

use super::*;

pub fn emit_localized_action_error(
    app: &AppHandle,
    reason: &str,
    binding_id: &str,
    title_key: &str,
    message_key: &str,
    params: serde_json::Value,
) {
    let _ = app.emit(
        "binding_action_error",
        serde_json::json!({
            "reason": reason,
            "binding_id": binding_id,
            "title_key": title_key,
            "message_key": message_key,
            "params": params,
        }),
    );
}

pub(super) fn autohotkey_script_display(binding: &Binding) -> String {
    binding
        .autohotkey_script
        .as_ref()
        .map(|mapping| {
            let display = mapping.display.trim();
            if display.is_empty() {
                mapping.path.trim()
            } else {
                display
            }
            .to_string()
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "AutoHotkey script".to_string())
}

pub(super) fn open_application_display(binding: &Binding) -> String {
    binding
        .open_application
        .as_ref()
        .map(|mapping| {
            let display = mapping.display.trim();
            if display.is_empty() {
                mapping.path.trim()
            } else {
                display
            }
            .to_string()
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "application".to_string())
}

pub(super) fn is_press_only_button_action(action: &model::BindingAction) -> bool {
    matches!(
        action,
        model::BindingAction::MediaPlayPause
            | model::BindingAction::MediaNextTrack
            | model::BindingAction::MediaPrevTrack
            | model::BindingAction::MediaStop
            | model::BindingAction::Hotkey
            | model::BindingAction::OpenApplication
            | model::BindingAction::FocusWindow
            | model::BindingAction::FullScreenshot
            | model::BindingAction::SnipScreenshot
            | model::BindingAction::ToggleScreenRecording
            | model::BindingAction::RunAutoHotkeyScript
            | model::BindingAction::SwitchProfile
    )
}

pub fn request_profile_switch(app: &AppHandle, binding: &Binding, log_target: &str) {
    let profile_name = binding.normalized_targets_ref().iter().find_map(|target| {
        if let BindingTarget::Profile { name } = target {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        None
    });

    let Some(profile_name) = profile_name else {
        run_logger::warn(
            log_target,
            "profile_switch_missing_target",
            &format!("binding_id={}", binding.id),
        );
        emit_localized_action_error(
            app,
            "profile_switch_missing_target",
            &binding.id,
            "dialogs.profileSwitchUnavailableTitle",
            "dialogs.profileSwitchMissingTargetMessage",
            serde_json::json!({}),
        );
        return;
    };

    run_logger::info(
        log_target,
        "profile_switch_requested",
        &format!("binding_id={} profile={}", binding.id, profile_name),
    );
    let _ = app.emit(
        "profile_switch_requested",
        serde_json::json!({
            "binding_id": binding.id,
            "name": profile_name,
        }),
    );
}

pub fn run_autohotkey_script_action(app: &AppHandle, binding: &Binding, log_target: &str) {
    let Some(script) = binding.autohotkey_script.as_ref() else {
        run_logger::warn(
            log_target,
            "autohotkey_script_missing_config",
            &format!("binding_id={}", binding.id),
        );
        emit_localized_action_error(
            app,
            "autohotkey_script_missing_config",
            &binding.id,
            "dialogs.autoHotkeyNotConfiguredTitle",
            "dialogs.autoHotkeyNotConfiguredMessage",
            serde_json::json!({}),
        );
        return;
    };

    let script_path = script.path.trim();
    if script_path.is_empty() || !Path::new(script_path).is_file() {
        let display = autohotkey_script_display(binding);
        run_logger::warn(
            log_target,
            "autohotkey_script_path_missing",
            &format!("binding_id={} path={}", binding.id, script_path),
        );
        emit_localized_action_error(
            app,
            "autohotkey_script_path_missing",
            &binding.id,
            "dialogs.autoHotkeyScriptNotFoundTitle",
            "dialogs.autoHotkeyScriptNotFoundMessage",
            serde_json::json!({ "name": display }),
        );
        return;
    }

    match open_path_with_shell_association(Path::new(script_path)) {
        Ok(()) => {
            run_logger::info(
                log_target,
                "autohotkey_script_launched",
                &format!("binding_id={} path={}", binding.id, script_path),
            );
        }
        Err(err) if err.starts_with("no_association:") => {
            run_logger::warn(
                log_target,
                "autohotkey_script_no_association",
                &format!("binding_id={} path={}", binding.id, script_path),
            );
            emit_localized_action_error(
                app,
                "autohotkey_script_no_association",
                &binding.id,
                "dialogs.autoHotkeyNoAssociationTitle",
                "dialogs.autoHotkeyNoAssociationMessage",
                serde_json::json!({}),
            );
        }
        Err(err) => {
            run_logger::error(
                log_target,
                "autohotkey_script_launch_failed",
                &format!(
                    "binding_id={} path={} error={}",
                    binding.id, script_path, err
                ),
            );
            emit_localized_action_error(
                app,
                "autohotkey_script_launch_failed",
                &binding.id,
                "dialogs.autoHotkeyLaunchFailedTitle",
                "dialogs.autoHotkeyLaunchFailedMessage",
                serde_json::json!({ "message": err }),
            );
        }
    }
}

pub fn binding_focus_target_name(binding: &Binding) -> Option<String> {
    binding.normalized_targets_ref().iter().find_map(|target| {
        if let BindingTarget::Application { name, .. } = target {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        None
    })
}

pub fn apply_special_button_action(
    app: &AppHandle,
    binding: &Binding,
    action: &model::BindingAction,
    value: f32,
    log_target: &str,
) -> bool {
    if value <= 0.0 && is_press_only_button_action(action) {
        return true;
    }

    match action {
        model::BindingAction::MediaPlayPause
        | model::BindingAction::MediaNextTrack
        | model::BindingAction::MediaPrevTrack
        | model::BindingAction::MediaStop => {
            let vk: u16 = match action {
                model::BindingAction::MediaPlayPause => 0xB3,
                model::BindingAction::MediaNextTrack => 0xB0,
                model::BindingAction::MediaPrevTrack => 0xB1,
                model::BindingAction::MediaStop => 0xB2,
                _ => unreachable!(),
            };
            send_media_key(vk);
            run_logger::info(
                log_target,
                "media_action_sent",
                &format!(
                    "binding_id={} action={:?} keycode={}",
                    binding.id, action, vk
                ),
            );
            true
        }
        model::BindingAction::Hotkey => {
            if let Some(hotkey) = &binding.hotkey {
                if !hotkey.keys.is_empty() {
                    send_hotkey(&hotkey.keys);
                    run_logger::info(
                        log_target,
                        "hotkey_action_sent",
                        &format!(
                            "binding_id={} action={:?} hotkey={}",
                            binding.id, action, hotkey.display
                        ),
                    );
                }
            }
            true
        }
        model::BindingAction::OpenApplication => {
            let Some(open_app) = binding.open_application.as_ref() else {
                run_logger::warn(
                    log_target,
                    "open_application_missing_config",
                    &format!("binding_id={}", binding.id),
                );
                let _ = app.emit(
                    "binding_action_error",
                    serde_json::json!({
                        "reason": "open_application_missing_config",
                        "binding_id": binding.id,
                        "title": "Open Application Not Configured",
                        "message": "Choose an executable for this binding's Open Application action.",
                    }),
                );
                return true;
            };

            let app_path = open_app.path.trim();
            if app_path.is_empty() || !Path::new(app_path).is_file() {
                let display = open_application_display(binding);
                run_logger::warn(
                    log_target,
                    "open_application_path_missing",
                    &format!("binding_id={} path={}", binding.id, app_path),
                );
                let _ = app.emit(
                    "binding_action_error",
                    serde_json::json!({
                        "reason": "open_application_path_missing",
                        "binding_id": binding.id,
                        "title": "Application Not Found",
                        "message": format!("MIDIMaster couldn't find \"{}\". Re-select the .exe path in this binding.", display),
                    }),
                );
                return true;
            }

            match ProcessCommand::new(app_path).spawn() {
                Ok(_) => {
                    run_logger::info(
                        log_target,
                        "open_application_launched",
                        &format!("binding_id={} path={}", binding.id, app_path),
                    );
                }
                Err(err) => {
                    run_logger::error(
                        log_target,
                        "open_application_launch_failed",
                        &format!("binding_id={} path={} error={}", binding.id, app_path, err),
                    );
                    let _ = app.emit(
                        "binding_action_error",
                        serde_json::json!({
                            "reason": "open_application_launch_failed",
                            "binding_id": binding.id,
                            "title": "Launch Failed",
                            "message": format!("MIDIMaster couldn't open this application: {}", err),
                        }),
                    );
                }
            }
            true
        }
        model::BindingAction::FocusWindow => {
            let Some(process_name) = binding_focus_target_name(binding) else {
                emit_localized_action_error(
                    app,
                    "focus_window_missing_target",
                    &binding.id,
                    "dialogs.focusWindowUnavailableTitle",
                    "dialogs.focusWindowMissingTargetMessage",
                    serde_json::json!({}),
                );
                return true;
            };
            if let Err(err) = focus_window_by_process_name(&process_name) {
                run_logger::warn(
                    log_target,
                    "focus_window_failed",
                    &format!(
                        "binding_id={} process={} error={}",
                        binding.id, process_name, err
                    ),
                );
                emit_localized_action_error(
                    app,
                    "focus_window_unavailable",
                    &binding.id,
                    "dialogs.focusWindowUnavailableTitle",
                    "dialogs.focusWindowUnavailableMessage",
                    serde_json::json!({ "name": process_name }),
                );
            }
            true
        }
        model::BindingAction::FullScreenshot => {
            if !binding
                .normalized_targets_ref()
                .iter()
                .any(|target| matches!(target, BindingTarget::CaptureControl))
            {
                return true;
            }
            send_hotkey(&["META".to_string(), "PRINTSCREEN".to_string()]);
            true
        }
        model::BindingAction::SnipScreenshot => {
            if !binding
                .normalized_targets_ref()
                .iter()
                .any(|target| matches!(target, BindingTarget::CaptureControl))
            {
                return true;
            }
            send_hotkey(&["META".to_string(), "SHIFT".to_string(), "S".to_string()]);
            true
        }
        model::BindingAction::ToggleScreenRecording => {
            if !binding
                .normalized_targets_ref()
                .iter()
                .any(|target| matches!(target, BindingTarget::CaptureControl))
            {
                return true;
            }
            send_hotkey(&["META".to_string(), "ALT".to_string(), "R".to_string()]);
            true
        }
        model::BindingAction::RunAutoHotkeyScript => {
            run_autohotkey_script_action(app, binding, log_target);
            true
        }
        model::BindingAction::SwitchProfile => {
            request_profile_switch(app, binding, log_target);
            true
        }
        _ => false,
    }
}

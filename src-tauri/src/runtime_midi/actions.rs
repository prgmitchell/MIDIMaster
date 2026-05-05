use crate::bindings::BindingKey;
use crate::model::{self, Binding, BindingTarget, MidiEvent};
use crate::run_logger;
use crate::runtime_helpers::{focus_window_by_process_name, send_hotkey, send_media_key};
use crate::AppState;
use std::path::Path;
use std::process::Command as ProcessCommand;
use tauri::{AppHandle, Emitter};

fn emit_button_feedback(
    state: &AppState,
    app: &AppHandle,
    binding: &Binding,
    event: &MidiEvent,
    targets: &[BindingTarget],
    value: f32,
) {
    let key = BindingKey::from_event(event);
    if let Ok(mut feedback) = state.feedback_values.lock() {
        feedback.insert(key, value);
    }
    if let Ok(mut midi) = state.midi.lock() {
        let _ = midi.send_feedback(
            &binding.device_id,
            binding.control.channel,
            binding.control.controller,
            value,
            binding.control.msg_type.clone(),
        );
    }
    let payload = serde_json::json!({
      "target": targets.first().unwrap_or(&BindingTarget::Unset),
      "volume": value,
      "binding_id": binding.id,
      "source": "button_feedback",
    });
    let _ = app.emit("volume_update", payload);
}

fn emit_localized_action_error(
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

fn focus_target_name(targets: &[BindingTarget]) -> Option<String> {
    targets.iter().find_map(|target| {
        if let BindingTarget::Application { name, .. } = target {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        None
    })
}

pub(super) fn handle_special_action(
    state: &AppState,
    app: &AppHandle,
    binding: &Binding,
    targets: &[BindingTarget],
    event: &MidiEvent,
) -> Result<bool, String> {
    // Handle media key actions (fire-and-forget, no state tracking)
    if matches!(
        binding.action,
        model::BindingAction::MediaPlayPause
            | model::BindingAction::MediaNextTrack
            | model::BindingAction::MediaPrevTrack
            | model::BindingAction::MediaStop
    ) {
        if event.value == 0 {
            emit_button_feedback(state, app, binding, event, targets, 0.0);
            run_logger::debug(
                "bindings",
                "media_action_ignored_release",
                &format!("binding_id={} action={:?}", binding.id, binding.action),
            );
            return Ok(true);
        }
        emit_button_feedback(state, app, binding, event, targets, 1.0);
        let vk: u16 = match binding.action {
            model::BindingAction::MediaPlayPause => 0xB3,
            model::BindingAction::MediaNextTrack => 0xB0,
            model::BindingAction::MediaPrevTrack => 0xB1,
            model::BindingAction::MediaStop => 0xB2,
            _ => unreachable!(),
        };
        send_media_key(vk);
        run_logger::info(
            "bindings",
            "media_action_sent",
            &format!(
                "binding_id={} action={:?} keycode={}",
                binding.id, binding.action, vk
            ),
        );
        return Ok(true);
    }

    if binding.action == model::BindingAction::Hotkey {
        if event.value == 0 {
            emit_button_feedback(state, app, binding, event, targets, 0.0);
            run_logger::debug(
                "bindings",
                "hotkey_action_ignored_release",
                &format!("binding_id={} action={:?}", binding.id, binding.action),
            );
            return Ok(true);
        }
        emit_button_feedback(state, app, binding, event, targets, 1.0);
        if let Some(hotkey) = &binding.hotkey {
            if !hotkey.keys.is_empty() {
                send_hotkey(&hotkey.keys);
                run_logger::info(
                    "bindings",
                    "hotkey_action_sent",
                    &format!(
                        "binding_id={} action={:?} hotkey={}",
                        binding.id, binding.action, hotkey.display
                    ),
                );
            }
        }
        return Ok(true);
    }

    if binding.action == model::BindingAction::OpenApplication {
        if event.value == 0 {
            emit_button_feedback(state, app, binding, event, targets, 0.0);
            run_logger::debug(
                "bindings",
                "open_application_ignored_release",
                &format!("binding_id={} action={:?}", binding.id, binding.action),
            );
            return Ok(true);
        }
        emit_button_feedback(state, app, binding, event, targets, 1.0);

        let Some(open_app) = binding.open_application.as_ref() else {
            run_logger::warn(
                "bindings",
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
            return Ok(true);
        };

        let app_path = open_app.path.trim();
        if app_path.is_empty() || !Path::new(app_path).is_file() {
            run_logger::warn(
                "bindings",
                "open_application_path_missing",
                &format!("binding_id={} path={}", binding.id, app_path),
            );
            let app_name = open_app.display.trim();
            let display = if app_name.is_empty() {
                app_path
            } else {
                app_name
            };
            let _ = app.emit(
                "binding_action_error",
                serde_json::json!({
                    "reason": "open_application_path_missing",
                    "binding_id": binding.id,
                    "title": "Application Not Found",
                    "message": format!("MIDIMaster couldn't find \"{}\". Re-select the .exe path in this binding.", display),
                }),
            );
            return Ok(true);
        }

        match ProcessCommand::new(app_path).spawn() {
            Ok(_) => {
                run_logger::info(
                    "bindings",
                    "open_application_launched",
                    &format!("binding_id={} path={}", binding.id, app_path),
                );
            }
            Err(err) => {
                run_logger::error(
                    "bindings",
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
        return Ok(true);
    }

    if binding.action == model::BindingAction::FocusWindow {
        if event.value == 0 {
            emit_button_feedback(state, app, binding, event, targets, 0.0);
            return Ok(true);
        }
        emit_button_feedback(state, app, binding, event, targets, 1.0);
        let Some(process_name) = focus_target_name(targets) else {
            emit_localized_action_error(
                app,
                "focus_window_missing_target",
                &binding.id,
                "dialogs.focusWindowUnavailableTitle",
                "dialogs.focusWindowMissingTargetMessage",
                serde_json::json!({}),
            );
            return Ok(true);
        };
        if let Err(err) = focus_window_by_process_name(&process_name) {
            run_logger::warn(
                "bindings",
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
        return Ok(true);
    }

    if matches!(
        binding.action,
        model::BindingAction::FullScreenshot
            | model::BindingAction::SnipScreenshot
            | model::BindingAction::ToggleScreenRecording
    ) {
        if !targets
            .iter()
            .any(|target| matches!(target, BindingTarget::CaptureControl))
        {
            return Ok(true);
        }
        if event.value == 0 {
            emit_button_feedback(state, app, binding, event, targets, 0.0);
            return Ok(true);
        }
        emit_button_feedback(state, app, binding, event, targets, 1.0);
        let keys = match binding.action {
            model::BindingAction::FullScreenshot => {
                vec!["META".to_string(), "PRINTSCREEN".to_string()]
            }
            model::BindingAction::SnipScreenshot => {
                vec!["META".to_string(), "SHIFT".to_string(), "S".to_string()]
            }
            model::BindingAction::ToggleScreenRecording => {
                vec!["META".to_string(), "ALT".to_string(), "R".to_string()]
            }
            _ => unreachable!(),
        };
        send_hotkey(&keys);
        run_logger::info(
            "bindings",
            "capture_action_sent",
            &format!("binding_id={} action={:?}", binding.id, binding.action),
        );
        return Ok(true);
    }

    if binding.action == model::BindingAction::SetDefaultDevice {
        if event.value == 0 {
            emit_button_feedback(state, app, binding, event, targets, 0.0);
            run_logger::debug(
                "bindings",
                "set_default_device_ignored_release",
                &format!("binding_id={} action={:?}", binding.id, binding.action),
            );
            return Ok(true);
        }
        emit_button_feedback(state, app, binding, event, targets, 1.0);

        let mut any_applied = false;
        for target in targets {
            if let model::BindingTarget::Device { device_id } = target {
                if let Err(err) = state.audio.set_default_device(device_id) {
                    run_logger::error(
                        "bindings",
                        "set_default_device_failed",
                        &format!(
                            "binding_id={} device_id={} error={}",
                            binding.id, device_id, err
                        ),
                    );
                } else {
                    any_applied = true;
                }
            }
        }

        if !any_applied {
            run_logger::warn(
                "bindings",
                "set_default_device_no_target_applied",
                &format!("binding_id={} targets={}", binding.id, targets.len()),
            );
        }

        return Ok(true);
    }

    Ok(false)
}

use crate::model::{self, Binding, BindingTarget};
use crate::run_logger;
use crate::runtime_helpers::{
    focus_window_by_process_name, open_path_with_shell_association, send_hotkey, send_media_key,
};
use crate::AppState;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command as ProcessCommand;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntegrationButtonActionKind {
    Stateful,
    Momentary,
}

impl IntegrationButtonActionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stateful => "stateful",
            Self::Momentary => "momentary",
        }
    }
}

pub fn obs_action_is_stateful(action: &str) -> bool {
    action.starts_with("Toggle")
}

pub fn integration_volume_button_action_kind(
    integration_id: &str,
    kind: &str,
    data: &serde_json::Value,
) -> Option<IntegrationButtonActionKind> {
    if let Some(action_kind) = data.get("action_kind").and_then(|value| value.as_str()) {
        if action_kind.eq_ignore_ascii_case("stateful") {
            return Some(IntegrationButtonActionKind::Stateful);
        }
        if action_kind.eq_ignore_ascii_case("momentary") {
            return Some(IntegrationButtonActionKind::Momentary);
        }
    }
    if integration_id == "obs" && kind == "action" {
        let action = data
            .get("action")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        return Some(if obs_action_is_stateful(action) {
            IntegrationButtonActionKind::Stateful
        } else {
            IntegrationButtonActionKind::Momentary
        });
    }
    if integration_id == "obs" && matches!(kind, "scene" | "media") {
        return Some(IntegrationButtonActionKind::Momentary);
    }
    None
}

pub fn action_is_stateful_integration_toggle(action: &model::BindingAction) -> bool {
    matches!(
        action,
        model::BindingAction::ToggleMute | model::BindingAction::ToggleEffect
    )
}

pub fn action_is_momentary_integration_action(action: &model::BindingAction) -> bool {
    matches!(action, model::BindingAction::SetMainOutputDevice)
}

pub struct IntegrationTrigger<'a> {
    pub binding_id: &'a str,
    pub action: &'a model::BindingAction,
    pub value: f32,
    pub target_index: usize,
    pub target_count: usize,
    pub integration_id: &'a str,
    pub kind: &'a str,
    pub data: &'a serde_json::Value,
    pub source: Option<&'a str>,
    pub source_sequence: Option<u64>,
}

pub fn integration_trigger_payload(trigger: IntegrationTrigger<'_>) -> serde_json::Value {
    let mut payload = serde_json::json!({
      "binding_id": trigger.binding_id,
      "action": format!("{:?}", trigger.action),
      "value": trigger.value,
      "target_index": trigger.target_index,
      "target_count": trigger.target_count,
      "is_primary_target": trigger.target_index == 0,
      "target": {
        "integration_id": trigger.integration_id,
        "kind": trigger.kind,
        "data": trigger.data,
      }
    });
    if let Some(source) = trigger.source {
        payload["source"] = serde_json::Value::String(source.to_string());
    }
    if let Some(source_sequence) = trigger.source_sequence {
        payload["source_sequence"] = serde_json::Value::Number(source_sequence.into());
    }
    payload
}

pub fn emit_integration_binding_triggered(app: &AppHandle, trigger: IntegrationTrigger<'_>) {
    let _ = app.emit(
        "integration_binding_triggered",
        integration_trigger_payload(trigger),
    );
}

pub struct IntegrationBatchTrigger<'a> {
    pub binding_id: &'a str,
    pub action: &'a model::BindingAction,
    pub value: f32,
    pub integration_id: &'a str,
    pub targets: Vec<serde_json::Value>,
    pub source: Option<&'a str>,
    pub source_sequence: Option<u64>,
}

pub fn integration_batch_payload(batch: IntegrationBatchTrigger<'_>) -> serde_json::Value {
    let mut payload = serde_json::json!({
      "binding_id": batch.binding_id,
      "action": format!("{:?}", batch.action),
      "value": batch.value,
      "integration_id": batch.integration_id,
      "targets": batch.targets,
    });
    if let Some(source) = batch.source {
        payload["source"] = serde_json::Value::String(source.to_string());
    }
    if let Some(source_sequence) = batch.source_sequence {
        payload["source_sequence"] = serde_json::Value::Number(source_sequence.into());
    }
    payload
}

pub fn emit_integration_binding_triggered_batch(
    app: &AppHandle,
    batch: IntegrationBatchTrigger<'_>,
) {
    let _ = app.emit(
        "integration_binding_triggered_batch",
        integration_batch_payload(batch),
    );
}

pub fn finalize_grouped_integration_targets(grouped_targets: &mut [serde_json::Value]) {
    let grouped_count = grouped_targets.len();
    for (group_index, grouped_target) in grouped_targets.iter_mut().enumerate() {
        if let Some(map) = grouped_target.as_object_mut() {
            map.insert(
                "target_index".to_string(),
                serde_json::Value::Number((group_index as u64).into()),
            );
            map.insert(
                "target_count".to_string(),
                serde_json::Value::Number((grouped_count as u64).into()),
            );
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ActionExecutionOutcome {
    pub applied_targets: usize,
    pub value: Option<f32>,
    pub muted: Option<bool>,
}

impl ActionExecutionOutcome {
    pub fn applied(self) -> bool {
        self.applied_targets > 0
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ActionExecutionContext<'a> {
    pub source: Option<&'a str>,
    pub source_sequence: Option<u64>,
    pub log_target: &'a str,
}

impl<'a> ActionExecutionContext<'a> {
    pub const fn local(log_target: &'a str) -> Self {
        Self {
            source: None,
            source_sequence: None,
            log_target,
        }
    }
}

pub fn execute_local_target_action(
    state: &AppState,
    binding_id: &str,
    action: &model::BindingAction,
    target: &BindingTarget,
    value: f32,
    log_target: &str,
) -> bool {
    if matches!(action, model::BindingAction::Volume) && !target.supports_volume()
        || matches!(action, model::BindingAction::ToggleMute) && !target.supports_mute()
    {
        return false;
    }
    let value = value.clamp(0.0, 1.0);
    let muted = value > 0.5;
    let result = match (action, target) {
        (model::BindingAction::Volume, BindingTarget::Master) => state
            .audio
            .set_master_volume(value)
            .map_err(|err| err.to_string()),
        (model::BindingAction::Volume, BindingTarget::Focus) => {
            if state.apply_focus_volume_with_retry(binding_id, value) {
                Ok(())
            } else {
                return false;
            }
        }
        (model::BindingAction::Volume, BindingTarget::MonitorBrightness { monitor_id, .. }) => {
            crate::monitor_brightness::set_monitor_brightness(monitor_id.as_deref(), value)
        }
        (model::BindingAction::Volume, BindingTarget::Session { session_id }) => state
            .audio
            .set_session_volume(session_id, value)
            .map_err(|err| err.to_string()),
        (model::BindingAction::Volume, BindingTarget::Application { name, .. }) => state
            .audio
            .set_application_volume(name, value)
            .map_err(|err| err.to_string()),
        (model::BindingAction::Volume, BindingTarget::Device { device_id }) => state
            .audio
            .set_device_volume(device_id, value)
            .map_err(|err| err.to_string()),
        (model::BindingAction::ToggleMute, BindingTarget::Master) => state
            .audio
            .set_master_mute(muted)
            .map_err(|err| err.to_string()),
        (model::BindingAction::ToggleMute, BindingTarget::Focus) => {
            if state.audio.focused_session().ok().flatten().is_none() {
                return false;
            }
            state
                .audio
                .set_focused_session_mute(muted)
                .map_err(|err| err.to_string())
        }
        (model::BindingAction::ToggleMute, BindingTarget::Session { session_id }) => state
            .audio
            .set_session_mute(session_id, muted)
            .map_err(|err| err.to_string()),
        (model::BindingAction::ToggleMute, BindingTarget::Application { name, .. }) => state
            .audio
            .set_application_mute(name, muted)
            .map_err(|err| err.to_string()),
        (model::BindingAction::ToggleMute, BindingTarget::Device { device_id }) => state
            .audio
            .set_device_mute(device_id, muted)
            .map_err(|err| err.to_string()),
        (model::BindingAction::SetDefaultDevice, BindingTarget::Device { device_id }) => state
            .audio
            .set_default_device(device_id)
            .map_err(|err| err.to_string()),
        _ => return false,
    };

    match result {
        Ok(()) => true,
        Err(err) => {
            run_logger::warn(
                log_target,
                "target_action_failed",
                &format!(
                    "binding_id={} action={:?} target={:?} error={}",
                    binding_id, action, target, err
                ),
            );
            false
        }
    }
}

pub fn execute_target_action(
    app: &AppHandle,
    state: &AppState,
    binding: &Binding,
    action: &model::BindingAction,
    value: f32,
    context: ActionExecutionContext<'_>,
) -> Result<ActionExecutionOutcome, String> {
    let ActionExecutionContext {
        source,
        source_sequence,
        log_target,
    } = context;
    let targets = binding.normalized_targets_ref();
    if targets.is_empty() {
        return Ok(ActionExecutionOutcome::default());
    }

    let value = value.clamp(0.0, 1.0);
    let muted = value > 0.5;
    let mut outcome = ActionExecutionOutcome {
        value: matches!(action, model::BindingAction::Volume).then_some(value),
        muted: matches!(action, model::BindingAction::ToggleMute).then_some(muted),
        ..Default::default()
    };
    let mut integration_volume_batches: HashMap<String, Vec<serde_json::Value>> = HashMap::new();

    for (target_index, target) in targets.iter().enumerate() {
        if matches!(action, model::BindingAction::Volume) {
            if let BindingTarget::Integration {
                integration_id,
                kind,
                data,
            } = target
            {
                let group_index = integration_volume_batches
                    .get(integration_id)
                    .map(Vec::len)
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
                outcome.applied_targets += 1;
                continue;
            }
        }

        if let BindingTarget::Integration {
            integration_id,
            kind,
            data,
        } = target
        {
            if action_is_stateful_integration_toggle(action)
                || action_is_momentary_integration_action(action)
            {
                emit_integration_binding_triggered(
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
                outcome.applied_targets += 1;
            }
            continue;
        }

        if execute_local_target_action(state, &binding.id, action, target, value, log_target) {
            outcome.applied_targets += 1;
        }
    }

    for (integration_id, mut grouped_targets) in integration_volume_batches {
        finalize_grouped_integration_targets(&mut grouped_targets);
        emit_integration_binding_triggered_batch(
            app,
            IntegrationBatchTrigger {
                binding_id: &binding.id,
                action,
                value,
                integration_id: &integration_id,
                targets: grouped_targets,
                source,
                source_sequence,
            },
        );
    }

    Ok(outcome)
}

pub fn add_momentary_integration_input_value(
    payload: &mut serde_json::Value,
    binding: &Binding,
    action: &model::BindingAction,
    input_value: Option<f32>,
) {
    let Some(input_value) = momentary_integration_button_input_value(binding, action, input_value)
    else {
        return;
    };
    payload["input_value"] = serde_json::json!(input_value);
}

pub fn momentary_integration_button_input_value(
    binding: &Binding,
    action: &model::BindingAction,
    input_value: Option<f32>,
) -> Option<f32> {
    if !binding.is_button_binding() || !matches!(action, model::BindingAction::Volume) {
        return None;
    }

    if binding
        .normalized_targets_ref()
        .iter()
        .any(target_is_momentary_integration_action)
    {
        input_value.map(|value| value.clamp(0.0, 1.0))
    } else {
        None
    }
}

pub fn target_is_momentary_integration_action(target: &BindingTarget) -> bool {
    let BindingTarget::Integration { data, .. } = target else {
        return false;
    };

    data.get("action_kind")
        .and_then(|value| value.as_str())
        .map(|value| value.eq_ignore_ascii_case("momentary"))
        .unwrap_or(false)
}

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

fn autohotkey_script_display(binding: &Binding) -> String {
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

fn open_application_display(binding: &Binding) -> String {
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

fn is_press_only_button_action(action: &model::BindingAction) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obs_toggle_action_is_stateful_button_action() {
        let data = serde_json::json!({ "action": "ToggleMute" });
        assert_eq!(
            integration_volume_button_action_kind("obs", "action", &data),
            Some(IntegrationButtonActionKind::Stateful)
        );
    }

    #[test]
    fn action_kind_overrides_obs_defaults() {
        let data = serde_json::json!({ "action": "ToggleMute", "action_kind": "momentary" });
        assert_eq!(
            integration_volume_button_action_kind("obs", "action", &data),
            Some(IntegrationButtonActionKind::Momentary)
        );
    }

    #[test]
    fn integration_trigger_payload_keeps_public_shape() {
        let data = serde_json::json!({ "scene": "Intro" });
        let payload = integration_trigger_payload(IntegrationTrigger {
            binding_id: "b1",
            action: &model::BindingAction::ToggleEffect,
            value: 1.0,
            target_index: 1,
            target_count: 2,
            integration_id: "obs",
            kind: "scene",
            data: &data,
            source: Some("test"),
            source_sequence: Some(7),
        });

        assert_eq!(payload["binding_id"], "b1");
        assert_eq!(payload["action"], "ToggleEffect");
        assert_eq!(payload["target"]["integration_id"], "obs");
        assert_eq!(payload["source"], "test");
        assert_eq!(payload["source_sequence"], 7);
    }
}

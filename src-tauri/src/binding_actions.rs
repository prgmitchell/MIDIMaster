use crate::model::{self, Binding, BindingTarget};
use crate::run_logger;
use crate::runtime_helpers::{focus_window_by_process_name, send_hotkey};
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
        .normalized_targets()
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

pub fn binding_focus_target_name(binding: &Binding) -> Option<String> {
    binding.normalized_targets().into_iter().find_map(|target| {
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
    if value <= 0.0 {
        return true;
    }

    match action {
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
                .normalized_targets()
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
                .normalized_targets()
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
                .normalized_targets()
                .iter()
                .any(|target| matches!(target, BindingTarget::CaptureControl))
            {
                return true;
            }
            send_hotkey(&["META".to_string(), "ALT".to_string(), "R".to_string()]);
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

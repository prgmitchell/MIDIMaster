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

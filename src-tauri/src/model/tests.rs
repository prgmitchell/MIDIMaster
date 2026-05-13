use super::*;
fn binding_base_json() -> serde_json::Value {
    serde_json::json!({
        "id": "b1",
        "name": "Binding 1",
        "device_id": "midi-dev",
        "control": {
            "channel": 0,
            "controller": 7,
            "msg_type": "ControlChange"
        },
        "control_kind": "Continuous",
        "action": "Volume",
        "mode": "Absolute",
        "deadzone": 0.0,
        "debounce_ms": 0
    })
}

#[test]
fn deserialize_legacy_target_into_targets() {
    let mut json = binding_base_json();
    json.as_object_mut()
        .unwrap()
        .insert("target".to_string(), serde_json::json!("Master"));

    let mut binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    binding.ensure_targets();

    assert_eq!(binding.targets.len(), 1);
    assert_eq!(binding.targets[0], BindingTarget::Master);
}

#[test]
fn deserialize_targets_shape_unchanged() {
    let mut json = binding_base_json();
    json.as_object_mut().unwrap().insert(
        "targets".to_string(),
        serde_json::json!([
            "Master",
            { "Application": { "name": "spotify" } }
        ]),
    );

    let mut binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    binding.ensure_targets();

    assert_eq!(binding.targets.len(), 2);
    assert_eq!(binding.targets[0], BindingTarget::Master);
    assert_eq!(
        binding.targets[1],
        BindingTarget::Application {
            name: "spotify".to_string(),
            display_name: None,
            icon_data: None,
        }
    );
}

#[test]
fn deserialize_application_target_metadata() {
    let mut json = binding_base_json();
    json.as_object_mut().unwrap().insert(
        "targets".to_string(),
        serde_json::json!([
            {
                "Application": {
                    "name": "firefox",
                    "display_name": "Firefox",
                    "icon_data": "data:image/png;base64,abc"
                }
            }
        ]),
    );

    let mut binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    binding.ensure_targets();

    assert_eq!(
        binding.targets[0],
        BindingTarget::Application {
            name: "firefox".to_string(),
            display_name: Some("Firefox".to_string()),
            icon_data: Some("data:image/png;base64,abc".to_string()),
        }
    );
    assert_eq!(
        binding.targets[0],
        BindingTarget::Application {
            name: "FIREFOX".to_string(),
            display_name: None,
            icon_data: None,
        }
    );
}

#[test]
fn serialize_binding_uses_targets_not_target() {
    let binding = Binding {
        id: "b2".to_string(),
        name: "Binding 2".to_string(),
        device_id: "midi-dev".to_string(),
        control: MidiControl {
            channel: 0,
            controller: 8,
            msg_type: MidiMessageType::ControlChange,
        },
        control_kind: BindingControlKind::Continuous,
        targets: vec![BindingTarget::Master],
        target: BindingTarget::Master,
        action: BindingAction::Volume,
        mode: MidiMode::Absolute,
        relative_format: RelativeFormat::Auto,
        fader_curve: FaderCurve::Linear,
        custom_curve: Vec::new(),
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: MuteBehavior::ToggleOnPress,
        button_light_mode: ButtonLightMode::Activity,
        mute_control: None,
        assign_control: None,
        assign_mode: AssignMode::Add,
        hotkey: None,
        open_application: None,
    };

    let json = serde_json::to_value(binding).expect("binding should serialize");
    assert!(json.get("targets").is_some());
    assert!(json.get("target").is_none());
}

#[test]
fn deserialize_set_default_device_action() {
    let mut json = binding_base_json();
    json.as_object_mut()
        .unwrap()
        .insert("action".to_string(), serde_json::json!("SetDefaultDevice"));

    let binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    assert_eq!(binding.action, BindingAction::SetDefaultDevice);
}

#[test]
fn deserialize_open_application_action() {
    let mut json = binding_base_json();
    json.as_object_mut()
        .unwrap()
        .insert("action".to_string(), serde_json::json!("OpenApplication"));

    let binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    assert_eq!(binding.action, BindingAction::OpenApplication);
}

#[test]
fn deserialize_custom_curve_defaults_to_empty_points() {
    let binding: Binding =
        serde_json::from_value(binding_base_json()).expect("binding should deserialize");
    assert_eq!(binding.fader_curve, FaderCurve::Linear);
    assert!(binding.custom_curve.is_empty());
}

#[test]
fn deserialize_custom_curve_points_when_present() {
    let mut json = binding_base_json();
    json.as_object_mut()
        .unwrap()
        .insert("fader_curve".to_string(), serde_json::json!("Custom"));
    json.as_object_mut().unwrap().insert(
        "custom_curve".to_string(),
        serde_json::json!([
            { "x": 0.0, "y": 0.0 },
            { "x": 0.4, "y": 0.7 },
            { "x": 1.0, "y": 1.0 }
        ]),
    );

    let binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    assert_eq!(binding.fader_curve, FaderCurve::Custom);
    assert_eq!(binding.custom_curve.len(), 3);
    assert_eq!(binding.custom_curve[1].x, 0.4);
    assert_eq!(binding.custom_curve[1].y, 0.7);
}

#[test]
fn deserialize_binding_defaults_mute_behavior_to_toggle_on_press() {
    let binding: Binding =
        serde_json::from_value(binding_base_json()).expect("binding should deserialize");
    assert_eq!(binding.mute_behavior, MuteBehavior::ToggleOnPress);
}

#[test]
fn deserialize_binding_defaults_button_light_mode_to_activity() {
    let binding: Binding =
        serde_json::from_value(binding_base_json()).expect("binding should deserialize");
    assert_eq!(binding.button_light_mode, ButtonLightMode::Activity);
}

#[test]
fn deserialize_aux_control_defaults_mute_behavior_to_toggle_on_press() {
    let aux: AuxiliaryControl = serde_json::from_value(serde_json::json!({
        "device_id": "midi-dev",
        "channel": 0,
        "controller": 10,
        "msg_type": "ControlChange",
        "control_kind": "Button",
        "mode": "Absolute",
        "deadzone": 0.0,
        "debounce_ms": 0
    }))
    .expect("aux control should deserialize");

    assert_eq!(aux.mute_behavior, MuteBehavior::ToggleOnPress);
}

fn mapped_button_binding(action: BindingAction, targets: Vec<BindingTarget>) -> Binding {
    let mut binding: Binding =
        serde_json::from_value(binding_base_json()).expect("binding should deserialize");
    binding.control_kind = BindingControlKind::Button;
    binding.button_light_mode = ButtonLightMode::MappedWhenAssigned;
    binding.action = action;
    binding.targets = targets;
    binding.ensure_targets();
    binding
}

#[test]
fn mapped_button_light_requires_open_application_path() {
    let mut binding = mapped_button_binding(
        BindingAction::OpenApplication,
        vec![BindingTarget::OpenApplication],
    );
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(0.0));

    binding.open_application = Some(OpenApplicationMapping {
        path: "C:\\Program Files\\App\\app.exe".to_string(),
        display: "App".to_string(),
        icon_data: None,
    });
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(1.0));
}

#[test]
fn mapped_button_light_requires_hotkey_keys() {
    let mut binding = mapped_button_binding(BindingAction::Hotkey, vec![BindingTarget::Hotkey]);
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(0.0));

    binding.hotkey = Some(HotkeyMapping {
        keys: vec!["Ctrl".to_string(), "Shift".to_string(), "S".to_string()],
        display: "Ctrl+Shift+S".to_string(),
    });
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(1.0));
}

#[test]
fn mapped_button_light_does_not_override_toggle_mute_state() {
    let binding = mapped_button_binding(BindingAction::ToggleMute, vec![BindingTarget::Master]);
    assert_eq!(binding.mapped_button_light_feedback_value(), None);
    assert_eq!(binding.idle_button_light_feedback_value(), None);
}

#[test]
fn mapped_button_light_supports_momentary_integration_actions() {
    let binding = mapped_button_binding(
        BindingAction::Volume,
        vec![BindingTarget::Integration {
            integration_id: "obs".to_string(),
            kind: "scene".to_string(),
            data: serde_json::json!({ "action_kind": "momentary" }),
        }],
    );
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(1.0));
}

#[test]
fn mapped_button_light_does_not_override_stateful_integration_actions() {
    let binding = mapped_button_binding(
        BindingAction::Volume,
        vec![BindingTarget::Integration {
            integration_id: "obs".to_string(),
            kind: "action".to_string(),
            data: serde_json::json!({ "action_kind": "stateful", "action": "ToggleMute" }),
        }],
    );
    assert_eq!(binding.mapped_button_light_feedback_value(), None);
    assert_eq!(binding.idle_button_light_feedback_value(), None);
}

#[test]
fn mapped_button_light_does_not_override_obs_toggle_actions() {
    let binding = mapped_button_binding(
        BindingAction::Volume,
        vec![BindingTarget::Integration {
            integration_id: "obs".to_string(),
            kind: "action".to_string(),
            data: serde_json::json!({ "action": "ToggleVirtualCam" }),
        }],
    );
    assert_eq!(binding.mapped_button_light_feedback_value(), None);
    assert_eq!(binding.idle_button_light_feedback_value(), None);
}

#[test]
fn idle_button_light_clears_activity_mode_for_stateless_actions() {
    let mut binding = mapped_button_binding(
        BindingAction::OpenApplication,
        vec![BindingTarget::OpenApplication],
    );
    binding.button_light_mode = ButtonLightMode::Activity;
    binding.open_application = Some(OpenApplicationMapping {
        path: "C:\\Program Files\\App\\app.exe".to_string(),
        display: "App".to_string(),
        icon_data: None,
    });

    assert_eq!(binding.mapped_button_light_feedback_value(), None);
    assert_eq!(binding.idle_button_light_feedback_value(), Some(0.0));
}

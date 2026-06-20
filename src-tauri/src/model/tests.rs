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
        macro_name: String::new(),
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
        autohotkey_script: None,
        macro_steps: Vec::new(),
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
fn deserialize_macro_binding_defaults_steps_without_breaking_profiles() {
    let mut json = binding_base_json();
    json.as_object_mut()
        .unwrap()
        .insert("action".to_string(), serde_json::json!("Macro"));

    let mut binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    binding.ensure_targets();

    assert_eq!(binding.action, BindingAction::Macro);
    assert_eq!(binding.targets, vec![BindingTarget::Macro]);
    assert_eq!(binding.macro_name, "");
    assert!(binding.macro_steps.is_empty());
}

#[test]
fn deserialize_macro_binding_preserves_macro_name() {
    let mut json = binding_base_json();
    json.as_object_mut()
        .unwrap()
        .insert("action".to_string(), serde_json::json!("Macro"));
    json.as_object_mut()
        .unwrap()
        .insert("macro_name".to_string(), serde_json::json!("Game Mix"));

    let binding: Binding = serde_json::from_value(json).expect("binding should deserialize");

    assert_eq!(binding.macro_name, "Game Mix");
    let serialized = serde_json::to_value(binding).expect("binding should serialize");
    assert_eq!(
        serialized.get("macro_name"),
        Some(&serde_json::json!("Game Mix"))
    );
}

#[test]
fn normalize_macro_steps_clamps_waits_and_limits_top_level_steps() {
    let steps = vec![
        MacroStep::Wait {
            duration_ms: MACRO_MAX_WAIT_MS + 1,
        };
        MACRO_MAX_TOP_LEVEL_STEPS + 4
    ];

    let normalized = normalize_macro_steps(&steps);

    assert_eq!(normalized.len(), MACRO_MAX_TOP_LEVEL_STEPS);
    assert_eq!(
        normalized[0],
        MacroStep::Wait {
            duration_ms: MACRO_MAX_WAIT_MS
        }
    );
}

#[test]
fn normalize_macro_steps_filters_nested_macro_targets_and_limits_parallel_children() {
    let mut children = vec![
        MacroActionStep {
            action: BindingAction::Macro,
            targets: vec![BindingTarget::Macro],
            ..Default::default()
        },
        MacroActionStep {
            action: BindingAction::ToggleMute,
            targets: vec![BindingTarget::Macro],
            ..Default::default()
        },
    ];
    for _ in 0..(MACRO_MAX_PARALLEL_STEPS + 2) {
        children.push(MacroActionStep {
            action: BindingAction::ToggleMute,
            targets: vec![BindingTarget::Master],
            state: MacroActionState::Mute,
            ..Default::default()
        });
    }

    let normalized = normalize_macro_steps(&[MacroStep::Parallel { steps: children }]);

    assert_eq!(normalized.len(), 1);
    let MacroStep::Parallel { steps } = &normalized[0] else {
        panic!("expected parallel macro step");
    };
    assert_eq!(steps.len(), MACRO_MAX_PARALLEL_STEPS);
    assert!(steps
        .iter()
        .all(|step| step.action == BindingAction::ToggleMute));
    assert!(steps
        .iter()
        .all(|step| step.targets == vec![BindingTarget::Master]));
}

#[test]
fn normalize_macro_steps_preserves_action_metadata() {
    let normalized = normalize_macro_steps(&[MacroStep::Action(Box::new(MacroActionStep {
        action: BindingAction::Volume,
        targets: vec![BindingTarget::Master],
        value: Some(0.42),
        action_role: Some("value".to_string()),
        action_label: Some("Set Value".to_string()),
        value_kind: Some("percent".to_string()),
        ..Default::default()
    }))]);

    assert_eq!(normalized.len(), 1);
    let MacroStep::Action(step) = &normalized[0] else {
        panic!("expected action macro step");
    };
    assert_eq!(step.action_role.as_deref(), Some("value"));
    assert_eq!(step.action_label.as_deref(), Some("Set Value"));
    assert_eq!(step.value_kind.as_deref(), Some("percent"));
    assert_eq!(step.value, Some(0.42));
}

#[test]
fn ensure_targets_preserves_macro_draft_placeholders() {
    let mut binding = mapped_button_binding(BindingAction::Macro, vec![BindingTarget::Macro]);
    binding.macro_steps = vec![
        MacroStep::Action(Box::default()),
        MacroStep::Wait { duration_ms: 500 },
        MacroStep::Parallel {
            steps: vec![MacroActionStep::default(), MacroActionStep::default()],
        },
    ];

    binding.ensure_targets();

    assert_eq!(binding.macro_steps.len(), 3);
    assert_eq!(binding.macro_steps[0], MacroStep::Action(Box::default()));
    let MacroStep::Parallel { steps } = &binding.macro_steps[2] else {
        panic!("expected parallel macro draft step");
    };
    assert_eq!(steps.len(), 2);
    assert!(normalize_macro_steps(&binding.macro_steps)
        .iter()
        .all(|step| matches!(step, MacroStep::Wait { .. })));
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(1.0));
}

#[test]
fn mapped_button_light_requires_macro_steps() {
    let mut binding = mapped_button_binding(BindingAction::Macro, vec![BindingTarget::Macro]);
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(0.0));

    binding.macro_steps = normalize_macro_steps(&[MacroStep::Action(Box::new(MacroActionStep {
        action: BindingAction::ToggleMute,
        targets: vec![BindingTarget::Master],
        state: MacroActionState::Toggle,
        ..Default::default()
    }))]);

    assert_eq!(binding.mapped_button_light_feedback_value(), Some(1.0));
}

#[test]
fn deserialize_run_autohotkey_script_action() {
    let mut json = binding_base_json();
    json.as_object_mut().unwrap().insert(
        "action".to_string(),
        serde_json::json!("RunAutoHotkeyScript"),
    );
    json.as_object_mut().unwrap().insert(
        "targets".to_string(),
        serde_json::json!(["AutoHotkeyScript"]),
    );
    json.as_object_mut().unwrap().insert(
        "autohotkey_script".to_string(),
        serde_json::json!({
            "path": "C:\\Users\\Test\\Scripts\\mute-toggle.ahk",
            "display": "mute-toggle.ahk"
        }),
    );

    let mut binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    binding.ensure_targets();

    assert_eq!(binding.action, BindingAction::RunAutoHotkeyScript);
    assert_eq!(binding.targets, vec![BindingTarget::AutoHotkeyScript]);
    assert_eq!(
        binding.autohotkey_script,
        Some(AutoHotkeyScriptMapping {
            path: "C:\\Users\\Test\\Scripts\\mute-toggle.ahk".to_string(),
            display: "mute-toggle.ahk".to_string(),
        })
    );
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
    assert_eq!(binding.custom_curve[1].curve, 0.0);
}

#[test]
fn deserialize_custom_curve_preserves_segment_bend() {
    let mut json = binding_base_json();
    json.as_object_mut()
        .unwrap()
        .insert("fader_curve".to_string(), serde_json::json!("Custom"));
    json.as_object_mut().unwrap().insert(
        "custom_curve".to_string(),
        serde_json::json!([
            { "x": 0.0, "y": 0.0, "curve": 0.35 },
            { "x": 1.0, "y": 1.0 }
        ]),
    );

    let binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    assert_eq!(binding.fader_curve, FaderCurve::Custom);
    assert_eq!(binding.custom_curve[0].curve, 0.35);
    assert_eq!(binding.custom_curve[1].curve, 0.0);
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
fn mapped_button_light_requires_autohotkey_script_path() {
    let mut binding = mapped_button_binding(
        BindingAction::RunAutoHotkeyScript,
        vec![BindingTarget::AutoHotkeyScript],
    );
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(0.0));

    binding.autohotkey_script = Some(AutoHotkeyScriptMapping {
        path: "C:\\Users\\Test\\Scripts\\mute-toggle.ahk".to_string(),
        display: "mute-toggle.ahk".to_string(),
    });
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(1.0));
}

#[test]
fn mapped_button_light_marks_toggle_mute_application_targets_as_mapped() {
    let binding = mapped_button_binding(
        BindingAction::ToggleMute,
        vec![BindingTarget::Application {
            name: "firefox".to_string(),
            display_name: Some("Firefox".to_string()),
            icon_data: None,
        }],
    );
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(1.0));
    assert_eq!(binding.idle_button_light_feedback_value(), Some(1.0));
}

#[test]
fn mapped_button_light_keeps_toggle_mute_unset_targets_dark() {
    let binding = mapped_button_binding(BindingAction::ToggleMute, vec![BindingTarget::Unset]);
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(0.0));
    assert_eq!(binding.idle_button_light_feedback_value(), Some(0.0));
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
fn mapped_button_light_marks_stateful_integration_actions_as_mapped() {
    let binding = mapped_button_binding(
        BindingAction::Volume,
        vec![BindingTarget::Integration {
            integration_id: "obs".to_string(),
            kind: "action".to_string(),
            data: serde_json::json!({ "action_kind": "stateful", "action": "ToggleMute" }),
        }],
    );
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(1.0));
    assert_eq!(binding.idle_button_light_feedback_value(), Some(1.0));
}

#[test]
fn mapped_button_light_marks_obs_toggle_actions_as_mapped() {
    let binding = mapped_button_binding(
        BindingAction::Volume,
        vec![BindingTarget::Integration {
            integration_id: "obs".to_string(),
            kind: "action".to_string(),
            data: serde_json::json!({ "action": "ToggleVirtualCam" }),
        }],
    );
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(1.0));
    assert_eq!(binding.idle_button_light_feedback_value(), Some(1.0));
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

#[test]
fn activity_button_light_tracks_button_press_for_stateless_actions() {
    let mut binding = mapped_button_binding(
        BindingAction::OpenApplication,
        vec![BindingTarget::OpenApplication],
    );
    binding.button_light_mode = ButtonLightMode::Activity;

    assert_eq!(
        binding.activity_button_light_feedback_value(false),
        Some(0.0)
    );
    assert_eq!(
        binding.activity_button_light_feedback_value(true),
        Some(1.0)
    );
}

#[test]
fn activity_button_light_does_not_override_mapped_or_stateful_feedback() {
    let mapped = mapped_button_binding(
        BindingAction::MediaPlayPause,
        vec![BindingTarget::MediaControl],
    );
    assert_eq!(mapped.activity_button_light_feedback_value(true), None);

    let mut stateful =
        mapped_button_binding(BindingAction::ToggleMute, vec![BindingTarget::Master]);
    stateful.button_light_mode = ButtonLightMode::Activity;
    assert_eq!(stateful.activity_button_light_feedback_value(true), None);
}

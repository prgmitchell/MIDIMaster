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
fn monitor_brightness_target_round_trips() {
    let target: BindingTarget = serde_json::from_value(serde_json::json!("MonitorBrightness"))
        .expect("monitor brightness target should deserialize");

    assert_eq!(
        target,
        BindingTarget::MonitorBrightness {
            monitor_id: None,
            display_name: None,
        }
    );
    assert_eq!(
        serde_json::to_value(target).expect("monitor brightness target should serialize"),
        serde_json::json!({ "MonitorBrightness": {} })
    );
}

#[test]
fn individual_monitor_brightness_target_round_trips() {
    let target = BindingTarget::MonitorBrightness {
        monitor_id: Some("DISPLAY\\ACR073A\\123".to_string()),
        display_name: Some("XZ322QU".to_string()),
    };

    let serialized = serde_json::to_value(&target).expect("target should serialize");
    let restored: BindingTarget =
        serde_json::from_value(serialized).expect("target should deserialize");

    assert_eq!(restored, target);
}

#[test]
fn profile_switch_binding_round_trips_target_and_action() {
    let mut json = binding_base_json();
    let object = json.as_object_mut().unwrap();
    object.insert("control_kind".to_string(), serde_json::json!("Button"));
    object.insert("action".to_string(), serde_json::json!("SwitchProfile"));
    object.insert(
        "targets".to_string(),
        serde_json::json!([{ "Profile": { "name": "Streaming" } }]),
    );

    let mut binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    binding.ensure_targets();

    assert_eq!(binding.action, BindingAction::SwitchProfile);
    assert_eq!(
        binding.targets,
        vec![BindingTarget::Profile {
            name: "Streaming".to_string(),
        }]
    );
    assert!(binding.has_complete_mapped_button_light_target(&binding.targets));

    let serialized = serde_json::to_value(binding).expect("binding should serialize");
    assert_eq!(
        serialized.get("targets"),
        Some(&serde_json::json!([{ "Profile": { "name": "Streaming" } }]))
    );
    assert_eq!(
        serialized.get("action").and_then(|value| value.as_str()),
        Some("SwitchProfile")
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
        button_light_behavior: ButtonLightBehavior::FollowState,
        feedback_enabled: true,
        indicator_control: None,
        mute_control: None,
        assign_control: None,
        assign_mode: AssignMode::Add,
        hotkey: None,
        open_application: None,
        autohotkey_script: None,
        soundboard: None,
        macro_steps: Vec::new(),
    };

    let json = serde_json::to_value(binding).expect("binding should serialize");
    assert!(json.get("targets").is_some());
    assert!(json.get("target").is_none());
}

#[test]
fn deserialize_binding_indicator_control_defaults_to_none() {
    let binding: Binding =
        serde_json::from_value(binding_base_json()).expect("binding should deserialize");

    assert!(binding.indicator_control.is_none());
}

#[test]
fn feedback_enabled_defaults_true_for_legacy_bindings() {
    let binding: Binding =
        serde_json::from_value(binding_base_json()).expect("legacy binding should deserialize");

    assert!(binding.feedback_enabled);
    let serialized = serde_json::to_value(binding).expect("binding should serialize");
    assert_eq!(serialized["feedback_enabled"], serde_json::json!(true));
}

#[test]
fn explicitly_disabled_feedback_round_trips_and_suppresses_button_values() {
    let mut binding = mapped_button_binding(BindingAction::ToggleMute, vec![BindingTarget::Master]);
    binding.feedback_enabled = false;

    let serialized = serde_json::to_value(&binding).expect("binding should serialize");
    assert_eq!(serialized["feedback_enabled"], serde_json::json!(false));

    let restored: Binding =
        serde_json::from_value(serialized).expect("disabled binding should deserialize");
    assert!(!restored.feedback_enabled);
    assert_eq!(restored.mapped_button_light_feedback_value(), None);
    assert_eq!(
        restored.button_light_feedback_value(Some(true), Some(true)),
        None
    );
}

#[test]
fn assign_mode_clear_round_trips_and_missing_or_unknown_mode_defaults_to_add() {
    assert_eq!(
        serde_json::to_value(AssignMode::Clear).expect("Clear should serialize"),
        serde_json::json!("Clear")
    );

    let mut explicit = binding_base_json();
    explicit
        .as_object_mut()
        .unwrap()
        .insert("assign_mode".to_string(), serde_json::json!("Clear"));
    let clear_binding: Binding =
        serde_json::from_value(explicit).expect("Clear binding should deserialize");
    assert_eq!(clear_binding.assign_mode, AssignMode::Clear);

    let default_binding: Binding =
        serde_json::from_value(binding_base_json()).expect("legacy binding should deserialize");
    assert_eq!(default_binding.assign_mode, AssignMode::Add);

    let mut unknown = binding_base_json();
    unknown
        .as_object_mut()
        .unwrap()
        .insert("assign_mode".to_string(), serde_json::json!("FutureMode"));
    let unknown_binding: Binding = serde_json::from_value(unknown)
        .expect("an unknown assign mode must not invalidate the binding or profile");
    assert_eq!(unknown_binding.assign_mode, AssignMode::Add);
}

#[test]
fn deserialize_binding_indicator_control_round_trips_note_mapping() {
    let mut json = binding_base_json();
    json.as_object_mut().unwrap().insert(
        "indicator_control".to_string(),
        serde_json::json!({
            "device_id": "midi-dev",
            "channel": 2,
            "controller": 40,
            "msg_type": "Note",
            "control_kind": "Button"
        }),
    );

    let binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    let indicator = binding
        .indicator_control
        .as_ref()
        .expect("indicator control should deserialize");

    assert_eq!(indicator.device_id, "midi-dev");
    assert_eq!(indicator.channel, 2);
    assert_eq!(indicator.controller, 40);
    assert_eq!(indicator.msg_type, MidiMessageType::Note);
}

#[test]
fn serialize_continuous_indicator_control() {
    let mut binding: Binding =
        serde_json::from_value(binding_base_json()).expect("binding should deserialize");
    binding.control_kind = BindingControlKind::Continuous;
    binding.indicator_control = Some(AuxiliaryControl {
        device_id: "midi-dev".to_string(),
        channel: 3,
        controller: 0,
        msg_type: MidiMessageType::PitchBend,
        control_kind: BindingControlKind::Continuous,
        mode: MidiMode::Absolute,
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: MuteBehavior::ToggleOnPress,
    });

    let json = serde_json::to_value(&binding).expect("binding should serialize");
    let indicator = json
        .get("indicator_control")
        .expect("indicator control should serialize");

    assert_eq!(
        indicator.get("device_id").and_then(|value| value.as_str()),
        Some("midi-dev")
    );
    assert_eq!(
        indicator.get("channel").and_then(|value| value.as_u64()),
        Some(3)
    );
    assert_eq!(
        indicator.get("controller").and_then(|value| value.as_u64()),
        Some(0)
    );
    assert_eq!(
        indicator.get("msg_type").and_then(|value| value.as_str()),
        Some("PitchBend")
    );
}

#[test]
fn custom_feedback_output_allows_note_cc_or_continuous_pitch_bend_output() {
    let mut binding: Binding =
        serde_json::from_value(binding_base_json()).expect("binding should deserialize");
    binding.control_kind = BindingControlKind::Button;
    binding.control.msg_type = MidiMessageType::ProgramChange;
    binding.indicator_control = Some(AuxiliaryControl {
        device_id: "midi-dev".to_string(),
        channel: 1,
        controller: 41,
        msg_type: MidiMessageType::ControlChange,
        control_kind: BindingControlKind::Button,
        mode: MidiMode::Absolute,
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: MuteBehavior::ToggleOnPress,
    });
    assert!(binding.custom_feedback_output_control().is_some());
    assert!(binding.indicator_feedback_control().is_some());

    binding
        .indicator_control
        .as_mut()
        .expect("indicator control")
        .msg_type = MidiMessageType::PitchBend;
    assert!(binding.custom_feedback_output_control().is_none());
    assert!(binding.indicator_feedback_control().is_none());

    binding
        .indicator_control
        .as_mut()
        .expect("indicator control")
        .msg_type = MidiMessageType::ProgramChange;
    assert!(binding.custom_feedback_output_control().is_none());
    assert!(binding.indicator_feedback_control().is_none());

    binding.control_kind = BindingControlKind::Continuous;
    binding
        .indicator_control
        .as_mut()
        .expect("indicator control")
        .msg_type = MidiMessageType::Note;
    assert!(binding.custom_feedback_output_control().is_some());
    assert!(binding.indicator_feedback_control().is_none());

    binding
        .indicator_control
        .as_mut()
        .expect("indicator control")
        .msg_type = MidiMessageType::PitchBend;
    assert!(binding.custom_feedback_output_control().is_some());
    assert!(binding.indicator_feedback_control().is_none());
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
fn deserialize_binding_defaults_button_light_behavior_to_follow_state() {
    let binding: Binding =
        serde_json::from_value(binding_base_json()).expect("binding should deserialize");
    assert_eq!(
        binding.button_light_behavior,
        ButtonLightBehavior::FollowState
    );
}

#[test]
fn normalize_button_light_serialization_repairs_unsafe_mode() {
    let mut json = binding_base_json();
    json.as_object_mut().unwrap().insert(
        "button_light_mode".to_string(),
        serde_json::json!("Pressed"),
    );

    let mut binding: Binding = serde_json::from_value(json).expect("binding should deserialize");
    assert_eq!(binding.button_light_mode, ButtonLightMode::Pressed);
    assert_eq!(
        binding.button_light_behavior,
        ButtonLightBehavior::FollowState
    );

    assert!(binding.normalize_button_light_serialization());
    assert_eq!(binding.button_light_mode, ButtonLightMode::Activity);
    assert_eq!(binding.button_light_behavior, ButtonLightBehavior::Pressed);

    let json = serde_json::to_value(binding).expect("binding should serialize");
    assert_eq!(json["button_light_mode"], serde_json::json!("Activity"));
    assert_eq!(json["button_light_behavior"], serde_json::json!("Pressed"));
}

#[test]
fn serialize_button_light_behavior_keeps_legacy_mode_downgrade_safe() {
    let mut binding: Binding =
        serde_json::from_value(binding_base_json()).expect("binding should deserialize");
    binding.button_light_mode = ButtonLightMode::Activity;
    binding.button_light_behavior = ButtonLightBehavior::InvertState;

    let json = serde_json::to_value(binding).expect("binding should serialize");
    assert_eq!(json["button_light_mode"], serde_json::json!("Activity"));
    assert_eq!(
        json["button_light_behavior"],
        serde_json::json!("InvertState")
    );

    let mut binding: Binding =
        serde_json::from_value(binding_base_json()).expect("binding should deserialize");
    binding.button_light_mode = ButtonLightMode::Activity;
    binding.button_light_behavior = ButtonLightBehavior::Pressed;

    let json = serde_json::to_value(binding).expect("binding should serialize");
    assert_eq!(json["button_light_mode"], serde_json::json!("Activity"));
    assert_eq!(json["button_light_behavior"], serde_json::json!("Pressed"));
}

#[test]
fn mapped_button_light_serializes_legacy_mode_and_overrides_behavior() {
    let mut binding = mapped_button_binding(BindingAction::ToggleMute, vec![BindingTarget::Master]);
    binding.button_light_behavior = ButtonLightBehavior::InvertState;

    assert_eq!(
        binding.button_light_feedback_value(Some(false), Some(false)),
        Some(1.0)
    );

    let json = serde_json::to_value(binding).expect("binding should serialize");
    assert_eq!(
        json["button_light_mode"],
        serde_json::json!("MappedWhenAssigned")
    );
    assert_eq!(
        json["button_light_behavior"],
        serde_json::json!("InvertState")
    );
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
    assert_eq!(binding.button_light_feedback_value(None, None), Some(1.0));
}

#[test]
fn mapped_button_light_keeps_toggle_mute_unset_targets_dark() {
    let binding = mapped_button_binding(BindingAction::ToggleMute, vec![BindingTarget::Unset]);
    assert_eq!(binding.mapped_button_light_feedback_value(), Some(0.0));
    assert_eq!(binding.button_light_feedback_value(None, None), Some(0.0));
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
    assert_eq!(binding.button_light_feedback_value(None, None), Some(1.0));
}

#[test]
fn mapped_button_light_respects_integration_target_availability() {
    let binding = mapped_button_binding(
        BindingAction::ToggleMute,
        vec![BindingTarget::Integration {
            integration_id: "obs".to_string(),
            kind: "input".to_string(),
            data: serde_json::json!({ "input_name": "Mic/Aux" }),
        }],
    );

    assert_eq!(
        binding.mapped_button_light_feedback_value_with_availability(|_| false),
        Some(0.0)
    );
    assert_eq!(
        binding.mapped_button_light_feedback_value_with_availability(|_| true),
        Some(1.0)
    );
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
    assert_eq!(binding.button_light_feedback_value(None, None), Some(1.0));
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
    assert_eq!(binding.button_light_feedback_value(None, None), Some(0.0));
}

#[test]
fn activity_button_light_tracks_button_press_for_stateless_actions() {
    let mut binding = mapped_button_binding(
        BindingAction::OpenApplication,
        vec![BindingTarget::OpenApplication],
    );
    binding.button_light_mode = ButtonLightMode::Activity;

    assert_eq!(
        binding.button_light_feedback_value(Some(false), None),
        Some(0.0)
    );
    assert_eq!(
        binding.button_light_feedback_value(Some(true), None),
        Some(1.0)
    );
}

#[test]
fn legacy_activity_button_light_follows_state_with_press_fallback() {
    let mut binding = mapped_button_binding(BindingAction::ToggleMute, vec![BindingTarget::Master]);
    binding.button_light_mode = ButtonLightMode::Activity;

    assert_eq!(
        binding.button_light_feedback_value(Some(false), Some(true)),
        Some(1.0)
    );
    assert_eq!(
        binding.button_light_feedback_value(Some(true), Some(false)),
        Some(0.0)
    );

    binding.action = BindingAction::OpenApplication;
    binding.targets = vec![BindingTarget::OpenApplication];
    assert_eq!(
        binding.button_light_feedback_value(Some(true), None),
        Some(1.0)
    );
    assert_eq!(
        binding.button_light_feedback_value(Some(false), None),
        Some(0.0)
    );
}

#[test]
fn follow_state_button_light_follows_state_with_press_fallback() {
    let mut binding = mapped_button_binding(BindingAction::ToggleMute, vec![BindingTarget::Master]);
    binding.button_light_mode = ButtonLightMode::Activity;
    binding.button_light_behavior = ButtonLightBehavior::FollowState;

    assert_eq!(
        binding.button_light_feedback_value(Some(false), Some(true)),
        Some(1.0)
    );
    assert_eq!(
        binding.button_light_feedback_value(Some(true), Some(false)),
        Some(0.0)
    );

    binding.action = BindingAction::MediaPlayPause;
    binding.targets = vec![BindingTarget::MediaControl];
    assert_eq!(
        binding.button_light_feedback_value(Some(true), None),
        Some(1.0)
    );
    assert_eq!(
        binding.button_light_feedback_value(Some(false), None),
        Some(0.0)
    );
}

#[test]
fn invert_state_button_light_inverts_state_with_release_fallback() {
    let mut binding = mapped_button_binding(BindingAction::ToggleMute, vec![BindingTarget::Master]);
    binding.button_light_mode = ButtonLightMode::Activity;
    binding.button_light_behavior = ButtonLightBehavior::InvertState;

    assert_eq!(
        binding.button_light_feedback_value(Some(false), Some(true)),
        Some(0.0)
    );
    assert_eq!(
        binding.button_light_feedback_value(Some(true), Some(false)),
        Some(1.0)
    );

    binding.action = BindingAction::MediaPlayPause;
    binding.targets = vec![BindingTarget::MediaControl];
    assert_eq!(
        binding.button_light_feedback_value(Some(true), None),
        Some(0.0)
    );
    assert_eq!(
        binding.button_light_feedback_value(Some(false), None),
        Some(1.0)
    );
}

#[test]
fn pressed_button_light_ignores_state() {
    let mut binding = mapped_button_binding(BindingAction::ToggleMute, vec![BindingTarget::Master]);
    binding.button_light_mode = ButtonLightMode::Activity;
    binding.button_light_behavior = ButtonLightBehavior::Pressed;

    assert_eq!(
        binding.button_light_feedback_value(Some(false), Some(true)),
        Some(0.0)
    );
    assert_eq!(
        binding.button_light_feedback_value(Some(true), Some(false)),
        Some(1.0)
    );
}

#[test]
fn mapped_button_light_overrides_toggle_mute_feedback() {
    let binding = mapped_button_binding(BindingAction::ToggleMute, vec![BindingTarget::Master]);

    assert_eq!(
        binding.button_light_feedback_value(Some(false), Some(false)),
        Some(1.0)
    );
    assert_eq!(
        binding.button_light_feedback_value(Some(true), Some(true)),
        Some(1.0)
    );
}

#[test]
fn mapped_button_light_overrides_toggle_effect_feedback() {
    let binding = mapped_button_binding(BindingAction::ToggleEffect, vec![BindingTarget::Master]);

    assert_eq!(
        binding.button_light_feedback_value(Some(false), Some(false)),
        Some(1.0)
    );
}

#[test]
fn mapped_button_light_overrides_stateful_integration_feedback() {
    let binding = mapped_button_binding(
        BindingAction::Volume,
        vec![BindingTarget::Integration {
            integration_id: "obs".to_string(),
            kind: "action".to_string(),
            data: serde_json::json!({ "action_kind": "stateful", "action": "ToggleRecording" }),
        }],
    );

    assert_eq!(
        binding.button_light_feedback_value(Some(false), Some(false)),
        Some(1.0)
    );
}

#[test]
fn soundboard_mapping_serializes_and_round_trips() {
    let mut binding: Binding = serde_json::from_value(binding_base_json()).unwrap();
    binding.control_kind = BindingControlKind::Button;
    binding.action = BindingAction::Soundboard;
    binding.targets = vec![BindingTarget::Soundboard];
    binding.soundboard = Some(SoundboardMapping {
        path: r"C:\sounds\intro.mp3".to_string(),
        display: "intro.mp3".to_string(),
        trim_start_ms: 125,
        trim_end_ms: Some(1_875),
        volume: 0.65,
        speed: 1.25,
        output_device_id: Some("wasapi:device-1".to_string()),
        output_device_display: Some("Studio Speakers".to_string()),
    });

    let json = serde_json::to_value(&binding).unwrap();
    assert_eq!(json["action"], "Soundboard");
    assert_eq!(json["targets"][0], "Soundboard");
    assert_eq!(json["soundboard"]["trim_start_ms"], 125);
    assert_eq!(json["soundboard"]["trim_end_ms"], 1_875);
    let volume = json["soundboard"]["volume"].as_f64().unwrap();
    assert!((volume - 0.65).abs() < 0.000_001);
    assert_eq!(json["soundboard"]["speed"], 1.25);
    assert_eq!(
        json["soundboard"]["output_device_display"],
        "Studio Speakers"
    );

    let restored: Binding = serde_json::from_value(json).unwrap();
    assert_eq!(restored.soundboard, binding.soundboard);
}

#[test]
fn soundboard_defaults_preserve_old_profiles() {
    let binding: Binding = serde_json::from_value(binding_base_json()).unwrap();
    assert!(binding.soundboard.is_none());

    let mapping: SoundboardMapping = serde_json::from_value(serde_json::json!({
        "path": "clip.wav",
        "display": "clip.wav"
    }))
    .unwrap();
    assert_eq!(mapping.trim_start_ms, 0);
    assert_eq!(mapping.trim_end_ms, None);
    assert_eq!(mapping.volume, 1.0);
    assert_eq!(mapping.speed, 1.0);
    assert_eq!(mapping.output_device_id, None);
}

#[test]
fn soundboard_normalization_clamps_volume_and_invalid_end() {
    let mapping = SoundboardMapping {
        path: " clip.wav ".to_string(),
        display: " ".to_string(),
        trim_start_ms: 500,
        trim_end_ms: Some(100),
        volume: 5.0,
        speed: 0.1,
        output_device_id: Some(" device ".to_string()),
        output_device_display: Some(" Speakers ".to_string()),
    }
    .normalized()
    .unwrap();

    assert_eq!(mapping.path, "clip.wav");
    assert_eq!(mapping.display, "clip.wav");
    assert_eq!(mapping.trim_start_ms, 500);
    assert_eq!(mapping.trim_end_ms, Some(501));
    assert_eq!(mapping.volume, 1.0);
    assert_eq!(mapping.speed, 0.5);
    assert_eq!(mapping.output_device_id.as_deref(), Some("device"));
    assert_eq!(mapping.output_device_display.as_deref(), Some("Speakers"));
}

#[test]
fn soundboard_button_mapping_is_complete_and_momentary() {
    let mut binding =
        mapped_button_binding(BindingAction::Soundboard, vec![BindingTarget::Soundboard]);
    binding.soundboard = Some(SoundboardMapping {
        path: "clip.wav".to_string(),
        display: "clip.wav".to_string(),
        trim_start_ms: 0,
        trim_end_ms: None,
        volume: 1.0,
        speed: 1.0,
        output_device_id: None,
        output_device_display: None,
    });

    assert!(binding.has_complete_mapped_button_light_target(&binding.targets));
    assert_eq!(
        binding.normalized_targets(),
        vec![BindingTarget::Soundboard]
    );
}

#[test]
fn soundboard_normalization_preserves_other_targets_and_deduplicates_soundboard() {
    let mut binding = mapped_button_binding(
        BindingAction::Soundboard,
        vec![
            BindingTarget::Soundboard,
            BindingTarget::Master,
            BindingTarget::Soundboard,
        ],
    );
    binding.ensure_targets();
    assert_eq!(binding.action, BindingAction::Soundboard);
    assert_eq!(
        binding.targets,
        vec![BindingTarget::Soundboard, BindingTarget::Master]
    );
}

#[test]
fn soundboard_target_preserves_primary_media_action() {
    let mut binding = mapped_button_binding(
        BindingAction::MediaPlayPause,
        vec![BindingTarget::Soundboard, BindingTarget::MediaControl],
    );
    binding.ensure_targets();
    assert_eq!(binding.action, BindingAction::MediaPlayPause);
    assert_eq!(
        binding.targets,
        vec![BindingTarget::Soundboard, BindingTarget::MediaControl]
    );
}

#[test]
fn macro_and_soundboard_conflict_keeps_only_the_preferred_special_target() {
    let mut binding = mapped_button_binding(
        BindingAction::Soundboard,
        vec![BindingTarget::Macro, BindingTarget::Soundboard],
    );
    binding.macro_name = "Discard me".to_string();
    binding.soundboard = Some(SoundboardMapping {
        path: "clip.wav".to_string(),
        display: "clip.wav".to_string(),
        trim_start_ms: 0,
        trim_end_ms: None,
        volume: 1.0,
        speed: 1.0,
        output_device_id: None,
        output_device_display: None,
    });
    binding.ensure_targets();
    assert_eq!(binding.targets, vec![BindingTarget::Soundboard]);
    assert!(binding.macro_name.is_empty());
    assert!(binding.soundboard.is_some());
}

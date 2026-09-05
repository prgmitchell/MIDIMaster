use super::*;
use crate::model::{
    AuxiliaryControl, BindingAction, BindingControlKind, BindingTarget, FaderCurve,
    FaderCurvePoint, MidiControl, MidiMode, MuteBehavior,
};

fn direct_feedback(
    channel: u8,
    controller: u8,
    value: f32,
    msg_type: MidiMessageType,
) -> FeedbackMessage {
    build_feedback_message(channel, controller, value, &msg_type, None, "")
}

fn expected_direct_feedback(
    bytes: Vec<u8>,
    channel: u8,
    controller: u8,
    msg_type: MidiMessageType,
    normalized_value: f32,
    raw_midi_value: u16,
) -> FeedbackMessage {
    FeedbackMessage {
        logical_bytes: bytes.clone(),
        logical_raw_midi_value: raw_midi_value,
        physical_bytes: bytes.clone(),
        physical_messages: vec![bytes],
        physical_channel: channel,
        physical_controller: controller,
        physical_msg_type: msg_type,
        physical_raw_midi_value: raw_midi_value,
        normalized_value,
        protocol: "direct",
    }
}

#[test]
fn parses_program_change_zero_as_button_press() {
    let event = parse_midi_message("midi:0", &[0xC0, 0x00]).expect("program change event");

    assert_eq!(event.device_id, "midi:0");
    assert_eq!(event.channel, 0);
    assert_eq!(event.controller, 0);
    assert_eq!(event.value, 127);
    assert_eq!(event.value_14, None);
    assert_eq!(event.msg_type, MidiMessageType::ProgramChange);
}

#[test]
fn parses_program_change_program_number_and_channel() {
    let event = parse_midi_message("midi:1", &[0xC3, 0x7C]).expect("program change event");

    assert_eq!(event.device_id, "midi:1");
    assert_eq!(event.channel, 3);
    assert_eq!(event.controller, 0x7C);
    assert_eq!(event.value, 127);
    assert_eq!(event.value_14, None);
    assert_eq!(event.msg_type, MidiMessageType::ProgramChange);
}

#[test]
fn ignores_truncated_three_byte_messages_without_dropping_program_change() {
    assert!(parse_midi_message("midi:0", &[0xB0, 0x07]).is_none());
    assert!(parse_midi_message("midi:0", &[0xC0, 0x05]).is_some());
}

fn manager_with_test_route(input_device_id: &str, output_device_id: &str) -> MidiManager {
    let mut manager = MidiManager::new();
    insert_test_route(&mut manager, input_device_id, output_device_id);
    manager
}

fn insert_test_route(manager: &mut MidiManager, input_device_id: &str, output_device_id: &str) {
    manager.input_routes.insert(
        input_device_id.to_string(),
        MidiInputRoute {
            input_connection: None,
            input_device_id: input_device_id.to_string(),
            input_device_name: String::new(),
            output_device_id: output_device_id.to_string(),
            input_connection_suspect: false,
            input_connection_suspect_reason: None,
            input_inventory_generation: inventory_generation("input"),
            last_input_seen_at_ms: Arc::new(AtomicU64::new(0)),
        },
    );
    manager.output_routes.insert(
        output_device_id.to_string(),
        MidiOutputRoute {
            output_connection: None,
            output_device_name: String::new(),
            last_reconnect_attempt: None,
            last_reconnect_skipped_log: None,
            reconnect_failures: 0,
            connection_suspect: false,
            connection_suspect_reason: None,
        },
    );
}

fn xtouch_mini_mc_volume_binding(controller: u8) -> Binding {
    Binding {
        id: "binding-1".to_string(),
        name: "Binding 1".to_string(),
        device_id: "midi:0".to_string(),
        control: MidiControl {
            channel: 0,
            controller,
            msg_type: MidiMessageType::ControlChange,
        },
        control_kind: BindingControlKind::Continuous,
        targets: vec![BindingTarget::Master],
        target: BindingTarget::Master,
        action: BindingAction::Volume,
        mode: MidiMode::Relative,
        ..crate::test_support::binding()
    }
}

#[test]
fn empty_enumeration_logging_is_rate_limited() {
    let mut state = EmptyEnumerationLogState::default();
    let start = Instant::now();
    let interval = Duration::from_secs(60);

    assert!(should_log_empty_enumeration(&mut state, start, interval));
    assert!(!should_log_empty_enumeration(
        &mut state,
        start + Duration::from_secs(3),
        interval
    ));
    assert!(should_log_empty_enumeration(
        &mut state,
        start + Duration::from_secs(61),
        interval
    ));
}

#[test]
fn empty_enumeration_logging_resets_after_devices_return() {
    let mut state = EmptyEnumerationLogState::default();
    let start = Instant::now();
    let interval = Duration::from_secs(60);

    assert!(should_log_empty_enumeration(&mut state, start, interval));
    note_non_empty_enumeration(&mut state);
    assert!(should_log_empty_enumeration(
        &mut state,
        start + Duration::from_secs(3),
        interval
    ));
}

#[test]
fn reconnect_skipped_logging_is_rate_limited() {
    let mut last_logged_at = None;
    let start = Instant::now();
    let interval = Duration::from_secs(30);

    assert!(should_log_reconnect_skipped(
        &mut last_logged_at,
        start,
        interval
    ));
    assert!(!should_log_reconnect_skipped(
        &mut last_logged_at,
        start + Duration::from_secs(3),
        interval
    ));
    assert!(should_log_reconnect_skipped(
        &mut last_logged_at,
        start + Duration::from_secs(31),
        interval
    ));
}

#[test]
fn expected_device_name_validation_rejects_reused_output_id() {
    validate_expected_device_name(
        "output",
        "midi:1",
        Some("Platform X+1 V2.13"),
        "Platform X+1 V2.13",
    )
    .expect("matching output name should pass");

    let err = validate_expected_device_name(
        "output",
        "midi:1",
        Some("Platform X+1 V2.13"),
        "Focusrite USB MIDI",
    )
    .expect_err("reused id with a different output name should be rejected");

    let message = err.to_string();
    assert!(message.contains("midi:1"));
    assert!(message.contains("Focusrite USB MIDI"));
    assert!(message.contains("Platform X+1 V2.13"));
}

#[test]
fn unrelated_inventory_addition_preserves_route_identity() {
    let devices = vec![
        DeviceInfo {
            id: "midi:0".to_string(),
            name: "MIDI Mix".to_string(),
        },
        DeviceInfo {
            id: "midi:1".to_string(),
            name: "Unrelated Controller".to_string(),
        },
    ];

    assert_eq!(inventory_device_name(&devices, "midi:0"), Some("MIDI Mix"));
}

#[test]
fn inventory_identity_detects_actual_removal_and_id_reuse() {
    let removed = vec![DeviceInfo {
        id: "midi:1".to_string(),
        name: "Unrelated Controller".to_string(),
    }];
    let reused = vec![DeviceInfo {
        id: "midi:0".to_string(),
        name: "Focusrite USB MIDI".to_string(),
    }];

    assert_eq!(inventory_device_name(&removed, "midi:0"), None);
    assert_ne!(
        inventory_device_name(&reused, "midi:0"),
        Some("Platform X+1 V2.13")
    );
}

#[test]
fn route_preflight_failure_preserves_existing_routes() {
    let mut manager = manager_with_test_route("midi:998", "midi:999");
    let before = manager.active_routes();
    let requested = MidiDeviceRoute {
        input_device_id: Some("midi:999999".to_string()),
        output_device_id: Some("midi:999999".to_string()),
        input_device_name: Some("Missing MIDI Input".to_string()),
        output_device_name: Some("Missing MIDI Output".to_string()),
        enabled: true,
    };

    let result = manager.set_device_routes(&[requested], Arc::new(|_| {}), false);

    assert!(result.is_err());
    assert_eq!(manager.active_routes(), before);
}

#[test]
fn device_name_mismatch_requires_known_expected_name() {
    assert!(!device_name_mismatch(None, Some("Focusrite USB MIDI")));
    assert!(!device_name_mismatch(
        Some("Platform X+1 V2.13"),
        Some("Platform X+1 V2.13")
    ));
    assert!(device_name_mismatch(
        Some("Platform X+1 V2.13"),
        Some("Focusrite USB MIDI")
    ));
    assert!(device_name_mismatch(Some("Platform X+1 V2.13"), None));
}

#[test]
fn route_health_reports_input_suspect_fields() {
    let mut manager = manager_with_test_route("midi:998", "midi:999");
    let route = manager
        .input_routes
        .get_mut("midi:998")
        .expect("test input route");
    route.input_device_name = "Platform X+1 V2.13".to_string();
    route.input_connection_suspect = true;
    route.input_connection_suspect_reason = Some("input_inventory_changed".to_string());
    route.last_input_seen_at_ms.store(1234, Ordering::Relaxed);

    let health = manager.connection_health();

    assert_eq!(health.input_device_id, "midi:998");
    assert!(health.suspect);
    assert!(health.input_suspect);
    assert_eq!(health.reason, "input_port_missing");
    assert_eq!(
        health.expected_input_name.as_deref(),
        Some("Platform X+1 V2.13")
    );
    assert_eq!(health.last_input_seen_at, Some(1234));
}

#[test]
fn connection_health_marks_suspect_pair() {
    let mut manager = manager_with_test_route("midi:0", "midi:1");

    manager.mark_output_suspect("midi:1", "output_send_failed");

    let health = manager.connection_health();
    assert_eq!(health.input_device_id, "midi:0");
    assert_eq!(health.output_device_id, "midi:1");
    assert!(health.suspect);
    assert!(!health.connected);
    assert_eq!(health.reason, "output_send_failed");
}

#[test]
fn route_health_isolated_by_output_route() {
    let mut manager = manager_with_test_route("midi:0", "midi:10");
    insert_test_route(&mut manager, "midi:1", "midi:11");

    manager.mark_output_suspect("midi:10", "output_send_failed");

    let health = manager.route_health();

    assert_eq!(health.len(), 2);
    assert_eq!(health[0].input_device_id, "midi:0");
    assert!(health[0].suspect);
    assert_eq!(health[0].reason, "output_send_failed");
    assert_eq!(health[1].input_device_id, "midi:1");
    assert!(!health[1].suspect);
    assert_eq!(health[1].reason, "");
}

#[test]
fn feedback_failure_marks_only_binding_route_output_suspect() {
    let mut manager = manager_with_test_route("midi:0", "midi:998");
    insert_test_route(&mut manager, "midi:1", "midi:999");

    manager
        .send_feedback("midi:0", 0, 7, 0.5, MidiMessageType::ControlChange)
        .expect("feedback send should degrade health instead of failing");

    let health = manager.route_health();
    let first = health
        .iter()
        .find(|route| route.input_device_id == "midi:0")
        .expect("first route health");
    let second = health
        .iter()
        .find(|route| route.input_device_id == "midi:1")
        .expect("second route health");

    assert!(first.suspect);
    assert_eq!(first.output_device_id, "midi:998");
    assert!(!second.suspect);
    assert_eq!(second.output_device_id, "midi:999");
}

#[test]
fn feedback_with_stale_device_id_uses_single_active_route() {
    let mut manager = manager_with_test_route("midi:1", "midi:998");

    manager
        .send_feedback("midi:0", 0, 7, 0.5, MidiMessageType::ControlChange)
        .expect("single active route feedback fallback should not fail");

    let health = manager.route_health();
    assert_eq!(health.len(), 1);
    assert_eq!(health[0].input_device_id, "midi:1");
    assert_eq!(health[0].output_device_id, "midi:998");
    assert!(health[0].suspect);
}

#[test]
fn feedback_with_stale_device_id_does_not_fallback_when_routes_are_ambiguous() {
    let mut manager = manager_with_test_route("midi:1", "midi:998");
    insert_test_route(&mut manager, "midi:2", "midi:999");

    manager
        .send_feedback("midi:0", 0, 7, 0.5, MidiMessageType::ControlChange)
        .expect("ambiguous stale feedback should be skipped without failing");

    let health = manager.route_health();
    assert_eq!(health.len(), 2);
    assert!(health.iter().all(|route| !route.suspect));
}

#[test]
fn setting_empty_routes_clears_suspect_health() {
    let mut manager = manager_with_test_route("midi:0", "midi:1");
    manager.mark_output_suspect("midi:1", "output_send_failed");

    manager
        .set_device_routes(&[], std::sync::Arc::new(|_| {}), false)
        .expect("empty route sync");

    let health = manager.connection_health();
    assert_eq!(health.input_device_id, "");
    assert_eq!(health.output_device_id, "");
    assert!(!health.suspect);
    assert_eq!(health.reason, "");
}

#[test]
fn stop_clears_suspect_health() {
    let mut manager = manager_with_test_route("midi:0", "midi:1");
    manager.mark_output_suspect("midi:1", "output_reconnect_failed");

    manager.stop();

    let health = manager.connection_health();
    assert!(!health.suspect);
    assert_eq!(health.reason, "");
}

#[test]
fn control_change_feedback_maps_normalized_values_to_7_bit_bytes() {
    assert_eq!(
        direct_feedback(0, 9, 0.0, MidiMessageType::ControlChange),
        expected_direct_feedback(
            vec![0xB0, 9, 0],
            0,
            9,
            MidiMessageType::ControlChange,
            0.0,
            0
        )
    );
    assert_eq!(
        direct_feedback(0, 9, 0.5, MidiMessageType::ControlChange),
        expected_direct_feedback(
            vec![0xB0, 9, 64],
            0,
            9,
            MidiMessageType::ControlChange,
            0.5,
            64
        )
    );
    assert_eq!(
        direct_feedback(0, 9, 1.0, MidiMessageType::ControlChange),
        expected_direct_feedback(
            vec![0xB0, 9, 127],
            0,
            9,
            MidiMessageType::ControlChange,
            1.0,
            127
        )
    );
}

#[test]
fn note_feedback_maps_normalized_value_to_velocity() {
    assert_eq!(
        direct_feedback(2, 15, 1.0, MidiMessageType::Note),
        expected_direct_feedback(vec![0x92, 15, 127], 2, 15, MidiMessageType::Note, 1.0, 127)
    );
}

#[test]
fn program_change_button_can_emit_note_indicator_feedback() {
    let mut binding = xtouch_mini_mc_volume_binding(16);
    binding.control_kind = BindingControlKind::Button;
    binding.control.msg_type = MidiMessageType::ProgramChange;
    binding.indicator_control = Some(AuxiliaryControl {
        device_id: "midi:0".to_string(),
        channel: 4,
        controller: 25,
        msg_type: MidiMessageType::Note,
        control_kind: BindingControlKind::Button,
        mode: MidiMode::Absolute,
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: MuteBehavior::ToggleOnPress,
    });

    let indicator = binding
        .indicator_feedback_control()
        .expect("custom indicator should be used");
    let feedback = build_feedback_message(
        indicator.channel,
        indicator.controller,
        1.0,
        &indicator.msg_type,
        None,
        "Generic MIDI Output",
    );

    assert_eq!(feedback.protocol, "direct");
    assert_eq!(feedback.physical_bytes, vec![0x94, 25, 127]);
}

#[test]
fn custom_indicator_light_feedback_includes_primary_off_send() {
    let mut binding = xtouch_mini_mc_volume_binding(21);
    binding.control_kind = BindingControlKind::Button;
    binding.control.msg_type = MidiMessageType::Note;
    binding.mode = MidiMode::Absolute;
    binding.indicator_control = Some(AuxiliaryControl {
        device_id: "midi:0".to_string(),
        channel: 0,
        controller: 22,
        msg_type: MidiMessageType::Note,
        control_kind: BindingControlKind::Button,
        mode: MidiMode::Absolute,
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: MuteBehavior::ToggleOnPress,
    });

    let sends = binding_light_feedback_sends(&binding, 1.0);

    assert_eq!(sends.len(), 2);
    assert_eq!(sends[0].device_id, "midi:0");
    assert_eq!(sends[0].channel, 0);
    assert_eq!(sends[0].controller, 22);
    assert_eq!(sends[0].msg_type, MidiMessageType::Note);
    assert_eq!(sends[0].value, 1.0);
    assert!(!sends[0].use_binding_protocol);
    assert_eq!(sends[1].device_id, "midi:0");
    assert_eq!(sends[1].channel, 0);
    assert_eq!(sends[1].controller, 21);
    assert_eq!(sends[1].msg_type, MidiMessageType::Note);
    assert_eq!(sends[1].value, 0.0);
    assert!(!sends[1].use_binding_protocol);
}

#[test]
fn default_button_light_feedback_uses_primary_send_only() {
    let mut binding = xtouch_mini_mc_volume_binding(21);
    binding.control_kind = BindingControlKind::Button;
    binding.control.msg_type = MidiMessageType::Note;
    binding.mode = MidiMode::Absolute;

    let sends = binding_light_feedback_sends(&binding, 1.0);

    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].device_id, "midi:0");
    assert_eq!(sends[0].channel, 0);
    assert_eq!(sends[0].controller, 21);
    assert_eq!(sends[0].msg_type, MidiMessageType::Note);
    assert_eq!(sends[0].value, 1.0);
    assert!(sends[0].use_binding_protocol);
}

#[test]
fn custom_fader_feedback_uses_pitch_bend_indicator_send_without_primary_suppression() {
    let mut binding = xtouch_mini_mc_volume_binding(21);
    binding.control_kind = BindingControlKind::Continuous;
    binding.control.msg_type = MidiMessageType::PitchBend;
    binding.indicator_control = Some(AuxiliaryControl {
        device_id: "midi:0".to_string(),
        channel: 4,
        controller: 0,
        msg_type: MidiMessageType::PitchBend,
        control_kind: BindingControlKind::Continuous,
        mode: MidiMode::Absolute,
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: MuteBehavior::ToggleOnPress,
    });

    let send = binding_feedback_send(&binding, 0.5).expect("enabled fader should produce feedback");
    let feedback = build_feedback_message(
        send.channel,
        send.controller,
        send.value,
        &send.msg_type,
        None,
        "Generic MIDI Output",
    );

    assert_eq!(send.device_id, "midi:0");
    assert_eq!(send.channel, 4);
    assert_eq!(send.controller, 0);
    assert_eq!(send.msg_type, MidiMessageType::PitchBend);
    assert_eq!(send.value, 0.5);
    assert!(!send.use_binding_protocol);
    assert_eq!(feedback.protocol, "direct");
    assert_eq!(feedback.physical_bytes, vec![0xE4, 0, 64]);
}

#[test]
fn default_fader_feedback_uses_primary_binding_protocol() {
    let mut binding = xtouch_mini_mc_volume_binding(21);
    binding.control_kind = BindingControlKind::Continuous;
    binding.control.msg_type = MidiMessageType::PitchBend;

    let send = binding_feedback_send(&binding, 0.5).expect("enabled fader should produce feedback");

    assert_eq!(send.device_id, "midi:0");
    assert_eq!(send.channel, binding.control.channel);
    assert_eq!(send.controller, binding.control.controller);
    assert_eq!(send.msg_type, MidiMessageType::PitchBend);
    assert_eq!(send.value, 0.5);
    assert!(send.use_binding_protocol);
}

#[test]
fn absolute_custom_curve_feedback_inverts_logical_volume_for_primary_output() {
    let mut binding = xtouch_mini_mc_volume_binding(21);
    binding.mode = MidiMode::Absolute;
    binding.fader_curve = FaderCurve::Custom;
    binding.custom_curve = vec![
        FaderCurvePoint {
            x: 0.0,
            y: 0.0,
            curve: 0.0,
        },
        FaderCurvePoint {
            x: 0.5,
            y: 0.75,
            curve: 0.0,
        },
        FaderCurvePoint {
            x: 1.0,
            y: 1.0,
            curve: 0.0,
        },
    ];

    let send =
        binding_feedback_send(&binding, 0.75).expect("enabled fader should produce feedback");

    assert!((send.value - 0.5).abs() < 1.0e-6);
    assert!(send.use_binding_protocol);
}

#[test]
fn absolute_curve_feedback_inverts_logical_volume_for_custom_output() {
    let mut binding = xtouch_mini_mc_volume_binding(21);
    binding.mode = MidiMode::Absolute;
    binding.fader_curve = FaderCurve::Exponential;
    binding.indicator_control = Some(AuxiliaryControl {
        device_id: "midi:1".to_string(),
        channel: 4,
        controller: 7,
        msg_type: MidiMessageType::ControlChange,
        control_kind: BindingControlKind::Continuous,
        mode: MidiMode::Absolute,
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: MuteBehavior::ToggleOnPress,
    });
    let logical = 0.5_f32.powf(0.55);

    let send =
        binding_feedback_send(&binding, logical).expect("enabled fader should produce feedback");

    assert_eq!(send.device_id, "midi:1");
    assert_eq!(send.channel, 4);
    assert_eq!(send.controller, 7);
    assert!((send.value - 0.5).abs() < 1.0e-6);
    assert!(!send.use_binding_protocol);
}

#[test]
fn relative_fader_feedback_does_not_apply_curve_inversion() {
    let mut binding = xtouch_mini_mc_volume_binding(21);
    binding.mode = MidiMode::Relative;
    binding.fader_curve = FaderCurve::Logarithmic;

    let send =
        binding_feedback_send(&binding, 0.75).expect("enabled fader should produce feedback");

    assert_eq!(send.value, 0.75);
}

#[test]
fn raw_fader_position_feedback_bypasses_curve_inversion() {
    let mut binding = xtouch_mini_mc_volume_binding(21);
    binding.mode = MidiMode::Absolute;
    binding.fader_curve = FaderCurve::Custom;
    binding.custom_curve = vec![
        FaderCurvePoint {
            x: 0.0,
            y: 0.25,
            curve: 0.0,
        },
        FaderCurvePoint {
            x: 1.0,
            y: 1.0,
            curve: 0.0,
        },
    ];

    let send = binding_feedback_position_send(&binding, 0.0)
        .expect("enabled fader should produce raw position feedback");

    assert_eq!(send.value, 0.0);
}

#[test]
fn disabled_bindings_produce_no_primary_or_custom_feedback_sends() {
    let mut fader = xtouch_mini_mc_volume_binding(21);
    fader.feedback_enabled = false;
    fader.indicator_control = Some(AuxiliaryControl {
        device_id: "midi:0".to_string(),
        channel: 4,
        controller: 22,
        msg_type: MidiMessageType::ControlChange,
        control_kind: BindingControlKind::Continuous,
        mode: MidiMode::Absolute,
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: MuteBehavior::ToggleOnPress,
    });

    assert!(binding_feedback_send(&fader, 0.5).is_none());

    let mut button = fader;
    button.control_kind = BindingControlKind::Button;
    assert!(binding_light_feedback_sends(&button, 1.0).is_empty());
}

#[test]
fn pitch_bend_feedback_maps_normalized_value_to_14_bit_bytes() {
    assert_eq!(
        direct_feedback(1, 0xE0, 0.0, MidiMessageType::PitchBend),
        expected_direct_feedback(
            vec![0xE1, 0, 0],
            1,
            0xE0,
            MidiMessageType::PitchBend,
            0.0,
            0
        )
    );
    assert_eq!(
        direct_feedback(1, 0xE0, 0.5, MidiMessageType::PitchBend),
        expected_direct_feedback(
            vec![0xE1, 0, 64],
            1,
            0xE0,
            MidiMessageType::PitchBend,
            0.5,
            8192
        )
    );
    assert_eq!(
        direct_feedback(1, 0xE0, 1.0, MidiMessageType::PitchBend),
        expected_direct_feedback(
            vec![0xE1, 0x7F, 0x7F],
            1,
            0xE0,
            MidiMessageType::PitchBend,
            1.0,
            16383
        )
    );
}

#[test]
fn feedback_values_are_clamped_before_byte_construction() {
    assert_eq!(
        direct_feedback(0, 9, -1.0, MidiMessageType::ControlChange),
        expected_direct_feedback(
            vec![0xB0, 9, 0],
            0,
            9,
            MidiMessageType::ControlChange,
            0.0,
            0
        )
    );
    assert_eq!(
        direct_feedback(0, 9, 2.0, MidiMessageType::ControlChange),
        expected_direct_feedback(
            vec![0xB0, 9, 127],
            0,
            9,
            MidiMessageType::ControlChange,
            1.0,
            127
        )
    );
}

#[test]
fn xtouch_mini_mc_knob_one_relative_volume_maps_to_vpot_fan_feedback() {
    let binding = xtouch_mini_mc_volume_binding(16);

    let off = build_feedback_message(
        0,
        16,
        0.0,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-TOUCH MINI",
    );
    assert_eq!(off.protocol, "xtouch_mc_vpot_fan");
    assert_eq!(off.logical_bytes, vec![0xB0, 0x10, 0x00]);
    assert_eq!(off.physical_bytes, vec![0xB0, 0x30, 0x00]);
    assert_eq!(off.physical_messages, vec![vec![0xB0, 0x30, 0x00]]);

    let halfway = build_feedback_message(
        0,
        16,
        0.5,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-TOUCH MINI",
    );
    assert_eq!(halfway.logical_bytes, vec![0xB0, 0x10, 0x40]);
    assert_eq!(halfway.physical_bytes, vec![0xB0, 0x30, 0x26]);

    let full = build_feedback_message(
        0,
        16,
        1.0,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-TOUCH MINI",
    );
    assert_eq!(full.logical_bytes, vec![0xB0, 0x10, 0x7F]);
    assert_eq!(full.physical_bytes, vec![0xB0, 0x30, 0x2B]);
}

#[test]
fn xtouch_mini_standard_knob_one_maps_to_full_ring_feedback() {
    let mut binding = xtouch_mini_mc_volume_binding(1);
    binding.control.channel = 10;
    binding.mode = MidiMode::Absolute;

    let off = build_feedback_message(
        10,
        1,
        0.0,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-TOUCH MINI",
    );
    assert_eq!(off.protocol, "xtouch_mini_standard_fan");
    assert_eq!(off.logical_bytes, vec![0xBA, 0x01, 0x00]);
    assert_eq!(off.physical_bytes, vec![0xBA, 0x09, 0x00]);
    assert_eq!(
        off.physical_messages,
        vec![vec![0xBA, 0x01, 0x02], vec![0xBA, 0x09, 0x00]]
    );

    let first_segment = build_feedback_message(
        10,
        1,
        0.001,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-TOUCH MINI",
    );
    assert_eq!(first_segment.physical_bytes, vec![0xBA, 0x09, 0x01]);

    let full = build_feedback_message(
        10,
        1,
        1.0,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-TOUCH MINI",
    );
    assert_eq!(full.physical_bytes, vec![0xBA, 0x09, 0x0D]);
}

#[test]
fn xtouch_mini_standard_knob_eight_relative_volume_maps_to_ring_eight() {
    let mut binding = xtouch_mini_mc_volume_binding(8);
    binding.control.channel = 10;

    let feedback = build_feedback_message(
        10,
        8,
        0.5,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-Touch Mini MIDI 1",
    );

    assert_eq!(feedback.protocol, "xtouch_mini_standard_fan");
    assert_eq!(feedback.physical_bytes, vec![0xBA, 0x10, 0x07]);
    assert_eq!(
        feedback.physical_messages,
        vec![vec![0xBA, 0x08, 0x02], vec![0xBA, 0x10, 0x07]]
    );
}

#[test]
fn xtouch_standard_detection_does_not_affect_extender_or_generic_outputs() {
    let mut binding = xtouch_mini_mc_volume_binding(1);
    binding.control.channel = 10;

    for output_name in ["X-Touch-Ext", "X-TOUCH EXTENDER", "Generic MIDI Output"] {
        let feedback = build_feedback_message(
            10,
            1,
            0.5,
            &MidiMessageType::ControlChange,
            Some(&binding),
            output_name,
        );

        assert_eq!(feedback.protocol, "direct", "output={output_name}");
        assert_eq!(feedback.physical_bytes, vec![0xBA, 0x01, 0x40]);
        assert_eq!(feedback.physical_messages.len(), 1);
    }
}

#[test]
fn xtouch_standard_detection_requires_continuous_volume_cc_in_factory_range() {
    let mut binding = xtouch_mini_mc_volume_binding(1);
    binding.control.channel = 10;

    binding.action = BindingAction::ToggleMute;
    let non_volume = build_feedback_message(
        10,
        1,
        0.5,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-TOUCH MINI",
    );
    assert_eq!(non_volume.protocol, "direct");

    binding.action = BindingAction::Volume;
    binding.control_kind = BindingControlKind::Button;
    let button = build_feedback_message(
        10,
        1,
        0.5,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-TOUCH MINI",
    );
    assert_eq!(button.protocol, "direct");

    binding.control_kind = BindingControlKind::Continuous;
    binding.control.controller = 9;
    let outside_range = build_feedback_message(
        10,
        9,
        0.5,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-TOUCH MINI",
    );
    assert_eq!(outside_range.protocol, "direct");
}

#[test]
fn ordered_feedback_retry_restarts_from_first_message() {
    let messages = vec![vec![0xBA, 0x01, 0x02], vec![0xBA, 0x09, 0x07]];
    let mut attempted = Vec::new();
    let first_result = send_feedback_messages(&messages, |message| {
        attempted.push(message.to_vec());
        if attempted.len() == 2 {
            Err("send failed")
        } else {
            Ok(())
        }
    });
    assert_eq!(first_result, Err("send failed"));

    let retry_result: std::result::Result<(), &str> =
        send_feedback_messages(&messages, |message| {
            attempted.push(message.to_vec());
            Ok(())
        });
    assert_eq!(retry_result, Ok(()));
    assert_eq!(
        attempted,
        vec![
            vec![0xBA, 0x01, 0x02],
            vec![0xBA, 0x09, 0x07],
            vec![0xBA, 0x01, 0x02],
            vec![0xBA, 0x09, 0x07]
        ]
    );
}

#[test]
fn xtouch_mini_mc_knob_eight_relative_volume_maps_to_vpot_eight() {
    let binding = xtouch_mini_mc_volume_binding(23);
    let feedback = build_feedback_message(
        0,
        23,
        1.0,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-TOUCH MINI",
    );

    assert_eq!(feedback.protocol, "xtouch_mc_vpot_fan");
    assert_eq!(feedback.physical_bytes, vec![0xB0, 0x37, 0x2B]);
}

#[test]
fn xtouch_ext_knob_one_relative_volume_maps_to_vpot_fan_feedback() {
    let binding = xtouch_mini_mc_volume_binding(16);
    let feedback = build_feedback_message(
        0,
        16,
        0.5,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-Touch-Ext",
    );

    assert_eq!(feedback.protocol, "xtouch_mc_vpot_fan");
    assert_eq!(feedback.physical_bytes, vec![0xB0, 0x30, 0x26]);
}

#[test]
fn xtouch_ext_knob_eight_relative_volume_maps_to_vpot_eight() {
    let binding = xtouch_mini_mc_volume_binding(23);
    let feedback = build_feedback_message(
        0,
        23,
        1.0,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-Touch-Ext",
    );

    assert_eq!(feedback.protocol, "xtouch_mc_vpot_fan");
    assert_eq!(feedback.physical_bytes, vec![0xB0, 0x37, 0x2B]);
}

#[test]
fn non_xtouch_output_keeps_direct_relative_encoder_feedback() {
    let binding = xtouch_mini_mc_volume_binding(16);
    let feedback = build_feedback_message(
        0,
        16,
        0.5,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "Generic MIDI Output",
    );

    assert_eq!(feedback.protocol, "direct");
    assert_eq!(feedback.physical_bytes, vec![0xB0, 0x10, 0x40]);
}

#[test]
fn xtouch_mini_note_feedback_stays_direct() {
    let mut binding = xtouch_mini_mc_volume_binding(16);
    binding.control.msg_type = MidiMessageType::Note;
    binding.control.controller = 40;
    let feedback = build_feedback_message(
        0,
        40,
        1.0,
        &MidiMessageType::Note,
        Some(&binding),
        "X-TOUCH MINI",
    );

    assert_eq!(feedback.protocol, "direct");
    assert_eq!(feedback.physical_bytes, vec![0x90, 40, 127]);
}

#[test]
fn xtouch_mini_absolute_cc_feedback_stays_direct() {
    let mut binding = xtouch_mini_mc_volume_binding(16);
    binding.mode = MidiMode::Absolute;
    let feedback = build_feedback_message(
        0,
        16,
        0.5,
        &MidiMessageType::ControlChange,
        Some(&binding),
        "X-TOUCH MINI",
    );

    assert_eq!(feedback.protocol, "direct");
    assert_eq!(feedback.physical_bytes, vec![0xB0, 0x10, 0x40]);
}

use super::*;
use crate::model::{AuxiliaryControl, FaderOutput, FaderOutputKind, FeedbackMode};

fn output(
    id: &str,
    kind: FaderOutputKind,
    msg_type: MidiMessageType,
    controller: u8,
) -> FaderOutput {
    FaderOutput {
        id: id.into(),
        kind,
        enabled: true,
        feedback_mode: FeedbackMode::FollowValue,
        control: AuxiliaryControl {
            device_id: "usb-in".into(),
            channel: 0,
            controller,
            msg_type,
            control_kind: crate::model::BindingControlKind::Continuous,
            mode: crate::model::MidiMode::Absolute,
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: crate::model::MuteBehavior::ToggleOnPress,
        },
    }
}

#[test]
fn additional_value_outputs_share_curve_and_route_independently() {
    let mut binding = crate::test_support::binding();
    binding.device_id = "usb-in".into();
    binding.control.msg_type = MidiMessageType::PitchBend;
    binding.fader_curve = crate::model::FaderCurve::Exponential;
    let mut second = output(
        "second",
        FaderOutputKind::Feedback,
        MidiMessageType::ControlChange,
        23,
    );
    second.control.device_id = "network-in".into();
    binding.additional_outputs = vec![
        second,
        output("light", FaderOutputKind::Led, MidiMessageType::Note, 30),
    ];
    let sends = additional_feedback::value_feedback_sends(&binding, 0.25, false);
    assert_eq!(sends.len(), 2);
    assert!((sends[0].value - 0.0804).abs() < 0.001);
    assert_eq!(sends[0].value, sends[1].value);
    assert_eq!(sends[1].device_id, "network-in");
    assert_eq!(sends[1].controller, 23);
    assert!(!sends[1].use_binding_protocol);
    binding.feedback_enabled = false;
    assert!(binding.has_value_feedback());
    assert_eq!(
        additional_feedback::value_feedback_sends(&binding, 0.25, false).len(),
        1
    );
    assert_eq!(
        additional_feedback::value_feedback_sends(&binding, 0.25, true)[0].value,
        0.25
    );
    binding.additional_outputs[0].enabled = false;
    assert!(additional_feedback::value_feedback_sends(&binding, 0.25, false).is_empty());
}

#[test]
fn led_outputs_keep_independent_modes_and_do_not_replace_value_feedback() {
    let manager = tests::manager_with_test_route("usb-in", "usb-out");
    let mut binding = crate::test_support::binding();
    binding.device_id = "usb-in".into();
    binding.control.msg_type = MidiMessageType::PitchBend;
    let mut meter = output(
        "meter",
        FaderOutputKind::Led,
        MidiMessageType::ChannelPressure,
        3,
    );
    meter.feedback_mode = FeedbackMode::AudioReactive;
    binding.additional_outputs = vec![
        output(
            "value",
            FaderOutputKind::Feedback,
            MidiMessageType::ControlChange,
            22,
        ),
        output("note", FaderOutputKind::Led, MidiMessageType::Note, 30),
        meter,
    ];
    let views = binding.led_output_bindings();
    assert_eq!(views.len(), 3);
    assert_eq!(
        views[1].normalized_targets_ref(),
        binding.normalized_targets_ref()
    );
    assert_eq!(
        crate::bindings::BindingKey::from_binding(&views[2]),
        crate::bindings::BindingKey::from_binding(&binding)
    );
    assert!(!views[1].uses_audio_feedback());
    assert!(views[2].uses_audio_feedback());
    assert_ne!(views[1].id, views[2].id);
    assert_eq!(
        manager.meter_feedback_key(&views[1], 1.0).unwrap().1,
        vec![vec![0x90, 30, 127]]
    );
    assert_eq!(
        manager.meter_feedback_key(&views[2], 1.0).unwrap().1,
        vec![vec![0xD0, 0x3C]]
    );
    assert_eq!(
        additional_feedback::value_feedback_sends(&binding, 0.5, false).len(),
        2
    );
    binding.additional_outputs[1].control.msg_type = MidiMessageType::ControlChange;
    binding.additional_outputs[1].control.controller = 22;
    assert!(
        !binding.led_output_bindings()[1].has_led_feedback(),
        "an LED cannot overwrite additional value feedback"
    );
    binding.additional_outputs[1].control.msg_type = MidiMessageType::PitchBend;
    assert!(!binding.led_output_bindings()[1].has_led_feedback());
}

#[test]
fn output_lists_round_trip_and_legacy_profiles_stay_empty() {
    let mut binding = crate::test_support::binding();
    let legacy = serde_json::to_value(&binding).unwrap();
    assert!(legacy.get("additional_outputs").is_none());
    assert!(serde_json::from_value::<Binding>(legacy)
        .unwrap()
        .additional_outputs
        .is_empty());
    binding.additional_outputs = vec![output(
        "extra",
        FaderOutputKind::Feedback,
        MidiMessageType::Note,
        24,
    )];
    let restored: Binding =
        serde_json::from_value(serde_json::to_value(&binding).unwrap()).unwrap();
    assert_eq!(restored.additional_outputs[0].id, "extra");
    assert_eq!(restored.additional_outputs[0].control.controller, 24);
}

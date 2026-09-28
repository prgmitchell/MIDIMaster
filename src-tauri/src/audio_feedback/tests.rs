use super::*;
use crate::model::{AuxiliaryControl, BindingControlKind, FeedbackMode, MidiMessageType};

#[test]
fn held_mackie_segments_refresh_before_hardware_decay_but_silence_and_cc_do_not() {
    assert!(!refresh_held_meter(
        &[vec![0xD0, 0x78]],
        Duration::from_millis(80)
    ));
    assert!(refresh_held_meter(
        &[vec![0xD0, 0x78]],
        Duration::from_millis(120)
    ));
    assert!(!refresh_held_meter(
        &[vec![0xD0, 0x70]],
        Duration::from_secs(1)
    ));
    assert!(!refresh_held_meter(
        &[vec![0xB0, 7, 64]],
        Duration::from_secs(1)
    ));
    assert!(!refresh_held_meter(
        &[vec![0x90, 7, 64]],
        Duration::from_secs(1)
    ));
}

fn wave_target(channel: &str) -> BindingTarget {
    BindingTarget::Integration {
        integration_id: "wavelink".into(),
        kind: "channel_mix".into(),
        data: serde_json::json!({"identifier":channel,"mixer_id":"mix"}),
    }
}

#[test]
fn defaults_and_round_trip_keep_existing_profiles_and_buttons_unchanged() {
    let mut json = serde_json::to_value(crate::test_support::binding()).unwrap();
    for key in ["feedback_mode", "led_enabled", "led_control"] {
        json.as_object_mut().unwrap().remove(key);
    }
    let mut binding: Binding = serde_json::from_value(json).unwrap();
    assert_eq!(binding.feedback_mode, FeedbackMode::FollowValue);
    assert!(!binding.led_enabled);
    assert!(binding.led_control.is_none());
    assert!(
        !binding.has_led_feedback(),
        "existing value feedback stays on its original path"
    );
    binding.control.msg_type = MidiMessageType::PitchBend;
    binding.feedback_mode = FeedbackMode::AudioReactive;
    assert!(
        !binding.uses_audio_feedback(),
        "reactive mode alone must never drive a motor"
    );
    binding.led_enabled = true;
    binding.led_control = Some(AuxiliaryControl {
        device_id: binding.device_id.clone(),
        channel: 2,
        controller: 42,
        msg_type: MidiMessageType::Note,
        control_kind: BindingControlKind::Continuous,
        mode: Default::default(),
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: Default::default(),
    });
    let round_trip: Binding =
        serde_json::from_value(serde_json::to_value(&binding).unwrap()).unwrap();
    assert!(round_trip.uses_audio_feedback());
    binding.feedback_enabled = false;
    assert!(
        binding.uses_audio_feedback(),
        "LED enablement is independent of value feedback"
    );
    binding.feedback_enabled = true;
    binding.control_kind = BindingControlKind::Button;
    assert!(!binding.uses_audio_feedback());
}

#[test]
fn mixed_targets_use_loudest_available_and_ignore_unrelated_sources() {
    let mut binding = crate::test_support::binding();
    let wave = wave_target("game");
    binding.targets = vec![BindingTarget::Master, wave.clone(), BindingTarget::Unset];
    let mut samples = vec![
        AudioSample {
            target: BindingTarget::Master,
            level: Some(0.3),
        },
        AudioSample {
            target: wave.clone(),
            level: Some(0.7),
        },
        AudioSample {
            target: wave_target("other"),
            level: Some(1.0),
        },
    ];
    assert_eq!(binding_level(&binding, &samples), Some(0.7));
    samples[1].level = None;
    assert_eq!(binding_level(&binding, &samples), Some(0.3));
    samples[0].level = Some(0.0);
    assert_eq!(binding_level(&binding, &samples), Some(0.0));
    samples[0].level = None;
    assert_eq!(binding_level(&binding, &samples), None);
}

#[test]
fn duplicate_application_sessions_use_maximum_and_levels_are_bounded() {
    let target = BindingTarget::Application {
        name: "music".into(),
        display_name: None,
        icon_data: None,
    };
    let mut binding = crate::test_support::binding();
    binding.targets = vec![target.clone()];
    let samples = [0.1, 0.6, 0.4, f32::NAN].map(|level| AudioSample {
        target: target.clone(),
        level: Some(level),
    });
    assert_eq!(binding_level(&binding, &samples), Some(0.6));
    assert_eq!(clamp_level(f32::INFINITY), 0.0);
    assert_eq!(clamp_level(2.0), 1.0);
}

#[test]
fn fixed_release_has_immediate_attack_and_reaches_zero() {
    assert_eq!(release(0.0, 0.8, INTERVAL), 0.8);
    assert_eq!(release(1.0, 0.0, INTERVAL), 0.75);
    assert_eq!(release(1.0, 0.0, Duration::from_millis(160)), 0.0);
}

#[test]
fn plugin_snapshots_replace_samples_and_reject_old_profile_generations() {
    let target = wave_target("game");
    let mut state = AudioFeedbackState::default();
    state.reset(vec![target.clone()]);
    let generation = state.demand.generation;
    let samples = vec![AudioSample {
        target: target.clone(),
        level: Some(0.6),
    }];
    state.replace("wavelink".into(), generation, samples.clone());
    assert_eq!(state.plugins["wavelink"][0].level, Some(0.6));
    state.reset(vec![target]);
    state.replace("wavelink".into(), generation, samples);
    assert!(state.plugins.is_empty());
    state.replace("wavelink".into(), state.demand.generation, vec![]);
    assert!(state.plugins["wavelink"].is_empty());
}

#[test]
fn led_output_cannot_compete_with_value_mute_or_assign_addresses() {
    let mut binding = crate::test_support::binding();
    let led = AuxiliaryControl {
        device_id: binding.device_id.clone(),
        channel: binding.control.channel,
        controller: binding.control.controller,
        msg_type: binding.control.msg_type.clone(),
        control_kind: BindingControlKind::Continuous,
        mode: Default::default(),
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: Default::default(),
    };
    binding.led_enabled = true;
    binding.led_control = Some(led.clone());
    assert!(binding.led_feedback_control().is_none());
    binding.feedback_enabled = false;
    assert!(binding.led_feedback_control().is_some());
    binding.mute_control = Some(led.clone());
    assert!(binding.led_feedback_control().is_none());
    binding.mute_control = None;
    binding.assign_control = Some(led);
    assert!(binding.led_feedback_control().is_none());
}

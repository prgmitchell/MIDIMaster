use super::*;
use crate::model::{AuxiliaryControl, MidiMessageType};

fn route(id: &str, device: &str) -> MidiDeviceRoute {
    MidiDeviceRoute {
        input_device_id: Some(id.into()),
        output_device_id: Some(format!("out-{device}")),
        input_device_name: Some(device.into()),
        output_device_name: Some(device.into()),
        enabled: true,
    }
}

fn fixture() -> Profile {
    let mut profile = Profile {
        name: "Default".into(),
        bindings: vec![],
        osd_settings: Default::default(),
        plugin_settings: Default::default(),
        midi_device_preference: Default::default(),
        midi_device_preference_set: true,
        target_states: Vec::new(),
    };
    profile.bindings.clear();
    profile.midi_device_preference.routes = vec![route("midi:0", "A"), route("midi:1", "B")];
    for (id, device) in [("midi:0", "A"), ("midi:1", "B")] {
        let mut binding = crate::test_support::binding();
        binding.id = device.into();
        binding.device_id = id.into();
        binding.mute_control = Some(AuxiliaryControl {
            device_id: id.into(),
            channel: 0,
            controller: 16,
            msg_type: MidiMessageType::Note,
            control_kind: crate::model::BindingControlKind::Button,
            mode: crate::model::MidiMode::Absolute,
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: crate::model::MuteBehavior::ToggleOnPress,
        });
        profile.bindings.push(binding);
    }
    profile
}

#[test]
fn partial_swap_defers_both_owners_until_the_second_device_returns() {
    let original = fixture();
    let partial = vec![route("midi:1", "A")];
    assert!(safe_routes(&original, &partial).is_empty());
    let desired = vec![route("midi:1", "A"), route("midi:1", "B")];
    let waiting = reconciled_profile(&original, &desired, &[]);
    assert_eq!(waiting.bindings[0].device_id, "midi:0");
    assert_eq!(
        waiting.midi_device_preference.routes,
        original.midi_device_preference.routes
    );
    let returned = vec![route("midi:1", "A"), route("midi:0", "B")];
    assert_eq!(safe_routes(&waiting, &returned), returned);
    let repaired = reconciled_profile(&waiting, &returned, &returned);
    for (binding, id) in repaired.bindings.iter().zip(["midi:1", "midi:0"]) {
        assert_eq!(binding.device_id, id);
        let mute = binding.mute_control.as_ref().unwrap();
        assert_eq!(mute.device_id, id);
        assert_eq!((mute.channel, mute.controller), (0, 16));
    }
    assert_eq!(repaired.midi_device_preference.routes, returned);
    let reloaded: Profile =
        serde_json::from_value(serde_json::to_value(&repaired).unwrap()).unwrap();
    let retried = reconciled_profile(&reloaded, &returned, &returned);
    assert_eq!(
        serde_json::to_value(&repaired).unwrap(),
        serde_json::to_value(retried).unwrap()
    );
}

#[test]
fn failed_member_closes_the_swap_but_preserves_an_unrelated_route() {
    let mut profile = fixture();
    profile
        .midi_device_preference
        .routes
        .push(route("midi:8", "C"));
    let opened = vec![route("midi:1", "A"), route("midi:8", "C")];
    assert_eq!(safe_routes(&profile, &opened), vec![route("midi:8", "C")]);
}

#[test]
fn disabled_and_missing_owners_reserve_their_addresses() {
    let mut profile = fixture();
    profile.midi_device_preference.routes[1].enabled = false;
    assert!(safe_routes(&profile, &[route("midi:1", "A")]).is_empty());
    assert!(!allows_single_device_fallback(&profile));
}

#[test]
fn disabled_route_without_controls_does_not_block_a_named_reconnect() {
    let mut profile = fixture();
    profile.bindings.truncate(1);
    profile.midi_device_preference.routes[1].enabled = false;
    let connected = vec![route("midi:1", "A")];
    assert_eq!(safe_routes(&profile, &connected), connected);

    let desired = vec![
        connected[0].clone(),
        profile.midi_device_preference.routes[1].clone(),
    ];
    let updated = reconciled_profile(&profile, &desired, &connected);
    assert_eq!(updated.bindings[0].device_id, "midi:1");
    assert_eq!(
        updated.bindings[0].mute_control.as_ref().unwrap().device_id,
        "midi:1"
    );
    assert_eq!(updated.midi_device_preference.routes, desired);
    assert_eq!(safe_routes(&updated, &connected), connected);
}

#[test]
fn disabling_a_shifted_route_preserves_the_baseline_for_button_migration() {
    let mut original = fixture();
    original.bindings.truncate(1);
    let mut solo = original.bindings[0].mute_control.clone().unwrap();
    solo.controller = 8;
    original.bindings[0].modifiers = Some(vec![crate::model::FaderModifier {
        id: "solo".into(),
        kind: crate::model::FaderModifierKind::Solo,
        control: Some(solo),
        assign_mode: crate::model::AssignMode::Add,
    }]);
    original.midi_device_preference.routes[1].enabled = false;
    let mut desired = original.midi_device_preference.routes.clone();
    desired[0] = route("midi:1", "A");
    desired[0].enabled = false;
    desired[0].output_device_id = Some("new-output".into());
    let disabled = reconciled_profile(&original, &desired, &[]);
    assert!(!disabled.midi_device_preference.routes[0].enabled);
    assert_eq!(
        disabled.midi_device_preference.routes[0].input_id(),
        Some("midi:0")
    );
    assert_eq!(
        disabled.midi_device_preference.routes[0].output_id(),
        Some("new-output")
    );
    assert_eq!(disabled.bindings[0].device_id, "midi:0");

    let reloaded: Profile =
        serde_json::from_value(serde_json::to_value(disabled).unwrap()).unwrap();
    desired[0].enabled = true;
    let connected = vec![desired[0].clone()];
    assert_eq!(safe_routes(&reloaded, &connected), connected);
    let repaired = reconciled_profile(&reloaded, &desired, &connected);
    assert_eq!(repaired.bindings[0].device_id, "midi:1");
    let button = repaired.bindings[0].mute_control.as_ref().unwrap();
    let event = crate::model::MidiEvent {
        device_id: "midi:1".into(),
        channel: 0,
        controller: 16,
        value: 127,
        value_14: None,
        msg_type: MidiMessageType::Note,
    };
    assert!(crate::AppState::binding_matches_aux(button, &event));
    let solo = repaired.bindings[0].modifier_controls().next().unwrap().1;
    let solo_event = crate::model::MidiEvent {
        controller: 8,
        ..event
    };
    assert!(crate::AppState::binding_matches_aux(solo, &solo_event));
}

#[test]
fn disabled_route_with_only_auxiliary_controls_still_reserves_its_address() {
    let mut profile = fixture();
    profile.bindings[0].assign_control = profile.bindings[1].mute_control.clone();
    profile.bindings.truncate(1);
    profile.midi_device_preference.routes[1].enabled = false;
    assert!(safe_routes(&profile, &[route("midi:1", "A")]).is_empty());
}

#[test]
fn reconnect_keeps_the_active_identity_when_the_disabled_route_is_listed_first() {
    let mut profile = fixture();
    profile.bindings.truncate(1);
    profile.midi_device_preference.routes[1].enabled = false;
    profile.midi_device_preference.routes.reverse();
    let connected = vec![route("midi:1", "A")];
    assert_eq!(safe_routes(&profile, &connected), connected);

    let desired = vec![
        profile.midi_device_preference.routes[0].clone(),
        connected[0].clone(),
    ];
    let updated = reconciled_profile(&profile, &desired, &connected);
    assert_eq!(updated.midi_device_preference.routes.len(), 2);
    assert!(updated.midi_device_preference.routes.contains(&desired[0]));
    assert_eq!(
        updated.midi_device_preference.normalized_routes(),
        connected
    );
    assert_eq!(safe_routes(&updated, &connected), connected);
}

#[test]
fn duplicate_names_and_unrelated_names_never_transfer_ownership() {
    let mut profile = fixture();
    profile.midi_device_preference.routes[1].input_device_name = Some("A".into());
    assert!(safe_routes(&profile, &[route("midi:2", "A")]).is_empty());
    assert!(safe_routes(&fixture(), &[route("midi:0", "Unrelated")]).is_empty());
}

#[test]
fn auxiliary_controls_follow_their_own_device_and_orphans_are_untouched() {
    let mut profile = fixture();
    profile.bindings[0].assign_control = profile.bindings[1].mute_control.clone();
    let mut orphan = crate::test_support::binding();
    orphan.device_id = "midi:9".into();
    orphan.control.msg_type = MidiMessageType::PitchBend;
    profile.bindings.push(orphan);
    let routes = vec![route("midi:1", "A"), route("midi:0", "B")];
    let updated = reconciled_profile(&profile, &routes, &routes);
    assert_eq!(
        updated.bindings[0]
            .assign_control
            .as_ref()
            .unwrap()
            .device_id,
        "midi:0"
    );
    assert_eq!(updated.bindings[2].device_id, "midi:9");
    assert!(!allows_single_device_fallback(&updated));
}

#[test]
fn failed_save_cannot_publish_and_repeated_success_does_not_write_again() {
    let original = fixture();
    let mut slot = Some(std::sync::Arc::new(
        crate::profile_snapshot::ProfileSnapshot::new(original.clone()),
    ));
    let routes = vec![route("midi:1", "A"), route("midi:0", "B")];
    let candidate = reconciled_profile(&original, &routes, &routes);
    assert!(publish_profile(&mut slot, &candidate, |_| Err("disk full".into())).is_err());
    assert_eq!(slot.as_ref().unwrap().bindings[0].device_id, "midi:0");
    publish_profile(&mut slot, &candidate, |_| Ok(())).unwrap();
    publish_profile(&mut slot, &candidate, |_| {
        panic!("unchanged profile must not be saved")
    })
    .unwrap();
    assert_eq!(slot.as_ref().unwrap().bindings[0].device_id, "midi:1");
}

#[test]
fn noncolliding_reconnect_updates_all_roles_and_route_baseline_even_without_controls() {
    let mut profile = fixture();
    profile.bindings[0].indicator_control = profile.bindings[0].mute_control.clone();
    profile.bindings[0].additional_outputs = vec![crate::model::FaderOutput {
        id: "extra".into(),
        kind: crate::model::FaderOutputKind::Led,
        control: profile.bindings[0].mute_control.clone().unwrap(),
        enabled: true,
        feedback_mode: crate::model::FeedbackMode::AudioReactive,
    }];
    let desired = vec![route("midi:4", "A"), route("midi:1", "B")];
    let updated = reconciled_profile(&profile, &desired, &desired[..1]);
    assert_eq!(
        updated.bindings[0].additional_outputs[0].control.device_id,
        "midi:4"
    );
    assert_eq!(
        updated.bindings[0]
            .indicator_control
            .as_ref()
            .unwrap()
            .device_id,
        "midi:4"
    );
    assert_eq!(
        updated.bindings[1].mute_control.as_ref().unwrap().device_id,
        "midi:1"
    );
    assert_eq!(updated.midi_device_preference.routes, desired);
    profile.bindings.clear();
    let updated = reconciled_profile(&profile, &desired, &desired[..1]);
    assert_eq!(updated.midi_device_preference.routes, desired);
}

#[test]
fn legacy_id_only_connection_is_accepted_without_ignoring_known_name_mismatches() {
    let named = route("midi:0", "A");
    let mut legacy = named.clone();
    legacy.input_device_name = None;
    legacy.output_device_name = None;
    assert!(same_connection(&legacy, &named));
    let mut wrong = named.clone();
    wrong.input_device_name = Some("B".into());
    assert!(!same_connection(&wrong, &named));
}

#[test]
fn only_one_connected_device_cannot_trigger_a_missing_devices_unique_control() {
    let mut profile = fixture();
    profile.bindings[0].control.controller = 7;
    profile.bindings[1].control.controller = 8;
    let snapshot = crate::profile_snapshot::ProfileSnapshot::new(profile);
    let event = crate::bindings::BindingKey {
        device_id: "midi:1".into(),
        channel: 0,
        controller: 7,
        msg_type: MidiMessageType::ControlChange,
    };
    assert!(snapshot.find_binding(&event, true).is_none());
}

use super::*;
use crate::bindings::BindingState;

fn binding_state(last_value: f32, elapsed_ms: u64) -> BindingState {
    BindingState {
        last_value,
        last_update: Instant::now()
            .checked_sub(Duration::from_millis(elapsed_ms))
            .unwrap_or_else(Instant::now),
        last_absolute_input: None,
        absolute_input_direction: 0,
        relative_auto_format: None,
        relative_seen_midpoint: false,
        relative_seen_sign_band: false,
        relative_seen_high_negative: false,
        relative_seen_low_negative_hint: false,
    }
}

fn integration_button_binding(action_kind: &str) -> Binding {
    Binding {
        id: "b1".to_string(),
        name: "Binding 1".to_string(),
        device_id: "midi-dev".to_string(),
        control: model::MidiControl {
            channel: 0,
            controller: 7,
            msg_type: model::MidiMessageType::Note,
        },
        control_kind: model::BindingControlKind::Button,
        targets: vec![model::BindingTarget::Integration {
            integration_id: "hue".to_string(),
            kind: "light".to_string(),
            data: serde_json::json!({ "id": "1", "action_kind": action_kind }),
        }],
        target: model::BindingTarget::Unset,
        action: model::BindingAction::Volume,
        mode: model::MidiMode::Absolute,
        ..crate::test_support::binding()
    }
}

fn indicator_control(controller: u8) -> model::AuxiliaryControl {
    model::AuxiliaryControl {
        device_id: "midi-dev".to_string(),
        channel: 0,
        controller,
        msg_type: model::MidiMessageType::Note,
        control_kind: model::BindingControlKind::Button,
        mode: model::MidiMode::Absolute,
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: model::MuteBehavior::ToggleOnPress,
    }
}

#[test]
fn stale_feedback_outputs_include_replaced_indicator_destination() {
    let mut previous = integration_button_binding("stateful");
    previous.control.controller = 21;

    let mut next = previous.clone();
    next.indicator_control = Some(indicator_control(22));

    let active_outputs = active_feedback_outputs(&[next]);
    let stale = stale_feedback_bindings_for_removed_outputs(&[previous.clone()], &active_outputs);

    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].id, previous.id);
}

#[test]
fn stale_feedback_outputs_keep_destinations_used_by_other_bindings() {
    let mut previous = integration_button_binding("stateful");
    previous.control.controller = 21;

    let mut next = previous.clone();
    next.indicator_control = Some(indicator_control(22));

    let mut other = integration_button_binding("stateful");
    other.id = "b2".to_string();
    other.control.controller = 30;
    other.indicator_control = Some(indicator_control(21));

    let active_outputs = active_feedback_outputs(&[next, other]);
    let stale = stale_feedback_bindings_for_removed_outputs(&[previous], &active_outputs);

    assert!(stale.is_empty());
}

#[test]
fn resolved_feedback_control_key_uses_indicator_for_button_bindings() {
    let mut binding = integration_button_binding("stateful");
    binding.control.controller = 21;
    binding.indicator_control = Some(indicator_control(22));

    let key = resolved_binding_feedback_control_key(&binding);

    assert_eq!(key.device_id, "midi-dev");
    assert_eq!(key.controller, 22);
    assert_eq!(key.msg_type, model::MidiMessageType::Note);
}

#[test]
fn resolved_feedback_control_key_uses_indicator_for_continuous_bindings() {
    let mut binding = integration_button_binding("stateful");
    binding.control_kind = model::BindingControlKind::Continuous;
    binding.control.controller = 21;
    binding.indicator_control = Some(indicator_control(22));

    let key = resolved_binding_feedback_control_key(&binding);

    assert_eq!(key.device_id, "midi-dev");
    assert_eq!(key.controller, 22);
    assert_eq!(key.msg_type, model::MidiMessageType::Note);
}

#[test]
fn stale_feedback_outputs_include_replaced_continuous_indicator_destination() {
    let mut previous = integration_button_binding("stateful");
    previous.control_kind = model::BindingControlKind::Continuous;
    previous.control.controller = 21;
    previous.indicator_control = Some(indicator_control(22));

    let mut next = previous.clone();
    next.indicator_control = Some(indicator_control(23));

    let active_outputs = active_feedback_outputs(&[next]);
    let stale = stale_feedback_bindings_for_removed_outputs(&[previous.clone()], &active_outputs);

    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].id, previous.id);
}

#[test]
fn disabled_bindings_are_not_active_primary_feedback_outputs() {
    let mut binding = integration_button_binding("stateful");
    binding.feedback_enabled = false;
    binding.indicator_control = Some(indicator_control(22));

    assert!(active_feedback_outputs(&[binding]).is_empty());
}

#[test]
fn disabling_button_feedback_clears_hardware_but_disabling_fader_does_not() {
    let button = integration_button_binding("stateful");
    let mut disabled_button = button.clone();
    disabled_button.feedback_enabled = false;
    assert!(should_clear_stale_feedback_hardware(
        &button,
        Some(&disabled_button)
    ));

    let mut fader = integration_button_binding("stateful");
    fader.control_kind = model::BindingControlKind::Continuous;
    let mut disabled_fader = fader.clone();
    disabled_fader.feedback_enabled = false;
    assert!(!should_clear_stale_feedback_hardware(
        &fader,
        Some(&disabled_fader)
    ));
    assert!(should_clear_stale_feedback_hardware(&fader, None));
}

#[test]
fn note_button_is_active_only_while_input_is_pressed() {
    assert!(feedback::binding_state_user_active(
        &binding_state(1.0, 10),
        true
    ));
    assert!(feedback::binding_state_user_active(
        &binding_state(63.0 / 127.0, 10),
        true
    ));
    assert!(!feedback::binding_state_user_active(
        &binding_state(0.0, 10),
        true
    ));
}

#[test]
fn continuous_control_activity_uses_recent_update_window() {
    assert!(feedback::binding_state_user_active(
        &binding_state(0.0, 100),
        false
    ));
    assert!(!feedback::binding_state_user_active(
        &binding_state(0.0, 700),
        false
    ));
}

#[test]
fn momentary_integration_button_feedback_adds_input_value_without_changing_volume() {
    let binding = integration_button_binding("momentary");
    let mut payload = serde_json::json!({
        "volume": 0.0,
    });

    binding_actions::add_momentary_integration_input_value(
        &mut payload,
        &binding,
        &model::BindingAction::Volume,
        Some(1.0),
    );

    assert_eq!(payload["volume"], serde_json::json!(0.0));
    assert_eq!(payload["input_value"], serde_json::json!(1.0));
}

#[test]
fn momentary_integration_button_feedback_without_input_value_does_not_infer_from_volume() {
    let binding = integration_button_binding("momentary");
    let mut payload = serde_json::json!({
        "volume": 0.75,
    });

    binding_actions::add_momentary_integration_input_value(
        &mut payload,
        &binding,
        &model::BindingAction::Volume,
        None,
    );

    assert_eq!(payload["volume"], serde_json::json!(0.75));
    assert!(payload.get("input_value").is_none());
}

#[test]
fn stateful_integration_button_feedback_does_not_add_input_value() {
    let binding = integration_button_binding("stateful");
    let mut payload = serde_json::json!({
        "volume": 0.0,
    });

    binding_actions::add_momentary_integration_input_value(
        &mut payload,
        &binding,
        &model::BindingAction::Volume,
        None,
    );

    assert!(payload.get("input_value").is_none());
}

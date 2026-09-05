use super::*;

fn key(controller: u8) -> BindingKey {
    BindingKey {
        device_id: "device".to_string(),
        channel: 0,
        controller,
        msg_type: model::MidiMessageType::Note,
    }
}

#[test]
fn activity_button_light_generation_refresh_invalidates_old_task() {
    let key = key(23);
    let mut generations = HashMap::new();

    let first = start_activity_button_light_generation(&mut generations, &key);
    assert!(activity_button_light_generation_is_current(
        &generations,
        &key,
        first
    ));

    let second = start_activity_button_light_generation(&mut generations, &key);
    assert!(!activity_button_light_generation_is_current(
        &generations,
        &key,
        first
    ));
    assert!(activity_button_light_generation_is_current(
        &generations,
        &key,
        second
    ));
}

#[test]
fn activity_button_light_generation_cancel_invalidates_task() {
    let key = key(23);
    let mut generations = HashMap::new();

    let generation = start_activity_button_light_generation(&mut generations, &key);
    cancel_activity_button_light_generation(&mut generations, &key);

    assert!(!activity_button_light_generation_is_current(
        &generations,
        &key,
        generation
    ));
}

#[test]
fn note_button_hold_detection_uses_last_input_value() {
    let key = key(23);
    let generations = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
    let binding_state = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
    let generation = {
        let mut generations = generations.lock().unwrap();
        start_activity_button_light_generation(&mut generations, &key)
    };

    {
        let mut states = binding_state.lock().unwrap();
        states.insert(
            key.clone(),
            BindingState {
                last_value: 63.0 / 127.0,
                last_update: Instant::now(),
                last_absolute_input: None,
                absolute_input_direction: 0,
                relative_auto_format: None,
                relative_seen_midpoint: false,
                relative_seen_sign_band: false,
                relative_seen_high_negative: false,
                relative_seen_low_negative_hint: false,
            },
        );
    }
    assert!(activity_button_light_hold_should_continue(
        &generations,
        &binding_state,
        &key,
        generation
    ));

    {
        let mut states = binding_state.lock().unwrap();
        states.get_mut(&key).unwrap().last_value = 0.0;
    }
    assert!(!activity_button_light_hold_should_continue(
        &generations,
        &binding_state,
        &key,
        generation
    ));
}

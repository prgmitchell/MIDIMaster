use super::*;

const ACTIVITY_BUTTON_LIGHT_HOLD_RETRY_DELAYS_MS: [u64; 3] = [10, 35, 75];
const ACTIVITY_BUTTON_LIGHT_HOLD_INTERVAL_MS: u64 = 100;

struct ActivityButtonLightHoldContext {
    generations: std::sync::Arc<std::sync::Mutex<HashMap<BindingKey, u64>>>,
    binding_state: std::sync::Arc<std::sync::Mutex<HashMap<BindingKey, BindingState>>>,
    feedback_values: std::sync::Arc<std::sync::Mutex<HashMap<BindingKey, f32>>>,
    midi: std::sync::Arc<std::sync::Mutex<crate::midi::MidiManager>>,
    key: BindingKey,
    generation: u64,
    output_key: BindingKey,
    binding: model::Binding,
}

pub(super) fn start_activity_button_light_generation(
    generations: &mut HashMap<BindingKey, u64>,
    key: &BindingKey,
) -> u64 {
    let generation = generations.get(key).copied().unwrap_or(0).wrapping_add(1);
    generations.insert(key.clone(), generation);
    generation
}

pub(super) fn cancel_activity_button_light_generation(
    generations: &mut HashMap<BindingKey, u64>,
    key: &BindingKey,
) {
    generations.remove(key);
}

pub(super) fn activity_button_light_generation_is_current(
    generations: &HashMap<BindingKey, u64>,
    key: &BindingKey,
    generation: u64,
) -> bool {
    generations.get(key).copied() == Some(generation)
}

#[cfg(test)]
pub(super) fn activity_button_light_hold_should_continue(
    generations: &std::sync::Arc<std::sync::Mutex<HashMap<BindingKey, u64>>>,
    binding_state: &std::sync::Arc<std::sync::Mutex<HashMap<BindingKey, BindingState>>>,
    key: &BindingKey,
    generation: u64,
) -> bool {
    let generation_current = generations
        .lock()
        .ok()
        .map(|generations| {
            activity_button_light_generation_is_current(&generations, key, generation)
        })
        .unwrap_or(false);
    if !generation_current {
        return false;
    }

    binding_state
        .lock()
        .ok()
        .and_then(|states| states.get(key).map(|state| state.last_value > 0.0))
        .unwrap_or(false)
}

pub(super) fn send_activity_button_light_hold_feedback(
    feedback_values: &std::sync::Arc<std::sync::Mutex<HashMap<BindingKey, f32>>>,
    midi: &std::sync::Arc<std::sync::Mutex<crate::midi::MidiManager>>,
    key: &BindingKey,
    output_key: &BindingKey,
    binding: &model::Binding,
) {
    if let Ok(mut feedback) = feedback_values.lock() {
        feedback.insert(key.clone(), 1.0);
        if output_key != key {
            feedback.insert(output_key.clone(), 1.0);
        }
    }
    if let Ok(mut midi) = midi.lock() {
        let _ = midi.send_binding_light_feedback(binding, 1.0);
    }
}

fn send_activity_button_light_hold_feedback_if_current(
    context: &ActivityButtonLightHoldContext,
) -> bool {
    let Ok(generations_guard) = context.generations.lock() else {
        return false;
    };
    if !activity_button_light_generation_is_current(
        &generations_guard,
        &context.key,
        context.generation,
    ) {
        return false;
    }

    let still_pressed = context
        .binding_state
        .lock()
        .ok()
        .and_then(|states| states.get(&context.key).map(|state| state.last_value > 0.0))
        .unwrap_or(false);
    if !still_pressed {
        return false;
    }

    send_activity_button_light_hold_feedback(
        &context.feedback_values,
        &context.midi,
        &context.key,
        &context.output_key,
        &context.binding,
    );
    true
}

pub(super) fn update_activity_button_light_hold_feedback(
    state: &AppState,
    binding: &model::Binding,
    key: BindingKey,
    input_active: bool,
) {
    if !binding.feedback_enabled {
        if let Ok(mut generations) = state.activity_button_light_generations.lock() {
            cancel_activity_button_light_generation(&mut generations, &key);
        }
        return;
    }
    if matches!(
        binding.control.msg_type,
        model::MidiMessageType::ProgramChange
    ) && binding.indicator_feedback_control().is_none()
    {
        if let Ok(mut generations) = state.activity_button_light_generations.lock() {
            cancel_activity_button_light_generation(&mut generations, &key);
        }
        return;
    }

    if state
        .button_light_hold_feedback_value(binding, input_active)
        .is_none()
        || !input_active
    {
        if let Ok(mut generations) = state.activity_button_light_generations.lock() {
            cancel_activity_button_light_generation(&mut generations, &key);
        }
        return;
    }

    let generation = match state.activity_button_light_generations.lock() {
        Ok(mut generations) => start_activity_button_light_generation(&mut generations, &key),
        Err(_) => return,
    };

    let output_control = binding
        .indicator_feedback_control()
        .map(FeedbackControlKey::from_aux)
        .unwrap_or_else(|| FeedbackControlKey::from_binding(binding));
    let hold_context = ActivityButtonLightHoldContext {
        generations: state.activity_button_light_generations.clone(),
        binding_state: state.binding_state.clone(),
        feedback_values: state.feedback_values.clone(),
        midi: state.midi.clone(),
        key,
        generation,
        output_key: output_control.to_binding_key(),
        binding: binding.clone(),
    };

    tauri::async_runtime::spawn(async move {
        let mut previous_delay = 0;
        for delay in ACTIVITY_BUTTON_LIGHT_HOLD_RETRY_DELAYS_MS {
            tokio::time::sleep(Duration::from_millis(delay - previous_delay)).await;
            previous_delay = delay;

            if !send_activity_button_light_hold_feedback_if_current(&hold_context) {
                return;
            }
        }

        loop {
            tokio::time::sleep(Duration::from_millis(
                ACTIVITY_BUTTON_LIGHT_HOLD_INTERVAL_MS,
            ))
            .await;

            if !send_activity_button_light_hold_feedback_if_current(&hold_context) {
                return;
            }
        }
    });
}

pub(super) fn mark_binding_user_activity(state: &AppState, key: &BindingKey) {
    if let Ok(mut states) = state.binding_state.lock() {
        if let Some(binding_state) = states.get_mut(key) {
            binding_state.last_update = Instant::now();
        }
    }
}

pub(super) fn schedule_latched_button_feedback_resend(
    state: &AppState,
    binding: &model::Binding,
    key: &BindingKey,
) {
    let key = key.clone();
    let feedback_values = state.feedback_values.clone();
    let midi = state.midi.clone();
    let binding = binding.clone();

    tauri::async_runtime::spawn(async move {
        // Let the controller finish processing Note Off before restoring its latched LED.
        tokio::time::sleep(Duration::from_millis(20)).await;
        if let Ok(feedback) = feedback_values.lock() {
            let current_value = feedback.get(&key).copied().unwrap_or(0.0);
            if let Ok(mut midi) = midi.lock() {
                let _ = midi.send_binding_light_feedback(&binding, current_value);
            }
        }
    });
}

pub(super) fn handle_latched_button_release(
    state: &AppState,
    binding: &model::Binding,
    key: &BindingKey,
    event: &MidiEvent,
) -> bool {
    if event.value != 0 || binding.mute_behavior != model::MuteBehavior::ToggleOnPress {
        return false;
    }
    schedule_latched_button_feedback_resend(state, binding, key);
    true
}

pub(super) fn resolve_stateful_button_transition(
    state: &AppState,
    binding: &model::Binding,
    key: &BindingKey,
    event: &MidiEvent,
    current_state: bool,
) -> Option<bool> {
    let tracks_input_edges = binding.mute_behavior == model::MuteBehavior::SetFromValue;
    let previous_input_active = if tracks_input_edges {
        state
            .last_mute_input_active
            .lock()
            .ok()
            .and_then(|inputs| inputs.get(key).copied())
    } else {
        None
    };
    let next_state = AppState::resolve_target_mute_state(
        event.value,
        current_state,
        binding.mute_behavior.clone(),
        previous_input_active,
    );

    if tracks_input_edges {
        if let Ok(mut inputs) = state.last_mute_input_active.lock() {
            inputs.insert(key.clone(), event.value > 0);
        }
    }
    next_state
}

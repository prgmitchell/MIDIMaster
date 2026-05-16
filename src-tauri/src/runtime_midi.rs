use crate::bindings::{
    apply_midi_event as apply_binding_midi_event, find_binding, BindingKey, BindingState,
};
use crate::model::{self, MidiEvent};
use crate::run_logger;
use crate::AppState;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[path = "runtime_midi/actions.rs"]
mod actions;
#[path = "runtime_midi/aux_controls.rs"]
mod aux_controls;
#[path = "runtime_midi/learn.rs"]
mod learn;

fn binding_is_button(binding: &model::Binding) -> bool {
    matches!(binding.control_kind, model::BindingControlKind::Button)
        || (matches!(binding.control_kind, model::BindingControlKind::Auto)
            && matches!(binding.control.msg_type, model::MidiMessageType::Note))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IntegrationButtonActionKind {
    Stateful,
    Momentary,
}

fn obs_action_is_stateful(action: &str) -> bool {
    action.starts_with("Toggle")
}

fn integration_volume_button_action_kind(
    integration_id: &str,
    kind: &str,
    data: &serde_json::Value,
) -> Option<IntegrationButtonActionKind> {
    if let Some(action_kind) = data.get("action_kind").and_then(|value| value.as_str()) {
        if action_kind.eq_ignore_ascii_case("stateful") {
            return Some(IntegrationButtonActionKind::Stateful);
        }
        if action_kind.eq_ignore_ascii_case("momentary") {
            return Some(IntegrationButtonActionKind::Momentary);
        }
    }
    if integration_id == "obs" && kind == "action" {
        let action = data
            .get("action")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        return Some(if obs_action_is_stateful(action) {
            IntegrationButtonActionKind::Stateful
        } else {
            IntegrationButtonActionKind::Momentary
        });
    }
    if integration_id == "obs" && matches!(kind, "scene" | "media") {
        return Some(IntegrationButtonActionKind::Momentary);
    }
    None
}

fn resolve_integration_button_event(
    state: &AppState,
    key: &BindingKey,
    binding: &model::Binding,
    event: &MidiEvent,
) -> Option<&'static str> {
    let input_active = event.value > 0;
    match binding.mute_behavior.clone() {
        model::MuteBehavior::ToggleOnPress => Some(if input_active { "press" } else { "release" }),
        model::MuteBehavior::SetFromValue => {
            let previous = state
                .last_mute_input_active
                .lock()
                .ok()
                .and_then(|inputs| inputs.get(key).copied());
            if let Ok(mut inputs) = state.last_mute_input_active.lock() {
                inputs.insert(key.clone(), input_active);
            }
            let changed = previous
                .map(|prev| prev != input_active)
                .unwrap_or(input_active);
            if changed {
                Some(if input_active { "press" } else { "release" })
            } else {
                None
            }
        }
    }
}

const ACTIVITY_BUTTON_LIGHT_HOLD_RETRY_DELAYS_MS: [u64; 3] = [10, 35, 75];
const ACTIVITY_BUTTON_LIGHT_HOLD_INTERVAL_MS: u64 = 100;

fn start_activity_button_light_generation(
    generations: &mut HashMap<BindingKey, u64>,
    key: &BindingKey,
) -> u64 {
    let generation = generations.get(key).copied().unwrap_or(0).wrapping_add(1);
    generations.insert(key.clone(), generation);
    generation
}

fn cancel_activity_button_light_generation(
    generations: &mut HashMap<BindingKey, u64>,
    key: &BindingKey,
) {
    generations.remove(key);
}

fn activity_button_light_generation_is_current(
    generations: &HashMap<BindingKey, u64>,
    key: &BindingKey,
    generation: u64,
) -> bool {
    generations.get(key).copied() == Some(generation)
}

#[cfg(test)]
fn activity_button_light_hold_should_continue(
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
        .and_then(|states| states.get(key).map(|state| state.last_value > 0.5))
        .unwrap_or(false)
}

fn send_activity_button_light_hold_feedback(
    feedback_values: &std::sync::Arc<std::sync::Mutex<HashMap<BindingKey, f32>>>,
    midi: &std::sync::Arc<std::sync::Mutex<crate::midi::MidiManager>>,
    key: &BindingKey,
    device_id: &str,
    channel: u8,
    controller: u8,
    msg_type: model::MidiMessageType,
) {
    if let Ok(mut feedback) = feedback_values.lock() {
        feedback.insert(key.clone(), 1.0);
    }
    if let Ok(mut midi) = midi.lock() {
        let _ = midi.send_feedback(device_id, channel, controller, 1.0, msg_type);
    }
}

fn send_activity_button_light_hold_feedback_if_current(
    generations: &std::sync::Arc<std::sync::Mutex<HashMap<BindingKey, u64>>>,
    binding_state: &std::sync::Arc<std::sync::Mutex<HashMap<BindingKey, BindingState>>>,
    feedback_values: &std::sync::Arc<std::sync::Mutex<HashMap<BindingKey, f32>>>,
    midi: &std::sync::Arc<std::sync::Mutex<crate::midi::MidiManager>>,
    key: &BindingKey,
    generation: u64,
    device_id: &str,
    channel: u8,
    controller: u8,
    msg_type: model::MidiMessageType,
) -> bool {
    let Ok(generations_guard) = generations.lock() else {
        return false;
    };
    if !activity_button_light_generation_is_current(&generations_guard, key, generation) {
        return false;
    }

    let still_pressed = binding_state
        .lock()
        .ok()
        .and_then(|states| states.get(key).map(|state| state.last_value > 0.5))
        .unwrap_or(false);
    if !still_pressed {
        return false;
    }

    send_activity_button_light_hold_feedback(
        feedback_values,
        midi,
        key,
        device_id,
        channel,
        controller,
        msg_type,
    );
    true
}

pub(super) fn update_activity_button_light_hold_feedback(
    state: &AppState,
    binding: &model::Binding,
    key: BindingKey,
    input_active: bool,
) {
    if binding
        .activity_button_light_feedback_value(input_active)
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

    let generations = state.activity_button_light_generations.clone();
    let binding_state = state.binding_state.clone();
    let feedback_values = state.feedback_values.clone();
    let midi = state.midi.clone();
    let device_id = binding.device_id.clone();
    let channel = binding.control.channel;
    let controller = binding.control.controller;
    let msg_type = binding.control.msg_type.clone();

    tauri::async_runtime::spawn(async move {
        let mut previous_delay = 0;
        for delay in ACTIVITY_BUTTON_LIGHT_HOLD_RETRY_DELAYS_MS {
            tokio::time::sleep(Duration::from_millis(delay - previous_delay)).await;
            previous_delay = delay;

            if !send_activity_button_light_hold_feedback_if_current(
                &generations,
                &binding_state,
                &feedback_values,
                &midi,
                &key,
                generation,
                &device_id,
                channel,
                controller,
                msg_type.clone(),
            ) {
                return;
            }
        }

        loop {
            tokio::time::sleep(Duration::from_millis(
                ACTIVITY_BUTTON_LIGHT_HOLD_INTERVAL_MS,
            ))
            .await;

            if !send_activity_button_light_hold_feedback_if_current(
                &generations,
                &binding_state,
                &feedback_values,
                &midi,
                &key,
                generation,
                &device_id,
                channel,
                controller,
                msg_type.clone(),
            ) {
                return;
            }
        }
    });
}

pub(crate) fn apply_midi_event(
    state: &AppState,
    app: &AppHandle,
    event: MidiEvent,
) -> Result<(), String> {
    if learn::handle_learn_event(state, &event)? {
        return Ok(());
    }

    let profile = match state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned")?
        .clone()
    {
        Some(profile) => profile,
        None => return Ok(()),
    };
    let key = BindingKey::from_event(&event);
    let binding = match find_binding(&profile, &key) {
        Some(binding) => binding.clone(),
        None => {
            aux_controls::handle_aux_or_unmatched(state, app, &profile, &key, &event)?;
            return Ok(());
        }
    };
    let targets = binding.normalized_targets();
    if targets.is_empty() {
        run_logger::warn(
            "bindings",
            "binding_has_no_targets",
            &format!("binding_id={} action={:?}", binding.id, binding.action),
        );
        return Ok(());
    }
    let event_value_14 = event
        .value_14
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_string());
    run_logger::debug(
        "bindings",
        "event_matched",
        &format!(
            "binding_id={} action={:?} targets={} device_id={} channel={} controller={} value={} value_14={} control_kind={:?} msg_type={:?}",
            binding.id,
            binding.action,
            targets.len(),
            event.device_id,
            event.channel,
            event.controller,
            event.value,
            event_value_14,
            binding.control_kind,
            binding.control.msg_type
        ),
    );

    let volume = {
        let mut states = state.binding_state.lock().map_err(|_| "Lock poisoned")?;
        let state = states.entry(key.clone()).or_insert_with(|| BindingState {
            last_value: 0.0,
            last_update: Instant::now(),
            relative_auto_format: None,
            relative_seen_midpoint: false,
            relative_seen_sign_band: false,
            relative_seen_high_negative: false,
            relative_seen_low_negative_hint: false,
        });
        apply_binding_midi_event(&binding, &event, state)
    };

    let volume = match volume {
        Some(v) => v,
        None => return Ok(()),
    };

    if actions::handle_special_action(state, app, &binding, &targets, &event)? {
        return Ok(());
    }

    // Handle toggle mute action for button bindings
    if binding.action == model::BindingAction::ToggleMute {
        // Mark user activity to prevent stale feedback loop
        if let Ok(mut states) = state.binding_state.lock() {
            if let Some(state) = states.get_mut(&key) {
                state.last_update = Instant::now();
            }
        }

        // On button release (value == 0), re-send current state to enforce latching check
        // This fixes controllers that turn off LED on release (momentary behavior)
        if event.value == 0 && binding.mute_behavior == model::MuteBehavior::ToggleOnPress {
            run_logger::debug(
                "bindings",
                "toggle_mute_release_resend",
                &format!("binding_id={} device_id={}", binding.id, binding.device_id),
            );
            let key_clone = key.clone();
            // Clone Arcs for async task
            let feedback_arc = state.feedback_values.clone();
            let midi_arc = state.midi.clone();
            let binding_for_feedback = binding.clone();

            tauri::async_runtime::spawn(async move {
                // Sleep for 20ms to allow the hardware to process the "Note Off" completely
                tokio::time::sleep(Duration::from_millis(20)).await;

                if let Ok(feedback) = feedback_arc.lock() {
                    let current_val = feedback.get(&key_clone).cloned().unwrap_or(0.0);
                    if let Ok(mut midi) = midi_arc.lock() {
                        let _ = midi.send_binding_feedback(&binding_for_feedback, current_val);
                    }
                }
            });
            return Ok(());
        }

        let current_val = state
            .feedback_values
            .lock()
            .ok()
            .and_then(|fb| fb.get(&key).cloned())
            .unwrap_or(0.0);
        let current_muted = current_val > 0.5;
        let previous_input_active = if binding.mute_behavior == model::MuteBehavior::SetFromValue {
            state
                .last_mute_input_active
                .lock()
                .ok()
                .and_then(|inputs| inputs.get(&key).copied())
        } else {
            None
        };
        let Some(muted) = AppState::resolve_target_mute_state(
            event.value,
            current_muted,
            binding.mute_behavior.clone(),
            previous_input_active,
        ) else {
            if binding.mute_behavior == model::MuteBehavior::SetFromValue {
                if let Ok(mut inputs) = state.last_mute_input_active.lock() {
                    inputs.insert(key.clone(), event.value > 0);
                }
            }
            return Ok(());
        };
        if binding.mute_behavior == model::MuteBehavior::SetFromValue {
            if let Ok(mut inputs) = state.last_mute_input_active.lock() {
                inputs.insert(key.clone(), event.value > 0);
            }
        }
        let mut any_applied = false;

        for (target_index, target) in targets.iter().enumerate() {
            match target {
                model::BindingTarget::Master => {
                    if let Err(err) = state.audio.set_master_mute(muted) {
                        run_logger::error(
                            "bindings",
                            "toggle_mute_master_failed",
                            &format!("binding_id={} error={}", binding.id, err),
                        );
                    } else {
                        any_applied = true;
                    }
                }
                model::BindingTarget::Focus => {
                    if let Some(_focused) = state.audio.focused_session().ok().flatten() {
                        if let Err(err) = state.audio.set_focused_session_mute(muted) {
                            run_logger::error(
                                "bindings",
                                "toggle_mute_focus_failed",
                                &format!("binding_id={} error={}", binding.id, err),
                            );
                        } else {
                            any_applied = true;
                        }
                    }
                }
                model::BindingTarget::Session { session_id } => {
                    if let Err(err) = state.audio.set_session_mute(session_id, muted) {
                        run_logger::error(
                            "bindings",
                            "toggle_mute_session_failed",
                            &format!(
                                "binding_id={} session_id={} error={}",
                                binding.id, session_id, err
                            ),
                        );
                    } else {
                        any_applied = true;
                    }
                }
                model::BindingTarget::Application { name, .. } => {
                    if let Err(err) = state.audio.set_application_mute(name, muted) {
                        run_logger::error(
                            "bindings",
                            "toggle_mute_application_failed",
                            &format!("binding_id={} app={} error={}", binding.id, name, err),
                        );
                    } else {
                        any_applied = true;
                    }
                }
                model::BindingTarget::Device { device_id } => {
                    if let Err(err) = state.audio.set_device_mute(device_id, muted) {
                        run_logger::error(
                            "bindings",
                            "toggle_mute_device_failed",
                            &format!(
                                "binding_id={} device_id={} error={}",
                                binding.id, device_id, err
                            ),
                        );
                    } else {
                        any_applied = true;
                    }
                }
                model::BindingTarget::Integration {
                    integration_id,
                    kind,
                    data,
                } => {
                    let payload = serde_json::json!({
                      "binding_id": binding.id,
                      "action": "ToggleMute",
                      "value": if muted { 1.0 } else { 0.0 },
                      "target_index": target_index,
                      "target_count": targets.len(),
                      "is_primary_target": target_index == 0,
                      "target": {
                        "integration_id": integration_id,
                        "kind": kind,
                        "data": data,
                      }
                    });
                    let _ = app.emit("integration_binding_triggered", payload);
                    any_applied = true;
                }
                model::BindingTarget::Unset
                | model::BindingTarget::MediaControl
                | model::BindingTarget::CaptureControl
                | model::BindingTarget::Hotkey
                | model::BindingTarget::OpenApplication => {}
            }
        }

        if !any_applied {
            run_logger::warn(
                "bindings",
                "toggle_mute_no_target_applied",
                &format!("binding_id={} targets={}", binding.id, targets.len()),
            );
            return Ok(());
        }

        if let Ok(mut last_update) = state.osd_last_update.lock() {
            *last_update = Some(Instant::now());
        }

        let feedback_value = binding
            .mapped_button_light_feedback_value()
            .unwrap_or(if muted { 1.0 } else { 0.0 });

        if let Ok(mut feedback) = state.feedback_values.lock() {
            feedback.insert(key.clone(), feedback_value);
        }

        if let Ok(mut midi) = state.midi.lock() {
            // println!("MIDI Event Matched Binding: {:?} -> {:?}", binding.name, binding.target);
            let _ = midi.send_binding_feedback(&binding, feedback_value);
        }

        let settings_enabled = state
            .osd_settings
            .lock()
            .map(|settings| settings.enabled)
            .unwrap_or(true);

        for target in &targets {
            let focus_session = if matches!(target, model::BindingTarget::Focus) {
                state.audio.focused_session().ok().flatten()
            } else {
                None
            };
            let payload = serde_json::json!({
              "target": target,
              "muted": muted,
              "action": "toggle_mute",
              "focus_session": focus_session,
              "binding_id": binding.id
            });
            let _ = app.emit("mute_update", payload.clone());

            if settings_enabled {
                AppState::emit_osd_update(app, state, &payload, false);
            }
        }

        return Ok(());
    }

    let mut any_applied = false;
    let mut integration_volume_batches: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    let mut button_event_for_event: Option<Option<&'static str>> = None;
    let mut skipped_button_integration_event = false;
    let mut integration_button_feedback_owned = false;
    for (target_index, target) in targets.iter().enumerate() {
        match target {
            model::BindingTarget::Master => {
                if let Err(err) = state.audio.set_master_volume(volume) {
                    run_logger::error(
                        "bindings",
                        "set_master_volume_failed",
                        &format!("binding_id={} error={}", binding.id, err),
                    );
                } else {
                    any_applied = true;
                }
            }
            model::BindingTarget::Focus => {
                if state.apply_focus_volume_with_retry(&binding.id, volume) {
                    any_applied = true;
                }
            }
            model::BindingTarget::Session { session_id } => {
                if let Err(err) = state.audio.set_session_volume(session_id, volume) {
                    run_logger::error(
                        "bindings",
                        "set_session_volume_failed",
                        &format!(
                            "binding_id={} session_id={} error={}",
                            binding.id, session_id, err
                        ),
                    );
                } else {
                    any_applied = true;
                }
            }
            model::BindingTarget::Application { name, .. } => {
                if let Err(err) = state.audio.set_application_volume(name, volume) {
                    run_logger::error(
                        "bindings",
                        "set_application_volume_failed",
                        &format!("binding_id={} app={} error={}", binding.id, name, err),
                    );
                } else {
                    any_applied = true;
                }
            }
            model::BindingTarget::Device { device_id } => {
                if let Err(err) = state.audio.set_device_volume(device_id, volume) {
                    run_logger::error(
                        "bindings",
                        "set_device_volume_failed",
                        &format!(
                            "binding_id={} device_id={} error={}",
                            binding.id, device_id, err
                        ),
                    );
                } else {
                    any_applied = true;
                }
            }
            model::BindingTarget::Integration {
                integration_id,
                kind,
                data,
            } => {
                let integration_button_kind = if binding.action == model::BindingAction::Volume
                    && binding_is_button(&binding)
                {
                    integration_volume_button_action_kind(integration_id, kind, data)
                } else {
                    None
                };
                let button_event = if integration_button_kind.is_some() {
                    integration_button_feedback_owned = true;
                    let resolved_event = *button_event_for_event.get_or_insert_with(|| {
                        resolve_integration_button_event(state, &key, &binding, &event)
                    });
                    if resolved_event.is_none() {
                        skipped_button_integration_event = true;
                        continue;
                    }
                    resolved_event
                } else {
                    None
                };
                let group_index = integration_volume_batches
                    .get(integration_id)
                    .map(|items| items.len())
                    .unwrap_or(0);
                integration_volume_batches
                    .entry(integration_id.clone())
                    .or_default()
                    .push(serde_json::json!({
                      "target": {
                        "integration_id": integration_id,
                        "kind": kind,
                        "data": data,
                      },
                      "button_event": button_event,
                      "button_action_kind": integration_button_kind.map(|kind| match kind {
                          IntegrationButtonActionKind::Stateful => "stateful",
                          IntegrationButtonActionKind::Momentary => "momentary",
                      }),
                      "button_input_active": event.value > 0,
                      "target_index": group_index,
                      "target_count": 0,
                      "is_primary_target": target_index == 0,
                      "original_target_index": target_index,
                      "binding_target_count": targets.len(),
                    }));
                any_applied = true;
            }
            model::BindingTarget::Unset
            | model::BindingTarget::MediaControl
            | model::BindingTarget::CaptureControl
            | model::BindingTarget::Hotkey
            | model::BindingTarget::OpenApplication => {}
        }
    }

    for (integration_id, mut grouped_targets) in integration_volume_batches {
        let grouped_count = grouped_targets.len();
        for (group_index, grouped_target) in grouped_targets.iter_mut().enumerate() {
            if let Some(map) = grouped_target.as_object_mut() {
                map.insert(
                    "target_index".to_string(),
                    serde_json::Value::Number((group_index as u64).into()),
                );
                map.insert(
                    "target_count".to_string(),
                    serde_json::Value::Number((grouped_count as u64).into()),
                );
            }
        }
        let payload = serde_json::json!({
          "binding_id": binding.id,
          "action": "Volume",
          "value": volume,
          "integration_id": integration_id,
          "targets": grouped_targets,
          "source": if integration_button_feedback_owned { "midi_button" } else { "midi_fader" },
        });
        let _ = app.emit("integration_binding_triggered_batch", payload);
    }

    if !any_applied {
        if skipped_button_integration_event {
            return Ok(());
        }
        run_logger::warn(
            "bindings",
            "volume_no_target_applied",
            &format!("binding_id={} targets={}", binding.id, targets.len()),
        );
        return Ok(());
    }

    let primary_feedback_value = binding
        .mapped_button_light_feedback_value()
        .or_else(|| binding.activity_button_light_feedback_value(event.value > 0))
        .unwrap_or(volume);

    let input_active = event.value > 0;
    if !integration_button_feedback_owned && !input_active {
        update_activity_button_light_hold_feedback(state, &binding, key.clone(), false);
    }

    if !integration_button_feedback_owned {
        if let Ok(mut feedback) = state.feedback_values.lock() {
            feedback.insert(key.clone(), primary_feedback_value);
        }
    }

    if let Ok(mut last_update) = state.osd_last_update.lock() {
        *last_update = Some(Instant::now());
    }

    if !integration_button_feedback_owned {
        if let Ok(mut midi) = state.midi.lock() {
            let _ = midi.send_binding_feedback(&binding, primary_feedback_value);
        }
        if input_active {
            update_activity_button_light_hold_feedback(state, &binding, key.clone(), true);
        }
    }

    let settings_enabled = state
        .osd_settings
        .lock()
        .map(|settings| settings.enabled)
        .unwrap_or(true);
    for target in &targets {
        let focus_session = if matches!(target, model::BindingTarget::Focus) {
            state.audio.focused_session().ok().flatten()
        } else {
            None
        };
        let payload = serde_json::json!({
          "target": target,
          "volume": volume,
          "focus_session": focus_session,
          "binding_id": binding.id
        });
        if !integration_button_feedback_owned {
            let _ = app.emit("volume_update", payload.clone());

            if settings_enabled {
                AppState::emit_osd_update(app, state, &payload, false);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
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
                    last_value: 1.0,
                    last_update: Instant::now(),
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
}

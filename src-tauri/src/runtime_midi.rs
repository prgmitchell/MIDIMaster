mod button_state;
use crate::binding_actions;
use crate::bindings::{apply_midi_event as apply_binding_midi_event, BindingKey, BindingState};
use crate::feedback::{self, FeedbackControlKey, FeedbackSendOptions};
use crate::model::{self, MidiEvent};
use crate::run_logger;
use crate::AppState;
use button_state::*;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[path = "runtime_midi/actions.rs"]
mod actions;
#[path = "runtime_midi/aux_controls.rs"]
mod aux_controls;
#[path = "runtime_midi/learn.rs"]
mod learn;

fn send_immediate_button_light_feedback(
    state: &AppState,
    binding: &model::Binding,
    value: f32,
    context: &'static str,
) {
    feedback::send_button_light_feedback_to_binding(
        state,
        binding,
        FeedbackSendOptions {
            value,
            silent: false,
            force_hardware_feedback: true,
            context,
        },
    );
}

fn emit_macro_button_feedback(
    state: &AppState,
    app: &AppHandle,
    binding: &model::Binding,
    key: &BindingKey,
    input_active: bool,
) {
    let input_value = if input_active { 1.0 } else { 0.0 };
    let feedback_value = state
        .button_light_feedback_value(binding, Some(input_active), None)
        .unwrap_or(input_value);

    if !input_active {
        update_activity_button_light_hold_feedback(state, binding, key.clone(), false);
    }

    state.set_binding_action_value(key, feedback_value);
    send_immediate_button_light_feedback(state, binding, feedback_value, "macro_button");

    if input_active {
        update_activity_button_light_hold_feedback(state, binding, key.clone(), true);
    }

    let _ = app.emit(
        "volume_update",
        serde_json::json!({
            "target": model::BindingTarget::Macro,
            "volume": feedback_value,
            "binding_id": binding.id,
            "source": "macro_feedback",
        }),
    );
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
    let allow_stale_device_fallback = state
        .midi
        .lock()
        .map(|midi| midi.active_route_count() <= 1)
        .unwrap_or(true);
    let binding = match profile.find_binding(&key, allow_stale_device_fallback) {
        Some(binding) => binding,
        None => {
            aux_controls::handle_aux_or_unmatched(state, app, &profile, &key, &event)?;
            return Ok(());
        }
    };
    let targets = binding.normalized_targets_ref();
    if targets.is_empty() {
        run_logger::warn(
            "bindings",
            "binding_has_no_targets",
            &format!("binding_id={} action={:?}", binding.id, binding.action),
        );
        return Ok(());
    }
    if !state.binding_has_available_target(binding) {
        if binding.is_button_binding() {
            state.set_binding_action_value(&key, 0.0);
            send_immediate_button_light_feedback(state, binding, 0.0, "integration_unavailable");
        }
        run_logger::debug(
            "bindings",
            "binding_targets_unavailable",
            &format!("binding_id={} targets={}", binding.id, targets.len()),
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
            last_absolute_input: None,
            absolute_input_direction: 0,
            relative_auto_format: None,
            relative_seen_midpoint: false,
            relative_seen_sign_band: false,
            relative_seen_high_negative: false,
            relative_seen_low_negative_hint: false,
        });
        apply_binding_midi_event(binding, &event, state)
    };

    let volume = match volume {
        Some(v) => v,
        None => return Ok(()),
    };

    if binding.is_button_binding()
        && targets
            .iter()
            .all(|target| matches!(target, model::BindingTarget::Unset))
    {
        let feedback_value = if event.value > 0 { 1.0 } else { 0.0 };
        state.set_binding_action_value(&key, feedback_value);
        send_immediate_button_light_feedback(state, binding, feedback_value, "unassigned_button");
        run_logger::debug(
            "bindings",
            "unassigned_button_activity_feedback",
            &format!("binding_id={} value={}", binding.id, feedback_value),
        );
        return Ok(());
    }

    actions::trigger_supplemental_soundboard(state, app, binding, targets, &event);

    let has_macro_target = targets
        .iter()
        .any(|target| matches!(target, model::BindingTarget::Macro));
    if has_macro_target {
        if !binding.is_button_binding() {
            run_logger::warn(
                "bindings",
                "macro_non_button_ignored",
                &format!("binding_id={}", binding.id),
            );
            return Ok(());
        }

        let input_active = event.value > 0;
        if matches!(binding.action, model::BindingAction::Macro) {
            emit_macro_button_feedback(state, app, binding, &key, input_active);
        }
        if input_active {
            crate::binding_services::spawn_macro_binding(app.clone(), binding.id.clone(), false);
        }
        if matches!(binding.action, model::BindingAction::Macro) {
            if !input_active {
                run_logger::debug(
                    "bindings",
                    "macro_release_ignored",
                    &format!("binding_id={}", binding.id),
                );
            }
            return Ok(());
        }
        if !input_active {
            run_logger::debug(
                "bindings",
                "supplemental_macro_release_ignored",
                &format!("binding_id={}", binding.id),
            );
        }
    }

    if actions::handle_special_action(state, app, binding, targets, &event)? {
        return Ok(());
    }

    // Handle toggle mute action for button bindings
    if binding.action == model::BindingAction::ToggleMute {
        // Mark user activity to prevent stale feedback loop
        mark_binding_user_activity(state, &key);

        // On button release (value == 0), re-send current state to enforce latching check
        // This fixes controllers that turn off LED on release (momentary behavior)
        if handle_latched_button_release(state, binding, &key, &event) {
            run_logger::debug(
                "bindings",
                "toggle_mute_release_resend",
                &format!("binding_id={} device_id={}", binding.id, binding.device_id),
            );
            return Ok(());
        }

        let current_muted = state.current_binding_toggle_state(targets, &key);
        let Some(muted) =
            resolve_stateful_button_transition(state, binding, &key, &event, current_muted)
        else {
            return Ok(());
        };
        let outcome = binding_actions::execute_target_action(
            app,
            state,
            binding,
            &model::BindingAction::ToggleMute,
            if muted { 1.0 } else { 0.0 },
            binding_actions::ActionExecutionContext::local("bindings"),
        )?;

        if !outcome.applied() {
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

        let feedback_value = state
            .button_light_feedback_value(binding, Some(event.value > 0), Some(muted))
            .unwrap_or(if muted { 1.0 } else { 0.0 });
        state.set_binding_action_value(&key, if muted { 1.0 } else { 0.0 });
        send_immediate_button_light_feedback(state, binding, feedback_value, "toggle_mute");

        let settings_enabled = state
            .osd_settings
            .lock()
            .map(|settings| settings.enabled)
            .unwrap_or(true);

        let binding_primary_target = outcome
            .applied_target_indices
            .first()
            .and_then(|index| targets.get(*index))
            .cloned();
        for target_index in outcome.applied_target_indices {
            let Some(target) = targets.get(target_index) else {
                continue;
            };
            let focus_session = if matches!(target, model::BindingTarget::Focus) {
                state.audio.focused_session().ok().flatten()
            } else {
                None
            };
            let payload = crate::binding_events::binding_event_payload(
                binding,
                &binding_primary_target,
                serde_json::json!({
                  "target": target,
                  "muted": muted,
                  "action": "toggle_mute",
                  "focus_session": focus_session,
                }),
            );
            let _ = app.emit("mute_update", payload.clone());

            if settings_enabled {
                AppState::emit_osd_update(app, state, &payload, false);
            }
        }

        return Ok(());
    }

    if binding_actions::action_is_stateful_integration_toggle(&binding.action) {
        mark_binding_user_activity(state, &key);

        if handle_latched_button_release(state, binding, &key, &event) {
            return Ok(());
        }

        let current_enabled = state
            .binding_action_value(&key)
            .map(|value| value > 0.5)
            .unwrap_or(false);
        let Some(next_enabled) =
            resolve_stateful_button_transition(state, binding, &key, &event, current_enabled)
        else {
            return Ok(());
        };

        let any_applied = binding_actions::execute_target_action(
            app,
            state,
            binding,
            &binding.action,
            if next_enabled { 1.0 } else { 0.0 },
            binding_actions::ActionExecutionContext {
                integrations_only: true,
                ..binding_actions::ActionExecutionContext::local("bindings")
            },
        )?
        .applied();

        if !any_applied {
            run_logger::warn(
                "bindings",
                "stateful_integration_toggle_no_target_applied",
                &format!("binding_id={} targets={}", binding.id, targets.len()),
            );
            return Ok(());
        }

        let feedback_value = state
            .button_light_feedback_value(binding, Some(event.value > 0), Some(next_enabled))
            .unwrap_or(if next_enabled { 1.0 } else { 0.0 });
        state.set_binding_action_value(&key, if next_enabled { 1.0 } else { 0.0 });
        send_immediate_button_light_feedback(
            state,
            binding,
            feedback_value,
            "stateful_integration_toggle",
        );
        return Ok(());
    }

    if binding_actions::action_is_momentary_integration_action(&binding.action) {
        if event.value == 0 {
            let feedback_value = state
                .button_light_feedback_value(binding, Some(false), None)
                .unwrap_or(0.0);
            send_immediate_button_light_feedback(
                state,
                binding,
                feedback_value,
                "momentary_integration_release",
            );
            update_activity_button_light_hold_feedback(state, binding, key.clone(), false);
            return Ok(());
        }

        let any_applied = binding_actions::execute_target_action(
            app,
            state,
            binding,
            &binding.action,
            1.0,
            binding_actions::ActionExecutionContext {
                integrations_only: true,
                ..binding_actions::ActionExecutionContext::local("bindings")
            },
        )?
        .applied();

        if !any_applied {
            run_logger::warn(
                "bindings",
                "momentary_integration_no_target_applied",
                &format!("binding_id={} targets={}", binding.id, targets.len()),
            );
            return Ok(());
        }

        let feedback_value = state
            .button_light_feedback_value(binding, Some(true), None)
            .unwrap_or(1.0);
        send_immediate_button_light_feedback(
            state,
            binding,
            feedback_value,
            "momentary_integration_press",
        );
        update_activity_button_light_hold_feedback(state, binding, key.clone(), true);
        return Ok(());
    }

    let integration_button_feedback_owned = binding.is_button_binding()
        && targets.iter().any(|target| {
            if let model::BindingTarget::Integration {
                integration_id,
                kind,
                data,
            } = target
            {
                binding_actions::integration_volume_button_action_kind(integration_id, kind, data)
                    .is_some()
            } else {
                false
            }
        });
    let button_event = if integration_button_feedback_owned {
        resolve_integration_button_event(state, &key, binding, &event)
    } else {
        None
    };
    let outcome = binding_actions::execute_target_action(
        app,
        state,
        binding,
        &model::BindingAction::Volume,
        volume,
        binding_actions::ActionExecutionContext {
            integrations_only: false,
            source: Some(if integration_button_feedback_owned {
                "midi_button"
            } else {
                "midi_fader"
            }),
            source_sequence: None,
            log_target: "bindings",
            midi_input: Some(binding_actions::MidiActionInput {
                active: event.value > 0,
                button_event,
            }),
        },
    )?;
    let integration_button_feedback_owned = outcome.integration_button_feedback_owned;
    let skipped_button_integration_event = outcome.skipped_button_integration_event;
    let applied_targets: Vec<_> = outcome
        .applied_target_indices
        .iter()
        .map(|index| &targets[*index])
        .collect();

    if applied_targets.is_empty() {
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

    let button_light_feedback_value =
        state.button_light_feedback_value(binding, Some(event.value > 0), None);
    let primary_feedback_value = button_light_feedback_value.unwrap_or(volume);

    let input_active = event.value > 0;
    if !integration_button_feedback_owned && !input_active {
        update_activity_button_light_hold_feedback(state, binding, key.clone(), false);
    }

    if !integration_button_feedback_owned && button_light_feedback_value.is_none() {
        let output_key = feedback::binding_feedback_control_key(binding).to_binding_key();
        if let Ok(mut feedback) = state.feedback_values.lock() {
            feedback.insert(key.clone(), primary_feedback_value);
            if output_key != key {
                feedback.insert(output_key, primary_feedback_value);
            }
        }
    }

    if let Ok(mut last_update) = state.osd_last_update.lock() {
        *last_update = Some(Instant::now());
    }

    if !integration_button_feedback_owned {
        if button_light_feedback_value.is_some() {
            send_immediate_button_light_feedback(
                state,
                binding,
                primary_feedback_value,
                "button_volume",
            );
        } else if binding.is_button_binding() {
            send_immediate_button_light_feedback(
                state,
                binding,
                primary_feedback_value,
                "button_volume_default",
            );
        } else if let Ok(mut midi) = state.midi.lock() {
            let _ = midi.send_binding_feedback(binding, primary_feedback_value);
        }
        if input_active {
            update_activity_button_light_hold_feedback(state, binding, key.clone(), true);
        }
    }

    let settings_enabled = state
        .osd_settings
        .lock()
        .map(|settings| settings.enabled)
        .unwrap_or(true);
    let binding_primary_target = applied_targets.first().map(|target| (*target).clone());
    for target in applied_targets {
        let focus_session = if matches!(target, model::BindingTarget::Focus) {
            state.audio.focused_session().ok().flatten()
        } else {
            None
        };
        let payload = crate::binding_events::binding_event_payload(
            binding,
            &binding_primary_target,
            serde_json::json!({
              "target": target,
              "volume": volume,
              "focus_session": focus_session,
            }),
        );
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
mod tests;

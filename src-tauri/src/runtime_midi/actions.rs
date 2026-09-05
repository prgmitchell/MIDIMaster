use super::update_activity_button_light_hold_feedback;
use crate::binding_actions;
use crate::bindings::BindingKey;
use crate::feedback::{self, FeedbackSendOptions};
use crate::model::{self, Binding, BindingTarget, MidiEvent};
use crate::run_logger;
use crate::AppState;
use tauri::{AppHandle, Emitter};

fn emit_button_feedback(
    state: &AppState,
    app: &AppHandle,
    binding: &Binding,
    event: &MidiEvent,
    targets: &[BindingTarget],
    value: f32,
) {
    let key = BindingKey::from_event(event);
    let input_active = event.value > 0;
    let feedback_value = state
        .button_light_feedback_value(binding, Some(input_active), None)
        .unwrap_or(value);
    if !input_active {
        update_activity_button_light_hold_feedback(state, binding, key.clone(), false);
    }
    feedback::send_button_light_feedback_to_binding(
        state,
        binding,
        FeedbackSendOptions {
            value: feedback_value,
            silent: false,
            force_hardware_feedback: true,
            context: "special_action_button",
        },
    );
    if input_active {
        update_activity_button_light_hold_feedback(state, binding, key, true);
    }
    let payload = serde_json::json!({
      "target": targets.first().unwrap_or(&BindingTarget::Unset),
      "volume": feedback_value,
      "binding_id": binding.id,
      "source": "button_feedback",
    });
    let _ = app.emit("volume_update", payload);
}

fn clear_profile_switch_button_feedback(
    state: &AppState,
    app: &AppHandle,
    binding: &Binding,
    event: &MidiEvent,
    targets: &[BindingTarget],
) {
    let key = BindingKey::from_event(event);
    update_activity_button_light_hold_feedback(state, binding, key.clone(), false);
    if let Ok(mut states) = state.binding_state.lock() {
        if let Some(binding_state) = states.get_mut(&key) {
            binding_state.last_value = 0.0;
            binding_state.last_update = std::time::Instant::now();
        }
    }
    state.set_binding_action_value(&key, 0.0);
    feedback::send_button_light_feedback_to_binding(
        state,
        binding,
        FeedbackSendOptions {
            value: 0.0,
            silent: false,
            force_hardware_feedback: true,
            context: "profile_switch_button",
        },
    );
    let _ = app.emit(
        "volume_update",
        serde_json::json!({
            "target": targets.first().unwrap_or(&BindingTarget::Unset),
            "volume": 0.0,
            "binding_id": binding.id,
            "source": "profile_switch_feedback",
            "silent": true,
        }),
    );
}

pub(super) fn trigger_supplemental_soundboard(
    state: &AppState,
    app: &AppHandle,
    binding: &Binding,
    targets: &[BindingTarget],
    event: &MidiEvent,
) {
    if binding.action == model::BindingAction::Soundboard
        || !targets
            .iter()
            .any(|target| matches!(target, BindingTarget::Soundboard))
        || !crate::soundboard::should_trigger_from_input(f32::from(event.value))
    {
        return;
    }
    #[cfg(feature = "perf-audit")]
    crate::perf_audit::record_unverified_action();
    let result = binding
        .soundboard
        .as_ref()
        .ok_or_else(|| "Select an audio file for this Soundboard action".to_string())
        .and_then(|mapping| state.soundboard.play_binding(&binding.id, mapping));
    if let Err(err) = result {
        run_logger::warn(
            "bindings",
            "soundboard_play_failed",
            &format!("binding_id={} error={}", binding.id, err),
        );
        binding_actions::emit_localized_action_error(
            app,
            "soundboard_play_failed",
            &binding.id,
            "dialogs.soundboardPlaybackFailedTitle",
            "dialogs.soundboardPlaybackFailedMessage",
            serde_json::json!({ "message": err }),
        );
    }
}

pub(super) fn handle_special_action(
    state: &AppState,
    app: &AppHandle,
    binding: &Binding,
    targets: &[BindingTarget],
    event: &MidiEvent,
) -> Result<bool, String> {
    if binding.action == model::BindingAction::SwitchProfile {
        clear_profile_switch_button_feedback(state, app, binding, event, targets);
        if event.value > 0 {
            #[cfg(feature = "perf-audit")]
            crate::perf_audit::record_unverified_action();
            binding_actions::request_profile_switch(app, binding, "bindings");
        }
        return Ok(true);
    }

    if binding.action == model::BindingAction::Soundboard {
        let input_active = crate::soundboard::should_trigger_from_input(f32::from(event.value));
        emit_button_feedback(
            state,
            app,
            binding,
            event,
            targets,
            if input_active { 1.0 } else { 0.0 },
        );
        if !input_active {
            return Ok(true);
        }
        #[cfg(feature = "perf-audit")]
        crate::perf_audit::record_unverified_action();
        let result = binding
            .soundboard
            .as_ref()
            .ok_or_else(|| "Select an audio file for this Soundboard action".to_string())
            .and_then(|mapping| state.soundboard.play_binding(&binding.id, mapping));
        if let Err(err) = result {
            run_logger::warn(
                "bindings",
                "soundboard_play_failed",
                &format!("binding_id={} error={}", binding.id, err),
            );
            let _ = app.emit(
                "binding_action_error",
                serde_json::json!({
                    "reason": "soundboard_play_failed",
                    "binding_id": binding.id,
                    "title_key": "dialogs.soundboardPlaybackFailedTitle",
                    "message_key": "dialogs.soundboardPlaybackFailedMessage",
                    "params": { "message": err },
                }),
            );
        }
        return Ok(true);
    }

    let shared_button_action = matches!(
        binding.action,
        model::BindingAction::MediaPlayPause
            | model::BindingAction::MediaNextTrack
            | model::BindingAction::MediaPrevTrack
            | model::BindingAction::MediaStop
            | model::BindingAction::Hotkey
            | model::BindingAction::OpenApplication
            | model::BindingAction::RunAutoHotkeyScript
            | model::BindingAction::FocusWindow
            | model::BindingAction::FullScreenshot
            | model::BindingAction::SnipScreenshot
            | model::BindingAction::ToggleScreenRecording
    );
    if shared_button_action {
        #[cfg(feature = "perf-audit")]
        if event.value > 0 {
            crate::perf_audit::record_unverified_action();
        }
        let is_capture_action = matches!(
            binding.action,
            model::BindingAction::FullScreenshot
                | model::BindingAction::SnipScreenshot
                | model::BindingAction::ToggleScreenRecording
        );
        if is_capture_action
            && !targets
                .iter()
                .any(|target| matches!(target, BindingTarget::CaptureControl))
        {
            return Ok(true);
        }

        emit_button_feedback(
            state,
            app,
            binding,
            event,
            targets,
            if event.value > 0 { 1.0 } else { 0.0 },
        );
        binding_actions::apply_special_button_action(
            app,
            binding,
            &binding.action,
            f32::from(event.value),
            "bindings",
        );
        return Ok(true);
    }

    if binding.action == model::BindingAction::SetDefaultDevice {
        if event.value == 0 {
            emit_button_feedback(state, app, binding, event, targets, 0.0);
            run_logger::debug(
                "bindings",
                "set_default_device_ignored_release",
                &format!("binding_id={} action={:?}", binding.id, binding.action),
            );
            return Ok(true);
        }
        emit_button_feedback(state, app, binding, event, targets, 1.0);
        let outcome = binding_actions::execute_target_action(
            app,
            state,
            binding,
            &model::BindingAction::SetDefaultDevice,
            1.0,
            binding_actions::ActionExecutionContext::local("bindings"),
        )?;
        if !outcome.applied() {
            run_logger::warn(
                "bindings",
                "set_default_device_no_target_applied",
                &format!("binding_id={} targets={}", binding.id, targets.len()),
            );
        }

        return Ok(true);
    }

    Ok(false)
}

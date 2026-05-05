use crate::run_logger;
use crate::{model::DeviceInfo, AppState};
use tauri::{AppHandle, Emitter, Manager, State};

fn emit_midi_connection_status(
    app: &AppHandle,
    input_device_id: &str,
    output_device_id: &str,
    state: &str,
    reason: &str,
) {
    let _ = app.emit(
        "midi_connection_status",
        serde_json::json!({
            "inputDeviceId": input_device_id,
            "outputDeviceId": output_device_id,
            "state": state,
            "reason": reason,
        }),
    );
}

#[tauri::command]
pub fn list_midi_devices(state: State<AppState>) -> Result<Vec<DeviceInfo>, String> {
    state
        .midi
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?
        .list_devices()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_midi_output_devices(state: State<AppState>) -> Result<Vec<DeviceInfo>, String> {
    state
        .midi
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?
        .list_output_devices()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn start_midi_device(
    app: AppHandle,
    state: State<AppState>,
    input_device_id: String,
    output_device_id: String,
) -> Result<(), String> {
    run_logger::info(
        "midi_cmd",
        "start_requested",
        &format!(
            "input_device_id={} output_device_id={}",
            input_device_id, output_device_id
        ),
    );
    emit_midi_connection_status(
        &app,
        &input_device_id,
        &output_device_id,
        "reconnecting",
        "start_requested",
    );
    let app_handle = app.clone();
    {
        if let Err(err) = state
            .midi
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?
            .start_device(&input_device_id, &output_device_id, move |event| {
                let state = app_handle.state::<AppState>();
                {
                    if let Ok(mut queue) = state.midi_event_queue.lock() {
                        queue.enqueue(event);
                    } else {
                        run_logger::error("midi_queue", "enqueue_failed", "queue lock poisoned");
                    }
                };
            })
            .map_err(|err| err.to_string())
        {
            run_logger::error(
                "midi_cmd",
                "start_failed",
                &format!(
                    "input_device_id={} output_device_id={} error={}",
                    input_device_id, output_device_id, err
                ),
            );
            emit_midi_connection_status(
                &app,
                &input_device_id,
                &output_device_id,
                "failed",
                "start_failed",
            );
            return Err(err);
        }
    }

    // Keep persisted bindings aligned with the currently connected input device.
    // This prevents stale device ids (e.g. midi index changed) from breaking
    // event lookup, motor feedback, and UI event mapping.
    let mut migrated_count = 0usize;
    let mut profile_for_sync = None;
    {
        let mut profile_guard = state
            .active_profile
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;

        if let Some(profile) = profile_guard.as_mut() {
            for binding in &mut profile.bindings {
                if binding.device_id != input_device_id {
                    binding.device_id = input_device_id.clone();
                    migrated_count += 1;
                }
            }

            if migrated_count > 0 {
                state
                    .profile_store
                    .save_profile(profile.clone())
                    .map_err(|err| err.to_string())?;
                profile_for_sync = Some(profile.clone());
            }
        }
    }

    if let Some(profile) = profile_for_sync {
        if let Ok(mut states) = state.binding_state.lock() {
            states.clear();
        }
        if let Ok(mut feedback) = state.feedback_values.lock() {
            feedback.clear();
        }
        state.sync_feedback_values(&profile);
        let _ = app.emit(
            "bindings_migrated",
            serde_json::json!({ "device_id": input_device_id, "count": migrated_count }),
        );
    }
    run_logger::info(
        "midi_cmd",
        "start_succeeded",
        &format!(
            "input_device_id={} output_device_id={} bindings_migrated={}",
            input_device_id, output_device_id, migrated_count
        ),
    );
    emit_midi_connection_status(
        &app,
        &input_device_id,
        &output_device_id,
        "connected",
        "start_succeeded",
    );

    Ok(())
}

#[tauri::command]
pub fn stop_midi_device(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    run_logger::info("midi_cmd", "stop_requested", "");
    let active = {
        let mut midi = state.midi.lock().map_err(|_| "Lock poisoned".to_string())?;
        let active = midi.active_pair();
        midi.stop();
        active
    };
    if let Some((input_device_id, output_device_id)) = active {
        emit_midi_connection_status(
            &app,
            &input_device_id,
            &output_device_id,
            "disconnected",
            "stop_requested",
        );
    }
    Ok(())
}

#[tauri::command]
pub fn start_midi_learn(state: State<AppState>) -> Result<(), String> {
    run_logger::info("learn", "start_requested", "");
    *state
        .learn_pending
        .lock()
        .map_err(|_| "Lock poisoned".to_string())? = true;
    *state
        .learn_candidate
        .lock()
        .map_err(|_| "Lock poisoned".to_string())? = None;
    *state
        .learned_control
        .lock()
        .map_err(|_| "Lock poisoned".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn consume_learned_control(
    state: State<AppState>,
) -> Result<Option<crate::model::LearnedControl>, String> {
    let mut guard = state
        .learned_control
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let next = guard.take();
    if let Some(control) = next.as_ref() {
        run_logger::info(
            "learn",
            "control_consumed",
            &format!(
                "device_id={} channel={} controller={} msg_type={:?} control_kind={:?}",
                control.device_id,
                control.channel,
                control.controller,
                control.msg_type,
                control.control_kind
            ),
        );
    }
    Ok(next)
}

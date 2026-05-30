use crate::run_logger;
use crate::{
    model::{DeviceInfo, Profile},
    AppState,
};
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

fn migrate_profile_input_device(profile: &mut Profile, input_device_id: &str) -> usize {
    let mut migrated_count = 0usize;

    for binding in &mut profile.bindings {
        if update_device_id(&mut binding.device_id, input_device_id) {
            migrated_count += 1;
        }
        if let Some(mute_control) = binding.mute_control.as_mut() {
            if update_device_id(&mut mute_control.device_id, input_device_id) {
                migrated_count += 1;
            }
        }
        if let Some(assign_control) = binding.assign_control.as_mut() {
            if update_device_id(&mut assign_control.device_id, input_device_id) {
                migrated_count += 1;
            }
        }
    }

    migrated_count
}

fn update_device_id(device_id: &mut String, input_device_id: &str) -> bool {
    if device_id == input_device_id {
        return false;
    }

    *device_id = input_device_id.to_string();
    true
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
                let enqueue_result = state.midi_event_queue.lock();
                match enqueue_result {
                    Ok(mut queue) => queue.enqueue(event),
                    Err(_) => {
                        run_logger::error("midi_queue", "enqueue_failed", "queue lock poisoned")
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
            migrated_count = migrate_profile_input_device(profile, &input_device_id);

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
        if let Ok(mut values) = state.binding_action_values.lock() {
            values.clear();
        }
        state.sync_feedback_values(&profile);
        let _ = app.emit(
            "bindings_migrated",
            serde_json::json!({ "device_id": input_device_id, "count": migrated_count }),
        );
    }

    let profile_for_lights = state
        .active_profile
        .lock()
        .ok()
        .and_then(|profile| profile.clone());
    if let Some(profile) = profile_for_lights {
        state.sync_feedback_values(&profile);
        state.send_idle_button_light_feedback_values(&profile);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        self, AssignMode, BindingAction, BindingControlKind, BindingTarget, FaderCurve,
        MidiMessageType, MidiMode, MuteBehavior, RelativeFormat,
    };
    use std::collections::HashMap;

    fn profile_with(binding: model::Binding) -> Profile {
        Profile {
            name: "Default".to_string(),
            bindings: vec![binding],
            osd_settings: model::OsdSettings::default(),
            plugin_settings: HashMap::new(),
            midi_device_preference: model::MidiDevicePreference::default(),
        }
    }

    fn binding(
        device_id: &str,
        mute_device_id: Option<&str>,
        assign_device_id: Option<&str>,
    ) -> model::Binding {
        model::Binding {
            id: "binding-1".to_string(),
            name: "Binding 1".to_string(),
            device_id: device_id.to_string(),
            control: model::MidiControl {
                channel: 2,
                controller: 224,
                msg_type: MidiMessageType::PitchBend,
            },
            control_kind: BindingControlKind::Continuous,
            targets: vec![BindingTarget::Master],
            target: BindingTarget::Master,
            action: BindingAction::Volume,
            mode: MidiMode::Absolute,
            relative_format: RelativeFormat::Auto,
            fader_curve: FaderCurve::Linear,
            custom_curve: Vec::new(),
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: MuteBehavior::ToggleOnPress,
            button_light_mode: model::ButtonLightMode::Activity,
            mute_control: mute_device_id.map(|id| aux_control(id, 18)),
            assign_control: assign_device_id.map(|id| aux_control(id, 19)),
            assign_mode: AssignMode::Add,
            hotkey: None,
            open_application: None,
        }
    }

    fn aux_control(device_id: &str, controller: u8) -> model::AuxiliaryControl {
        model::AuxiliaryControl {
            device_id: device_id.to_string(),
            channel: 0,
            controller,
            msg_type: MidiMessageType::Note,
            control_kind: BindingControlKind::Button,
            mode: MidiMode::Absolute,
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: MuteBehavior::ToggleOnPress,
        }
    }

    #[test]
    fn migrate_input_device_updates_primary_stale_id() {
        let mut profile = profile_with(binding("midi:1", None, None));

        let migrated_count = migrate_profile_input_device(&mut profile, "midi:0");

        assert_eq!(migrated_count, 1);
        assert_eq!(profile.bindings[0].device_id, "midi:0");
    }

    #[test]
    fn migrate_input_device_updates_mute_aux_when_primary_is_current() {
        let mut profile = profile_with(binding("midi:0", Some("midi:1"), None));

        let migrated_count = migrate_profile_input_device(&mut profile, "midi:0");

        let mute_control = profile.bindings[0]
            .mute_control
            .as_ref()
            .expect("mute control should remain mapped");
        assert_eq!(migrated_count, 1);
        assert_eq!(profile.bindings[0].device_id, "midi:0");
        assert_eq!(mute_control.device_id, "midi:0");
        assert_eq!(mute_control.channel, 0);
        assert_eq!(mute_control.controller, 18);
        assert_eq!(mute_control.msg_type, MidiMessageType::Note);
    }

    #[test]
    fn migrate_input_device_updates_assign_aux_when_primary_is_current() {
        let mut profile = profile_with(binding("midi:0", None, Some("midi:1")));

        let migrated_count = migrate_profile_input_device(&mut profile, "midi:0");

        let assign_control = profile.bindings[0]
            .assign_control
            .as_ref()
            .expect("assign control should remain mapped");
        assert_eq!(migrated_count, 1);
        assert_eq!(profile.bindings[0].device_id, "midi:0");
        assert_eq!(assign_control.device_id, "midi:0");
        assert_eq!(assign_control.channel, 0);
        assert_eq!(assign_control.controller, 19);
        assert_eq!(assign_control.msg_type, MidiMessageType::Note);
    }

    #[test]
    fn migrate_input_device_returns_zero_when_all_controls_match() {
        let mut profile = profile_with(binding("midi:0", Some("midi:0"), Some("midi:0")));

        let migrated_count = migrate_profile_input_device(&mut profile, "midi:0");

        assert_eq!(migrated_count, 0);
        assert_eq!(profile.bindings[0].device_id, "midi:0");
        assert_eq!(
            profile.bindings[0]
                .mute_control
                .as_ref()
                .expect("mute control should remain mapped")
                .device_id,
            "midi:0"
        );
        assert_eq!(
            profile.bindings[0]
                .assign_control
                .as_ref()
                .expect("assign control should remain mapped")
                .device_id,
            "midi:0"
        );
    }
}

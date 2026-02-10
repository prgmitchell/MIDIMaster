use crate::{bindings::BindingKey, model, model::Binding, AppState};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub fn add_binding(state: State<AppState>, binding: Binding) -> Result<(), String> {
    let mut profile_guard = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let profile = profile_guard.get_or_insert(model::Profile {
        name: "Default".to_string(),
        bindings: Vec::new(),
        osd_settings: model::OsdSettings::default(),
        plugin_settings: std::collections::HashMap::new(),
    });
    profile.bindings.retain(|existing| {
        !(existing.device_id == binding.device_id && existing.control == binding.control)
    });
    profile.bindings.push(binding);
    state.sync_feedback_values(profile);
    Ok(())
}

#[tauri::command]
pub async fn remove_binding(state: State<'_, AppState>, binding: Binding) -> Result<(), String> {
    // 1. Remove the binding from the active profile FIRST to stop the background loop
    {
        let mut profile_guard = state
            .active_profile
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;

        if let Some(profile) = profile_guard.as_mut() {
            profile
                .bindings
                .retain(|existing| existing.id != binding.id);

            // Save the updated profile to disk
            state
                .profile_store
                .save_profile(profile.clone())
                .map_err(|err| err.to_string())?;
        }
    }

    // 2. Clear internal state
    let key = BindingKey::from_binding(&binding);
    if let Ok(mut feedback) = state.feedback_values.lock() {
        feedback.remove(&key);
    }
    if let Ok(mut states) = state.binding_state.lock() {
        states.remove(&key);
    }

    // 3. Wait for any pending background loop iterations to finish
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 4. Send 0.0 value to the binding's control
    if let Ok(mut midi) = state.midi.lock() {
        let _ = midi.send_feedback(
            &binding.device_id,
            binding.control.channel,
            binding.control.controller,
            0.0,
            binding.control.msg_type.clone(),
        );
    }

    Ok(())
}

#[tauri::command]
pub fn update_midi_feedback(
    state: State<AppState>,
    target: model::BindingTarget,
    value: f32,
    binding_id: Option<String>,
    action: Option<model::BindingAction>,
) -> Result<(), String> {
    let profile_guard = state.active_profile.lock().map_err(|_| "Lock poisoned")?;
    let profile = match profile_guard.as_ref() {
        Some(p) => p,
        None => return Ok(()),
    };

    for binding in &profile.bindings {
        let matches = if let Some(ref id) = binding_id {
            binding.id == *id
        } else if let Some(ref act) = action {
            if binding.action != *act {
                false
            } else {
                binding.target == target
            }
        } else {
            binding.target == target
        };

        if matches {
            let key = BindingKey::from_binding(binding);

            // Check for active user interaction (prevent fighting the user)
            let is_note = matches!(binding.control.msg_type, model::MidiMessageType::Note);

            if !is_note {
                if let Ok(states) = state.binding_state.lock() {
                    if let Some(state) = states.get(&key) {
                        let elapsed = state.last_update.elapsed().as_millis();
                        if elapsed < 500 {
                            continue;
                        }
                    }
                }
            }

            // Check current value to avoid unnecessary updates
            let mut skip = false;
            if let Ok(mut feedback) = state.feedback_values.lock() {
                if let Some(current) = feedback.get(&key) {
                    if (current - value).abs() < 0.005 {
                        skip = true;
                    }
                }
                if !skip {
                    feedback.insert(key.clone(), value);
                }
            }

            if skip {
                continue;
            }

            // Send the actual MIDI feedback
            if let Ok(mut midi) = state.midi.lock() {
                let _ = midi.send_feedback(
                    &binding.device_id,
                    binding.control.channel,
                    binding.control.controller,
                    value,
                    binding.control.msg_type.clone(),
                );
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn set_binding_feedback(
    app: AppHandle,
    state: State<AppState>,
    binding_id: String,
    value: f32,
    action: Option<model::BindingAction>,
    silent: Option<bool>,
) -> Result<(), String> {
    let profile_guard = state.active_profile.lock().map_err(|_| "Lock poisoned")?;
    let profile = match profile_guard.as_ref() {
        Some(p) => p,
        None => return Ok(()),
    };

    let binding = match profile.bindings.iter().find(|b| b.id == binding_id) {
        Some(b) => b,
        None => return Ok(()),
    };

    let key = BindingKey::from_binding(binding);

    let silent = silent.unwrap_or(false);

    // Prevent fighting the user while they're moving a control.
    // For motor faders, sending feedback while the user is actively moving causes jitter.
    // We still want to update internal state + UI/OSD for user-driven changes.
    let is_note = matches!(binding.control.msg_type, model::MidiMessageType::Note);
    let mut user_active = false;
    if !is_note {
        if let Ok(states) = state.binding_state.lock() {
            if let Some(st) = states.get(&key) {
                user_active = st.last_update.elapsed().as_millis() < 500;
            }
        }
    }

    // Ignore background (silent) sync updates while the user is actively moving.
    // Otherwise a slightly delayed poll/notification can overwrite the latched value and
    // make the motor snap or jitter.
    if user_active && silent {
        return Ok(());
    }

    // Update current value to avoid unnecessary updates.
    let mut skip = false;
    if let Ok(mut feedback) = state.feedback_values.lock() {
        if let Some(current) = feedback.get(&key) {
            if (current - value).abs() < 0.005 {
                skip = true;
            }
        }
        if !skip {
            feedback.insert(key.clone(), value);
        }
    }
    if skip {
        return Ok(());
    }

    if let Ok(mut last_update) = state.osd_last_update.lock() {
        *last_update = Some(Instant::now());
    }

    // Send MIDI feedback to hardware.
    // Suppress during active user movement to avoid motor jitter.
    if !user_active {
        if let Ok(mut midi) = state.midi.lock() {
            let _ = midi.send_feedback(
                &binding.device_id,
                binding.control.channel,
                binding.control.controller,
                value,
                binding.control.msg_type.clone(),
            );
        }
    }

    // Emit UI/OSD updates.
    let effective_action = action.unwrap_or_else(|| binding.action.clone());
    let settings_enabled = state
        .osd_settings
        .lock()
        .map(|settings| settings.enabled)
        .unwrap_or(true);

    match effective_action {
        model::BindingAction::ToggleMute => {
            let muted = value > 0.5;
            let focus_session = if matches!(&binding.target, model::BindingTarget::Focus) {
                state.audio.focused_session().ok().flatten()
            } else {
                None
            };
            let payload = serde_json::json!({
              "target": binding.target,
              "muted": muted,
              "action": "toggle_mute",
              "focus_session": focus_session,
              "binding_id": binding.id,
              "silent": silent
            });
            let _ = app.emit("mute_update", payload.clone());
            if settings_enabled && !silent {
                if let Some(osd_window) = app.get_webview_window("osd") {
                    let _ = osd_window.show();
                    let _ = osd_window.emit("mute_update", payload.clone());
                    if let Ok(payload_json) = serde_json::to_string(&payload) {
                        let script = format!(
                            "window.__OSD_UPDATE__ && window.__OSD_UPDATE__({});",
                            payload_json
                        );
                        let _ = osd_window.eval(&script);
                    }
                }
            }
        }
        model::BindingAction::Volume => {
            let focus_session = if matches!(&binding.target, model::BindingTarget::Focus) {
                state.audio.focused_session().ok().flatten()
            } else {
                None
            };
            let payload = serde_json::json!({
              "target": binding.target,
              "volume": value,
              "focus_session": focus_session,
              "binding_id": binding.id,
              "silent": silent
            });
            let _ = app.emit("volume_update", payload.clone());
            if settings_enabled && !silent {
                if let Some(osd_window) = app.get_webview_window("osd") {
                    let _ = osd_window.show();
                    let _ = osd_window.emit("volume_update", payload.clone());
                    if let Ok(payload_json) = serde_json::to_string(&payload) {
                        let script = format!(
                            "window.__OSD_UPDATE__ && window.__OSD_UPDATE__({});",
                            payload_json
                        );
                        let _ = osd_window.eval(&script);
                    }
                }
            }
        }
    }

    Ok(())
}

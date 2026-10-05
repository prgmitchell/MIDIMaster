use crate::{
    collect_monitor_descriptors, feedback, model::Profile, model::ProfileSummary, AppState,
};
use tauri::{AppHandle, State};

fn heal_legacy_osd_monitor_id(app: &AppHandle, profile: &mut Profile) -> bool {
    let needs_heal = profile
        .osd_settings
        .monitor_id
        .as_ref()
        .map(|id| id.trim().is_empty())
        .unwrap_or(true);
    if !needs_heal {
        return false;
    }

    let monitors = match collect_monitor_descriptors(app) {
        Ok(monitors) => monitors,
        Err(_) => return false,
    };
    if monitors.is_empty() {
        return false;
    }

    let selected = monitors
        .get(profile.osd_settings.monitor_index)
        .or_else(|| monitors.iter().find(|m| m.is_primary))
        .unwrap_or(&monitors[0]);

    profile.osd_settings.monitor_index = selected.index;
    profile.osd_settings.monitor_name = Some(selected.friendly_name.clone());
    profile.osd_settings.monitor_id = Some(selected.stable_id.clone());
    true
}

fn normalize_profile_midi_preference(profile: &mut Profile) -> bool {
    if profile.midi_device_preference_set {
        return false;
    }
    if profile
        .midi_device_preference
        .normalized_routes()
        .is_empty()
    {
        return false;
    }

    profile.midi_device_preference_set = true;
    true
}

fn safe_export_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string();

    let base = if cleaned.is_empty() {
        "profile".to_string()
    } else {
        cleaned
    };

    format!("{}.json", base)
}

fn set_active_profile_state(
    state: &AppState,
    app: &AppHandle,
    profile: &Profile,
    restore: bool,
) -> Result<(), String> {
    crate::solo::reset_for_profile(app, state)?;
    state
        .profile_target_state
        .lock()
        .map_err(|_| "Lock poisoned")?
        .activate(profile, restore);
    let previous_bindings = {
        let mut active_profile = state
            .active_profile
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;
        let previous_bindings = active_profile
            .as_ref()
            .map(|profile| profile.bindings.clone())
            .unwrap_or_default();
        *active_profile = Some(AppState::profile_snapshot(profile.clone()));
        previous_bindings
    };

    feedback::reconcile_assign_feedback_outputs(state, &previous_bindings, &profile.bindings);

    if let Ok(mut values) = state.binding_action_values.lock() {
        values.clear();
    }

    if let Ok(mut settings) = state.osd_settings.lock() {
        *settings = profile.osd_settings.clone();
        let updated_osd_settings = settings.clone();
        drop(settings);
        crate::AppState::apply_osd_settings(app, &updated_osd_settings);
        crate::osd_window::emit_osd_settings_update(app, &updated_osd_settings);
    }

    state.sync_feedback_values(profile);
    if restore {
        state.sync_feedback_values(profile);
    }
    state.send_idle_button_light_feedback_values(profile);
    Ok(())
}

#[tauri::command]
pub fn list_profiles(state: State<AppState>) -> Result<Vec<ProfileSummary>, String> {
    state
        .profile_store
        .list_profiles()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn load_profile(
    app: AppHandle,
    state: State<AppState>,
    name: String,
    capture_current: Option<bool>,
) -> Result<Profile, String> {
    if capture_current.unwrap_or(true) {
        crate::solo::reset_for_profile(&app, &state)?;
        let previous = state
            .active_profile
            .lock()
            .map_err(|_| "Lock poisoned")?
            .clone();
        if let Some(previous) = previous {
            state.sync_feedback_values(&previous);
            crate::profile_target_state::checkpoint(&state)?;
        }
    }
    let mut profile = state
        .profile_store
        .load_profile(&name)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Profile not found".to_string())?;

    let bindings_changed = profile.normalize_bindings();
    let midi_preference_changed = normalize_profile_midi_preference(&mut profile);

    if heal_legacy_osd_monitor_id(&app, &mut profile) {
        state
            .profile_store
            .save_profile(profile.clone())
            .map_err(|err| err.to_string())?;
    } else if bindings_changed || midi_preference_changed {
        state
            .profile_store
            .save_profile(profile.clone())
            .map_err(|err| err.to_string())?;
    }

    set_active_profile_state(&state, &app, &profile, true)?;
    Ok(profile)
}

#[tauri::command]
pub fn save_profile(
    app: AppHandle,
    state: State<AppState>,
    mut profile: Profile,
    activate: Option<bool>,
) -> Result<(), String> {
    profile.normalize_bindings();
    normalize_profile_midi_preference(&mut profile);
    let active = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned")?
        .clone();
    let update_active = activate.unwrap_or(true)
        && active
            .as_ref()
            .map(|active| active.name == profile.name)
            .unwrap_or(true);
    if update_active {
        crate::solo::reset_for_profile(&app, &state)?;
        if let Some(active) = active {
            state.sync_feedback_values(&active);
        }
        state
            .profile_target_state
            .lock()
            .map_err(|_| "Lock poisoned")?
            .include_in(&mut profile);
    }
    state
        .profile_store
        .save_profile(profile.clone())
        .map_err(|err| err.to_string())?;
    if update_active {
        set_active_profile_state(&state, &app, &profile, false)?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_profile(state: State<AppState>, name: String) -> Result<(), String> {
    state
        .profile_store
        .delete_profile(&name)
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_active_profile(state: State<AppState>) -> Result<Option<Profile>, String> {
    let active = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let mut profile = active.as_ref().map(|snapshot| snapshot.profile().clone());
    if let Some(profile) = profile.as_mut() {
        state
            .profile_target_state
            .lock()
            .map_err(|_| "Lock poisoned")?
            .include_in(profile);
    }
    Ok(profile)
}

#[tauri::command]
pub fn checkpoint_profile_state(
    app: AppHandle,
    state: State<AppState>,
    profile_name: String,
    target_states: Vec<crate::model::ProfileTargetState>,
    leave_profile: Option<bool>,
) -> Result<bool, String> {
    let active = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned")?
        .clone();
    if active.as_ref().map(|active| active.name.as_str()) != Some(profile_name.as_str()) {
        return Ok(false);
    }
    if leave_profile.unwrap_or(false) {
        crate::solo::reset_for_profile(&app, &state)?;
        let active = state
            .active_profile
            .lock()
            .map_err(|_| "Lock poisoned")?
            .clone();
        if let Some(active) = active.filter(|active| active.name == profile_name) {
            state.sync_feedback_values(&active);
        }
    }
    if state.solo.is_active() {
        return Ok(false);
    }
    crate::profile_target_state::update_integrations(&state, &profile_name, target_states)?;
    crate::profile_target_state::checkpoint(&state)?;
    Ok(true)
}

#[tauri::command]
pub fn export_current_profile(
    state: State<AppState>,
    profile_name: String,
) -> Result<Option<String>, String> {
    let trimmed_name = profile_name.trim();
    if trimmed_name.is_empty() {
        return Err("Profile name is required".to_string());
    }

    let mut profile = state
        .profile_store
        .load_profile(trimmed_name)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Profile not found".to_string())?;
    profile.normalize_bindings();

    let suggested_file_name = safe_export_file_name(&profile.name);
    let Some(path) = rfd::FileDialog::new()
        .add_filter("JSON", &["json"])
        .set_file_name(&suggested_file_name)
        .save_file()
    else {
        return Ok(None);
    };

    profile.normalize_for_storage();
    let json = serde_json::to_string_pretty(&profile).map_err(|err| err.to_string())?;
    std::fs::write(&path, json).map_err(|err| err.to_string())?;

    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn import_profile_from_file() -> Result<Option<Profile>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file()
    else {
        return Ok(None);
    };

    let data = std::fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let mut profile: Profile =
        serde_json::from_str(&data).map_err(|err| format!("Invalid profile JSON: {}", err))?;
    profile.restore_from_storage();

    profile.name = profile.name.trim().to_string();
    if profile.name.is_empty() {
        return Err("Imported profile is missing a name".to_string());
    }

    profile.normalize_bindings();
    Ok(Some(profile))
}

#[cfg(test)]
mod tests {

    use crate::model::{Binding, ButtonLightBehavior, ButtonLightMode, Profile};

    fn profile_with_button_light_mode(mode: &str) -> Profile {
        let binding: Binding = serde_json::from_value(serde_json::json!({
            "id": "b1",
            "name": "Binding 1",
            "device_id": "midi-dev",
            "control": {
                "channel": 0,
                "controller": 22,
                "msg_type": "Note"
            },
            "control_kind": "Button",
            "targets": ["Master"],
            "action": "ToggleMute",
            "mode": "Absolute",
            "deadzone": 0.0,
            "debounce_ms": 0,
            "button_light_mode": mode
        }))
        .expect("binding");

        Profile {
            name: "Default".to_string(),
            bindings: vec![binding],
            osd_settings: Default::default(),
            plugin_settings: Default::default(),
            midi_device_preference: Default::default(),
            midi_device_preference_set: false,
            target_states: Vec::new(),
        }
    }

    #[test]
    fn normalize_profile_bindings_repairs_unsafe_button_light_mode() {
        let mut profile = profile_with_button_light_mode("InvertState");

        assert!(profile.normalize_bindings());
        assert_eq!(
            profile.bindings[0].button_light_mode,
            ButtonLightMode::Activity
        );
        assert_eq!(
            profile.bindings[0].button_light_behavior,
            ButtonLightBehavior::InvertState
        );
    }
}

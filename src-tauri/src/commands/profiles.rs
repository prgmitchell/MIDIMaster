use crate::{collect_monitor_descriptors, model::Profile, model::ProfileSummary, AppState};
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

fn normalize_profile_bindings(profile: &mut Profile) -> bool {
    let mut changed = false;
    for binding in &mut profile.bindings {
        let before_targets = binding.targets.clone();
        let before_target = binding.target.clone();
        binding.ensure_targets();
        if binding.targets != before_targets || binding.target != before_target {
            changed = true;
        }
    }
    changed
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
) -> Result<Profile, String> {
    let mut profile = state
        .profile_store
        .load_profile(&name)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Profile not found".to_string())?;

    let bindings_changed = normalize_profile_bindings(&mut profile);

    if heal_legacy_osd_monitor_id(&app, &mut profile) {
        state
            .profile_store
            .save_profile(profile.clone())
            .map_err(|err| err.to_string())?;
    } else if bindings_changed {
        state
            .profile_store
            .save_profile(profile.clone())
            .map_err(|err| err.to_string())?;
    }

    *state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned".to_string())? = Some(profile.clone());

    if let Ok(mut settings) = state.osd_settings.lock() {
        *settings = profile.osd_settings.clone();
        crate::AppState::apply_osd_settings(&app, &settings);
    }
    state.sync_feedback_values(&profile);
    Ok(profile)
}

#[tauri::command]
pub fn save_profile(
    app: AppHandle,
    state: State<AppState>,
    mut profile: Profile,
) -> Result<(), String> {
    normalize_profile_bindings(&mut profile);
    state
        .profile_store
        .save_profile(profile.clone())
        .map_err(|err| err.to_string())?;
    *state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned".to_string())? = Some(profile.clone());
    if let Ok(mut settings) = state.osd_settings.lock() {
        *settings = profile.osd_settings.clone();
        crate::AppState::apply_osd_settings(&app, &settings);
    }
    state.sync_feedback_values(&profile);
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
    let mut active = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    if let Some(profile) = active.as_mut() {
        normalize_profile_bindings(profile);
    }
    Ok(active.clone())
}

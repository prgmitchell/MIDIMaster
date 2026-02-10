use crate::{model::Profile, model::ProfileSummary, AppState};
use tauri::{AppHandle, State};

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
    let profile = state
        .profile_store
        .load_profile(&name)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Profile not found".to_string())?;

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
    profile: Profile,
) -> Result<(), String> {
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
    Ok(state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?
        .clone())
}

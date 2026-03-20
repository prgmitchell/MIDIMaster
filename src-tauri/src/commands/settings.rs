use crate::{app_settings::AppSettings, collect_monitor_descriptors, model::OsdSettings, AppState};
use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Clone, Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub stable_id: String,
    pub is_primary: bool,
}

#[tauri::command]
pub fn list_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let monitors = collect_monitor_descriptors(&app)?;
    Ok(monitors
        .iter()
        .map(|monitor| MonitorInfo {
            index: monitor.index,
            name: monitor.friendly_name.clone(),
            stable_id: monitor.stable_id.clone(),
            is_primary: monitor.is_primary,
        })
        .collect())
}

#[tauri::command]
pub fn get_osd_settings(state: State<AppState>) -> Result<OsdSettings, String> {
    state
        .osd_settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Lock poisoned".to_string())
}

#[tauri::command]
pub fn update_osd_settings(
    app: AppHandle,
    state: State<AppState>,
    enabled: bool,
    monitor_index: usize,
    monitor_name: Option<String>,
    monitor_id: Option<String>,
    anchor: String,
) -> Result<(), String> {
    let mut settings = state
        .osd_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.enabled = enabled;
    settings.monitor_index = monitor_index;
    settings.monitor_name = monitor_name;
    settings.monitor_id = monitor_id;
    settings.anchor = anchor;
    let updated = settings.clone();
    drop(settings);

    if let Ok(mut profile_guard) = state.active_profile.lock() {
        if let Some(profile) = profile_guard.as_mut() {
            profile.osd_settings = updated.clone();
            state
                .profile_store
                .save_profile(profile.clone())
                .map_err(|err| err.to_string())?;
        }
    }

    crate::AppState::apply_osd_settings(&app, &updated);
    Ok(())
}

#[tauri::command]
pub fn get_app_settings(state: State<AppState>) -> Result<AppSettings, String> {
    state
        .app_settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Lock poisoned".to_string())
}

#[tauri::command]
pub fn update_app_settings(
    app: AppHandle,
    state: State<AppState>,
    start_with_windows: bool,
    start_in_tray: bool,
    minimize_to_tray: bool,
    exit_to_tray: bool,
) -> Result<(), String> {
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.start_with_windows = start_with_windows;
    settings.start_in_tray = start_in_tray;
    settings.minimize_to_tray = minimize_to_tray;
    settings.exit_to_tray = exit_to_tray;
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    crate::AppState::apply_app_settings(&app, &updated);
    Ok(())
}

#[tauri::command]
pub fn set_theme_preference(state: State<AppState>, theme: String) -> Result<(), String> {
    let normalized = match theme.as_str() {
        "dark" => "dark".to_string(),
        _ => "light".to_string(),
    };

    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.ui_theme = normalized;
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_midi_device_preferences(
    state: State<AppState>,
    input_device_id: String,
    output_device_id: String,
    input_device_name: Option<String>,
    output_device_name: Option<String>,
) -> Result<(), String> {
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.midi_input_device_id = Some(input_device_id);
    settings.midi_output_device_id = Some(output_device_id);
    settings.midi_input_device_name = input_device_name;
    settings.midi_output_device_name = output_device_name;
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_midi_device_preferences(state: State<AppState>) -> Result<(), String> {
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.midi_input_device_id = None;
    settings.midi_output_device_id = None;
    settings.midi_input_device_name = None;
    settings.midi_output_device_name = None;
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_active_profile_preference(
    state: State<AppState>,
    profile_name: String,
) -> Result<(), String> {
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let trimmed = profile_name.trim().to_string();
    settings.active_profile_name = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reset_app_data(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    state
        .profile_store
        .clear_all()
        .map_err(|err| err.to_string())?;
    state
        .app_settings_store
        .clear()
        .map_err(|err| err.to_string())?;

    if let Ok(mut midi) = state.midi.lock() {
        midi.stop();
    }

    if let Ok(mut profile) = state.active_profile.lock() {
        *profile = None;
    }

    if let Ok(mut feedback) = state.feedback_values.lock() {
        feedback.clear();
    }

    if let Ok(mut settings) = state.osd_settings.lock() {
        *settings = OsdSettings::default();
        crate::AppState::apply_osd_settings(&app, &settings);
    }

    if let Ok(mut settings) = state.app_settings.lock() {
        *settings = AppSettings::default();
        crate::AppState::apply_app_settings(&app, &settings);
    }

    Ok(())
}

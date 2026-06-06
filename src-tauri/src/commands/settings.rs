use crate::{
    app_paths::app_data_root_dir,
    app_settings::AppSettings,
    collect_monitor_descriptors,
    model::{MidiDevicePreference, MidiDeviceRoute, OsdSettings},
    run_logger, AppState,
};
use serde::Serialize;
use std::process::Command;
use tauri::{AppHandle, Emitter, State};

const SUPPORTED_LANGUAGE_CODES: &[&str] = &[
    "en", "fr", "es", "de", "it", "pt-BR", "nl", "pl", "ja", "ko", "zh-Hans",
];

#[derive(Clone, Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub stable_id: String,
    pub is_primary: bool,
}

#[derive(Clone, Serialize)]
pub struct PickExecutableResult {
    pub path: String,
    pub display: String,
    pub icon_data: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct PickAutoHotkeyScriptResult {
    pub path: String,
    pub display: String,
}

#[tauri::command]
pub fn frontend_log(level: String, component: String, event: String, details: String) {
    const MAX_DETAILS_LEN: usize = 4096;
    let component = capped_field(&component, 64);
    let event = capped_field(&event, 96);
    let details = capped_field(&details, MAX_DETAILS_LEN);
    match level.trim().to_ascii_lowercase().as_str() {
        "debug" => run_logger::debug(&component, &event, &details),
        "warn" | "warning" => run_logger::warn(&component, &event, &details),
        "error" => run_logger::error(&component, &event, &details),
        _ => run_logger::info(&component, &event, &details),
    }
}

fn capped_field(value: &str, max_chars: usize) -> String {
    let mut output: String = value.chars().take(max_chars).collect();
    if value.chars().count() > max_chars {
        output.push_str("...");
    }
    output
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
#[allow(clippy::too_many_arguments)]
pub fn update_osd_settings(
    app: AppHandle,
    state: State<AppState>,
    enabled: bool,
    monitor_index: usize,
    monitor_name: Option<String>,
    monitor_id: Option<String>,
    anchor: String,
    style: Option<String>,
    opacity: Option<f64>,
    scale: Option<f64>,
) -> Result<(), String> {
    let next_style = normalize_osd_style(style.as_deref());
    let next_opacity = opacity.unwrap_or(0.96).clamp(0.35, 1.0);
    let next_scale = scale.unwrap_or(1.0).clamp(0.75, 1.5);
    run_logger::info(
        "settings",
        "update_osd_settings",
        &format!(
            "enabled={} monitor_index={} monitor_name={} monitor_id={} anchor={} style={} opacity={} scale={}",
            enabled,
            monitor_index,
            monitor_name.as_deref().unwrap_or(""),
            monitor_id.as_deref().unwrap_or(""),
            anchor,
            next_style,
            next_opacity,
            next_scale
        ),
    );
    let mut settings = state
        .osd_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.enabled = enabled;
    settings.monitor_index = monitor_index;
    settings.monitor_name = monitor_name;
    settings.monitor_id = monitor_id;
    settings.anchor = anchor;
    settings.style = next_style;
    settings.opacity = next_opacity;
    settings.scale = next_scale;
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
    let _ = app.emit(
        "osd_settings_update",
        serde_json::json!({
            "enabled": updated.enabled,
            "monitor_index": updated.monitor_index,
            "monitor_name": updated.monitor_name,
            "monitor_id": updated.monitor_id,
            "anchor": updated.anchor,
            "style": updated.style,
            "opacity": updated.opacity,
            "scale": updated.scale,
        }),
    );
    Ok(())
}

fn normalize_osd_style(style: Option<&str>) -> String {
    let normalized = style.unwrap_or("midnight").trim().to_ascii_lowercase();
    match normalized.as_str() {
        "midnight" | "glass" | "neon" | "studio" => normalized,
        _ => "midnight".to_string(),
    }
}

#[tauri::command]
pub fn preview_osd(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let payload = serde_json::json!({
        "target": "Master",
        "volume": 0.5,
        "focus_session": null,
        "binding_id": null,
        "preview": true
    });
    crate::AppState::emit_osd_update(&app, state.inner(), &payload, false);
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
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_app_settings(
    app: AppHandle,
    state: State<AppState>,
    start_with_windows: bool,
    start_in_tray: bool,
    minimize_to_tray: bool,
    exit_to_tray: bool,
    auto_check_updates: bool,
    language: Option<String>,
) -> Result<(), String> {
    let normalized_language = normalize_language(language.as_deref());
    run_logger::info(
        "settings",
        "update_app_settings",
        &format!(
            "start_with_windows={} start_in_tray={} minimize_to_tray={} exit_to_tray={} auto_check_updates={} language={}",
            start_with_windows,
            start_in_tray,
            minimize_to_tray,
            exit_to_tray,
            auto_check_updates,
            normalized_language
        ),
    );
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.start_with_windows = start_with_windows;
    settings.start_in_tray = start_in_tray;
    settings.minimize_to_tray = minimize_to_tray;
    settings.exit_to_tray = exit_to_tray;
    settings.auto_check_updates = auto_check_updates;
    settings.language = normalized_language;
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    crate::AppState::apply_app_settings(&app, &updated);
    Ok(())
}

fn normalize_language(language: Option<&str>) -> String {
    let value = language.unwrap_or("en").trim();
    if SUPPORTED_LANGUAGE_CODES.contains(&value) {
        value.to_string()
    } else {
        "en".to_string()
    }
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
    run_logger::info(
        "settings",
        "set_midi_device_preferences",
        &format!(
            "input_id={} output_id={} input_name={} output_name={}",
            input_device_id,
            output_device_id,
            input_device_name.as_deref().unwrap_or(""),
            output_device_name.as_deref().unwrap_or("")
        ),
    );
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.midi_input_device_id = Some(input_device_id);
    settings.midi_output_device_id = Some(output_device_id);
    settings.midi_input_device_name = input_device_name;
    settings.midi_output_device_name = output_device_name;
    settings.midi_device_routes = settings.normalized_midi_routes();
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    if let Ok(mut profile_guard) = state.active_profile.lock() {
        if let Some(profile) = profile_guard.as_mut() {
            profile.midi_device_preference = MidiDevicePreference {
                input_device_id: updated.midi_input_device_id.clone(),
                output_device_id: updated.midi_output_device_id.clone(),
                input_device_name: updated.midi_input_device_name.clone(),
                output_device_name: updated.midi_output_device_name.clone(),
                routes: updated.midi_device_routes.clone(),
            };
            profile.midi_device_preference_set = true;
            state
                .profile_store
                .save_profile(profile.clone())
                .map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn set_midi_device_routes(
    state: State<AppState>,
    routes: Vec<MidiDeviceRoute>,
) -> Result<(), String> {
    let normalized = crate::model::normalized_routes_with_legacy(&routes, None, None, None, None);
    run_logger::info(
        "settings",
        "set_midi_device_routes",
        &format!("route_count={}", normalized.len()),
    );
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.midi_device_routes = normalized.clone();
    if let Some(first) = normalized.first() {
        settings.midi_input_device_id = first.input_device_id.clone();
        settings.midi_output_device_id = first.output_device_id.clone();
        settings.midi_input_device_name = first.input_device_name.clone();
        settings.midi_output_device_name = first.output_device_name.clone();
    } else {
        settings.midi_input_device_id = None;
        settings.midi_output_device_id = None;
        settings.midi_input_device_name = None;
        settings.midi_output_device_name = None;
    }
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    if let Ok(mut profile_guard) = state.active_profile.lock() {
        if let Some(profile) = profile_guard.as_mut() {
            profile.midi_device_preference = MidiDevicePreference {
                input_device_id: updated.midi_input_device_id.clone(),
                output_device_id: updated.midi_output_device_id.clone(),
                input_device_name: updated.midi_input_device_name.clone(),
                output_device_name: updated.midi_output_device_name.clone(),
                routes: normalized,
            };
            profile.midi_device_preference_set = true;
            state
                .profile_store
                .save_profile(profile.clone())
                .map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn clear_midi_device_preferences(state: State<AppState>) -> Result<(), String> {
    run_logger::info("settings", "clear_midi_device_preferences", "");
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.midi_input_device_id = None;
    settings.midi_output_device_id = None;
    settings.midi_input_device_name = None;
    settings.midi_output_device_name = None;
    settings.midi_device_routes = Vec::new();
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    if let Ok(mut profile_guard) = state.active_profile.lock() {
        if let Some(profile) = profile_guard.as_mut() {
            profile.midi_device_preference = MidiDevicePreference::default();
            profile.midi_device_preference_set = true;
            state
                .profile_store
                .save_profile(profile.clone())
                .map_err(|err| err.to_string())?;
        }
    }
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
    run_logger::warn("settings", "reset_app_data_requested", "");
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
    if let Ok(mut values) = state.binding_action_values.lock() {
        values.clear();
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

#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Result<String, String> {
    let config_dir = app_data_root_dir(&app)?;
    let logs_dir = crate::run_logger::logs_dir_from_app_data(&config_dir);
    std::fs::create_dir_all(&logs_dir).map_err(|err| err.to_string())?;

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&logs_dir)
            .spawn()
            .map_err(|err| err.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let msg = "Open logs folder is currently supported only on Windows".to_string();
        run_logger::warn("settings", "open_logs_folder_unsupported", &msg);
        return Err(msg);
    }

    let path = logs_dir.display().to_string();
    run_logger::info("settings", "open_logs_folder", &format!("path={}", path));
    Ok(path)
}

#[tauri::command]
pub fn pick_executable_path() -> Result<Option<PickExecutableResult>, String> {
    #[cfg(target_os = "windows")]
    {
        let picked = rfd::FileDialog::new()
            .add_filter("Applications", &["exe"])
            .pick_file();
        let Some(path) = picked else {
            return Ok(None);
        };

        if !path.is_file() {
            return Err("Selected path is not a file".to_string());
        }

        let ext_ok = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
        if !ext_ok {
            return Err("Selected file must be a .exe".to_string());
        }

        let path_string = path.to_string_lossy().to_string();
        let display = path
            .file_stem()
            .and_then(|name| name.to_str())
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| path_string.clone());

        let icon_data = crate::audio::windows::extract_executable_icon_base64(&path_string);

        Ok(Some(PickExecutableResult {
            path: path_string,
            display,
            icon_data,
        }))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Open Application is currently supported only on Windows".to_string())
    }
}

#[tauri::command]
pub fn pick_autohotkey_script_path() -> Result<Option<PickAutoHotkeyScriptResult>, String> {
    #[cfg(target_os = "windows")]
    {
        let picked = rfd::FileDialog::new()
            .add_filter("AutoHotkey Scripts", &["ahk"])
            .pick_file();
        let Some(path) = picked else {
            return Ok(None);
        };

        if !path.is_file() {
            return Err("Selected path is not a file".to_string());
        }

        let ext_ok = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("ahk"))
            .unwrap_or(false);
        if !ext_ok {
            return Err("Selected file must be a .ahk script".to_string());
        }

        let path_string = path.to_string_lossy().to_string();
        let display = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| path_string.clone());

        Ok(Some(PickAutoHotkeyScriptResult {
            path: path_string,
            display,
        }))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("AutoHotkey Script is currently supported only on Windows".to_string())
    }
}

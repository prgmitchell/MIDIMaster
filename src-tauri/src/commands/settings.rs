use crate::{
    app_paths::app_data_root_dir, app_settings::AppSettings, collect_monitor_descriptors,
    model::OsdSettings, run_logger, AppState,
};
use serde::Serialize;
use serde_json::Value;
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager, State};

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
    run_logger::info(
        "settings",
        "update_osd_settings",
        &format!(
            "enabled={} monitor_index={} monitor_name={} monitor_id={} anchor={}",
            enabled,
            monitor_index,
            monitor_name.as_deref().unwrap_or(""),
            monitor_id.as_deref().unwrap_or(""),
            anchor
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

fn is_mute_action(action: &str) -> bool {
    matches!(
        action.to_ascii_lowercase().as_str(),
        "togglemute" | "toggle_mute" | "mute" | "unmute"
    )
}

#[tauri::command]
pub fn plugin_show_osd(
    app: AppHandle,
    state: State<AppState>,
    target: Value,
    action: String,
    volume: Option<f64>,
    muted: Option<bool>,
    focus_session: Option<Value>,
    show_bar: Option<bool>,
    show_value: Option<bool>,
) -> Result<(), String> {
    let mut payload = serde_json::json!({ "target": target });
    if is_mute_action(&action) {
        payload["action"] = Value::from("toggle_mute");
        payload["muted"] = Value::from(muted.unwrap_or(false));
    } else {
        let clamped = volume.unwrap_or(0.0).clamp(0.0, 1.0);
        payload["volume"] = Value::from(clamped);
    }
    if let Some(session) = focus_session {
        payload["focus_session"] = session;
    }
    if let Some(flag) = show_bar {
        payload["show_bar"] = Value::from(flag);
    }
    if let Some(flag) = show_value {
        payload["show_value"] = Value::from(flag);
    }

    let settings_enabled = state
        .osd_settings
        .lock()
        .map(|settings| settings.enabled)
        .unwrap_or(true);

    let _ = app.emit("plugin_osd", payload.clone());

    if settings_enabled {
        if let Some(osd_window) = app.get_webview_window("osd") {
            let _ = osd_window.show();
            let _ = osd_window.set_always_on_top(true);
            #[cfg(target_os = "windows")]
            if let Ok(hwnd) = osd_window.hwnd() {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::WindowsAndMessaging::{
                    SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
                };
                unsafe {
                    let _ = SetWindowPos(
                        HWND(hwnd.0 as _),
                        Some(HWND_TOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE,
                    );
                }
            }
            let _ = osd_window.emit("plugin_osd", payload.clone());
            if let Ok(payload_json) = serde_json::to_string(&payload) {
                let script = format!(
                    "window.__OSD_UPDATE__ && window.__OSD_UPDATE__({});",
                    payload_json
                );
                let _ = osd_window.eval(&script);
            }
        }
    }

    run_logger::debug(
        "plugins",
        "plugin_show_osd",
        &format!("action={} payload={}", action, payload),
    );
    Ok(())
}

#[tauri::command]
pub fn plugin_hide_osd(app: AppHandle) -> Result<(), String> {
    let _ = app.emit("plugin_osd_hide", ());
    if let Some(osd_window) = app.get_webview_window("osd") {
        let _ = osd_window.emit("plugin_osd_hide", ());
        let _ = osd_window.eval("window.__OSD_HIDE__ && window.__OSD_HIDE__();");
    }
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
pub fn update_app_settings(
    app: AppHandle,
    state: State<AppState>,
    start_with_windows: bool,
    start_in_tray: bool,
    minimize_to_tray: bool,
    exit_to_tray: bool,
    auto_check_updates: bool,
) -> Result<(), String> {
    run_logger::info(
        "settings",
        "update_app_settings",
        &format!(
            "start_with_windows={} start_in_tray={} minimize_to_tray={} exit_to_tray={} auto_check_updates={}",
            start_with_windows, start_in_tray, minimize_to_tray, exit_to_tray, auto_check_updates
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
    run_logger::info("settings", "clear_midi_device_preferences", "");
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

        return Ok(Some(PickExecutableResult {
            path: path_string,
            display,
            icon_data,
        }));
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Open Application is currently supported only on Windows".to_string())
    }
}

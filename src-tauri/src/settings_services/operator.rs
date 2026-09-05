use super::*;

pub fn reset_app_data(app: AppHandle, state: &AppState) -> Result<(), String> {
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
        let _ = crate::windows_autostart::set_windows_autostart(false);
        *settings = AppSettings::default();
        crate::AppState::apply_app_settings(&app, &settings);
    }

    Ok(())
}

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

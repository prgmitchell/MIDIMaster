mod operator;
pub use operator::{
    open_logs_folder, pick_autohotkey_script_path, pick_executable_path, reset_app_data,
};
mod appearance;
pub use appearance::{
    export_appearance_theme, import_appearance_theme, update_appearance_settings,
    update_fader_curve_presets,
};
mod preferences;
use preferences::*;
mod osd;
pub use osd::{get_osd_settings, list_monitors, preview_osd, update_osd_settings};

mod normalization;
use crate::{
    app_paths::app_data_root_dir,
    app_settings::{
        AppAppearanceSettings, AppSettings, AppearanceTheme, FaderCurvePreset,
        MidiDeviceInventoryConsent, CURRENT_STARTUP_REGISTRATION_VERSION,
    },
    collect_monitor_descriptors,
    durable_json_store::StorageRecoveryNotice,
    model::{FaderCurvePoint, MidiDevicePreference, MidiDeviceRoute, OsdSettings},
    run_logger, AppState,
};
use normalization::*;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, process::Command};
use tauri::AppHandle;

const SUPPORTED_LANGUAGE_CODES: &[&str] = &[
    "en", "fr", "es", "de", "it", "pt-BR", "nl", "pl", "ja", "ko", "zh-Hans",
];
const APPEARANCE_THEME_FILE_KIND: &str = "midimaster.appearance.theme.v1";
const BUILT_IN_APPEARANCE_IDS: &[&str] = &[
    "system", "dark", "light", "midnight", "ocean", "forest", "sunset",
];
const SUPPORTED_FONT_FAMILIES: &[&str] = &["bahnschrift", "aptos", "segoe", "inter", "mono"];
const SUPPORTED_TEXT_RENDERING: &[&str] = &["auto", "legibility", "geometric", "speed"];
const MAX_FADER_CURVE_PRESETS: usize = 50;
const ALLOWED_APPEARANCE_TOKEN_KEYS: &[&str] = &[
    "--app-bg",
    "--sidebar-bg",
    "--topbar-bg",
    "--surface",
    "--surface-raised",
    "--surface-muted",
    "--surface-subtle",
    "--control-bg",
    "--control-bg-hover",
    "--control-border",
    "--control-border-intensity",
    "--control-border-strong",
    "--text-primary",
    "--text-primary-intensity",
    "--text-secondary",
    "--text-muted",
    "--theme-tint",
    "--theme-tint-intensity",
    "--icon-color",
    "--icon-color-intensity",
    "--accent",
    "--accent-intensity",
    "--accent-soft",
    "--danger",
    "--danger-soft",
    "--success",
    "--success-soft",
    "--shadow-raised",
    "--chip-bg",
    "--chip-border",
    "--chip-text",
    "--slider-track",
    "--slider-fill",
    "--slider-thumb",
    "--overlay-bg",
    "--accent-strong",
];

#[derive(Clone, Serialize, Deserialize)]
struct AppearanceThemeFile {
    kind: String,
    version: u32,
    theme: AppearanceTheme,
}

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

pub fn get_app_settings(state: &AppState) -> Result<AppSettings, String> {
    state
        .app_settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Lock poisoned".to_string())
}

pub(crate) fn persist_app_settings_update<F>(
    state: &AppState,
    update: F,
) -> Result<AppSettings, String>
where
    F: FnOnce(&mut AppSettings),
{
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let mut updated = settings.clone();
    update(&mut updated);
    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    *settings = updated.clone();
    Ok(updated)
}

pub fn take_storage_recovery_notices(
    state: &AppState,
) -> Result<Vec<StorageRecoveryNotice>, String> {
    let mut notices = state
        .storage_recovery_notices
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    Ok(std::mem::take(&mut *notices))
}

pub fn set_compact_bindings(state: &AppState, compact_bindings: bool) -> Result<bool, String> {
    let updated = persist_app_settings_update(state, |settings| {
        settings.compact_bindings = compact_bindings;
    })?;
    Ok(updated.compact_bindings)
}

pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[allow(clippy::too_many_arguments)]
pub fn update_app_settings(
    app: AppHandle,
    state: &AppState,
    start_with_windows: bool,
    start_in_tray: bool,
    minimize_to_tray: bool,
    exit_to_tray: bool,
    auto_check_updates: bool,
    language: Option<String>,
) -> Result<AppSettings, String> {
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
    let start_with_windows_changed = settings.start_with_windows != start_with_windows;
    let previous_start_with_windows = settings.start_with_windows;
    if start_with_windows_changed {
        crate::windows_autostart::set_windows_autostart(start_with_windows)?;
    }
    let mut updated = settings.clone();
    updated.start_with_windows = start_with_windows;
    if start_with_windows_changed {
        updated.startup_registration_version = CURRENT_STARTUP_REGISTRATION_VERSION;
    }
    updated.start_in_tray = start_in_tray;
    updated.minimize_to_tray = minimize_to_tray;
    updated.exit_to_tray = exit_to_tray;
    updated.auto_check_updates = auto_check_updates;
    updated.language = normalized_language;

    if let Err(error) = state.app_settings_store.save(&updated) {
        if start_with_windows_changed {
            let _ = crate::windows_autostart::set_windows_autostart(previous_start_with_windows);
        }
        return Err(error.to_string());
    }
    *settings = updated.clone();
    drop(settings);
    crate::AppState::apply_app_settings(&app, &updated);
    Ok(updated)
}

pub fn update_midi_device_inventory_consent(
    state: &AppState,
    consent: MidiDeviceInventoryConsent,
    notice_version: Option<u32>,
) -> Result<AppSettings, String> {
    let notice_version =
        notice_version.unwrap_or(crate::telemetry::MIDI_DEVICE_INVENTORY_NOTICE_VERSION);
    run_logger::info(
        "settings",
        "update_midi_device_inventory_consent",
        &format!("consent={:?} notice_version={}", consent, notice_version),
    );
    let updated = persist_app_settings_update(state, |settings| {
        let consent_changed = settings.midi_device_inventory_consent != consent;
        settings.midi_device_inventory_consent = consent;
        settings.midi_device_inventory_notice_version = notice_version;
        if consent_changed {
            settings.midi_device_inventory_last_sent_hash = None;
        }
    })?;
    Ok(updated)
}

pub fn set_theme_preference(state: &AppState, theme: String) -> Result<(), String> {
    let normalized = match theme.as_str() {
        "dark" => "dark".to_string(),
        "system" => "system".to_string(),
        _ => "light".to_string(),
    };

    persist_app_settings_update(state, |settings| {
        settings.ui_theme = normalized.clone();
        settings.appearance.active_theme_id = normalized;
    })?;
    Ok(())
}

pub fn set_midi_device_preferences(
    state: &AppState,
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
    persist_midi_preference_update(state, |settings| {
        settings.midi_input_device_id = Some(input_device_id);
        settings.midi_output_device_id = Some(output_device_id);
        settings.midi_input_device_name = input_device_name;
        settings.midi_output_device_name = output_device_name;
        settings.midi_device_routes = settings.normalized_midi_routes();
    })?;
    Ok(())
}

pub fn set_midi_device_routes(
    state: &AppState,
    routes: Vec<MidiDeviceRoute>,
) -> Result<(), String> {
    let normalized = crate::model::normalized_routes_with_legacy(&routes, None, None, None, None);
    run_logger::info(
        "settings",
        "set_midi_device_routes",
        &format!("route_count={}", normalized.len()),
    );
    persist_midi_preference_update(state, |settings| {
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
    })?;
    Ok(())
}

pub fn clear_midi_device_preferences(state: &AppState) -> Result<(), String> {
    run_logger::info("settings", "clear_midi_device_preferences", "");
    persist_midi_preference_update(state, |settings| {
        settings.midi_input_device_id = None;
        settings.midi_output_device_id = None;
        settings.midi_input_device_name = None;
        settings.midi_output_device_name = None;
        settings.midi_device_routes = Vec::new();
    })?;
    Ok(())
}

pub fn set_active_profile_preference(state: &AppState, profile_name: String) -> Result<(), String> {
    let trimmed = profile_name.trim().to_string();
    persist_app_settings_update(state, |settings| {
        settings.active_profile_name = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
    })?;
    Ok(())
}

#[cfg(test)]
mod tests;

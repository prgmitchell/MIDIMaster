use crate::{
    app_paths::app_data_root_dir,
    app_settings::{
        AppAppearanceSettings, AppSettings, AppearanceTheme, FaderCurvePreset,
        MidiDeviceInventoryConsent, CURRENT_STARTUP_REGISTRATION_VERSION,
    },
    collect_monitor_descriptors,
    model::{FaderCurvePoint, MidiDevicePreference, MidiDeviceRoute, OsdSettings},
    run_logger, AppState,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, process::Command};
use tauri::{AppHandle, State};

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
    crate::osd_window::emit_osd_settings_update(&app, &updated);
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
pub fn set_compact_bindings(
    state: State<AppState>,
    compact_bindings: bool,
) -> Result<bool, String> {
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let mut updated = settings.clone();
    updated.compact_bindings = compact_bindings;

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    settings.compact_bindings = updated.compact_bindings;
    Ok(updated.compact_bindings)
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
    if start_with_windows_changed {
        crate::windows_autostart::set_windows_autostart(start_with_windows)?;
    }
    settings.start_with_windows = start_with_windows;
    if start_with_windows_changed {
        settings.startup_registration_version = CURRENT_STARTUP_REGISTRATION_VERSION;
    }
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
    Ok(updated)
}

#[tauri::command]
pub fn update_midi_device_inventory_consent(
    state: State<AppState>,
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
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let consent_changed = settings.midi_device_inventory_consent != consent;
    settings.midi_device_inventory_consent = consent;
    settings.midi_device_inventory_notice_version = notice_version;
    if consent_changed {
        settings.midi_device_inventory_last_sent_hash = None;
    }
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    Ok(updated)
}

#[tauri::command]
pub fn update_appearance_settings(
    state: State<AppState>,
    appearance: AppAppearanceSettings,
) -> Result<AppAppearanceSettings, String> {
    let normalized = normalize_appearance_settings(appearance)?;
    run_logger::info(
        "settings",
        "update_appearance_settings",
        &format!(
            "active_theme_id={} custom_theme_count={}",
            normalized.active_theme_id,
            normalized.custom_themes.len()
        ),
    );

    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.ui_theme = legacy_theme_for_appearance(&normalized);
    settings.appearance = normalized.clone();
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    Ok(updated.appearance)
}

#[tauri::command]
pub fn update_fader_curve_presets(
    state: State<AppState>,
    presets: Vec<FaderCurvePreset>,
) -> Result<Vec<FaderCurvePreset>, String> {
    let normalized = normalize_fader_curve_presets(presets);
    run_logger::info(
        "settings",
        "update_fader_curve_presets",
        &format!("preset_count={}", normalized.len()),
    );

    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.fader_curve_presets = normalized.clone();
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    Ok(normalized)
}

#[tauri::command]
pub fn export_appearance_theme(theme: AppearanceTheme) -> Result<Option<String>, String> {
    let theme = normalize_appearance_theme(theme)?;
    let file_name = format!("{}.json", safe_file_stem(&theme.name));
    let Some(path) = rfd::FileDialog::new()
        .add_filter("JSON", &["json"])
        .set_file_name(&file_name)
        .save_file()
    else {
        return Ok(None);
    };

    let payload = AppearanceThemeFile {
        kind: APPEARANCE_THEME_FILE_KIND.to_string(),
        version: 1,
        theme,
    };
    let data = serde_json::to_string_pretty(&payload).map_err(|err| err.to_string())?;
    fs::write(&path, data).map_err(|err| err.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub fn import_appearance_theme(
    state: State<AppState>,
) -> Result<Option<AppAppearanceSettings>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file()
    else {
        return Ok(None);
    };

    let data = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let payload: AppearanceThemeFile =
        serde_json::from_str(&data).map_err(|err| err.to_string())?;
    if payload.kind != APPEARANCE_THEME_FILE_KIND || payload.version != 1 {
        return Err("Selected file is not a MIDIMaster appearance theme.".to_string());
    }

    let mut imported = normalize_appearance_theme(payload.theme)?;
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let mut appearance = normalize_appearance_settings(settings.appearance.clone())?;
    imported.name = unique_theme_name(&appearance.custom_themes, &imported.name);
    imported.id = unique_theme_id(&appearance.custom_themes, &imported.name);

    appearance.active_theme_id = imported.id.clone();
    appearance.accent_color = imported.accent_color.clone();
    appearance.color_temperature = imported.color_temperature;
    appearance.corner_radius = imported.corner_radius;
    appearance.animations = imported.animations;
    appearance.background_effects = imported.background_effects;
    appearance.effect_intensity = imported.effect_intensity;
    appearance.surface_contrast = imported.surface_contrast;
    appearance.icon_glow = imported.icon_glow;
    appearance.transparency = imported.transparency;
    appearance.font_family = imported.font_family.clone();
    appearance.font_size = imported.font_size;
    appearance.text_rendering = imported.text_rendering.clone();
    appearance.custom_themes.push(imported);
    let appearance = normalize_appearance_settings(appearance)?;

    settings.ui_theme = legacy_theme_for_appearance(&appearance);
    settings.appearance = appearance.clone();
    let updated = settings.clone();
    drop(settings);

    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    Ok(Some(updated.appearance))
}

fn normalize_language(language: Option<&str>) -> String {
    let value = language.unwrap_or("en").trim();
    if SUPPORTED_LANGUAGE_CODES.contains(&value) {
        value.to_string()
    } else {
        "en".to_string()
    }
}

fn normalize_fader_curve_presets(presets: Vec<FaderCurvePreset>) -> Vec<FaderCurvePreset> {
    let mut output: Vec<FaderCurvePreset> = Vec::new();
    for preset in presets {
        if output.len() >= MAX_FADER_CURVE_PRESETS {
            break;
        }
        let Some(mut normalized) = normalize_fader_curve_preset(preset) else {
            continue;
        };
        normalized.name = unique_curve_preset_name(&output, &normalized.name);
        normalized.id = unique_curve_preset_id(&output, &normalized.id);
        output.push(normalized);
    }
    output
}

fn normalize_fader_curve_preset(mut preset: FaderCurvePreset) -> Option<FaderCurvePreset> {
    preset.name = normalize_curve_preset_name(&preset.name);
    if preset.name.is_empty() {
        return None;
    }
    preset.id = normalize_id(&preset.id, &normalize_id(&preset.name, "curve-preset"));
    preset.points = normalize_curve_preset_points(preset.points);
    if preset.points.len() < 2 {
        return None;
    }
    Some(preset)
}

fn normalize_curve_preset_points(points: Vec<FaderCurvePoint>) -> Vec<FaderCurvePoint> {
    let mut normalized: Vec<FaderCurvePoint> = points
        .into_iter()
        .map(|point| FaderCurvePoint {
            x: point.x.clamp(0.0, 1.0),
            y: point.y.clamp(0.0, 1.0),
            curve: point.curve.clamp(-1.0, 1.0),
        })
        .collect();
    normalized.sort_by(|left, right| left.x.total_cmp(&right.x));
    if normalized.len() >= 2 {
        normalized[0].x = 0.0;
        if let Some(last) = normalized.last_mut() {
            last.x = 1.0;
            last.curve = 0.0;
        }
    }
    normalized
}

fn normalize_curve_preset_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .chars()
        .take(64)
        .collect()
}

fn unique_curve_preset_name(existing: &[FaderCurvePreset], candidate: &str) -> String {
    let base = normalize_curve_preset_name(candidate);
    let mut name = base.clone();
    let mut counter = 2;
    while existing
        .iter()
        .any(|preset| preset.name.eq_ignore_ascii_case(&name))
    {
        let suffix = format!(" {}", counter);
        let keep = 64usize.saturating_sub(suffix.chars().count()).max(1);
        name = format!("{}{}", base.chars().take(keep).collect::<String>(), suffix);
        counter += 1;
    }
    name
}

fn unique_curve_preset_id(existing: &[FaderCurvePreset], candidate: &str) -> String {
    let base = normalize_id(candidate, "curve-preset");
    let mut id = base.clone();
    let mut counter = 2;
    while existing.iter().any(|preset| preset.id == id) {
        let suffix = format!("-{}", counter);
        let keep = 64usize.saturating_sub(suffix.chars().count()).max(1);
        id = format!("{}{}", base.chars().take(keep).collect::<String>(), suffix);
        counter += 1;
    }
    id
}

fn normalize_appearance_settings(
    mut appearance: AppAppearanceSettings,
) -> Result<AppAppearanceSettings, String> {
    appearance.active_theme_id = normalize_id(&appearance.active_theme_id, "system");
    appearance.accent_color = normalize_hex_color(&appearance.accent_color, "#5aa7ff");
    appearance.color_temperature = appearance.color_temperature.clamp(0.0, 100.0);
    appearance.corner_radius = appearance.corner_radius.clamp(0.0, 16.0);
    appearance.effect_intensity = appearance.effect_intensity.clamp(0.0, 100.0);
    appearance.surface_contrast = appearance.surface_contrast.clamp(0.0, 100.0);
    appearance.icon_glow = appearance.icon_glow.clamp(0.0, 100.0);
    appearance.transparency = appearance.transparency.clamp(0.0, 80.0);
    appearance.font_family = normalize_choice(
        &appearance.font_family,
        SUPPORTED_FONT_FAMILIES,
        "bahnschrift",
    );
    appearance.font_size = appearance.font_size.clamp(11.0, 18.0);
    appearance.text_rendering =
        normalize_choice(&appearance.text_rendering, SUPPORTED_TEXT_RENDERING, "auto");
    appearance.tokens = normalize_appearance_tokens(appearance.tokens)?;

    let mut custom_themes = Vec::new();
    for theme in appearance.custom_themes {
        let normalized = normalize_appearance_theme(theme)?;
        if !custom_themes
            .iter()
            .any(|existing: &AppearanceTheme| existing.id == normalized.id)
        {
            custom_themes.push(normalized);
        }
    }
    let has_active_custom = custom_themes
        .iter()
        .any(|theme| theme.id == appearance.active_theme_id);
    if !BUILT_IN_APPEARANCE_IDS.contains(&appearance.active_theme_id.as_str()) && !has_active_custom
    {
        appearance.active_theme_id = "system".to_string();
    }
    appearance.custom_themes = custom_themes;
    Ok(appearance)
}

fn normalize_appearance_theme(mut theme: AppearanceTheme) -> Result<AppearanceTheme, String> {
    theme.id = normalize_id(&theme.id, "custom-theme");
    if BUILT_IN_APPEARANCE_IDS.contains(&theme.id.as_str()) {
        theme.id = format!("custom-{}", theme.id);
    }
    theme.name = normalize_theme_name(&theme.name);
    theme.scheme = normalize_choice(&theme.scheme, &["dark", "light"], "dark");
    theme.base_preset_id = normalize_id(&theme.base_preset_id, &theme.scheme);
    theme.accent_color = normalize_hex_color(
        &theme.accent_color,
        if theme.scheme == "light" {
            "#2f78d4"
        } else {
            "#5aa7ff"
        },
    );
    theme.color_temperature = theme.color_temperature.clamp(0.0, 100.0);
    theme.corner_radius = theme.corner_radius.clamp(0.0, 16.0);
    theme.effect_intensity = theme.effect_intensity.clamp(0.0, 100.0);
    theme.surface_contrast = theme.surface_contrast.clamp(0.0, 100.0);
    theme.icon_glow = theme.icon_glow.clamp(0.0, 100.0);
    theme.transparency = theme.transparency.clamp(0.0, 80.0);
    theme.font_family =
        normalize_choice(&theme.font_family, SUPPORTED_FONT_FAMILIES, "bahnschrift");
    theme.font_size = theme.font_size.clamp(11.0, 18.0);
    theme.text_rendering =
        normalize_choice(&theme.text_rendering, SUPPORTED_TEXT_RENDERING, "auto");
    theme.tokens = normalize_appearance_tokens(theme.tokens)?;
    Ok(theme)
}

fn normalize_appearance_tokens(
    tokens: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut safe_tokens = BTreeMap::new();
    for (key, value) in tokens {
        let key = key.trim().to_string();
        let value = value.trim().to_string();
        if !ALLOWED_APPEARANCE_TOKEN_KEYS.contains(&key.as_str()) {
            return Err(format!("Theme token is not supported: {}", key));
        }
        if !is_safe_token_value(&key, &value) {
            return Err(format!("Theme token value is not supported for {}", key));
        }
        safe_tokens.insert(key, value);
    }
    Ok(safe_tokens)
}

fn normalize_id(value: &str, fallback: &str) -> String {
    let mut output = String::new();
    let mut last_dash = false;
    for ch in value.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            output.push(ch);
            last_dash = false;
        } else if (ch == '-' || ch.is_ascii_whitespace()) && !last_dash && !output.is_empty() {
            output.push('-');
            last_dash = true;
        }
    }
    while output.ends_with('-') {
        output.pop();
    }
    if output.is_empty() {
        fallback.to_string()
    } else {
        output.chars().take(64).collect()
    }
}

fn normalize_theme_name(value: &str) -> String {
    let mut output = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    if output.is_empty() {
        output = "Custom Theme".to_string();
    }
    output.chars().take(64).collect()
}

fn normalize_choice(value: &str, allowed: &[&str], fallback: &str) -> String {
    let normalized = value.trim();
    if allowed.contains(&normalized) {
        normalized.to_string()
    } else {
        fallback.to_string()
    }
}

fn normalize_hex_color(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if is_hex_color(trimmed) {
        return trimmed.to_ascii_lowercase();
    }
    fallback.to_string()
}

fn is_hex_color(value: &str) -> bool {
    let Some(hex) = value.strip_prefix('#') else {
        return false;
    };
    hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn is_safe_token_value(key: &str, value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    if value.contains(';')
        || value.contains('{')
        || value.contains('}')
        || value.contains('<')
        || value.contains('>')
        || value.contains('\n')
        || value.contains('\r')
        || value.to_ascii_lowercase().contains("url(")
    {
        return false;
    }
    if key.ends_with("-intensity") {
        return value
            .parse::<f64>()
            .map(|number| (0.0..=100.0).contains(&number))
            .unwrap_or(false);
    }
    is_hex_color(value)
        || value.starts_with("rgb(")
        || value.starts_with("rgba(")
        || value.starts_with("hsl(")
        || value.starts_with("hsla(")
        || value.starts_with("color-mix(")
}

fn legacy_theme_for_appearance(appearance: &AppAppearanceSettings) -> String {
    match appearance.active_theme_id.as_str() {
        "light" => "light".to_string(),
        "system" => "system".to_string(),
        _ => "dark".to_string(),
    }
}

fn safe_file_stem(name: &str) -> String {
    let normalized = normalize_id(name, "midimaster-theme");
    if normalized.is_empty() {
        "midimaster-theme".to_string()
    } else {
        normalized
    }
}

fn unique_theme_name(existing: &[AppearanceTheme], desired: &str) -> String {
    let base = normalize_theme_name(desired);
    let names = existing
        .iter()
        .map(|theme| theme.name.to_ascii_lowercase())
        .collect::<std::collections::HashSet<_>>();
    if !names.contains(&base.to_ascii_lowercase()) {
        return base;
    }
    for index in 2..1000 {
        let candidate = format!("{} {}", base, index);
        if !names.contains(&candidate.to_ascii_lowercase()) {
            return candidate;
        }
    }
    format!("{} {}", base, existing.len() + 1)
}

fn unique_theme_id(existing: &[AppearanceTheme], name: &str) -> String {
    let base = normalize_id(name, "custom-theme");
    let ids = existing
        .iter()
        .map(|theme| theme.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let mut candidate = base.clone();
    let mut index = 2;
    while BUILT_IN_APPEARANCE_IDS.contains(&candidate.as_str()) || ids.contains(&candidate) {
        candidate = format!("{}-{}", base, index);
        index += 1;
    }
    candidate
}

#[tauri::command]
pub fn set_theme_preference(state: State<AppState>, theme: String) -> Result<(), String> {
    let normalized = match theme.as_str() {
        "dark" => "dark".to_string(),
        "system" => "system".to_string(),
        _ => "light".to_string(),
    };

    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.ui_theme = normalized.clone();
    settings.appearance.active_theme_id = normalized;
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
        let _ = crate::windows_autostart::set_windows_autostart(false);
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

#[cfg(test)]
mod tests {
    use super::{normalize_appearance_settings, normalize_fader_curve_presets};
    use crate::{
        app_settings::{AppAppearanceSettings, AppearanceTheme, FaderCurvePreset},
        model::FaderCurvePoint,
    };

    #[test]
    fn appearance_surface_contrast_and_icon_glow_are_clamped() {
        let mut appearance = AppAppearanceSettings {
            surface_contrast: 125.0,
            icon_glow: -20.0,
            ..AppAppearanceSettings::default()
        };
        appearance.custom_themes.push(AppearanceTheme {
            surface_contrast: -10.0,
            icon_glow: 140.0,
            ..AppearanceTheme::default()
        });

        let normalized = normalize_appearance_settings(appearance).expect("normalize appearance");

        assert_eq!(normalized.surface_contrast, 100.0);
        assert_eq!(normalized.icon_glow, 0.0);
        assert_eq!(normalized.custom_themes[0].surface_contrast, 0.0);
        assert_eq!(normalized.custom_themes[0].icon_glow, 100.0);
    }

    #[test]
    fn fader_curve_presets_are_normalized() {
        let presets = normalize_fader_curve_presets(vec![
            FaderCurvePreset {
                id: "Drums Ride".to_string(),
                name: "  Drums   Ride  ".to_string(),
                points: vec![
                    FaderCurvePoint {
                        x: 1.2,
                        y: -1.0,
                        curve: 2.0,
                    },
                    FaderCurvePoint {
                        x: 0.4,
                        y: 0.8,
                        curve: -0.4,
                    },
                    FaderCurvePoint {
                        x: -0.2,
                        y: 2.0,
                        curve: 0.25,
                    },
                ],
            },
            FaderCurvePreset {
                id: "Drums Ride".to_string(),
                name: "Drums Ride".to_string(),
                points: vec![
                    FaderCurvePoint {
                        x: 0.0,
                        y: 0.0,
                        curve: 0.0,
                    },
                    FaderCurvePoint {
                        x: 1.0,
                        y: 1.0,
                        curve: 0.0,
                    },
                ],
            },
            FaderCurvePreset {
                id: "ignored".to_string(),
                name: "   ".to_string(),
                points: vec![
                    FaderCurvePoint {
                        x: 0.0,
                        y: 0.0,
                        curve: 0.0,
                    },
                    FaderCurvePoint {
                        x: 1.0,
                        y: 1.0,
                        curve: 0.0,
                    },
                ],
            },
        ]);

        assert_eq!(presets.len(), 2);
        assert_eq!(presets[0].id, "drums-ride");
        assert_eq!(presets[0].name, "Drums Ride");
        assert_eq!(presets[0].points[0].x, 0.0);
        assert_eq!(presets[0].points[0].y, 1.0);
        assert_eq!(presets[0].points[0].curve, 0.25);
        assert_eq!(presets[0].points[1].curve, -0.4);
        assert_eq!(presets[0].points[2].x, 1.0);
        assert_eq!(presets[0].points[2].y, 0.0);
        assert_eq!(presets[0].points[2].curve, 0.0);
        assert_eq!(presets[1].id, "drums-ride-2");
        assert_eq!(presets[1].name, "Drums Ride 2");
    }

    #[test]
    fn fader_curve_presets_are_capped() {
        let presets = normalize_fader_curve_presets(
            (0..55)
                .map(|index| FaderCurvePreset {
                    id: format!("curve-{index}"),
                    name: format!("Curve {index}"),
                    points: vec![
                        FaderCurvePoint {
                            x: 0.0,
                            y: 0.0,
                            curve: 0.0,
                        },
                        FaderCurvePoint {
                            x: 1.0,
                            y: 1.0,
                            curve: 0.0,
                        },
                    ],
                })
                .collect(),
        );

        assert_eq!(presets.len(), 50);
    }
}

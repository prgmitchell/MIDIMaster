use super::*;

pub fn update_appearance_settings(
    state: &AppState,
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

    let updated = persist_app_settings_update(state, |settings| {
        settings.ui_theme = legacy_theme_for_appearance(&normalized);
        settings.appearance = normalized.clone();
    })?;
    Ok(updated.appearance)
}

pub fn update_fader_curve_presets(
    state: &AppState,
    presets: Vec<FaderCurvePreset>,
) -> Result<Vec<FaderCurvePreset>, String> {
    let normalized = normalize_fader_curve_presets(presets);
    run_logger::info(
        "settings",
        "update_fader_curve_presets",
        &format!("preset_count={}", normalized.len()),
    );

    persist_app_settings_update(state, |settings| {
        settings.fader_curve_presets = normalized.clone();
    })?;
    Ok(normalized)
}

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

pub fn import_appearance_theme(state: &AppState) -> Result<Option<AppAppearanceSettings>, String> {
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
    let mut updated = settings.clone();
    let mut appearance = normalize_appearance_settings(updated.appearance.clone())?;
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

    updated.ui_theme = legacy_theme_for_appearance(&appearance);
    updated.appearance = appearance.clone();
    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;
    *settings = updated.clone();
    Ok(Some(updated.appearance))
}

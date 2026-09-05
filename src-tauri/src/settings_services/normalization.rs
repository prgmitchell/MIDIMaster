use super::*;

pub(super) fn normalize_language(language: Option<&str>) -> String {
    let value = language.unwrap_or("en").trim();
    if SUPPORTED_LANGUAGE_CODES.contains(&value) {
        value.to_string()
    } else {
        "en".to_string()
    }
}

pub(super) fn normalize_fader_curve_presets(
    presets: Vec<FaderCurvePreset>,
) -> Vec<FaderCurvePreset> {
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

pub(super) fn normalize_fader_curve_preset(
    mut preset: FaderCurvePreset,
) -> Option<FaderCurvePreset> {
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

pub(super) fn normalize_curve_preset_points(points: Vec<FaderCurvePoint>) -> Vec<FaderCurvePoint> {
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

pub(super) fn normalize_curve_preset_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .chars()
        .take(64)
        .collect()
}

pub(super) fn unique_curve_preset_name(existing: &[FaderCurvePreset], candidate: &str) -> String {
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

pub(super) fn unique_curve_preset_id(existing: &[FaderCurvePreset], candidate: &str) -> String {
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

pub(super) fn normalize_appearance_settings(
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

pub(super) fn normalize_appearance_theme(
    mut theme: AppearanceTheme,
) -> Result<AppearanceTheme, String> {
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

pub(super) fn normalize_appearance_tokens(
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

pub(super) fn normalize_id(value: &str, fallback: &str) -> String {
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

pub(super) fn normalize_theme_name(value: &str) -> String {
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

pub(super) fn normalize_choice(value: &str, allowed: &[&str], fallback: &str) -> String {
    let normalized = value.trim();
    if allowed.contains(&normalized) {
        normalized.to_string()
    } else {
        fallback.to_string()
    }
}

pub(super) fn normalize_hex_color(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if is_hex_color(trimmed) {
        return trimmed.to_ascii_lowercase();
    }
    fallback.to_string()
}

pub(super) fn is_hex_color(value: &str) -> bool {
    let Some(hex) = value.strip_prefix('#') else {
        return false;
    };
    hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit())
}

pub(super) fn is_safe_token_value(key: &str, value: &str) -> bool {
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

pub(super) fn legacy_theme_for_appearance(appearance: &AppAppearanceSettings) -> String {
    match appearance.active_theme_id.as_str() {
        "light" => "light".to_string(),
        "system" => "system".to_string(),
        _ => "dark".to_string(),
    }
}

pub(super) fn safe_file_stem(name: &str) -> String {
    let normalized = normalize_id(name, "midimaster-theme");
    if normalized.is_empty() {
        "midimaster-theme".to_string()
    } else {
        normalized
    }
}

pub(super) fn unique_theme_name(existing: &[AppearanceTheme], desired: &str) -> String {
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

pub(super) fn unique_theme_id(existing: &[AppearanceTheme], name: &str) -> String {
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

use super::*;

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

pub fn get_osd_settings(state: &AppState) -> Result<OsdSettings, String> {
    state
        .osd_settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Lock poisoned".to_string())
}

#[allow(clippy::too_many_arguments)]
pub fn update_osd_settings(
    app: AppHandle,
    state: &AppState,
    enabled: bool,
    monitor_index: usize,
    monitor_name: Option<String>,
    monitor_id: Option<String>,
    anchor: String,
    show_binding_name: bool,
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
            "enabled={} monitor_index={} monitor_name={} monitor_id={} anchor={} show_binding_name={} style={} opacity={} scale={}",
            enabled,
            monitor_index,
            monitor_name.as_deref().unwrap_or(""),
            monitor_id.as_deref().unwrap_or(""),
            anchor,
            show_binding_name,
            next_style,
            next_opacity,
            next_scale
        ),
    );
    let mut profile_guard = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let mut settings = state
        .osd_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let mut updated = settings.clone();
    updated.enabled = enabled;
    updated.monitor_index = monitor_index;
    updated.monitor_name = monitor_name;
    updated.monitor_id = monitor_id;
    updated.anchor = anchor;
    updated.show_binding_name = show_binding_name;
    updated.style = next_style;
    updated.opacity = next_opacity;
    updated.scale = next_scale;

    if let Some(profile) = profile_guard.as_ref() {
        let mut updated_profile = profile.profile().clone();
        updated_profile.osd_settings = updated.clone();
        state
            .profile_store
            .save_profile(updated_profile.clone())
            .map_err(|err| err.to_string())?;
        *profile_guard = Some(AppState::profile_snapshot(updated_profile));
    }
    *settings = updated.clone();
    drop(settings);
    drop(profile_guard);

    crate::AppState::apply_osd_settings(&app, &updated);
    crate::osd_window::emit_osd_settings_update(&app, &updated);
    Ok(())
}

pub(super) fn normalize_osd_style(style: Option<&str>) -> String {
    let normalized = style.unwrap_or("midnight").trim().to_ascii_lowercase();
    match normalized.as_str() {
        "midnight" | "glass" | "neon" | "studio" => normalized,
        _ => "midnight".to_string(),
    }
}

pub fn preview_osd(app: AppHandle, state: &AppState) -> Result<(), String> {
    let payload = serde_json::json!({
        "target": "Master",
        "volume": 0.5,
        "focus_session": null,
        "binding_id": null,
        "preview": true
    });
    crate::AppState::emit_osd_update(&app, state, &payload, false);
    Ok(())
}

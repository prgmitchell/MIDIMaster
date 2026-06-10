use crate::model::OsdSettings;
use crate::monitors::resolve_monitor_for_osd;
use crate::AppState;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};

pub(crate) fn apply_osd_settings(app: &AppHandle, settings: &OsdSettings) {
    apply_osd_settings_if_needed(app, settings, true);
}

#[derive(Default)]
struct OsdWindowCache {
    placement_signature: Option<String>,
    topmost_applied: bool,
}

fn osd_window_cache() -> &'static Mutex<OsdWindowCache> {
    static CACHE: OnceLock<Mutex<OsdWindowCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(OsdWindowCache::default()))
}

fn reset_osd_window_cache() {
    if let Ok(mut cache) = osd_window_cache().lock() {
        cache.placement_signature = None;
        cache.topmost_applied = false;
    }
}

fn apply_osd_settings_if_needed(app: &AppHandle, settings: &OsdSettings, force: bool) {
    let Some(osd_window) = app.get_webview_window("osd") else {
        return;
    };

    if !settings.enabled {
        let _ = osd_window.hide();
        reset_osd_window_cache();
        return;
    }

    let topmost_needed = osd_window_cache()
        .lock()
        .map(|cache| force || !cache.topmost_applied)
        .unwrap_or(true);
    if topmost_needed {
        let _ = osd_window.set_always_on_top(true);
        force_topmost(&osd_window);
        if let Ok(mut cache) = osd_window_cache().lock() {
            cache.topmost_applied = true;
        }
    }

    let selected = resolve_monitor_for_osd(app, settings);
    if let Some(selected) = selected {
        let monitor = selected;
        let scale_factor = monitor.scale_factor();
        let size = monitor.size();
        let position = monitor.position();
        let scale = settings.scale.clamp(0.75, 1.5);
        let monitor_name = monitor.name().map(String::as_str).unwrap_or_default();
        let signature = format!(
            "anchor={} scale={:.3} monitor={} pos={}x{} size={}x{} sf={:.3}",
            settings.anchor,
            scale,
            monitor_name,
            position.x,
            position.y,
            size.width,
            size.height,
            scale_factor
        );
        let placement_needed = osd_window_cache()
            .lock()
            .map(|cache| force || cache.placement_signature.as_deref() != Some(signature.as_str()))
            .unwrap_or(true);
        if !placement_needed {
            return;
        }

        let padding = 24.0;
        let logical_width = size.width as f64 / scale_factor;
        let logical_height = size.height as f64 / scale_factor;
        let origin_x = position.x as f64 / scale_factor;
        let origin_y = position.y as f64 / scale_factor;
        let available_width = (logical_width - (padding * 2.0)).max(1.0);
        let available_height = (logical_height - (padding * 2.0)).max(1.0);
        let width = (320.0 * scale).min(available_width);
        let height = (800.0 * scale).min(available_height);
        let anchor = settings.anchor.as_str();
        let (mut x, mut y) = match anchor {
            "top-left" => (origin_x + padding, origin_y + padding),
            "top-center" => (origin_x + (logical_width - width) / 2.0, origin_y + padding),
            "top-right" => (
                origin_x + logical_width - width - padding,
                origin_y + padding,
            ),
            "center-left" => (
                origin_x + padding,
                origin_y + (logical_height - height) / 2.0,
            ),
            "center" => (
                origin_x + (logical_width - width) / 2.0,
                origin_y + (logical_height - height) / 2.0,
            ),
            "center-right" => (
                origin_x + logical_width - width - padding,
                origin_y + (logical_height - height) / 2.0,
            ),
            "bottom-left" => (
                origin_x + padding,
                origin_y + logical_height - height - padding,
            ),
            "bottom-center" => (
                origin_x + (logical_width - width) / 2.0,
                origin_y + logical_height - height - padding,
            ),
            "bottom-right" => (
                origin_x + logical_width - width - padding,
                origin_y + logical_height - height - padding,
            ),
            _ => (
                origin_x + logical_width - width - padding,
                origin_y + padding,
            ),
        };
        let min_x = origin_x + padding;
        let min_y = origin_y + padding;
        let max_x = (origin_x + logical_width - width - padding).max(min_x);
        let max_y = (origin_y + logical_height - height - padding).max(min_y);
        x = x.clamp(min_x, max_x);
        y = y.clamp(min_y, max_y);
        let _ = osd_window.set_size(LogicalSize::new(width, height));
        let _ = osd_window.set_position(LogicalPosition::new(x, y));
        if let Ok(mut cache) = osd_window_cache().lock() {
            cache.placement_signature = Some(signature);
        }
    } else if force {
        if let Ok(mut cache) = osd_window_cache().lock() {
            cache.placement_signature = None;
        }
    }
}

pub(crate) fn emit_osd_update(
    app: &AppHandle,
    state: &AppState,
    payload: &serde_json::Value,
    silent: bool,
) {
    let settings = state
        .osd_settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_else(|_| OsdSettings::default());

    if !settings.enabled || silent {
        if !settings.enabled {
            if let Some(osd_window) = app.get_webview_window("osd") {
                let _ = osd_window.hide();
            }
        }
        return;
    }

    if let Ok(mut last_update) = state.osd_last_update.lock() {
        *last_update = Some(Instant::now());
    }

    let Some(osd_window) = app.get_webview_window("osd") else {
        return;
    };

    let was_visible = osd_window.is_visible().unwrap_or(false);
    if !was_visible {
        let _ = osd_window.show();
    }
    apply_osd_settings_if_needed(app, &settings, !was_visible);

    let mut osd_payload = payload.clone();
    if let Some(map) = osd_payload.as_object_mut() {
        map.insert("osd_enabled".to_string(), serde_json::Value::Bool(true));
    }

    let event_name =
        if osd_payload.get("action").and_then(|value| value.as_str()) == Some("toggle_mute") {
            "mute_update"
        } else {
            "volume_update"
        };
    let _ = osd_window.emit(event_name, osd_payload.clone());
}

#[cfg(target_os = "windows")]
fn force_topmost(window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
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
}

#[cfg(not(target_os = "windows"))]
fn force_topmost(_window: &tauri::WebviewWindow) {}

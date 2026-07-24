use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub body: Option<String>,
    pub date: Option<String>,
}

#[derive(Clone, Serialize)]
struct UpdateStatusEvent {
    phase: String,
    message: Option<String>,
    current_version: Option<String>,
    version: Option<String>,
    downloaded: Option<u64>,
    content_length: Option<u64>,
}

#[derive(Clone, Serialize)]
struct UpdateNotificationPayload {
    current_version: Option<String>,
    latest_version: String,
}

fn emit_status(app: &AppHandle, event: UpdateStatusEvent) {
    let _ = app.emit("updater_status", event);
}

fn emit_failed(app: &AppHandle, message: String) {
    emit_status(
        app,
        UpdateStatusEvent {
            phase: "failed".to_string(),
            message: Some(message),
            current_version: None,
            version: None,
            downloaded: None,
            content_length: None,
        },
    );
}

fn encode_query_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn show_update_notification_window(
    app: &AppHandle,
    payload: UpdateNotificationPayload,
) -> Result<(), String> {
    if payload.latest_version.trim().is_empty() {
        return Ok(());
    }

    if let Some(window) = app.get_webview_window("update") {
        send_update_notification_payload(&window, &payload);
        let _ = window.unminimize();
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let mut query = format!(
        "update=1&latestVersion={}",
        encode_query_component(payload.latest_version.trim())
    );
    if let Some(current_version) = payload.current_version.as_deref() {
        if !current_version.trim().is_empty() {
            query.push_str("&currentVersion=");
            query.push_str(&encode_query_component(current_version.trim()));
        }
    }
    #[cfg(feature = "perf-audit")]
    query.push_str("&perf-audit=1");

    let window = WebviewWindowBuilder::new(
        app,
        "update",
        WebviewUrl::App(format!("update.html?{query}").into()),
    )
    .title("MIDIMaster Update")
    .inner_size(420.0, 230.0)
    .min_inner_size(420.0, 230.0)
    .resizable(false)
    .maximizable(false)
    .always_on_top(true)
    .focused(false)
    .visible(false)
    .decorations(false)
    .build()
    .map_err(|err| format!("Unable to show update notification: {err}"))?;

    let _ = window.center();
    send_update_notification_payload(&window, &payload);
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

fn send_update_notification_payload(window: &WebviewWindow, payload: &UpdateNotificationPayload) {
    let _ = window.emit("update_notification_payload", payload.clone());
    if let Ok(payload_json) = serde_json::to_string(payload) {
        let script =
            format!("window.__MIDIMASTER_UPDATE_NOTIFICATION__?.setPayload({payload_json});");
        let _ = window.eval(script);
    }
}

#[tauri::command]
// WebviewWindowBuilder must run outside a synchronous command on Windows or the
// runtime event loop can deadlock before the new WebView navigates from about:blank.
pub async fn show_update_notification_window_if_main_hidden(
    app: AppHandle,
    current_version: Option<String>,
    latest_version: String,
) -> Result<bool, String> {
    let should_show_standalone = app
        .get_webview_window("main")
        .map(|window| {
            let hidden = !window.is_visible().unwrap_or(true);
            let minimized = window.is_minimized().unwrap_or(false);
            hidden || minimized
        })
        .unwrap_or(true);

    if !should_show_standalone {
        return Ok(false);
    }

    show_update_notification_window(
        &app,
        UpdateNotificationPayload {
            current_version,
            latest_version,
        },
    )?;
    Ok(true)
}

#[tauri::command]
pub fn close_update_notification_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("update") {
        window
            .hide()
            .map_err(|err| format!("Unable to hide update notification: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn start_update_notification_window_drag(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("update") else {
        return Ok(());
    };
    window
        .start_dragging()
        .map_err(|err| format!("Unable to drag update notification: {err}"))
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    #[cfg(feature = "perf-audit")]
    if crate::perf_audit::network_is_offline() {
        emit_status(
            &app,
            UpdateStatusEvent {
                phase: "offline".to_string(),
                message: Some("Network disabled by the local performance audit.".to_string()),
                current_version: Some(current_version.clone()),
                version: None,
                downloaded: None,
                content_length: None,
            },
        );
        return Ok(UpdateInfo {
            available: false,
            current_version,
            version: None,
            body: None,
            date: None,
        });
    }
    emit_status(
        &app,
        UpdateStatusEvent {
            phase: "checking".to_string(),
            message: None,
            current_version: Some(current_version.clone()),
            version: None,
            downloaded: None,
            content_length: None,
        },
    );

    let updater = app
        .updater_builder()
        .build()
        .map_err(|err| format!("Unable to initialize updater: {err}"))?;

    let update = updater
        .check()
        .await
        .map_err(|err| format!("Update check failed: {err}"))?;

    let Some(update) = update else {
        emit_status(
            &app,
            UpdateStatusEvent {
                phase: "no_update".to_string(),
                message: Some("No update available.".to_string()),
                current_version: Some(current_version.clone()),
                version: Some(current_version.clone()),
                downloaded: None,
                content_length: None,
            },
        );
        return Ok(UpdateInfo {
            available: false,
            current_version,
            version: Some(app.package_info().version.to_string()),
            body: None,
            date: None,
        });
    };

    let latest_version = update.version.clone();
    let date = update.date.map(|value| value.to_string());
    emit_status(
        &app,
        UpdateStatusEvent {
            phase: "available".to_string(),
            message: Some("Update available.".to_string()),
            current_version: Some(current_version.clone()),
            version: Some(latest_version.clone()),
            downloaded: None,
            content_length: None,
        },
    );
    Ok(UpdateInfo {
        available: true,
        current_version,
        version: Some(latest_version),
        body: update.body.clone(),
        date,
    })
}

#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    #[cfg(feature = "perf-audit")]
    if crate::perf_audit::network_is_offline() {
        return Err("Network disabled by the local performance audit".to_string());
    }
    let updater = match app.updater_builder().build() {
        Ok(updater) => updater,
        Err(err) => {
            let message = format!("Unable to initialize updater: {err}");
            emit_failed(&app, message.clone());
            return Err(message);
        }
    };

    let update = match updater.check().await {
        Ok(update) => update,
        Err(err) => {
            let message = format!("Update check failed: {err}");
            emit_failed(&app, message.clone());
            return Err(message);
        }
    };

    let Some(update) = update else {
        return Err("No update available to install.".to_string());
    };

    let version = update.version.clone();
    emit_status(
        &app,
        UpdateStatusEvent {
            phase: "downloading".to_string(),
            message: Some("Downloading update...".to_string()),
            current_version: Some(update.current_version.clone()),
            version: Some(version.clone()),
            downloaded: Some(0),
            content_length: None,
        },
    );

    let mut downloaded_total: u64 = 0;
    let install_result = update
        .download_and_install(
            |chunk_length, content_length| {
                downloaded_total = downloaded_total.saturating_add(chunk_length as u64);
                emit_status(
                    &app,
                    UpdateStatusEvent {
                        phase: "downloading".to_string(),
                        message: None,
                        current_version: None,
                        version: Some(version.clone()),
                        downloaded: Some(downloaded_total),
                        content_length,
                    },
                );
            },
            || {
                emit_status(
                    &app,
                    UpdateStatusEvent {
                        phase: "downloaded".to_string(),
                        message: Some("Update downloaded. Installing...".to_string()),
                        current_version: None,
                        version: Some(version.clone()),
                        downloaded: None,
                        content_length: None,
                    },
                );
            },
        )
        .await;

    if let Err(err) = install_result {
        let message = format!("Failed to download/install update: {err}");
        emit_failed(&app, message.clone());
        return Err(message);
    }

    emit_status(
        &app,
        UpdateStatusEvent {
            phase: "installed".to_string(),
            message: Some("Update installed. Restarting app...".to_string()),
            current_version: None,
            version: Some(version),
            downloaded: None,
            content_length: None,
        },
    );

    crate::run_logger::flush_pending_repeats();
    app.restart();
}

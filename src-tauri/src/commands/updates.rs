use serde::Serialize;
use tauri::{AppHandle, Emitter};
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

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
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

    app.restart();
}

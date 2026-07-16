use crate::model::SoundboardMapping;
use crate::soundboard::{SoundboardAnalysis, SoundboardOutputDevice};
use crate::AppState;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn pick_soundboard_audio(
    state: State<'_, AppState>,
) -> Result<Option<SoundboardAnalysis>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Audio", &["mp3", "wav", "flac", "ogg", "m4a", "mp4", "aac"])
        .pick_file()
    else {
        return Ok(None);
    };
    analyze_path(state, path).await.map(Some)
}

#[tauri::command]
pub async fn analyze_soundboard_audio(
    state: State<'_, AppState>,
    path: String,
) -> Result<SoundboardAnalysis, String> {
    analyze_path(state, PathBuf::from(path)).await
}

async fn analyze_path(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<SoundboardAnalysis, String> {
    let soundboard = state.soundboard.clone();
    tauri::async_runtime::spawn_blocking(move || soundboard.analyze(&path))
        .await
        .map_err(|err| format!("Soundboard analysis task failed: {err}"))?
}

#[tauri::command]
pub async fn preview_soundboard_audio(
    state: State<'_, AppState>,
    mapping: SoundboardMapping,
) -> Result<(), String> {
    let soundboard = state.soundboard.clone();
    tauri::async_runtime::spawn_blocking(move || soundboard.play_preview(&mapping))
        .await
        .map_err(|err| format!("Soundboard preview task failed: {err}"))?
}

#[tauri::command]
pub async fn list_soundboard_output_devices() -> Result<Vec<SoundboardOutputDevice>, String> {
    tauri::async_runtime::spawn_blocking(crate::soundboard::SoundboardService::output_devices)
        .await
        .map_err(|err| format!("Soundboard device-list task failed: {err}"))?
}

#[tauri::command]
pub fn set_soundboard_preview_volume(state: State<'_, AppState>, volume: f32) {
    state.soundboard.set_preview_volume(volume);
}

#[tauri::command]
pub fn set_soundboard_preview_paused(state: State<'_, AppState>, paused: bool) {
    state.soundboard.set_preview_paused(paused);
}

#[tauri::command]
pub fn stop_soundboard_preview(state: State<'_, AppState>) {
    state.soundboard.stop_preview();
}

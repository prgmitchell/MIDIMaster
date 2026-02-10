use crate::{model::PlaybackDeviceInfo, model::SessionInfo, AppState};
use tauri::State;

#[tauri::command]
pub fn list_sessions(state: State<AppState>) -> Result<Vec<SessionInfo>, String> {
    state.audio.list_sessions().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_playback_devices(state: State<AppState>) -> Result<Vec<PlaybackDeviceInfo>, String> {
    state
        .audio
        .list_playback_devices()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_recording_devices(state: State<AppState>) -> Result<Vec<PlaybackDeviceInfo>, String> {
    state
        .audio
        .list_recording_devices()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn set_master_volume(state: State<AppState>, volume: f32) -> Result<(), String> {
    state
        .audio
        .set_master_volume(volume)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn set_session_volume(
    state: State<AppState>,
    session_id: String,
    volume: f32,
) -> Result<(), String> {
    state
        .audio
        .set_session_volume(&session_id, volume)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn set_application_volume(
    state: State<AppState>,
    name: String,
    volume: f32,
) -> Result<(), String> {
    state
        .audio
        .set_application_volume(&name, volume)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn set_device_volume(
    state: State<AppState>,
    device_id: String,
    volume: f32,
) -> Result<(), String> {
    state
        .audio
        .set_device_volume(&device_id, volume)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn set_master_mute(state: State<AppState>, muted: bool) -> Result<(), String> {
    state
        .audio
        .set_master_mute(muted)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn set_session_mute(
    state: State<AppState>,
    session_id: String,
    muted: bool,
) -> Result<(), String> {
    state
        .audio
        .set_session_mute(&session_id, muted)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn set_application_mute(
    state: State<AppState>,
    name: String,
    muted: bool,
) -> Result<(), String> {
    state
        .audio
        .set_application_mute(&name, muted)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn set_device_mute(
    state: State<AppState>,
    device_id: String,
    muted: bool,
) -> Result<(), String> {
    state
        .audio
        .set_device_mute(&device_id, muted)
        .map_err(|err| err.to_string())
}

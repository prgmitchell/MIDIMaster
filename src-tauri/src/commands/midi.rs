use crate::{model::DeviceInfo, AppState};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub fn list_midi_devices(state: State<AppState>) -> Result<Vec<DeviceInfo>, String> {
    state
        .midi
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?
        .list_devices()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_midi_output_devices(state: State<AppState>) -> Result<Vec<DeviceInfo>, String> {
    state
        .midi
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?
        .list_output_devices()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn start_midi_device(
    app: AppHandle,
    state: State<AppState>,
    input_device_id: String,
    output_device_id: String,
) -> Result<(), String> {
    let app_handle = app.clone();
    state
        .midi
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?
        .start_device(&input_device_id, &output_device_id, move |event| {
            let _ = app_handle.emit("midi_event", &event);
            let state = app_handle.state::<AppState>();
            let _ = state.apply_midi_event(&app_handle, event);
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn stop_midi_device(state: State<AppState>) -> Result<(), String> {
    state
        .midi
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?
        .stop();
    Ok(())
}

#[tauri::command]
pub fn start_midi_learn(state: State<AppState>) -> Result<(), String> {
    *state
        .learn_pending
        .lock()
        .map_err(|_| "Lock poisoned".to_string())? = true;
    *state
        .learned_control
        .lock()
        .map_err(|_| "Lock poisoned".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn consume_learned_control(
    state: State<AppState>,
) -> Result<Option<crate::model::LearnedControl>, String> {
    let mut guard = state
        .learned_control
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    Ok(guard.take())
}

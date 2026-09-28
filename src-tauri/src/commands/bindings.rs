use crate::{binding_services, model, model::Binding, AppState};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_automatic_led_output(
    state: State<'_, AppState>,
    binding: Binding,
) -> Result<Option<model::MidiControl>, String> {
    Ok(state
        .midi
        .lock()
        .map_err(|_| "MIDI lock poisoned")?
        .automatic_led_output(&binding))
}

#[tauri::command]
pub fn get_audio_meter_demand(
    state: State<'_, AppState>,
) -> Result<crate::audio_feedback::MeterDemand, String> {
    Ok(state
        .audio_feedback
        .lock()
        .map_err(|_| "Meter lock poisoned")?
        .demand
        .clone())
}

#[tauri::command]
pub fn set_audio_meter_samples(
    state: State<'_, AppState>,
    provider: String,
    generation: u64,
    samples: Vec<crate::audio_feedback::AudioSample>,
) -> Result<(), String> {
    state
        .audio_feedback
        .lock()
        .map_err(|_| "Meter lock poisoned")?
        .replace(provider, generation, samples);
    Ok(())
}

#[tauri::command]
pub fn add_binding(state: State<AppState>, binding: Binding) -> Result<(), String> {
    binding_services::add_binding(state.inner(), binding)
}

#[tauri::command]
pub async fn remove_binding(state: State<'_, AppState>, binding: Binding) -> Result<(), String> {
    binding_services::remove_binding(state.inner(), binding).await
}

#[tauri::command]
pub fn update_midi_feedback(
    state: State<'_, AppState>,
    target: model::BindingTarget,
    value: f32,
    binding_id: Option<String>,
    action: Option<model::BindingAction>,
) -> Result<(), String> {
    binding_services::update_midi_feedback(state.inner(), target, value, binding_id, action)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn set_binding_feedback(
    app: AppHandle,
    state: State<AppState>,
    binding_id: String,
    value: f32,
    action: Option<model::BindingAction>,
    silent: Option<bool>,
    input_value: Option<f32>,
    force_hardware_feedback: Option<bool>,
) -> Result<(), String> {
    binding_services::set_binding_feedback(
        app,
        state.inner(),
        binding_id,
        value,
        action,
        silent,
        input_value,
        force_hardware_feedback,
    )
}

#[tauri::command]
pub fn set_integration_connection_state(
    state: State<'_, AppState>,
    integration_id: String,
    connected: bool,
) -> Result<(), String> {
    binding_services::set_integration_connection_state(state.inner(), integration_id, connected)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn apply_binding_action(
    app: AppHandle,
    state: State<'_, AppState>,
    binding_id: String,
    action: Option<model::BindingAction>,
    value: f32,
    silent: Option<bool>,
    source: Option<String>,
    source_sequence: Option<u64>,
) -> Result<(), String> {
    binding_services::apply_binding_action(
        app,
        state.inner(),
        binding_id,
        action,
        value,
        silent,
        source,
        source_sequence,
    )
    .await
}

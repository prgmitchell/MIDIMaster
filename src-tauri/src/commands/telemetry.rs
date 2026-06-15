use crate::{
    run_logger,
    telemetry::{
        build_midi_device_inventory_payload, midi_device_inventory_submission_decision,
        post_midi_device_inventory_payload, MidiDeviceInventorySubmissionDecision,
        MidiDeviceInventorySubmitResult,
    },
    AppState,
};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn submit_midi_device_inventory(
    app: AppHandle,
    state: State<AppState>,
) -> Result<MidiDeviceInventorySubmitResult, String> {
    let settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?
        .clone();
    let routes = settings.normalized_midi_routes();
    let app_version = app.package_info().version.to_string();
    let (inputs, outputs) = {
        let midi = state.midi.lock().map_err(|_| "Lock poisoned".to_string())?;
        let inputs = midi.list_devices().map_err(|err| err.to_string())?;
        let outputs = midi.list_output_devices().map_err(|err| err.to_string())?;
        (inputs, outputs)
    };

    let payload = build_midi_device_inventory_payload(app_version, &inputs, &outputs, &routes);
    let decision = midi_device_inventory_submission_decision(&settings, &payload)?;
    let hash = match decision {
        MidiDeviceInventorySubmissionDecision::Skip { reason } => {
            run_logger::info(
                "telemetry",
                "midi_device_inventory_skipped",
                &format!("reason={reason}"),
            );
            return Ok(MidiDeviceInventorySubmitResult {
                submitted: false,
                skipped: true,
                reason: reason.to_string(),
            });
        }
        MidiDeviceInventorySubmissionDecision::Send { hash } => hash,
    };

    post_midi_device_inventory_payload(&payload)?;

    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    settings.midi_device_inventory_last_sent_hash = Some(hash);
    let updated = settings.clone();
    drop(settings);
    state
        .app_settings_store
        .save(&updated)
        .map_err(|err| err.to_string())?;

    run_logger::info(
        "telemetry",
        "midi_device_inventory_submitted",
        &format!(
            "input_count={} output_count={} route_count={}",
            payload.input_device_count, payload.output_device_count, payload.selected_route_count
        ),
    );
    Ok(MidiDeviceInventorySubmitResult {
        submitted: true,
        skipped: false,
        reason: "submitted".to_string(),
    })
}

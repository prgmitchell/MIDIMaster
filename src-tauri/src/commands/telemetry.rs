use crate::model::MidiDeviceRoute;
use crate::{
    run_logger,
    telemetry::{
        build_midi_device_inventory_payload, midi_device_inventory_preflight,
        midi_device_inventory_submission_decision, post_midi_device_inventory_payload,
        MidiDeviceInventorySubmissionDecision, MidiDeviceInventorySubmitResult,
    },
    AppState,
};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

const UNCHANGED_INVENTORY_FAST_PATH_TTL: Duration = Duration::from_secs(60);

#[derive(Clone)]
struct RecentInventoryCheck {
    sent_hash: String,
    app_version: String,
    routes: Vec<MidiDeviceRoute>,
    checked_at: Instant,
}

fn recent_inventory_check() -> &'static Mutex<Option<RecentInventoryCheck>> {
    static RECENT: OnceLock<Mutex<Option<RecentInventoryCheck>>> = OnceLock::new();
    RECENT.get_or_init(|| Mutex::new(None))
}

fn inventory_is_recently_unchanged(
    sent_hash: Option<&str>,
    app_version: &str,
    routes: &[MidiDeviceRoute],
) -> bool {
    let Some(sent_hash) = sent_hash else {
        return false;
    };
    recent_inventory_check()
        .lock()
        .ok()
        .and_then(|recent| recent.clone())
        .is_some_and(|recent| {
            recent.checked_at.elapsed() <= UNCHANGED_INVENTORY_FAST_PATH_TTL
                && recent.sent_hash == sent_hash
                && recent.app_version == app_version
                && recent.routes == routes
        })
}

fn remember_inventory_check(hash: String, app_version: String, routes: Vec<MidiDeviceRoute>) {
    if let Ok(mut recent) = recent_inventory_check().lock() {
        *recent = Some(RecentInventoryCheck {
            sent_hash: hash,
            app_version,
            routes,
            checked_at: Instant::now(),
        });
    }
}

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
    if let Some(MidiDeviceInventorySubmissionDecision::Skip { reason }) =
        midi_device_inventory_preflight(&settings)
    {
        return Ok(MidiDeviceInventorySubmitResult {
            submitted: false,
            skipped: true,
            reason: reason.to_string(),
        });
    }
    let routes = settings.normalized_midi_routes();
    let app_version = app.package_info().version.to_string();
    if inventory_is_recently_unchanged(
        settings.midi_device_inventory_last_sent_hash.as_deref(),
        &app_version,
        &routes,
    ) {
        return Ok(MidiDeviceInventorySubmitResult {
            submitted: false,
            skipped: true,
            reason: "unchanged".to_string(),
        });
    }
    let (inputs, outputs) = {
        let midi = state.midi.lock().map_err(|_| "Lock poisoned".to_string())?;
        let inputs = midi.list_devices().map_err(|err| err.to_string())?;
        let outputs = midi.list_output_devices().map_err(|err| err.to_string())?;
        (inputs, outputs)
    };

    let payload =
        build_midi_device_inventory_payload(app_version.clone(), &inputs, &outputs, &routes);
    let decision = midi_device_inventory_submission_decision(&settings, &payload)?;
    let hash = match decision {
        MidiDeviceInventorySubmissionDecision::Skip { reason } => {
            if reason == "unchanged" {
                if let Some(hash) = settings.midi_device_inventory_last_sent_hash.clone() {
                    remember_inventory_check(hash, app_version, routes);
                }
            }
            return Ok(MidiDeviceInventorySubmitResult {
                submitted: false,
                skipped: true,
                reason: reason.to_string(),
            });
        }
        MidiDeviceInventorySubmissionDecision::Send { hash } => hash,
    };

    post_midi_device_inventory_payload(&payload)?;

    super::settings::persist_app_settings_update(state.inner(), |settings| {
        settings.midi_device_inventory_last_sent_hash = Some(hash.clone());
    })?;
    remember_inventory_check(hash, app_version, routes);

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

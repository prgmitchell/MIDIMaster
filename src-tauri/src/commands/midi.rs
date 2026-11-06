use crate::midi_reconciliation::{
    allows_single_device_fallback, publish_profile, reconciled_profile, safe_routes,
    same_connection,
};
use crate::run_logger;
use crate::{
    midi::MidiConnectionHealth,
    model::{DeviceInfo, MidiDeviceRoute, Profile},
    AppState,
};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiRouteApplyFailure {
    route: MidiDeviceRoute,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiRouteApplyResult {
    connected_routes: Vec<MidiDeviceRoute>,
    failed_routes: Vec<MidiRouteApplyFailure>,
    complete: bool,
    profile: Option<Profile>,
}

fn emit_midi_connection_status(
    app: &AppHandle,
    input_device_id: &str,
    output_device_id: &str,
    state: &str,
    reason: &str,
) {
    let _ = app.emit(
        "midi_connection_status",
        serde_json::json!({
            "inputDeviceId": input_device_id,
            "outputDeviceId": output_device_id,
            "state": state,
            "reason": reason,
        }),
    );
}

fn route_status_json(routes: &[MidiDeviceRoute]) -> Vec<serde_json::Value> {
    routes
        .iter()
        .filter_map(|route| route.normalized())
        .map(|route| {
            serde_json::json!({
                "inputDeviceId": route.input_id().unwrap_or_default(),
                "outputDeviceId": route.output_id().unwrap_or_default(),
                "inputDeviceName": route.input_device_name.as_deref().unwrap_or_default(),
                "outputDeviceName": route.output_device_name.as_deref().unwrap_or_default(),
                "enabled": route.enabled,
            })
        })
        .collect()
}

fn routes_from_pairs(pairs: Vec<(String, String)>) -> Vec<MidiDeviceRoute> {
    pairs
        .into_iter()
        .map(|(input_device_id, output_device_id)| MidiDeviceRoute {
            input_device_id: Some(input_device_id),
            output_device_id: Some(output_device_id),
            input_device_name: None,
            output_device_name: None,
            enabled: true,
        })
        .collect()
}

fn emit_midi_routes_connection_status(
    app: &AppHandle,
    routes: &[MidiDeviceRoute],
    state: &str,
    reason: &str,
) {
    let normalized_routes = route_status_json(routes);
    let route_count = normalized_routes.len();
    let first = normalized_routes.first();
    let _ = app.emit(
        "midi_connection_status",
        serde_json::json!({
            "inputDeviceId": first
                .and_then(|route| route.get("inputDeviceId"))
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            "outputDeviceId": first
                .and_then(|route| route.get("outputDeviceId"))
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            "routes": normalized_routes,
            "routeCount": route_count,
            "state": state,
            "reason": reason,
        }),
    );
}

fn midi_event_callback(
    app_handle: AppHandle,
) -> Arc<dyn Fn(crate::model::MidiEvent) + Send + Sync + 'static> {
    Arc::new(move |event| {
        let state = app_handle.state::<AppState>();
        let enqueue_result = state.midi_event_queue.lock();
        match enqueue_result {
            Ok(mut queue) => {
                queue.enqueue(event);
                crate::background_tasks::notify_midi_event_queued();
            }
            Err(_) => run_logger::error("midi_queue", "enqueue_failed", "queue lock poisoned"),
        };
    })
}

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
pub fn get_midi_connection_health(state: State<AppState>) -> Result<MidiConnectionHealth, String> {
    let mut midi = state.midi.lock().map_err(|_| "Lock poisoned".to_string())?;
    Ok(midi.connection_health())
}

#[tauri::command]
pub fn get_midi_route_health(state: State<AppState>) -> Result<Vec<MidiConnectionHealth>, String> {
    let mut midi = state.midi.lock().map_err(|_| "Lock poisoned".to_string())?;
    Ok(midi.route_health())
}

#[tauri::command]
pub fn start_midi_device(
    app: AppHandle,
    state: State<AppState>,
    input_device_id: String,
    output_device_id: String,
) -> Result<MidiRouteApplyResult, String> {
    run_logger::info(
        "midi_cmd",
        "start_requested",
        &format!(
            "input_device_id={} output_device_id={}",
            input_device_id, output_device_id
        ),
    );
    let route = MidiDeviceRoute {
        input_device_id: Some(input_device_id.clone()),
        output_device_id: Some(output_device_id.clone()),
        input_device_name: None,
        output_device_name: None,
        enabled: true,
    };
    start_midi_device_routes(app, state, vec![route], None, None, None)
}

#[tauri::command]
pub fn start_midi_device_routes(
    app: AppHandle,
    state: State<AppState>,
    routes: Vec<MidiDeviceRoute>,
    force: Option<bool>,
    desired_routes: Option<Vec<MidiDeviceRoute>>,
    expected_profile_name: Option<String>,
) -> Result<MidiRouteApplyResult, String> {
    // Dispatch holds this same gate before draining a batch. No drained old-port
    // events can cross the durable profile/connection transition.
    let _dispatch = state
        .midi_dispatch_lock
        .lock()
        .map_err(|_| "Lock poisoned")?;
    let mut profile_guard = state.active_profile.lock().map_err(|_| "Lock poisoned")?;
    let original = profile_guard.as_ref().map(|p| p.profile().clone());
    if let Some(expected) = expected_profile_name.as_deref() {
        if original.as_ref().map(|p| p.name.as_str()) != Some(expected) {
            return Err("Active profile changed before MIDI reconciliation".into());
        }
    }
    let desired = desired_routes.unwrap_or_else(|| routes.clone());
    let desired = desired
        .iter()
        .filter_map(MidiDeviceRoute::normalized)
        .collect::<Vec<_>>();
    let requested = routes
        .iter()
        .filter_map(MidiDeviceRoute::normalized)
        .filter(|r| r.enabled)
        .collect::<Vec<_>>();
    let permitted = original
        .as_ref()
        .map(|p| safe_routes(p, &requested))
        .unwrap_or_else(|| requested.clone());
    emit_midi_routes_connection_status(&app, &requested, "reconnecting", "start_requested");

    let mut midi = state.midi.lock().map_err(|_| "Lock poisoned")?;
    let before = midi.active_route_details();
    let saved = original
        .as_ref()
        .map(|p| p.midi_device_preference.normalized_routes())
        .unwrap_or_default();
    let affected = saved
        .iter()
        .chain(before.iter())
        .chain(requested.iter())
        .filter(|r| {
            force.unwrap_or(false)
                || !before.iter().any(|old| same_connection(old, r))
                || !permitted.iter().any(|next| same_connection(next, r))
        })
        .filter_map(|r| r.input_id().map(str::to_string))
        .collect::<std::collections::HashSet<_>>();
    for id in &affected {
        midi.stop_route(id);
    }
    midi.allow_single_route_fallback =
        original.as_ref().is_some_and(allows_single_device_fallback) && desired.len() <= 1;
    let apply_error = midi
        .set_device_routes(
            &permitted,
            midi_event_callback(app.clone()),
            force.unwrap_or(false),
        )
        .err()
        .map(|e| e.to_string());
    let opened = midi.active_route_details();
    let requested_opened = opened
        .iter()
        .filter(|r| permitted.iter().any(|p| same_connection(p, r)))
        .cloned()
        .collect::<Vec<_>>();
    let accepted = original
        .as_ref()
        .map(|p| safe_routes(p, &requested_opened))
        .unwrap_or(requested_opened);
    // If one member of a swap failed to open, close the other members too.
    for route in &opened {
        if !accepted.iter().any(|r| same_connection(r, route)) {
            if let Some(id) = route.input_id() {
                midi.stop_route(id);
            }
        }
    }
    let candidate = original
        .as_ref()
        .map(|p| reconciled_profile(p, &desired, &accepted));
    let save_result = if let Some(updated) = candidate.as_ref() {
        publish_profile(&mut profile_guard, updated, |p| {
            state
                .profile_store
                .save_profile(p.clone())
                .map_err(|e| e.to_string())
        })
    } else {
        Ok(())
    };
    if let Err(error) = save_result {
        // A failed durable write must never leave migrated handles dispatching
        // against the old assignments. Healthy, unchanged routes stay open.
        for route in &accepted {
            if !before.iter().any(|r| same_connection(r, route))
                || affected.contains(route.input_id().unwrap_or_default())
            {
                if let Some(id) = route.input_id() {
                    midi.stop_route(id);
                }
            }
        }
        if let Ok(mut queue) = state.midi_event_queue.lock() {
            queue.discard_devices(&affected);
        }
        return Err(error);
    }
    if let Some(updated) = candidate.as_ref() {
        midi.allow_single_route_fallback = allows_single_device_fallback(updated);
    }
    let connected_routes = midi.active_route_details();
    let failed_routes = desired
        .iter()
        .filter(|r| r.enabled)
        .filter(|r| !connected_routes.iter().any(|c| same_connection(c, r)))
        .cloned()
        .map(|route| MidiRouteApplyFailure {
            route,
            reason: apply_error.clone().unwrap_or_else(|| {
                "MIDI route unavailable or awaiting an unambiguous device group".into()
            }),
        })
        .collect::<Vec<_>>();
    let complete = apply_error.is_none() && failed_routes.is_empty();
    if let Ok(mut queue) = state.midi_event_queue.lock() {
        queue.discard_devices(&affected);
    }
    drop(midi);
    drop(profile_guard);
    if let Some(profile) = candidate.as_ref() {
        if let Ok(mut values) = state.binding_state.lock() {
            values.clear();
        }
        if let Ok(mut values) = state.binding_action_values.lock() {
            values.clear();
        }
        if let Ok(mut values) = state.feedback_values.lock() {
            values.clear();
        }
        if let Ok(mut values) = state.last_mute_input_active.lock() {
            values.clear();
        }
        state.sync_feedback_values(profile);
        state.send_idle_button_light_feedback_values(profile);
    }
    run_logger::info(
        "midi_cmd",
        if complete {
            "start_routes_succeeded"
        } else {
            "start_routes_partial"
        },
        &format!(
            "requested={} connected={} failed={}",
            desired.len(),
            connected_routes.len(),
            failed_routes.len()
        ),
    );
    emit_midi_routes_connection_status(
        &app,
        &connected_routes,
        if connected_routes.is_empty() {
            "failed"
        } else {
            "connected"
        },
        if complete {
            "start_succeeded"
        } else {
            "start_partial"
        },
    );
    Ok(MidiRouteApplyResult {
        connected_routes,
        failed_routes,
        complete,
        profile: candidate,
    })
}

#[tauri::command]
pub fn stop_midi_route(
    app: AppHandle,
    state: State<AppState>,
    input_device_id: String,
) -> Result<(), String> {
    let (output_device_id, remaining_routes) = {
        let mut midi = state.midi.lock().map_err(|_| "Lock poisoned".to_string())?;
        let output_device_id = midi.stop_route(&input_device_id);
        let remaining_routes = routes_from_pairs(midi.active_routes());
        (output_device_id, remaining_routes)
    };
    if let Some(output_device_id) = output_device_id {
        let state = if remaining_routes.is_empty() {
            "disconnected"
        } else {
            "connected"
        };
        let reason = if remaining_routes.is_empty() {
            "stop_route_requested"
        } else {
            "route_stopped_remaining_connected"
        };
        if remaining_routes.is_empty() {
            emit_midi_connection_status(&app, &input_device_id, &output_device_id, state, reason);
        } else {
            emit_midi_routes_connection_status(&app, &remaining_routes, state, reason);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn stop_midi_device(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    run_logger::info("midi_cmd", "stop_requested", "");
    let had_active = {
        let mut midi = state.midi.lock().map_err(|_| "Lock poisoned".to_string())?;
        let had_active = !midi.active_routes().is_empty();
        midi.stop();
        had_active
    };
    if had_active {
        emit_midi_routes_connection_status(&app, &[], "disconnected", "stop_requested");
    }
    Ok(())
}

#[tauri::command]
pub fn start_midi_learn(state: State<AppState>) -> Result<(), String> {
    run_logger::info("learn", "start_requested", "");
    *state
        .learn_pending
        .lock()
        .map_err(|_| "Lock poisoned".to_string())? = true;
    *state
        .learn_candidate
        .lock()
        .map_err(|_| "Lock poisoned".to_string())? = None;
    *state
        .learned_control
        .lock()
        .map_err(|_| "Lock poisoned".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn cancel_midi_learn(state: State<AppState>) -> Result<(), String> {
    *state.learn_pending.lock().map_err(|_| "Lock poisoned")? = false;
    *state.learn_candidate.lock().map_err(|_| "Lock poisoned")? = None;
    *state.learned_control.lock().map_err(|_| "Lock poisoned")? = None;
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
    let next = guard.take();
    if let Some(control) = next.as_ref() {
        run_logger::info(
            "learn",
            "control_consumed",
            &format!(
                "device_id={} channel={} controller={} msg_type={:?} control_kind={:?}",
                control.device_id,
                control.channel,
                control.controller,
                control.msg_type,
                control.control_kind
            ),
        );
    }
    Ok(next)
}

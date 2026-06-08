use crate::run_logger;
use crate::{
    midi::MidiConnectionHealth,
    model::{DeviceInfo, MidiDeviceRoute, MidiMessageType, Profile},
    AppState,
};
use serde::Serialize;
use std::{collections::HashSet, sync::Arc};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingDeviceMigration {
    binding_id: String,
    previous_device_id: String,
    device_id: String,
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

fn migrate_profile_route_inputs(
    profile: &mut Profile,
    routes: &[MidiDeviceRoute],
) -> (usize, Vec<BindingDeviceMigration>) {
    let saved_routes = profile.midi_device_preference.normalized_routes();
    let mut migrated_count = 0usize;
    let mut migrations = Vec::new();

    for route in routes {
        let Some(next_route) = route.normalized() else {
            continue;
        };
        let Some(next_input_id) = next_route.input_id() else {
            continue;
        };
        let Some(next_input_name) = next_route
            .input_device_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };

        for saved in &saved_routes {
            let Some(previous_input_id) = saved.input_id() else {
                continue;
            };
            if previous_input_id == next_input_id {
                continue;
            }
            let saved_name_matches = saved
                .input_device_name
                .as_deref()
                .map(str::trim)
                .map(|name| name == next_input_name)
                .unwrap_or(false);
            if saved_name_matches {
                migrated_count += migrate_control_device_id(
                    profile,
                    previous_input_id,
                    next_input_id,
                    &mut migrations,
                );
            }
        }
    }

    migrated_count += migrate_orphaned_binding_device_ids_to_primary_route(
        profile,
        &saved_routes,
        routes,
        &mut migrations,
    );

    migrated_count +=
        migrate_pitch_bend_bindings_saved_to_route_outputs(profile, routes, &mut migrations);

    (migrated_count, migrations)
}

fn migrate_control_device_id(
    profile: &mut Profile,
    previous_input_id: &str,
    next_input_id: &str,
    migrations: &mut Vec<BindingDeviceMigration>,
) -> usize {
    let mut migrated_count = 0usize;

    for binding in &mut profile.bindings {
        let mut binding_migrated = false;
        if binding.device_id == previous_input_id {
            binding.device_id = next_input_id.to_string();
            migrated_count += 1;
            binding_migrated = true;
        }
        if let Some(mute_control) = binding.mute_control.as_mut() {
            if mute_control.device_id == previous_input_id {
                mute_control.device_id = next_input_id.to_string();
                migrated_count += 1;
                binding_migrated = true;
            }
        }
        if let Some(assign_control) = binding.assign_control.as_mut() {
            if assign_control.device_id == previous_input_id {
                assign_control.device_id = next_input_id.to_string();
                migrated_count += 1;
                binding_migrated = true;
            }
        }
        if binding_migrated {
            record_binding_migration(migrations, &binding.id, previous_input_id, next_input_id);
        }
    }

    migrated_count
}

fn migrate_orphaned_binding_device_ids_to_primary_route(
    profile: &mut Profile,
    saved_routes: &[MidiDeviceRoute],
    routes: &[MidiDeviceRoute],
    migrations: &mut Vec<BindingDeviceMigration>,
) -> usize {
    if saved_routes.is_empty() || saved_routes.iter().any(|route| !route.enabled) {
        return 0;
    }
    let saved_enabled_routes = saved_routes
        .iter()
        .filter(|route| route.enabled)
        .filter_map(|route| route.normalized())
        .collect::<Vec<_>>();
    if saved_enabled_routes.is_empty() {
        return 0;
    }

    let normalized_routes = routes
        .iter()
        .filter_map(|route| route.normalized())
        .collect::<Vec<_>>();
    if normalized_routes.is_empty() {
        return 0;
    }
    if normalized_routes.len() < saved_enabled_routes.len()
        || !saved_enabled_routes.iter().all(|saved_route| {
            normalized_routes
                .iter()
                .any(|route| routes_share_input_identity(saved_route, route))
        })
    {
        return 0;
    }

    let primary_saved_route = saved_enabled_routes.first();
    let Some(primary_saved_route) = primary_saved_route else {
        return 0;
    };
    let Some(primary_route) = normalized_routes
        .iter()
        .find(|route| routes_share_input_identity(primary_saved_route, route))
    else {
        return 0;
    };
    let Some(primary_input_id) = primary_route.input_id() else {
        return 0;
    };

    if saved_enabled_routes.len() == 1 {
        let stale_device_ids = binding_midi_device_ids(profile)
            .into_iter()
            .filter(|device_id| device_id != primary_input_id)
            .collect::<HashSet<_>>();
        return migrate_single_stale_device_id_to_primary_route(
            profile,
            &stale_device_ids,
            primary_input_id,
            normalized_routes.len(),
            migrations,
        );
    }

    let active_input_ids = normalized_routes
        .iter()
        .filter_map(|route| route.input_id().map(str::to_string))
        .collect::<HashSet<_>>();
    let active_output_ids = normalized_routes
        .iter()
        .filter_map(|route| route.output_id().map(str::to_string))
        .collect::<HashSet<_>>();
    let orphan_device_ids = binding_midi_device_ids(profile)
        .into_iter()
        .filter(|device_id| {
            !active_input_ids.contains(device_id) && !active_output_ids.contains(device_id)
        })
        .collect::<HashSet<_>>();

    if orphan_device_ids.len() != 1 {
        return 0;
    }

    migrate_single_stale_device_id_to_primary_route(
        profile,
        &orphan_device_ids,
        primary_input_id,
        normalized_routes.len(),
        migrations,
    )
}

fn migrate_single_stale_device_id_to_primary_route(
    profile: &mut Profile,
    stale_device_ids: &HashSet<String>,
    primary_input_id: &str,
    active_route_count: usize,
    migrations: &mut Vec<BindingDeviceMigration>,
) -> usize {
    if stale_device_ids.len() != 1 {
        return 0;
    }
    let Some(orphan_device_id) = stale_device_ids.iter().next() else {
        return 0;
    };
    if orphan_device_id == primary_input_id {
        return 0;
    }

    let migrated_count =
        migrate_control_device_id(profile, orphan_device_id, primary_input_id, migrations);
    if migrated_count > 0 {
        run_logger::info(
            "midi_cmd",
            "orphan_binding_device_ids_migrated",
            &format!(
                "previous_device_id={} device_id={} binding_control_count={} active_route_count={}",
                orphan_device_id, primary_input_id, migrated_count, active_route_count
            ),
        );
    }
    migrated_count
}

fn binding_midi_device_ids(profile: &Profile) -> HashSet<String> {
    let mut device_ids = HashSet::new();
    for binding in &profile.bindings {
        insert_midi_device_id(&mut device_ids, &binding.device_id);
        if let Some(mute_control) = binding.mute_control.as_ref() {
            insert_midi_device_id(&mut device_ids, &mute_control.device_id);
        }
        if let Some(assign_control) = binding.assign_control.as_ref() {
            insert_midi_device_id(&mut device_ids, &assign_control.device_id);
        }
    }
    device_ids
}

fn insert_midi_device_id(device_ids: &mut HashSet<String>, device_id: &str) {
    let device_id = device_id.trim();
    if device_id.starts_with("midi:") {
        device_ids.insert(device_id.to_string());
    }
}

fn routes_share_input_identity(left: &MidiDeviceRoute, right: &MidiDeviceRoute) -> bool {
    if left.input_id().is_some() && left.input_id() == right.input_id() {
        return true;
    }

    let left_name = left
        .input_device_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let right_name = right
        .input_device_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());

    left_name.is_some() && left_name == right_name
}

fn migrate_pitch_bend_bindings_saved_to_route_outputs(
    profile: &mut Profile,
    routes: &[MidiDeviceRoute],
    migrations: &mut Vec<BindingDeviceMigration>,
) -> usize {
    let normalized_routes = routes
        .iter()
        .filter_map(|route| route.normalized())
        .collect::<Vec<_>>();
    let active_input_ids = normalized_routes
        .iter()
        .filter_map(|route| route.input_id().map(str::to_string))
        .collect::<HashSet<_>>();
    let mut migrated_count = 0usize;

    for binding in &mut profile.bindings {
        if binding.control.msg_type != MidiMessageType::PitchBend {
            continue;
        }

        let Some(route) = normalized_routes.iter().find(|route| {
            let Some(input_id) = route.input_id() else {
                return false;
            };
            let Some(output_id) = route.output_id() else {
                return false;
            };
            if active_input_ids.contains(output_id) {
                return false;
            }
            input_id != output_id && binding.device_id == output_id
        }) else {
            continue;
        };
        let Some(input_id) = route.input_id() else {
            continue;
        };
        let Some(output_id) = route.output_id() else {
            continue;
        };

        binding.device_id = input_id.to_string();
        migrated_count += 1;
        record_binding_migration(migrations, &binding.id, output_id, input_id);

        if let Some(mute_control) = binding.mute_control.as_mut() {
            if mute_control.device_id == output_id {
                mute_control.device_id = input_id.to_string();
                migrated_count += 1;
            }
        }
        if let Some(assign_control) = binding.assign_control.as_mut() {
            if assign_control.device_id == output_id {
                assign_control.device_id = input_id.to_string();
                migrated_count += 1;
            }
        }
    }

    migrated_count
}

fn record_binding_migration(
    migrations: &mut Vec<BindingDeviceMigration>,
    binding_id: &str,
    previous_device_id: &str,
    device_id: &str,
) {
    if migrations.iter().any(|migration| {
        migration.binding_id == binding_id
            && migration.previous_device_id == previous_device_id
            && migration.device_id == device_id
    }) {
        return;
    }

    migrations.push(BindingDeviceMigration {
        binding_id: binding_id.to_string(),
        previous_device_id: previous_device_id.to_string(),
        device_id: device_id.to_string(),
    });
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
) -> Result<(), String> {
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
    start_midi_device_routes(app, state, vec![route], None)
}

#[tauri::command]
pub fn start_midi_device_routes(
    app: AppHandle,
    state: State<AppState>,
    routes: Vec<MidiDeviceRoute>,
    force: Option<bool>,
) -> Result<(), String> {
    let force_reconnect = force.unwrap_or(false);
    let enabled_routes = routes
        .iter()
        .filter_map(|route| route.normalized())
        .filter(|route| route.enabled)
        .collect::<Vec<_>>();
    emit_midi_routes_connection_status(&app, &enabled_routes, "reconnecting", "start_requested");

    // Keep persisted bindings aligned before connecting new inputs so
    // multi-route matching never sees stale single-route device ids.
    let mut migrated_count = 0usize;
    let mut profile_for_sync = None;
    {
        let mut profile_guard = state
            .active_profile
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;

        if let Some(profile) = profile_guard.as_mut() {
            let migrations;
            (migrated_count, migrations) = migrate_profile_route_inputs(profile, &enabled_routes);

            if migrated_count > 0 {
                state
                    .profile_store
                    .save_profile(profile.clone())
                    .map_err(|err| err.to_string())?;
                profile_for_sync = Some((profile.clone(), migrations));
            }
        }
    }

    let app_handle = app.clone();
    {
        if let Err(err) = state
            .midi
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?
            .set_device_routes(
                &enabled_routes,
                midi_event_callback(app_handle),
                force_reconnect,
            )
            .map_err(|err| err.to_string())
        {
            run_logger::error(
                "midi_cmd",
                "start_routes_failed",
                &format!("route_count={} error={}", enabled_routes.len(), err),
            );
            emit_midi_routes_connection_status(&app, &enabled_routes, "failed", "start_failed");
            return Err(err);
        }
    }

    if let Some((profile, migrations)) = profile_for_sync {
        if let Ok(mut states) = state.binding_state.lock() {
            states.clear();
        }
        if let Ok(mut feedback) = state.feedback_values.lock() {
            feedback.clear();
        }
        if let Ok(mut values) = state.binding_action_values.lock() {
            values.clear();
        }
        state.sync_feedback_values(&profile);
        let _ = app.emit(
            "bindings_migrated",
            serde_json::json!({
                "route_count": enabled_routes.len(),
                "count": migrated_count,
                "migrations": migrations,
            }),
        );
    }

    let profile_for_lights = state
        .active_profile
        .lock()
        .ok()
        .and_then(|profile| profile.clone());
    if let Some(profile) = profile_for_lights {
        state.sync_feedback_values(&profile);
        state.send_idle_button_light_feedback_values(&profile);
    }

    run_logger::info(
        "midi_cmd",
        "start_routes_succeeded",
        &format!(
            "route_count={} bindings_migrated={}",
            enabled_routes.len(),
            migrated_count
        ),
    );
    emit_midi_routes_connection_status(&app, &enabled_routes, "connected", "start_succeeded");

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        self, AssignMode, BindingAction, BindingControlKind, BindingTarget, FaderCurve,
        MidiMessageType, MidiMode, MuteBehavior, RelativeFormat,
    };
    use std::collections::HashMap;

    fn profile_with(binding: model::Binding) -> Profile {
        Profile {
            name: "Default".to_string(),
            bindings: vec![binding],
            osd_settings: model::OsdSettings::default(),
            plugin_settings: HashMap::new(),
            midi_device_preference: model::MidiDevicePreference::default(),
            midi_device_preference_set: false,
        }
    }

    fn binding(
        device_id: &str,
        mute_device_id: Option<&str>,
        assign_device_id: Option<&str>,
    ) -> model::Binding {
        model::Binding {
            id: "binding-1".to_string(),
            name: "Binding 1".to_string(),
            device_id: device_id.to_string(),
            control: model::MidiControl {
                channel: 2,
                controller: 224,
                msg_type: MidiMessageType::PitchBend,
            },
            control_kind: BindingControlKind::Continuous,
            targets: vec![BindingTarget::Master],
            target: BindingTarget::Master,
            action: BindingAction::Volume,
            mode: MidiMode::Absolute,
            relative_format: RelativeFormat::Auto,
            fader_curve: FaderCurve::Linear,
            custom_curve: Vec::new(),
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: MuteBehavior::ToggleOnPress,
            button_light_mode: model::ButtonLightMode::Activity,
            mute_control: mute_device_id.map(|id| aux_control(id, 18)),
            assign_control: assign_device_id.map(|id| aux_control(id, 19)),
            assign_mode: AssignMode::Add,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
        }
    }

    fn aux_control(device_id: &str, controller: u8) -> model::AuxiliaryControl {
        model::AuxiliaryControl {
            device_id: device_id.to_string(),
            channel: 0,
            controller,
            msg_type: MidiMessageType::Note,
            control_kind: BindingControlKind::Button,
            mode: MidiMode::Absolute,
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: MuteBehavior::ToggleOnPress,
        }
    }

    fn route(input_id: &str, output_id: &str, input_name: &str) -> MidiDeviceRoute {
        MidiDeviceRoute {
            input_device_id: Some(input_id.to_string()),
            output_device_id: Some(output_id.to_string()),
            input_device_name: Some(input_name.to_string()),
            output_device_name: Some(format!("{input_name} Out")),
            enabled: true,
        }
    }

    #[test]
    fn migrate_route_inputs_updates_only_matching_saved_route_by_name() {
        let mut profile = profile_with(binding("midi:0", Some("midi:0"), Some("midi:5")));
        profile
            .bindings
            .push(binding("midi:5", Some("midi:5"), None));
        profile.midi_device_preference.routes = vec![
            route("midi:0", "midi:10", "Deck A"),
            route("midi:5", "midi:15", "Deck B"),
        ];

        let (migrated_count, migrations) =
            migrate_profile_route_inputs(&mut profile, &[route("midi:2", "midi:12", "Deck A")]);

        assert_eq!(migrated_count, 2);
        assert_eq!(migrations.len(), 1);
        assert_eq!(migrations[0].binding_id, "binding-1");
        assert_eq!(migrations[0].previous_device_id, "midi:0");
        assert_eq!(migrations[0].device_id, "midi:2");
        assert_eq!(profile.bindings[0].device_id, "midi:2");
        assert_eq!(
            profile.bindings[0]
                .mute_control
                .as_ref()
                .expect("mute control")
                .device_id,
            "midi:2"
        );
        assert_eq!(
            profile.bindings[0]
                .assign_control
                .as_ref()
                .expect("assign control")
                .device_id,
            "midi:5"
        );
        assert_eq!(profile.bindings[1].device_id, "midi:5");
    }

    #[test]
    fn migrate_route_inputs_ignores_routes_without_name_match() {
        let mut profile = profile_with(binding("midi:0", Some("midi:0"), None));
        profile.midi_device_preference.routes = vec![route("midi:0", "midi:10", "Deck A")];

        let (migrated_count, migrations) =
            migrate_profile_route_inputs(&mut profile, &[route("midi:2", "midi:12", "Deck B")]);

        assert_eq!(migrated_count, 0);
        assert!(migrations.is_empty());
        assert_eq!(profile.bindings[0].device_id, "midi:0");
        assert_eq!(
            profile.bindings[0]
                .mute_control
                .as_ref()
                .expect("mute control")
                .device_id,
            "midi:0"
        );
    }

    #[test]
    fn migrate_route_inputs_repairs_single_orphan_when_profile_expands_to_multiple_routes() {
        let mut profile = profile_with(binding("midi:0", Some("midi:0"), None));
        profile.midi_device_preference.routes = vec![route("midi:1", "midi:2", "Platform X+")];

        let (migrated_count, migrations) = migrate_profile_route_inputs(
            &mut profile,
            &[
                route("midi:1", "midi:2", "Platform X+"),
                route("midi:3", "midi:4", "Focusrite USB MIDI"),
            ],
        );

        assert_eq!(migrated_count, 2);
        assert_eq!(migrations.len(), 1);
        assert_eq!(migrations[0].binding_id, "binding-1");
        assert_eq!(migrations[0].previous_device_id, "midi:0");
        assert_eq!(migrations[0].device_id, "midi:1");
        assert_eq!(profile.bindings[0].device_id, "midi:1");
        assert_eq!(
            profile.bindings[0]
                .mute_control
                .as_ref()
                .expect("mute control")
                .device_id,
            "midi:1"
        );
    }

    #[test]
    fn migrate_route_inputs_repairs_single_route_stale_id_reused_by_new_route() {
        let mut profile = profile_with(binding("midi:0", Some("midi:0"), None));
        profile.midi_device_preference.routes = vec![route("midi:1", "midi:2", "Platform X+")];

        let (migrated_count, migrations) = migrate_profile_route_inputs(
            &mut profile,
            &[
                route("midi:1", "midi:2", "Platform X+"),
                route("midi:0", "midi:3", "Focusrite USB MIDI"),
            ],
        );

        assert_eq!(migrated_count, 2);
        assert_eq!(migrations.len(), 1);
        assert_eq!(profile.bindings[0].device_id, "midi:1");
        assert_eq!(
            profile.bindings[0]
                .mute_control
                .as_ref()
                .expect("mute control")
                .device_id,
            "midi:1"
        );
        assert_eq!(
            migrations[0],
            BindingDeviceMigration {
                binding_id: "binding-1".to_string(),
                previous_device_id: "midi:0".to_string(),
                device_id: "midi:1".to_string(),
            }
        );
    }

    #[test]
    fn migrate_route_inputs_repairs_single_orphan_in_existing_multi_route_profile() {
        let mut platform_binding = binding("midi:0", None, None);
        platform_binding.id = "platform-fader".to_string();
        let mut midi_mix_binding = binding("midi:3", None, None);
        midi_mix_binding.id = "midi-mix-fader".to_string();
        midi_mix_binding.control.msg_type = MidiMessageType::ControlChange;
        midi_mix_binding.control.controller = 7;

        let mut profile = profile_with(platform_binding);
        profile.bindings.push(midi_mix_binding);
        profile.midi_device_preference.routes = vec![
            route("midi:1", "midi:2", "Platform X+"),
            route("midi:3", "midi:4", "MIDI Mix"),
        ];
        let active_routes = profile.midi_device_preference.routes.clone();

        let (migrated_count, migrations) =
            migrate_profile_route_inputs(&mut profile, &active_routes);

        assert_eq!(migrated_count, 1);
        assert_eq!(migrations.len(), 1);
        assert_eq!(profile.bindings[0].device_id, "midi:1");
        assert_eq!(profile.bindings[1].device_id, "midi:3");
        assert_eq!(
            migrations[0],
            BindingDeviceMigration {
                binding_id: "platform-fader".to_string(),
                previous_device_id: "midi:0".to_string(),
                device_id: "midi:1".to_string(),
            }
        );
    }

    #[test]
    fn migrate_route_inputs_does_not_reassign_disabled_route_bindings() {
        let mut profile = profile_with(binding("midi:3", None, None));
        let mut disabled_route = route("midi:3", "midi:4", "MIDI Mix");
        disabled_route.enabled = false;
        profile.midi_device_preference.routes =
            vec![route("midi:1", "midi:2", "Platform X+"), disabled_route];

        let (migrated_count, migrations) =
            migrate_profile_route_inputs(&mut profile, &[route("midi:1", "midi:2", "Platform X+")]);

        assert_eq!(migrated_count, 0);
        assert!(migrations.is_empty());
        assert_eq!(profile.bindings[0].device_id, "midi:3");
    }

    #[test]
    fn migrate_route_inputs_does_not_repair_pitch_bend_output_when_id_is_active_input() {
        let mut platform_binding = binding("midi:1", None, None);
        platform_binding.id = "platform-fader".to_string();
        let mut focusrite_binding = binding("midi:0", None, None);
        focusrite_binding.id = "focusrite-fader".to_string();
        focusrite_binding.control.msg_type = MidiMessageType::ControlChange;
        focusrite_binding.control.controller = 7;

        let mut profile = profile_with(platform_binding);
        profile.bindings.push(focusrite_binding);
        profile.midi_device_preference.routes = vec![
            route("midi:1", "midi:2", "Platform X+"),
            route("midi:0", "midi:1", "Focusrite USB MIDI"),
        ];
        let active_routes = profile.midi_device_preference.routes.clone();

        let (migrated_count, migrations) =
            migrate_profile_route_inputs(&mut profile, &active_routes);

        assert_eq!(migrated_count, 0);
        assert!(migrations.is_empty());
        assert_eq!(profile.bindings[0].device_id, "midi:1");
        assert_eq!(profile.bindings[1].device_id, "midi:0");
    }

    #[test]
    fn migrate_route_inputs_repairs_pitch_bend_bindings_saved_to_route_output() {
        let mut platform_binding = binding("midi:2", None, None);
        platform_binding.id = "platform-fader".to_string();
        let mut midi_mix_binding = binding("midi:2", None, None);
        midi_mix_binding.id = "midi-mix-cc".to_string();
        midi_mix_binding.control.msg_type = MidiMessageType::ControlChange;
        midi_mix_binding.control.controller = 7;

        let mut profile = profile_with(platform_binding);
        profile.bindings.push(midi_mix_binding);
        profile.midi_device_preference.routes = vec![
            route("midi:1", "midi:2", "Platform X+"),
            route("midi:4", "midi:3", "MIDI Mix"),
        ];
        let active_routes = profile.midi_device_preference.routes.clone();

        let (migrated_count, migrations) =
            migrate_profile_route_inputs(&mut profile, &active_routes);

        assert_eq!(migrated_count, 1);
        assert_eq!(profile.bindings[0].device_id, "midi:1");
        assert_eq!(profile.bindings[1].device_id, "midi:2");
        assert_eq!(migrations.len(), 1);
        assert_eq!(
            migrations[0],
            BindingDeviceMigration {
                binding_id: "platform-fader".to_string(),
                previous_device_id: "midi:2".to_string(),
                device_id: "midi:1".to_string(),
            }
        );
    }
}

use super::*;
use crate::device_target::{parse_device_target, DeviceTargetKind};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ActionExecutionOutcome {
    pub applied_target_indices: Vec<usize>,
    pub value: Option<f32>,
    pub muted: Option<bool>,
    pub integration_button_feedback_owned: bool,
    pub skipped_button_integration_event: bool,
}

impl ActionExecutionOutcome {
    pub fn applied(&self) -> bool {
        !self.applied_target_indices.is_empty()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ActionExecutionContext<'a> {
    pub source: Option<&'a str>,
    pub source_sequence: Option<u64>,
    pub log_target: &'a str,
    pub midi_input: Option<MidiActionInput>,
    pub integrations_only: bool,
}

/// Raw MIDI input and the already resolved edge. Edge resolution stays with the
/// input state machine; target execution owns routing and payload construction.
#[derive(Clone, Copy, Debug)]
pub struct MidiActionInput {
    pub active: bool,
    pub button_event: Option<&'static str>,
}

impl<'a> ActionExecutionContext<'a> {
    pub const fn local(log_target: &'a str) -> Self {
        Self {
            source: None,
            source_sequence: None,
            log_target,
            midi_input: None,
            integrations_only: false,
        }
    }
}

pub fn execute_local_target_action(
    state: &AppState,
    binding_id: &str,
    action: &model::BindingAction,
    target: &BindingTarget,
    value: f32,
    log_target: &str,
) -> bool {
    if matches!(action, model::BindingAction::Volume) && !target.supports_volume()
        || matches!(action, model::BindingAction::ToggleMute) && !target.supports_mute()
    {
        return false;
    }
    let value = value.clamp(0.0, 1.0);
    let muted = value > 0.5;
    let result = match (action, target) {
        (model::BindingAction::Volume, BindingTarget::Master) => state
            .audio
            .set_master_volume(value)
            .map_err(|err| err.to_string()),
        (model::BindingAction::Volume, BindingTarget::Focus) => {
            if state.apply_focus_volume_with_retry(binding_id, value) {
                Ok(())
            } else {
                #[cfg(feature = "perf-audit")]
                crate::perf_audit::record_local_target_result(false);
                return false;
            }
        }
        (model::BindingAction::Volume, BindingTarget::MonitorBrightness { monitor_id, .. }) => {
            crate::monitor_brightness::set_monitor_brightness(monitor_id.as_deref(), value)
        }
        (model::BindingAction::Volume, BindingTarget::Session { session_id }) => state
            .audio
            .set_session_volume(session_id, value)
            .map_err(|err| err.to_string()),
        (model::BindingAction::Volume, BindingTarget::Application { name, .. }) => state
            .audio
            .set_application_volume(name, value)
            .map_err(|err| err.to_string()),
        (model::BindingAction::Volume, BindingTarget::Device { device_id }) => state
            .audio
            .set_device_volume(device_id, value)
            .map_err(|err| err.to_string()),
        (model::BindingAction::ToggleMute, BindingTarget::Master) => state
            .audio
            .set_master_mute(muted)
            .map_err(|err| err.to_string()),
        (model::BindingAction::ToggleMute, BindingTarget::Focus) => {
            if state.audio.focused_session().ok().flatten().is_none() {
                #[cfg(feature = "perf-audit")]
                crate::perf_audit::record_local_target_result(false);
                return false;
            }
            state
                .audio
                .set_focused_session_mute(muted)
                .map_err(|err| err.to_string())
        }
        (model::BindingAction::ToggleMute, BindingTarget::Session { session_id }) => state
            .audio
            .set_session_mute(session_id, muted)
            .map_err(|err| err.to_string()),
        (model::BindingAction::ToggleMute, BindingTarget::Application { name, .. }) => state
            .audio
            .set_application_mute(name, muted)
            .map_err(|err| err.to_string()),
        (model::BindingAction::ToggleMute, BindingTarget::Device { device_id }) => state
            .audio
            .set_device_mute(device_id, muted)
            .map_err(|err| err.to_string()),
        (model::BindingAction::SetDefaultDevice, BindingTarget::Device { device_id }) => state
            .audio
            .set_default_device(device_id)
            .map_err(|err| err.to_string()),
        _ => return false,
    };

    #[cfg(feature = "perf-audit")]
    crate::perf_audit::record_local_target_result(result.is_ok());
    match result {
        Ok(()) => {
            // Brightness has no readback feedback; remember successful writes.
            if binding_id != "profile_restore" && matches!(action, model::BindingAction::Volume) {
                crate::profile_target_state::observe_brightness(state, target, value);
            }
            true
        }
        Err(err) => {
            run_logger::warn(
                log_target,
                "target_action_failed",
                &format!(
                    "binding_id={} action={:?} target={:?} error={}",
                    binding_id, action, target, err
                ),
            );
            false
        }
    }
}

pub fn execute_target_action(
    app: &AppHandle,
    state: &AppState,
    binding: &Binding,
    action: &model::BindingAction,
    value: f32,
    context: ActionExecutionContext<'_>,
) -> Result<ActionExecutionOutcome, String> {
    let ActionExecutionContext {
        source,
        source_sequence,
        log_target,
        midi_input,
        integrations_only,
    } = context;
    let targets = binding.normalized_targets_ref();
    if targets.is_empty() {
        return Ok(ActionExecutionOutcome::default());
    }
    let default_device_indices =
        if *action == model::BindingAction::SetDefaultDevice && !integrations_only {
            Some(default_device_target_indices(state, targets)?)
        } else {
            None
        };
    #[cfg(feature = "perf-audit")]
    crate::perf_audit::record_requested_targets(default_device_indices.as_ref().map_or_else(
        || {
            targets
                .iter()
                .filter(|target| {
                    !integrations_only || matches!(target, BindingTarget::Integration { .. })
                })
                .count()
        },
        Vec::len,
    ));

    let value = value.clamp(0.0, 1.0);
    let muted = value > 0.5;
    let mut outcome = ActionExecutionOutcome {
        value: matches!(action, model::BindingAction::Volume).then_some(value),
        muted: matches!(action, model::BindingAction::ToggleMute).then_some(muted),
        ..Default::default()
    };
    let mut integration_volume_batches: HashMap<String, Vec<serde_json::Value>> = HashMap::new();

    for (target_index, target) in targets.iter().enumerate() {
        if default_device_indices
            .as_ref()
            .is_some_and(|indices| !indices.contains(&target_index))
        {
            continue;
        }
        if integrations_only && !matches!(target, BindingTarget::Integration { .. }) {
            continue;
        }
        if matches!(action, model::BindingAction::Volume)
            && append_integration_volume_target(
                binding,
                target,
                target_index,
                targets.len(),
                midi_input,
                &mut integration_volume_batches,
                &mut outcome,
            )
        {
            continue;
        }

        if let BindingTarget::Integration {
            integration_id,
            kind,
            data,
        } = target
        {
            if action_is_stateful_integration_toggle(action)
                || action_is_momentary_integration_action(action)
            {
                emit_integration_binding_triggered(
                    app,
                    IntegrationTrigger {
                        binding_id: &binding.id,
                        action,
                        value,
                        target_index,
                        target_count: targets.len(),
                        integration_id,
                        kind,
                        data,
                        source,
                        source_sequence,
                    },
                );
                outcome.applied_target_indices.push(target_index);
            }
            continue;
        }

        if execute_local_target_action(state, &binding.id, action, target, value, log_target) {
            outcome.applied_target_indices.push(target_index);
        }
    }

    for (integration_id, mut grouped_targets) in integration_volume_batches {
        finalize_grouped_integration_targets(&mut grouped_targets);
        emit_integration_binding_triggered_batch(
            app,
            IntegrationBatchTrigger {
                binding_id: &binding.id,
                action,
                value,
                integration_id: &integration_id,
                targets: grouped_targets,
                source,
                source_sequence,
            },
        );
    }

    Ok(outcome)
}

/// One selected endpoint sets the default. Multiple endpoints cycle in selection
/// order from the live default, independently for playback and recording.
fn default_device_target_indices(
    state: &AppState,
    targets: &[BindingTarget],
) -> Result<Vec<usize>, String> {
    let mut selected = Vec::new();
    for kind in [DeviceTargetKind::Playback, DeviceTargetKind::Recording] {
        let mut candidates = Vec::new();
        for (index, target) in targets.iter().enumerate() {
            if let BindingTarget::Device { device_id } = target {
                let (target_kind, raw_id) = parse_device_target(device_id);
                if target_kind == kind && !candidates.iter().any(|(_, id)| *id == raw_id) {
                    candidates.push((index, raw_id));
                }
            }
        }
        if candidates.len() <= 1 {
            selected.extend(candidates.iter().map(|(index, _)| *index));
            continue;
        }
        let devices = match kind {
            DeviceTargetKind::Playback => state.audio.list_playback_devices(),
            DeviceTargetKind::Recording => state.audio.list_recording_devices(),
        }
        .map_err(|err| err.to_string())?;
        // Unplugged devices must not stop a cycle through available endpoints.
        candidates.retain(|(_, id)| devices.iter().any(|device| device.id == *id));
        if candidates.is_empty() {
            continue;
        }
        let current = candidates.iter().position(|(_, id)| {
            devices
                .iter()
                .any(|device| device.id == *id && device.is_default)
        });
        let next = current.map_or(0, |index| (index + 1) % candidates.len());
        selected.push(candidates[next].0);
    }
    Ok(selected)
}

fn append_integration_volume_target(
    binding: &Binding,
    target: &BindingTarget,
    target_index: usize,
    target_count: usize,
    midi_input: Option<MidiActionInput>,
    integration_volume_batches: &mut HashMap<String, Vec<serde_json::Value>>,
    outcome: &mut ActionExecutionOutcome,
) -> bool {
    if let BindingTarget::Integration {
        integration_id,
        kind,
        data,
    } = target
    {
        let button_kind = midi_input
            .filter(|_| binding.is_button_binding())
            .and_then(|_| integration_volume_button_action_kind(integration_id, kind, data));
        if button_kind.is_some() {
            outcome.integration_button_feedback_owned = true;
            if midi_input.and_then(|input| input.button_event).is_none() {
                outcome.skipped_button_integration_event = true;
                return true;
            }
        }
        let group_index = integration_volume_batches
            .get(integration_id)
            .map(Vec::len)
            .unwrap_or(0);
        let mut grouped_target = serde_json::json!({
            "target": {
                "integration_id": integration_id,
                "kind": kind,
                "data": data,
            },
            "target_index": group_index,
            "target_count": 0,
            "is_primary_target": target_index == 0,
            "original_target_index": target_index,
            "binding_target_count": target_count,
        });
        if let Some(input) = midi_input {
            grouped_target["button_event"] = serde_json::json!(button_kind.and(input.button_event));
            grouped_target["button_action_kind"] =
                serde_json::json!(button_kind.map(IntegrationButtonActionKind::as_str));
            grouped_target["button_input_active"] = serde_json::json!(input.active);
        }
        integration_volume_batches
            .entry(integration_id.clone())
            .or_default()
            .push(grouped_target);
        outcome.applied_target_indices.push(target_index);
        return true;
    }
    false
}

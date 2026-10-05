use crate::model::{BindingAction, BindingTarget, Profile, ProfileTargetState};
use crate::AppState;
#[cfg(test)]
mod tests;

#[derive(Default)]
pub(crate) struct Runtime {
    name: String,
    states: Vec<ProfileTargetState>,
    pending: Vec<BindingTarget>,
}

// Labels and derived icons can change on reconnect without changing the target.
fn same_target(left: &BindingTarget, right: &BindingTarget) -> bool {
    match (left, right) {
        (
            BindingTarget::Integration {
                integration_id: left_id,
                kind: left_kind,
                data: left_data,
            },
            BindingTarget::Integration {
                integration_id: right_id,
                kind: right_kind,
                data: right_data,
            },
        ) => {
            fn identity(data: &serde_json::Value) -> serde_json::Value {
                let mut data = data.clone();
                if let Some(data) = data.as_object_mut() {
                    for key in [
                        "label",
                        "icon_data",
                        "iconData",
                        "display_label",
                        "displayLabel",
                        "action_label",
                        "action_value",
                        "action_kind",
                        "button_action",
                        "osd_value_text",
                    ] {
                        data.remove(key);
                    }
                }
                data
            }
            left_id == right_id
                && left_kind == right_kind
                && identity(left_data) == identity(right_data)
        }
        _ => left == right,
    }
}

pub(crate) fn contains_target(profile: &Profile, target: &BindingTarget) -> bool {
    profile.bindings.iter().any(|binding| {
        matches!(
            binding.action,
            BindingAction::Volume | BindingAction::ToggleMute | BindingAction::ToggleEffect
        ) && binding
            .normalized_targets_ref()
            .iter()
            .any(|bound| same_target(bound, target))
    })
}

fn native(target: &BindingTarget) -> bool {
    target.supports_volume() && !matches!(target, BindingTarget::Integration { .. })
}

impl Runtime {
    pub(crate) fn activate(&mut self, profile: &Profile, restore: bool) {
        let states = profile
            .target_states
            .iter()
            .filter(|entry| contains_target(profile, &entry.target))
            .cloned()
            .collect::<Vec<_>>();
        if restore {
            self.pending = states
                .iter()
                .filter(|entry| native(&entry.target))
                .map(|entry| entry.target.clone())
                .collect();
        } else {
            self.pending
                .retain(|target| contains_target(profile, target));
        }
        self.name = profile.name.clone();
        self.states = states;
    }

    pub(crate) fn include_in(&self, profile: &mut Profile) {
        if self.name == profile.name {
            profile.target_states = self
                .states
                .iter()
                .filter(|entry| contains_target(profile, &entry.target))
                .cloned()
                .collect();
        }
    }

    fn observe(&mut self, entry: ProfileTargetState) {
        if let Some(previous) = self
            .states
            .iter_mut()
            .find(|previous| same_target(&previous.target, &entry.target))
        {
            *previous = entry;
        } else {
            self.states.push(entry);
        }
    }
}

// Use the same audio enumeration as MIDI feedback. Missing targets keep their
// last saved state until they become available; they must not be saved as zero.
pub(crate) fn observe_audio(
    state: &AppState,
    profile: &Profile,
    sessions: &[crate::model::SessionInfo],
    focused: Option<&crate::model::SessionInfo>,
    playback: &[crate::model::PlaybackDeviceInfo],
    recording: &[crate::model::PlaybackDeviceInfo],
) {
    let mut observed = Vec::<ProfileTargetState>::new();
    for binding in &profile.bindings {
        if !matches!(
            binding.action,
            BindingAction::Volume | BindingAction::ToggleMute
        ) {
            continue;
        }
        for target in binding.normalized_targets_ref().iter() {
            if observed.iter().any(|entry| entry.target == *target) {
                continue;
            }
            let snapshot = crate::audio::target_state::target_snapshot(
                target, sessions, focused, playback, recording,
            );
            if let (Some(volume), Some(muted)) = (snapshot.value, snapshot.muted) {
                observed.push(ProfileTargetState {
                    target: target.clone(),
                    state: serde_json::json!({"volume": volume, "muted": muted}),
                });
            }
        }
    }
    sync_native(state, profile, observed);
}

pub(crate) fn sync_native(
    state: &AppState,
    profile: &Profile,
    mut observed: Vec<ProfileTargetState>,
) {
    if state.solo.is_active() {
        return;
    }
    let Ok(mut runtime) = state.profile_target_state.lock() else {
        return;
    };
    if runtime.name != profile.name {
        return;
    }
    observed.extend(
        runtime
            .states
            .iter()
            .filter(|entry| {
                matches!(entry.target, BindingTarget::MonitorBrightness { .. })
                    && runtime.pending.contains(&entry.target)
            })
            .cloned(),
    );
    for entry in observed {
        if runtime.pending.contains(&entry.target) {
            let Some(saved) = runtime
                .states
                .iter()
                .find(|saved| saved.target == entry.target)
            else {
                continue;
            };
            if restore_native(state, saved) {
                runtime.pending.retain(|target| *target != entry.target);
            }
            // This enumeration predates the restore, so do not capture it.
            continue;
        }
        runtime.observe(entry);
    }
}

fn restore_native(state: &AppState, entry: &ProfileTargetState) -> bool {
    let mut applied = true;
    for (field, action) in [
        ("volume", BindingAction::Volume),
        ("muted", BindingAction::ToggleMute),
    ] {
        let value = if field == "volume" {
            entry.state[field]
                .as_f64()
                .filter(|value| value.is_finite())
                .map(|value| value.clamp(0.0, 1.0) as f32)
        } else {
            entry.state[field]
                .as_bool()
                .map(|value| if value { 1.0 } else { 0.0 })
        };
        if let Some(value) = value {
            applied &= crate::binding_actions::execute_local_target_action(
                state,
                "profile_restore",
                &action,
                &entry.target,
                value,
                "profiles",
            );
        }
    }
    applied
}

pub(crate) fn observe_brightness(state: &AppState, target: &BindingTarget, value: f32) {
    if !matches!(target, BindingTarget::MonitorBrightness { .. }) {
        return;
    }
    if let Ok(mut runtime) = state.profile_target_state.lock() {
        runtime.pending.retain(|pending| pending != target);
        runtime.observe(ProfileTargetState {
            target: target.clone(),
            state: serde_json::json!({"volume": value}),
        });
    }
}

pub(crate) fn checkpoint(state: &AppState) -> Result<(), String> {
    let profile = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned")?
        .clone();
    let Some(profile) = profile else {
        return Ok(());
    };
    let runtime = state
        .profile_target_state
        .lock()
        .map_err(|_| "Lock poisoned")?;
    if runtime.name != profile.name {
        return Ok(());
    }
    let entries = runtime
        .states
        .iter()
        .filter(|entry| contains_target(&profile, &entry.target))
        .cloned()
        .collect();
    drop(runtime);
    state
        .profile_store
        .update_target_states(&profile.name, entries)
        .map_err(|error| error.to_string())
}

pub(crate) fn update_integrations(
    state: &AppState,
    name: &str,
    entries: Vec<ProfileTargetState>,
) -> Result<(), String> {
    if state.solo.is_active() {
        return Ok(());
    }
    let profile = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned")?
        .clone();
    let Some(profile) = profile.filter(|profile| profile.name == name) else {
        return Ok(());
    };
    let mut runtime = state
        .profile_target_state
        .lock()
        .map_err(|_| "Lock poisoned")?;
    if runtime.name != name {
        return Ok(());
    }
    for entry in entries {
        if matches!(entry.target, BindingTarget::Integration { .. })
            && contains_target(&profile, &entry.target)
            && entry.state.is_object()
        {
            runtime.observe(entry);
        }
    }
    Ok(())
}

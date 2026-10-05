//! Pure, conservative planning of route ownership changes. Port indices are not identities.
use crate::model::{Binding, MidiDevicePreference, MidiDeviceRoute, Profile};
use std::collections::HashSet;

fn name(route: &MidiDeviceRoute) -> Option<&str> {
    route
        .input_device_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub(crate) fn same_input(left: &MidiDeviceRoute, right: &MidiDeviceRoute) -> bool {
    match (name(left), name(right)) {
        (Some(a), Some(b)) => a == b,
        _ => left.input_id().is_some() && left.input_id() == right.input_id(),
    }
}

pub(crate) fn same_connection(left: &MidiDeviceRoute, right: &MidiDeviceRoute) -> bool {
    let compatible = |a: &Option<String>, b: &Option<String>| match (a, b) {
        (Some(a), Some(b)) => a.trim() == b.trim(),
        _ => true, // Legacy commands may specify only the port index.
    };
    left.input_id() == right.input_id()
        && left.output_id() == right.output_id()
        && compatible(&left.input_device_name, &right.input_device_name)
        && compatible(&left.output_device_name, &right.output_device_name)
}

fn source_index(saved: &[MidiDeviceRoute], next: &MidiDeviceRoute) -> Option<usize> {
    let matches = saved
        .iter()
        .enumerate()
        .filter(|(_, old)| same_input(old, next))
        .collect::<Vec<_>>();
    // Duplicate names only retain an unchanged, exact assignment. Never exchange them.
    if matches.len() == 1 {
        return Some(matches[0].0);
    }
    matches
        .into_iter()
        .find(|(_, old)| old.input_id() == next.input_id())
        .map(|(i, _)| i)
}

fn control_ids(binding: &Binding) -> impl Iterator<Item = &str> {
    std::iter::once(binding.device_id.as_str())
        .chain(
            binding
                .additional_outputs
                .iter()
                .map(|output| output.control.device_id.as_str()),
        )
        .chain(
            [
                &binding.mute_control,
                &binding.assign_control,
                &binding.indicator_control,
                &binding.led_control,
            ]
            .into_iter()
            .filter_map(|c| c.as_ref().map(|c| c.device_id.as_str())),
        )
        .chain(
            binding
                .modifier_controls()
                .map(|(_, control, _)| control.device_id.as_str()),
        )
}

/// Remove incomplete swaps/chains, including chains into disabled or missing routes.
/// This runs before opening handles and again against the handles that actually opened.
pub(crate) fn safe_routes(
    profile: &Profile,
    requested: &[MidiDeviceRoute],
) -> Vec<MidiDeviceRoute> {
    let saved = profile.midi_device_preference.normalized_routes();
    let sources = requested
        .iter()
        .map(|r| source_index(&saved, r))
        .collect::<Vec<_>>();
    let mut allowed = requested
        .iter()
        .enumerate()
        .map(|(i, next)| {
            if !next.enabled {
                return false;
            }
            let Some(source) = sources[i] else {
                if saved.iter().any(|old| same_input(old, next)) {
                    return false;
                }
                // A new route cannot take a saved device's address or an orphaned control.
                return !saved.iter().any(|old| old.input_id() == next.input_id())
                    && (saved.is_empty()
                        || !profile
                            .bindings
                            .iter()
                            .flat_map(control_ids)
                            .any(|id| Some(id) == next.input_id()));
            };
            let old = &saved[source];
            if old.input_id() == next.input_id() {
                return true;
            }
            name(old).is_some()
                && name(old) == name(next)
                && saved.iter().filter(|r| name(r) == name(old)).count() == 1
                && requested.iter().filter(|r| name(r) == name(next)).count() == 1
                && !(profile
                    .bindings
                    .iter()
                    .flat_map(control_ids)
                    .any(|id| Some(id) == next.input_id())
                    && !saved.iter().any(|r| r.input_id() == next.input_id()))
        })
        .collect::<Vec<_>>();

    loop {
        let before = allowed.clone();
        for (i, next) in requested.iter().enumerate() {
            if !before[i] {
                continue;
            }
            let Some(source) = sources[i] else {
                continue;
            };
            let old = &saved[source];
            for (other, owner) in saved.iter().enumerate() {
                if source == other {
                    continue;
                }
                // Both ends of an overlapping move must commit together.
                let shares_destination = owner.input_id() == next.input_id();
                let shares_source = requested
                    .iter()
                    .enumerate()
                    .any(|(j, r)| sources[j] == Some(other) && r.input_id() == old.input_id());
                if (shares_destination || shares_source)
                    && !requested.iter().enumerate().any(|(j, r)| {
                        before[j] && sources[j] == Some(other) && r.input_id() != next.input_id()
                    })
                {
                    allowed[i] = false;
                }
            }
        }
        if allowed == before {
            break;
        }
    }
    requested
        .iter()
        .zip(allowed)
        .filter_map(|(r, ok)| ok.then_some(r.clone()))
        .collect()
}

/// Produce one candidate profile containing both the new route baseline and its controls.
pub(crate) fn reconciled_profile(
    profile: &Profile,
    desired: &[MidiDeviceRoute],
    connected: &[MidiDeviceRoute],
) -> Profile {
    let saved = profile.midi_device_preference.normalized_routes();
    let accepted = safe_routes(profile, connected);
    let moves = accepted
        .iter()
        .filter_map(|next| {
            let old = &saved[source_index(&saved, next)?];
            (old.input_id() != next.input_id()).then_some((old.input_id()?, next.input_id()?))
        })
        .collect::<Vec<_>>();
    let mut updated = profile.clone();
    for binding in &mut updated.bindings {
        let migrate = |id: &mut String| {
            if let Some((_, next)) = moves.iter().find(|(old, _)| *old == id.as_str()) {
                *id = (*next).to_string();
            }
        };
        migrate(&mut binding.device_id);
        for output in &mut binding.additional_outputs {
            migrate(&mut output.control.device_id);
        }
        for modifier in binding.modifiers.iter_mut().flatten() {
            if let Some(control) = modifier.control.as_mut() {
                migrate(&mut control.device_id);
            }
        }
        for control in [
            &mut binding.mute_control,
            &mut binding.assign_control,
            &mut binding.indicator_control,
            &mut binding.led_control,
        ]
        .into_iter()
        .flatten()
        {
            migrate(&mut control.device_id);
        }
    }
    let routes = desired
        .iter()
        .map(|next| {
            if next.enabled && !accepted.iter().any(|r| same_connection(r, next)) {
                if let Some(i) = source_index(&saved, next) {
                    let mut old = saved[i].clone();
                    old.enabled = next.enabled;
                    return old;
                }
            }
            next.clone()
        })
        .collect::<Vec<_>>();
    let first = routes.first().cloned().unwrap_or_default();
    updated.midi_device_preference = MidiDevicePreference {
        input_device_id: first.input_device_id,
        output_device_id: first.output_device_id,
        input_device_name: first.input_device_name,
        output_device_name: first.output_device_name,
        routes,
    };
    updated.midi_device_preference_set = true;
    updated
}

pub(crate) fn allows_single_device_fallback(profile: &Profile) -> bool {
    let routes = profile.midi_device_preference.normalized_routes();
    let ids = profile
        .bindings
        .iter()
        .flat_map(control_ids)
        .filter(|id| id.starts_with("midi:"))
        .collect::<HashSet<_>>();
    routes.len() <= 1 && ids.len() <= 1
}

pub(crate) fn publish_profile(
    slot: &mut Option<std::sync::Arc<crate::profile_snapshot::ProfileSnapshot>>,
    candidate: &Profile,
    save: impl FnOnce(&Profile) -> Result<(), String>,
) -> Result<(), String> {
    if slot
        .as_ref()
        .and_then(|p| serde_json::to_value(p.profile()).ok())
        == serde_json::to_value(candidate).ok()
    {
        return Ok(());
    }
    save(candidate)?;
    *slot = Some(std::sync::Arc::new(
        crate::profile_snapshot::ProfileSnapshot::new(candidate.clone()),
    ));
    Ok(())
}

#[cfg(test)]
#[path = "midi_reconciliation_tests.rs"]
mod tests;

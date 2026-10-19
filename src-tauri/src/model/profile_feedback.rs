//! Keep profile files readable by releases that only know FollowValue/AudioReactive.
//! IPC still uses AlwaysOn; only disk/export storage uses the compatible fallback.
use super::{FeedbackMode, Profile};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const COMPAT_KEY: &str = "__midimaster_core_led_modes";

#[derive(Default, Serialize, Deserialize)]
struct LedModes {
    version: u32,
    #[serde(default)]
    always_on_binding_ids: BTreeSet<String>,
    #[serde(default)]
    always_on_outputs: BTreeMap<String, BTreeSet<String>>,
}

fn metadata(value: &serde_json::Value) -> Option<LedModes> {
    let modes: LedModes = serde_json::from_value(value.clone()).ok()?;
    (modes.version == 1).then_some(modes)
}

fn store_mode(mode: &mut FeedbackMode, id: &str, ids: &mut BTreeSet<String>) -> bool {
    match mode {
        FeedbackMode::AlwaysOn => {
            ids.insert(id.to_owned());
            *mode = FeedbackMode::FollowValue;
            true
        }
        FeedbackMode::AudioReactive => ids.remove(id),
        // Old releases preserve the metadata while saving the fallback mode.
        FeedbackMode::FollowValue => false,
    }
}

pub(super) fn normalize_for_storage(profile: &mut Profile) -> bool {
    let mut modes = profile
        .plugin_settings
        .get(COMPAT_KEY)
        .and_then(metadata)
        .unwrap_or_default();
    let mut changed = false;
    for binding in &mut profile.bindings {
        changed |= store_mode(
            &mut binding.feedback_mode,
            &binding.id,
            &mut modes.always_on_binding_ids,
        );
        let ids = modes
            .always_on_outputs
            .entry(binding.id.clone())
            .or_default();
        for output in &mut binding.additional_outputs {
            changed |= store_mode(&mut output.feedback_mode, &output.id, ids);
        }
        ids.retain(|id| {
            binding
                .additional_outputs
                .iter()
                .any(|output| output.id == *id)
        });
    }
    modes
        .always_on_binding_ids
        .retain(|id| profile.bindings.iter().any(|b| b.id == *id));
    modes
        .always_on_outputs
        .retain(|id, outputs| !outputs.is_empty() && profile.bindings.iter().any(|b| b.id == *id));
    if modes.always_on_binding_ids.is_empty() && modes.always_on_outputs.is_empty() {
        changed |= profile.plugin_settings.remove(COMPAT_KEY).is_some();
    } else {
        modes.version = 1;
        let value = serde_json::json!(modes);
        if profile.plugin_settings.get(COMPAT_KEY) != Some(&value) {
            profile.plugin_settings.insert(COMPAT_KEY.to_owned(), value);
            changed = true;
        }
    }
    changed
}

pub(super) fn restore_from_storage(profile: &mut Profile) -> bool {
    let Some(modes) = profile.plugin_settings.get(COMPAT_KEY).and_then(metadata) else {
        return false;
    };
    profile.plugin_settings.remove(COMPAT_KEY);
    for binding in &mut profile.bindings {
        if binding.feedback_mode == FeedbackMode::FollowValue
            && modes.always_on_binding_ids.contains(&binding.id)
        {
            binding.feedback_mode = FeedbackMode::AlwaysOn;
        }
        if let Some(ids) = modes.always_on_outputs.get(&binding.id) {
            for output in &mut binding.additional_outputs {
                if output.feedback_mode == FeedbackMode::FollowValue && ids.contains(&output.id) {
                    output.feedback_mode = FeedbackMode::AlwaysOn;
                }
            }
        }
    }
    true
}

#[cfg(test)]
mod tests;

use super::*;
use std::collections::HashMap;

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct BindingEdits {
    pub upsert: Vec<Binding>,
    pub remove_ids: Vec<String>,
    pub order: Option<Vec<String>>,
}

impl BindingEdits {
    fn apply(self, bindings: &mut Vec<Binding>, claim_existing: bool) -> Result<(), String> {
        let previous: HashMap<_, _> = bindings.iter().map(|b| (b.id.as_str(), b)).collect();
        let mut claimed = HashSet::new();
        let mut submitted_controls = HashSet::new();
        let mut replacements = HashMap::new();
        let mut append_order = Vec::new();
        for mut binding in self.upsert {
            binding.ensure_targets();
            binding.normalize_button_light_serialization();
            if binding.targets.is_empty() {
                return Err("Binding must have at least one target".into());
            }
            let key = BindingKey::from_binding(&binding);
            let original = previous.get(binding.id.as_str());
            // A label-only edit must also work for imported profiles with shared controls.
            let claims_control =
                claim_existing || original.is_none_or(|old| BindingKey::from_binding(old) != key);
            if !submitted_controls.insert(key.clone()) && (claims_control || claimed.contains(&key))
            {
                return Err("Two edited bindings claim the same MIDI control".into());
            }
            if claims_control {
                claimed.insert(key);
            }
            append_order.push(binding.id.clone());
            if replacements.insert(binding.id.clone(), binding).is_some() {
                return Err("Binding appears twice in an edit".into());
            }
        }
        let removed: HashSet<_> = self.remove_ids.into_iter().collect();
        let edited_ids: HashSet<_> = replacements.keys().cloned().collect();
        bindings.retain_mut(|existing| {
            if let Some(replacement) = replacements.remove(&existing.id) {
                *existing = replacement;
                return true;
            }
            !removed.contains(&existing.id)
                && !edited_ids.contains(&existing.id)
                && !claimed.contains(&BindingKey::from_binding(existing))
        });
        bindings.extend(append_order.iter().filter_map(|id| replacements.remove(id)));
        if let Some(order) = self.order {
            let positions: HashMap<_, _> =
                order.iter().enumerate().map(|(i, id)| (id, i)).collect();
            if positions.len() != bindings.len()
                || order.len() != bindings.len()
                || bindings
                    .iter()
                    .any(|binding| !positions.contains_key(&binding.id))
            {
                return Err("Binding list changed before reorder".into());
            }
            bindings.sort_by_key(|binding| positions[&binding.id]);
        }
        Ok(())
    }
}

pub(crate) fn commit_binding_edits(
    state: &AppState,
    expected_profile: Option<&str>,
    edits: BindingEdits,
) -> Result<Vec<String>, String> {
    let updated_ids: HashSet<_> = edits
        .upsert
        .iter()
        .map(|binding| binding.id.clone())
        .collect();
    let changes_controls = !updated_ids.is_empty() || !edits.remove_ids.is_empty();
    // Finish any in-flight MIDI batch before retiring a control and its hardware feedback.
    let _dispatch = state
        .midi_dispatch_lock
        .lock()
        .map_err(|_| "Lock poisoned")?;
    let mut active = state.active_profile.lock().map_err(|_| "Lock poisoned")?;
    if let Some(expected) = expected_profile {
        if active.as_ref().map(|snapshot| snapshot.name.as_str()) != Some(expected) {
            return Err("Active profile changed before binding edit".into());
        }
    }
    let mut profile = active
        .as_ref()
        .map(|snapshot| snapshot.profile().clone())
        .unwrap_or_else(|| model::Profile {
            name: "Default".into(),
            bindings: vec![],
            osd_settings: Default::default(),
            plugin_settings: Default::default(),
            midi_device_preference: Default::default(),
            midi_device_preference_set: false,
            target_states: vec![],
        });
    let previous = active.clone();
    edits.apply(&mut profile.bindings, expected_profile.is_none())?;
    state
        .profile_store
        .save_configuration(profile.clone())
        .map_err(|err| err.to_string())?;
    let next = AppState::profile_snapshot(profile);
    *active = Some(next.clone());
    drop(active);
    if changes_controls {
        let previous_bindings = previous
            .as_ref()
            .map(|snapshot| snapshot.bindings.as_slice())
            .unwrap_or_default();
        reconcile_edited_bindings(state, previous_bindings, &next, &updated_ids);
    }
    Ok(next
        .bindings
        .iter()
        .map(|binding| binding.id.clone())
        .collect())
}

fn reconcile_edited_bindings(
    state: &AppState,
    before: &[Binding],
    profile: &model::Profile,
    updated: &HashSet<String>,
) {
    let current: HashMap<_, _> = profile.bindings.iter().map(|b| (&b.id, b)).collect();
    let outputs = active_feedback_outputs(&profile.bindings);
    let active_controls: HashSet<_> = profile
        .bindings
        .iter()
        .map(resolved_binding_feedback_control_key)
        .collect();
    state.cancel_activity_button_light_holds();
    for previous in before {
        let replacement = current.get(&previous.id).copied();
        if replacement.is_some() && !updated.contains(&previous.id) {
            continue;
        }
        for output in
            stale_feedback_bindings_for_removed_outputs(std::slice::from_ref(previous), &outputs)
        {
            let clear = should_clear_stale_feedback_hardware(&output, replacement);
            clear_binding_feedback_output(state, &output, clear);
        }
        if replacement.is_none() {
            let key = BindingKey::from_binding(previous);
            if let Ok(mut values) = state.binding_action_values.lock() {
                values.remove(&key);
            }
            if let Ok(mut values) = state.binding_state.lock() {
                values.remove(&key);
            }
            // Ordinary faders also need their motor returned to zero on removal.
            if !binding_has_clearable_feedback_output(previous)
                && !active_controls.contains(&resolved_binding_feedback_control_key(previous))
            {
                clear_binding_feedback_output(state, previous, true);
            }
        }
    }
    feedback::reconcile_assign_feedback_outputs(state, before, &profile.bindings);
    state.sync_feedback_values(profile);
    state.send_idle_button_light_feedback_values(profile);
    for previous in before.iter().filter(|b| updated.contains(&b.id)) {
        let Some(binding) = current.get(&previous.id) else {
            continue;
        };
        let enabled_new_output = !previous.feedback_enabled && binding.feedback_enabled;
        let outputs_changed = previous.additional_outputs != binding.additional_outputs;
        if binding.is_button_binding()
            || !binding.has_value_feedback()
            || !(enabled_new_output || outputs_changed)
        {
            continue;
        }
        let key = BindingKey::from_binding(binding);
        let value = state
            .feedback_values
            .lock()
            .ok()
            .and_then(|values| values.get(&key).copied());
        if let Some(value) = value {
            send_resolved_binding_feedback(
                state,
                binding,
                value,
                false,
                true,
                &format!("feedback_outputs_changed:{}", binding.id),
            );
        }
    }
}

pub fn add_binding(state: &AppState, binding: Binding) -> Result<(), String> {
    commit_binding_edits(
        state,
        None,
        BindingEdits {
            upsert: vec![binding],
            ..Default::default()
        },
    )
    .map(|_| ())
}

pub fn remove_binding(state: &AppState, binding: Binding) -> Result<(), String> {
    if state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned")?
        .is_none()
    {
        return Ok(());
    }
    commit_binding_edits(
        state,
        None,
        BindingEdits {
            remove_ids: vec![binding.id],
            ..Default::default()
        },
    )
    .map(|_| ())
}

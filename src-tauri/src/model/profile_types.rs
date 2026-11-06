use super::binding_types::Binding;
use super::osd_types::OsdSettings;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct MidiDeviceRoute {
    pub input_device_id: Option<String>,
    pub output_device_id: Option<String>,
    pub input_device_name: Option<String>,
    pub output_device_name: Option<String>,
    pub enabled: bool,
}

impl Default for MidiDeviceRoute {
    fn default() -> Self {
        Self {
            input_device_id: None,
            output_device_id: None,
            input_device_name: None,
            output_device_name: None,
            enabled: true,
        }
    }
}

impl MidiDeviceRoute {
    pub fn from_legacy(
        input_device_id: Option<String>,
        output_device_id: Option<String>,
        input_device_name: Option<String>,
        output_device_name: Option<String>,
    ) -> Option<Self> {
        let input_device_id = clean_option(input_device_id);
        let output_device_id = clean_option(output_device_id);
        if input_device_id.is_none() || output_device_id.is_none() {
            return None;
        }

        Some(Self {
            input_device_id,
            output_device_id,
            input_device_name: clean_option(input_device_name),
            output_device_name: clean_option(output_device_name),
            enabled: true,
        })
    }

    pub fn normalized(&self) -> Option<Self> {
        let input_device_id = clean_option(self.input_device_id.clone());
        let output_device_id = clean_option(self.output_device_id.clone());
        if input_device_id.is_none() || output_device_id.is_none() {
            return None;
        }

        Some(Self {
            input_device_id,
            output_device_id,
            input_device_name: clean_option(self.input_device_name.clone()),
            output_device_name: clean_option(self.output_device_name.clone()),
            enabled: self.enabled,
        })
    }

    pub fn input_id(&self) -> Option<&str> {
        self.input_device_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
    }

    pub fn output_id(&self) -> Option<&str> {
        self.output_device_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct MidiDevicePreference {
    pub input_device_id: Option<String>,
    pub output_device_id: Option<String>,
    pub input_device_name: Option<String>,
    pub output_device_name: Option<String>,
    pub routes: Vec<MidiDeviceRoute>,
}

impl MidiDevicePreference {
    pub fn normalized_routes(&self) -> Vec<MidiDeviceRoute> {
        normalized_routes_with_legacy(
            &self.routes,
            self.input_device_id.clone(),
            self.output_device_id.clone(),
            self.input_device_name.clone(),
            self.output_device_name.clone(),
        )
    }
}

pub fn normalized_routes_with_legacy(
    routes: &[MidiDeviceRoute],
    legacy_input_device_id: Option<String>,
    legacy_output_device_id: Option<String>,
    legacy_input_device_name: Option<String>,
    legacy_output_device_name: Option<String>,
) -> Vec<MidiDeviceRoute> {
    let mut normalized = Vec::new();
    for route in routes {
        let Some(route) = route.normalized() else {
            continue;
        };
        let Some(input_id) = route.input_id() else {
            continue;
        };
        if normalized
            .iter()
            .any(|existing: &MidiDeviceRoute| existing.input_id() == Some(input_id))
        {
            continue;
        }
        normalized.push(route);
    }

    if normalized.is_empty() {
        if let Some(route) = MidiDeviceRoute::from_legacy(
            legacy_input_device_id,
            legacy_output_device_id,
            legacy_input_device_name,
            legacy_output_device_name,
        ) {
            normalized.push(route);
        }
    }

    normalized
}

fn clean_option(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub bindings: Vec<Binding>,
    #[serde(default)]
    pub osd_settings: OsdSettings,
    #[serde(default)]
    pub plugin_settings: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub midi_device_preference: MidiDevicePreference,
    #[serde(default)]
    pub midi_device_preference_set: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_states: Vec<ProfileTargetState>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileTargetState {
    pub target: super::BindingTarget,
    pub state: serde_json::Value,
}

impl Profile {
    /// Normalize current and legacy bindings at profile import/load boundaries.
    pub(crate) fn normalize_bindings(&mut self) -> bool {
        let mut changed = false;
        for binding in &mut self.bindings {
            let before_targets = binding.targets.clone();
            let before_target = binding.target.clone();
            binding.ensure_targets();
            changed |= binding.normalize_button_light_serialization();
            if binding.targets != before_targets || binding.target != before_target {
                changed = true;
            }
        }
        changed
    }

    pub(crate) fn strip_derived_integration_icons(&mut self) -> bool {
        let mut changed = false;
        for binding in &mut self.bindings {
            changed |= binding.strip_derived_integration_icons();
        }
        for entry in &mut self.target_states {
            if let super::BindingTarget::Integration { data, .. } = &mut entry.target {
                if let Some(data) = data.as_object_mut() {
                    changed |= data.remove("icon_data").is_some();
                    changed |= data.remove("iconData").is_some();
                }
            }
            if let super::BindingTarget::Application { icon_data, .. } = &mut entry.target {
                changed |= icon_data.take().is_some();
            }
        }
        changed
    }

    pub fn normalize_for_storage(&mut self) -> bool {
        let mut changed = self.strip_derived_integration_icons();
        changed |= super::profile_feedback::normalize_for_storage(self);
        let mut clear_assign_binding_ids = self
            .plugin_settings
            .get(CLEAR_ASSIGN_MODES_COMPAT_KEY)
            .and_then(clear_assign_binding_ids_from_compat_value)
            .unwrap_or_default();
        for binding in &mut self.bindings {
            changed |= binding.normalize_button_light_serialization();
            match binding.assign_mode {
                super::AssignMode::Clear => {
                    clear_assign_binding_ids.insert(binding.id.clone());
                    binding.assign_mode = super::AssignMode::Add;
                    changed = true;
                }
                super::AssignMode::Replace => {
                    changed |= clear_assign_binding_ids.remove(&binding.id);
                }
                super::AssignMode::Add => {}
            }
        }
        clear_assign_binding_ids.retain(|binding_id| {
            self.bindings
                .iter()
                .any(|binding| binding.id == *binding_id)
        });

        if clear_assign_binding_ids.is_empty() {
            changed |= self
                .plugin_settings
                .remove(CLEAR_ASSIGN_MODES_COMPAT_KEY)
                .is_some();
        } else {
            let compat_value = serde_json::json!({
                "version": 1,
                "clear_binding_ids": clear_assign_binding_ids,
            });
            if self.plugin_settings.get(CLEAR_ASSIGN_MODES_COMPAT_KEY) != Some(&compat_value) {
                self.plugin_settings
                    .insert(CLEAR_ASSIGN_MODES_COMPAT_KEY.to_string(), compat_value);
                changed = true;
            }
        }
        changed
    }

    pub fn restore_from_storage(&mut self) -> bool {
        let mut changed = self.strip_derived_integration_icons();
        changed |= super::profile_feedback::restore_from_storage(self);
        let Some(compat_value) = self.plugin_settings.remove(CLEAR_ASSIGN_MODES_COMPAT_KEY) else {
            return changed;
        };
        let Some(clear_assign_binding_ids) =
            clear_assign_binding_ids_from_compat_value(&compat_value)
        else {
            self.plugin_settings
                .insert(CLEAR_ASSIGN_MODES_COMPAT_KEY.to_string(), compat_value);
            return changed;
        };

        for binding in &mut self.bindings {
            if clear_assign_binding_ids.contains(&binding.id)
                && !matches!(binding.assign_mode, super::AssignMode::Replace)
            {
                changed |= !matches!(binding.assign_mode, super::AssignMode::Clear);
                binding.assign_mode = super::AssignMode::Clear;
            }
        }
        changed
    }
}

// MIDIMaster 4.4 rejects an unknown AssignMode before it can recover individual bindings.
// Keep the wire enum legacy-compatible and preserve Clear by binding ID in profile metadata,
// which older versions already round-trip as opaque plugin settings.
const CLEAR_ASSIGN_MODES_COMPAT_KEY: &str = "__midimaster_core_assign_modes";

fn clear_assign_binding_ids_from_compat_value(
    value: &serde_json::Value,
) -> Option<std::collections::BTreeSet<String>> {
    let version = value.get("version")?.as_u64()?;
    if version != 1 {
        return None;
    }
    let ids = value.get("clear_binding_ids")?.as_array()?;
    Some(
        ids.iter()
            .filter_map(|id| id.as_str())
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileSummary {
    pub name: String,
}

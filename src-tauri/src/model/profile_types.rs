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

#[cfg(test)]
mod tests {
    use super::*;

    fn route(input: &str, output: &str, input_name: &str, output_name: &str) -> MidiDeviceRoute {
        MidiDeviceRoute {
            input_device_id: Some(input.to_string()),
            output_device_id: Some(output.to_string()),
            input_device_name: Some(input_name.to_string()),
            output_device_name: Some(output_name.to_string()),
            enabled: true,
        }
    }

    #[test]
    fn normalizes_legacy_pair_into_single_route() {
        let routes = normalized_routes_with_legacy(
            &[],
            Some(" midi:0 ".to_string()),
            Some(" midi:1 ".to_string()),
            Some(" Deck Input ".to_string()),
            Some(" Deck Output ".to_string()),
        );

        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].input_device_id.as_deref(), Some("midi:0"));
        assert_eq!(routes[0].output_device_id.as_deref(), Some("midi:1"));
        assert_eq!(routes[0].input_device_name.as_deref(), Some("Deck Input"));
        assert_eq!(routes[0].output_device_name.as_deref(), Some("Deck Output"));
        assert!(routes[0].enabled);
    }

    #[test]
    fn existing_routes_take_precedence_over_legacy_fields() {
        let routes = normalized_routes_with_legacy(
            &[route("midi:2", "midi:3", "Route Input", "Route Output")],
            Some("midi:0".to_string()),
            Some("midi:1".to_string()),
            Some("Legacy Input".to_string()),
            Some("Legacy Output".to_string()),
        );

        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].input_device_id.as_deref(), Some("midi:2"));
        assert_eq!(routes[0].output_device_id.as_deref(), Some("midi:3"));
    }

    #[test]
    fn duplicate_input_routes_are_dropped_after_first_route() {
        let routes = normalized_routes_with_legacy(
            &[
                route("midi:0", "midi:1", "Deck A", "Out A"),
                route("midi:0", "midi:2", "Deck A duplicate", "Out B"),
                route("midi:3", "midi:4", "Deck B", "Out C"),
            ],
            None,
            None,
            None,
            None,
        );

        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].output_device_id.as_deref(), Some("midi:1"));
        assert_eq!(routes[1].input_device_id.as_deref(), Some("midi:3"));
    }

    #[test]
    fn disabled_complete_routes_remain_persistable() {
        let mut disabled = route("midi:0", "midi:1", "Deck A", "Out A");
        disabled.enabled = false;

        let routes = normalized_routes_with_legacy(&[disabled], None, None, None, None);

        assert_eq!(routes.len(), 1);
        assert!(!routes[0].enabled);
    }
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
}

impl Profile {
    pub fn normalize_for_storage(&mut self) -> bool {
        let mut changed = false;
        for binding in &mut self.bindings {
            changed |= binding.normalize_button_light_serialization();
        }
        changed
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileSummary {
    pub name: String,
}

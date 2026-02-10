use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub display_name: String,
    pub process_name: Option<String>,
    pub process_path: Option<String>,
    pub icon_data: Option<String>,
    pub volume: f32,
    pub is_muted: bool,
    pub is_master: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackDeviceInfo {
    pub id: String,
    pub display_name: String,
    pub icon_data: Option<String>,
    pub volume: f32,
    pub is_muted: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum MidiMessageType {
    ControlChange,
    Note,
    PitchBend,
}

impl Default for MidiMessageType {
    fn default() -> Self {
        MidiMessageType::ControlChange
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct MidiControl {
    pub channel: u8,
    pub controller: u8,
    #[serde(default)]
    pub msg_type: MidiMessageType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MidiMode {
    Absolute,
    Relative,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum BindingAction {
    Volume,
    ToggleMute,
}

impl Default for BindingAction {
    fn default() -> Self {
        BindingAction::Volume
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub enum BindingTarget {
    Master,
    Focus,
    Session {
        session_id: String,
    },
    Application {
        name: String,
    },
    Device {
        device_id: String,
    },
    /// Generic integration target.
    ///
    /// This is the stable extensibility point for third-party integration plugins.
    ///
    /// Notes:
    /// - `integration_id` should be a stable string (e.g. "obs", "wavelink").
    /// - `kind` is an integration-defined discriminator for the `data` shape.
    /// - `data` is integration-defined JSON.
    Integration {
        integration_id: String,
        kind: String,
        #[serde(default)]
        data: serde_json::Value,
    },
    Unset,
}

// Backward-compatible deserialization for legacy enum variants.
//
// Older profiles stored OBS/WaveLink targets as dedicated enum variants.
// We now collapse those into `BindingTarget::Integration` so new profiles remain
// forward-compatible with the runtime plugin system.
impl<'de> Deserialize<'de> for BindingTarget {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let v = serde_json::Value::deserialize(deserializer)?;
        binding_target_from_value(v).map_err(serde::de::Error::custom)
    }
}

fn binding_target_from_value(v: serde_json::Value) -> Result<BindingTarget, String> {
    // Unit variants are serialized as strings by default.
    if let Some(s) = v.as_str() {
        return match s {
            "Master" => Ok(BindingTarget::Master),
            "Focus" => Ok(BindingTarget::Focus),
            "Unset" => Ok(BindingTarget::Unset),
            other => Err(format!("Unknown BindingTarget string: {}", other)),
        };
    }

    if v.is_null() {
        return Ok(BindingTarget::Unset);
    }

    let obj = v
        .as_object()
        .ok_or_else(|| "BindingTarget must be a string or object".to_string())?;

    // Accept unwrapped integration target shape (defensive).
    if obj.contains_key("integration_id") && obj.contains_key("kind") {
        let integration_id = obj
            .get("integration_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Integration.integration_id missing".to_string())?
            .to_string();
        let kind = obj
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Integration.kind missing".to_string())?
            .to_string();
        let data = obj.get("data").cloned().unwrap_or(serde_json::Value::Null);
        return Ok(BindingTarget::Integration {
            integration_id,
            kind,
            data,
        });
    }

    if obj.len() != 1 {
        return Err("BindingTarget must be a single-key object".to_string());
    }
    let (k, val) = obj.iter().next().unwrap();
    match k.as_str() {
        // Core targets
        "Master" => Ok(BindingTarget::Master),
        "Focus" => Ok(BindingTarget::Focus),
        "Session" => {
            let session_id = val
                .get("session_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Session.session_id missing".to_string())?
                .to_string();
            Ok(BindingTarget::Session { session_id })
        }
        "Application" => {
            let name = val
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Application.name missing".to_string())?
                .to_string();
            Ok(BindingTarget::Application { name })
        }
        "Device" => {
            let device_id = val
                .get("device_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Device.device_id missing".to_string())?
                .to_string();
            Ok(BindingTarget::Device { device_id })
        }
        "Unset" => Ok(BindingTarget::Unset),

        // New generic integration target
        "Integration" => {
            let integration_id = val
                .get("integration_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Integration.integration_id missing".to_string())?
                .to_string();
            let kind = val
                .get("kind")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Integration.kind missing".to_string())?
                .to_string();
            let data = val.get("data").cloned().unwrap_or(serde_json::Value::Null);
            Ok(BindingTarget::Integration {
                integration_id,
                kind,
                data,
            })
        }

        // Legacy OBS targets
        "Obs" | "obs" => {
            let action = val
                .get("action")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Obs.action missing".to_string())?
                .to_string();
            Ok(BindingTarget::Integration {
                integration_id: "obs".to_string(),
                kind: "action".to_string(),
                data: serde_json::json!({ "action": action }),
            })
        }
        "ObsInput" | "obsInput" | "obs_input" => {
            let input_name = val
                .get("input_name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "ObsInput.input_name missing".to_string())?
                .to_string();
            Ok(BindingTarget::Integration {
                integration_id: "obs".to_string(),
                kind: "input".to_string(),
                data: serde_json::json!({ "input_name": input_name }),
            })
        }
        "ObsScene" | "obsScene" | "obs_scene" => {
            let scene_name = val
                .get("scene_name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "ObsScene.scene_name missing".to_string())?
                .to_string();
            Ok(BindingTarget::Integration {
                integration_id: "obs".to_string(),
                kind: "scene".to_string(),
                data: serde_json::json!({ "scene_name": scene_name }),
            })
        }
        "ObsSource" | "obsSource" | "obs_source" => {
            let scene_name = val
                .get("scene_name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "ObsSource.scene_name missing".to_string())?
                .to_string();
            let source_name = val
                .get("source_name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "ObsSource.source_name missing".to_string())?
                .to_string();
            Ok(BindingTarget::Integration {
                integration_id: "obs".to_string(),
                kind: "source".to_string(),
                data: serde_json::json!({ "scene_name": scene_name, "source_name": source_name }),
            })
        }
        "ObsMedia" | "obsMedia" | "obs_media" => {
            let source_name = val
                .get("source_name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "ObsMedia.source_name missing".to_string())?
                .to_string();
            let action = val
                .get("action")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "ObsMedia.action missing".to_string())?
                .to_string();
            Ok(BindingTarget::Integration {
                integration_id: "obs".to_string(),
                kind: "media".to_string(),
                data: serde_json::json!({ "source_name": source_name, "action": action }),
            })
        }

        // Legacy Wave Link target
        "WaveLink" | "wavelink" | "waveLink" => {
            let identifier = val
                .get("identifier")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let mixer_id = val
                .get("mixer_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            Ok(BindingTarget::Integration {
                integration_id: "wavelink".to_string(),
                kind: "endpoint".to_string(),
                data: serde_json::json!({ "identifier": identifier, "mixer_id": mixer_id }),
            })
        }

        other => Err(format!("Unknown BindingTarget variant: {}", other)),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Binding {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub device_id: String,
    pub control: MidiControl,
    pub target: BindingTarget,
    #[serde(default)]
    pub action: BindingAction,
    pub mode: MidiMode,
    pub deadzone: f32,
    pub debounce_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsdSettings {
    pub enabled: bool,
    pub monitor_index: usize,
    #[serde(default)]
    pub monitor_name: Option<String>,
    #[serde(default)]
    pub monitor_id: Option<String>,
    pub anchor: String,
}

impl Default for OsdSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            monitor_index: 0,
            monitor_name: None,
            monitor_id: None,
            anchor: "top-right".to_string(),
        }
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileSummary {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MidiEvent {
    pub device_id: String,
    pub channel: u8,
    pub controller: u8,
    pub value: u8,
    pub value_14: Option<u16>,
    #[serde(default)]
    pub msg_type: MidiMessageType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedControl {
    pub device_id: String,
    pub channel: u8,
    pub controller: u8,
    #[serde(default)]
    pub msg_type: MidiMessageType,
}

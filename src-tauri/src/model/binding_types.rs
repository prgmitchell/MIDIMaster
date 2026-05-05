use super::midi_types::{MidiControl, MidiMessageType};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuxiliaryControl {
    pub device_id: String,
    pub channel: u8,
    pub controller: u8,
    #[serde(default)]
    pub msg_type: MidiMessageType,
    #[serde(default)]
    pub control_kind: BindingControlKind,
    #[serde(default)]
    pub mode: MidiMode,
    #[serde(default)]
    pub deadzone: f32,
    #[serde(default)]
    pub debounce_ms: u64,
    #[serde(default)]
    pub mute_behavior: MuteBehavior,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum BindingControlKind {
    Auto,
    Button,
    Continuous,
}

impl Default for BindingControlKind {
    fn default() -> Self {
        BindingControlKind::Auto
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MidiMode {
    Absolute,
    Relative,
}

impl Default for MidiMode {
    fn default() -> Self {
        MidiMode::Absolute
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum MuteBehavior {
    ToggleOnPress,
    SetFromValue,
}

impl Default for MuteBehavior {
    fn default() -> Self {
        MuteBehavior::ToggleOnPress
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum RelativeFormat {
    Auto,
    TwosComplement,
    BinaryOffset,
    SignMagnitude,
}

impl Default for RelativeFormat {
    fn default() -> Self {
        RelativeFormat::Auto
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum FaderCurve {
    Linear,
    Exponential,
    Logarithmic,
    SCurve,
    Custom,
}

impl Default for FaderCurve {
    fn default() -> Self {
        FaderCurve::Linear
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FaderCurvePoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum BindingAction {
    Volume,
    ToggleMute,
    SetDefaultDevice,
    OpenApplication,
    FocusWindow,
    FullScreenshot,
    SnipScreenshot,
    ToggleScreenRecording,
    MediaPlayPause,
    MediaNextTrack,
    MediaPrevTrack,
    MediaStop,
    Hotkey,
}

impl Default for BindingAction {
    fn default() -> Self {
        BindingAction::Volume
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HotkeyMapping {
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenApplicationMapping {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub display: String,
    #[serde(default)]
    pub icon_data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AssignMode {
    Add,
    Replace,
}

impl Default for AssignMode {
    fn default() -> Self {
        AssignMode::Add
    }
}

#[derive(Debug, Clone, Serialize)]
pub enum BindingTarget {
    Master,
    Focus,
    Session {
        session_id: String,
    },
    Application {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        icon_data: Option<String>,
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
    MediaControl,
    CaptureControl,
    Hotkey,
    OpenApplication,
    Unset,
}

impl PartialEq for BindingTarget {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (BindingTarget::Master, BindingTarget::Master)
            | (BindingTarget::Focus, BindingTarget::Focus)
            | (BindingTarget::MediaControl, BindingTarget::MediaControl)
            | (BindingTarget::CaptureControl, BindingTarget::CaptureControl)
            | (BindingTarget::Hotkey, BindingTarget::Hotkey)
            | (BindingTarget::OpenApplication, BindingTarget::OpenApplication)
            | (BindingTarget::Unset, BindingTarget::Unset) => true,
            (
                BindingTarget::Session { session_id: a },
                BindingTarget::Session { session_id: b },
            ) => a == b,
            (
                BindingTarget::Application { name: a, .. },
                BindingTarget::Application { name: b, .. },
            ) => a.eq_ignore_ascii_case(b),
            (BindingTarget::Device { device_id: a }, BindingTarget::Device { device_id: b }) => {
                a == b
            }
            (
                BindingTarget::Integration {
                    integration_id: a_id,
                    kind: a_kind,
                    data: a_data,
                },
                BindingTarget::Integration {
                    integration_id: b_id,
                    kind: b_kind,
                    data: b_data,
                },
            ) => a_id == b_id && a_kind == b_kind && a_data == b_data,
            _ => false,
        }
    }
}

impl Default for BindingTarget {
    fn default() -> Self {
        BindingTarget::Unset
    }
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
            "MediaControl" => Ok(BindingTarget::MediaControl),
            "CaptureControl" => Ok(BindingTarget::CaptureControl),
            "Hotkey" => Ok(BindingTarget::Hotkey),
            "OpenApplication" => Ok(BindingTarget::OpenApplication),
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
            let display_name = val
                .get("display_name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let icon_data = val
                .get("icon_data")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Ok(BindingTarget::Application {
                name,
                display_name,
                icon_data,
            })
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
        "MediaControl" => Ok(BindingTarget::MediaControl),
        "CaptureControl" => Ok(BindingTarget::CaptureControl),
        "Hotkey" => Ok(BindingTarget::Hotkey),
        "OpenApplication" => Ok(BindingTarget::OpenApplication),

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
    #[serde(default)]
    pub control_kind: BindingControlKind,
    #[serde(default)]
    pub targets: Vec<BindingTarget>,
    #[serde(default, skip_serializing)]
    pub target: BindingTarget,
    #[serde(default)]
    pub action: BindingAction,
    pub mode: MidiMode,
    #[serde(default)]
    pub relative_format: RelativeFormat,
    #[serde(default)]
    pub fader_curve: FaderCurve,
    #[serde(default)]
    pub custom_curve: Vec<FaderCurvePoint>,
    pub deadzone: f32,
    pub debounce_ms: u64,
    #[serde(default)]
    pub mute_behavior: MuteBehavior,
    #[serde(default)]
    pub mute_control: Option<AuxiliaryControl>,
    #[serde(default)]
    pub assign_control: Option<AuxiliaryControl>,
    #[serde(default)]
    pub assign_mode: AssignMode,
    #[serde(default)]
    pub hotkey: Option<HotkeyMapping>,
    #[serde(default)]
    pub open_application: Option<OpenApplicationMapping>,
}

impl Binding {
    pub fn normalized_targets(&self) -> Vec<BindingTarget> {
        if !self.targets.is_empty() {
            self.targets.clone()
        } else if self.target != BindingTarget::Unset {
            vec![self.target.clone()]
        } else {
            Vec::new()
        }
    }

    pub fn primary_target(&self) -> BindingTarget {
        self.normalized_targets()
            .into_iter()
            .next()
            .unwrap_or(BindingTarget::Unset)
    }

    pub fn ensure_targets(&mut self) {
        if self.targets.is_empty() && self.target != BindingTarget::Unset {
            self.targets.push(self.target.clone());
        }
        if self.targets.len() > 1 {
            self.targets.retain(|t| *t != BindingTarget::Unset);
        }
        if self.targets.len() > 8 {
            self.targets.truncate(8);
        }
        if let Some(first) = self.targets.first().cloned() {
            self.target = first;
        } else {
            self.target = BindingTarget::Unset;
        }
    }
}

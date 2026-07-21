use super::midi_types::{MidiControl, MidiMessageType};
use serde::{Deserialize, Serialize, Serializer};

pub const MACRO_MAX_TOP_LEVEL_STEPS: usize = 25;
pub const MACRO_MAX_PARALLEL_STEPS: usize = 8;
pub const MACRO_MAX_WAIT_MS: u64 = 60_000;

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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum BindingControlKind {
    #[default]
    Auto,
    Button,
    Continuous,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub enum MidiMode {
    #[default]
    Absolute,
    Relative,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum MuteBehavior {
    #[default]
    ToggleOnPress,
    SetFromValue,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq, Hash)]
pub enum ButtonLightMode {
    #[default]
    Activity,
    MappedWhenAssigned,
    FollowState,
    InvertState,
    Pressed,
}

impl Serialize for ButtonLightMode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let value = match self {
            ButtonLightMode::MappedWhenAssigned => "MappedWhenAssigned",
            ButtonLightMode::Activity
            | ButtonLightMode::FollowState
            | ButtonLightMode::InvertState
            | ButtonLightMode::Pressed => "Activity",
        };
        serializer.serialize_str(value)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum ButtonLightBehavior {
    #[default]
    FollowState,
    InvertState,
    Pressed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum RelativeFormat {
    #[default]
    Auto,
    TwosComplement,
    BinaryOffset,
    SignMagnitude,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum FaderCurve {
    #[default]
    Linear,
    Exponential,
    Logarithmic,
    SCurve,
    Custom,
}

fn default_curve_segment() -> f32 {
    0.0
}

fn is_default_curve_segment(value: &f32) -> bool {
    value.abs() < f32::EPSILON
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FaderCurvePoint {
    pub x: f32,
    pub y: f32,
    #[serde(
        default = "default_curve_segment",
        skip_serializing_if = "is_default_curve_segment"
    )]
    pub curve: f32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub enum BindingAction {
    #[default]
    Volume,
    ToggleMute,
    ToggleEffect,
    SetMainOutputDevice,
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
    RunAutoHotkeyScript,
    SwitchProfile,
    Macro,
    Soundboard,
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
pub struct AutoHotkeyScriptMapping {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub display: String,
}

fn default_soundboard_volume() -> f32 {
    1.0
}

fn default_soundboard_speed() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SoundboardMapping {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub display: String,
    #[serde(default)]
    pub trim_start_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trim_end_ms: Option<u64>,
    #[serde(default = "default_soundboard_volume")]
    pub volume: f32,
    #[serde(default = "default_soundboard_speed")]
    pub speed: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_device_display: Option<String>,
}

impl SoundboardMapping {
    pub fn normalized(&self) -> Option<Self> {
        let path = self.path.trim();
        if path.is_empty() {
            return None;
        }
        let display = self.display.trim();
        let trim_end_ms = self
            .trim_end_ms
            .map(|end| end.max(self.trim_start_ms.saturating_add(1)));
        let output_device_id = self
            .output_device_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let output_device_display = output_device_id.as_ref().and_then(|_| {
            self.output_device_display
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
        Some(Self {
            path: path.to_string(),
            display: if display.is_empty() {
                std::path::Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(path)
                    .to_string()
            } else {
                display.to_string()
            },
            trim_start_ms: self.trim_start_ms,
            trim_end_ms,
            volume: if self.volume.is_finite() {
                self.volume.clamp(0.0, 1.0)
            } else {
                1.0
            },
            speed: if self.speed.is_finite() {
                self.speed.clamp(0.5, 2.0)
            } else {
                1.0
            },
            output_device_id,
            output_device_display,
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum MacroActionState {
    #[default]
    Default,
    Toggle,
    On,
    Off,
    Mute,
    Unmute,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct MacroActionStep {
    pub action: BindingAction,
    pub targets: Vec<BindingTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f32>,
    #[serde(default)]
    pub state: MacroActionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotkey: Option<HotkeyMapping>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_application: Option<OpenApplicationMapping>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autohotkey_script: Option<AutoHotkeyScriptMapping>,
}

impl Default for MacroActionStep {
    fn default() -> Self {
        Self {
            action: BindingAction::Volume,
            targets: Vec::new(),
            value: None,
            state: MacroActionState::Default,
            action_role: None,
            action_label: None,
            value_kind: None,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MacroStep {
    Action(Box<MacroActionStep>),
    Wait { duration_ms: u64 },
    Parallel { steps: Vec<MacroActionStep> },
}

impl MacroStep {
    pub fn normalized(&self) -> Option<Self> {
        match self {
            MacroStep::Action(step) => {
                normalize_macro_action_step(step).map(|step| MacroStep::Action(Box::new(step)))
            }
            MacroStep::Wait { duration_ms } => Some(MacroStep::Wait {
                duration_ms: (*duration_ms).min(MACRO_MAX_WAIT_MS),
            }),
            MacroStep::Parallel { steps } => {
                let normalized: Vec<MacroActionStep> = steps
                    .iter()
                    .filter_map(normalize_macro_action_step)
                    .take(MACRO_MAX_PARALLEL_STEPS)
                    .collect();
                if normalized.is_empty() {
                    None
                } else {
                    Some(MacroStep::Parallel { steps: normalized })
                }
            }
        }
    }

    pub fn normalized_draft(&self) -> Option<Self> {
        match self {
            MacroStep::Action(step) => normalize_macro_draft_action_step(step)
                .map(|step| MacroStep::Action(Box::new(step))),
            MacroStep::Wait { duration_ms } => Some(MacroStep::Wait {
                duration_ms: (*duration_ms).min(MACRO_MAX_WAIT_MS),
            }),
            MacroStep::Parallel { steps } => {
                let normalized: Vec<MacroActionStep> = steps
                    .iter()
                    .filter_map(normalize_macro_draft_action_step)
                    .take(MACRO_MAX_PARALLEL_STEPS)
                    .collect();
                Some(MacroStep::Parallel { steps: normalized })
            }
        }
    }
}

pub fn normalize_macro_steps(steps: &[MacroStep]) -> Vec<MacroStep> {
    steps
        .iter()
        .filter_map(MacroStep::normalized)
        .take(MACRO_MAX_TOP_LEVEL_STEPS)
        .collect()
}

pub fn normalize_macro_draft_steps(steps: &[MacroStep]) -> Vec<MacroStep> {
    steps
        .iter()
        .filter_map(MacroStep::normalized_draft)
        .take(MACRO_MAX_TOP_LEVEL_STEPS)
        .collect()
}

fn normalize_macro_action_step(step: &MacroActionStep) -> Option<MacroActionStep> {
    if matches!(
        step.action,
        BindingAction::Macro | BindingAction::Soundboard
    ) {
        return None;
    }

    let targets: Vec<BindingTarget> = step
        .targets
        .iter()
        .filter(|target| {
            !matches!(
                target,
                BindingTarget::Unset | BindingTarget::Macro | BindingTarget::Soundboard
            )
        })
        .take(8)
        .cloned()
        .collect();

    if targets.is_empty() {
        return None;
    }

    Some(MacroActionStep {
        action: step.action.clone(),
        targets,
        value: step.value.map(|value| value.clamp(0.0, 1.0)),
        state: step.state.clone(),
        action_role: normalize_macro_action_text(step.action_role.as_deref()),
        action_label: normalize_macro_action_text(step.action_label.as_deref()),
        value_kind: normalize_macro_action_text(step.value_kind.as_deref()),
        hotkey: step.hotkey.clone(),
        open_application: step.open_application.clone(),
        autohotkey_script: step.autohotkey_script.clone(),
    })
}

fn normalize_macro_draft_action_step(step: &MacroActionStep) -> Option<MacroActionStep> {
    let is_nested_macro_action = matches!(
        step.action,
        BindingAction::Macro | BindingAction::Soundboard
    );
    let action = if is_nested_macro_action {
        BindingAction::Volume
    } else {
        step.action.clone()
    };
    let targets: Vec<BindingTarget> = if is_nested_macro_action {
        Vec::new()
    } else {
        step.targets
            .iter()
            .filter(|target| {
                !matches!(
                    target,
                    BindingTarget::Unset | BindingTarget::Macro | BindingTarget::Soundboard
                )
            })
            .take(8)
            .cloned()
            .collect()
    };

    Some(MacroActionStep {
        action,
        targets,
        value: step.value.map(|value| value.clamp(0.0, 1.0)),
        state: step.state.clone(),
        action_role: normalize_macro_action_text(step.action_role.as_deref()),
        action_label: normalize_macro_action_text(step.action_label.as_deref()),
        value_kind: normalize_macro_action_text(step.value_kind.as_deref()),
        hotkey: step.hotkey.clone(),
        open_application: step.open_application.clone(),
        autohotkey_script: step.autohotkey_script.clone(),
    })
}

fn normalize_macro_action_text(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(80).collect())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub enum AssignMode {
    Replace,
    Clear,
    #[default]
    // A future assign mode must not make an entire profile store unreadable.
    #[serde(other)]
    Add,
}

#[derive(Debug, Clone, Default, Serialize)]
pub enum BindingTarget {
    Master,
    Focus,
    MonitorBrightness {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        monitor_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
    },
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
    AutoHotkeyScript,
    Profile {
        name: String,
    },
    Macro,
    Soundboard,
    #[default]
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
            | (BindingTarget::AutoHotkeyScript, BindingTarget::AutoHotkeyScript)
            | (BindingTarget::Macro, BindingTarget::Macro)
            | (BindingTarget::Soundboard, BindingTarget::Soundboard)
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
                BindingTarget::MonitorBrightness { monitor_id: a, .. },
                BindingTarget::MonitorBrightness { monitor_id: b, .. },
            ) => a == b,
            (BindingTarget::Profile { name: a }, BindingTarget::Profile { name: b }) => a == b,
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
            "MonitorBrightness" => Ok(BindingTarget::MonitorBrightness {
                monitor_id: None,
                display_name: None,
            }),
            "MediaControl" => Ok(BindingTarget::MediaControl),
            "CaptureControl" => Ok(BindingTarget::CaptureControl),
            "Hotkey" => Ok(BindingTarget::Hotkey),
            "OpenApplication" => Ok(BindingTarget::OpenApplication),
            "AutoHotkeyScript" => Ok(BindingTarget::AutoHotkeyScript),
            "Macro" => Ok(BindingTarget::Macro),
            "Soundboard" => Ok(BindingTarget::Soundboard),
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
        "MonitorBrightness" => {
            let monitor_id = val
                .get("monitor_id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let display_name = val
                .get("display_name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            Ok(BindingTarget::MonitorBrightness {
                monitor_id,
                display_name,
            })
        }
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
        "Profile" => {
            let name = val
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Profile.name missing".to_string())?
                .to_string();
            Ok(BindingTarget::Profile { name })
        }
        "Unset" => Ok(BindingTarget::Unset),
        "MediaControl" => Ok(BindingTarget::MediaControl),
        "CaptureControl" => Ok(BindingTarget::CaptureControl),
        "Hotkey" => Ok(BindingTarget::Hotkey),
        "OpenApplication" => Ok(BindingTarget::OpenApplication),
        "AutoHotkeyScript" => Ok(BindingTarget::AutoHotkeyScript),
        "Macro" => Ok(BindingTarget::Macro),
        "Soundboard" => Ok(BindingTarget::Soundboard),

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
    #[serde(default)]
    pub macro_name: String,
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
    pub button_light_mode: ButtonLightMode,
    #[serde(default)]
    pub button_light_behavior: ButtonLightBehavior,
    #[serde(default)]
    pub indicator_control: Option<AuxiliaryControl>,
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
    #[serde(default)]
    pub autohotkey_script: Option<AutoHotkeyScriptMapping>,
    #[serde(default)]
    pub soundboard: Option<SoundboardMapping>,
    #[serde(default)]
    pub macro_steps: Vec<MacroStep>,
}

impl Binding {
    pub(crate) fn strip_derived_integration_icons(&mut self) -> bool {
        fn strip_target(target: &mut BindingTarget) -> bool {
            let BindingTarget::Integration { data, .. } = target else {
                return false;
            };
            let Some(data) = data.as_object_mut() else {
                return false;
            };
            let snake = data.remove("icon_data").is_some();
            let camel = data.remove("iconData").is_some();
            snake || camel
        }

        fn strip_macro_step(step: &mut MacroStep) -> bool {
            let mut changed = false;
            match step {
                MacroStep::Action(action) => {
                    for target in &mut action.targets {
                        changed |= strip_target(target);
                    }
                }
                MacroStep::Parallel { steps } => {
                    for target in steps.iter_mut().flat_map(|step| step.targets.iter_mut()) {
                        changed |= strip_target(target);
                    }
                }
                MacroStep::Wait { .. } => {}
            }
            changed
        }

        let mut changed = strip_target(&mut self.target);
        for target in &mut self.targets {
            changed |= strip_target(target);
        }
        for step in &mut self.macro_steps {
            changed |= strip_macro_step(step);
        }
        changed
    }

    pub fn normalize_button_light_serialization(&mut self) -> bool {
        let before_mode = self.button_light_mode.clone();
        let before_behavior = self.button_light_behavior.clone();
        match self.button_light_mode.clone() {
            ButtonLightMode::Activity | ButtonLightMode::MappedWhenAssigned => {}
            ButtonLightMode::FollowState => {
                self.button_light_mode = ButtonLightMode::Activity;
                self.button_light_behavior = ButtonLightBehavior::FollowState;
            }
            ButtonLightMode::InvertState => {
                self.button_light_mode = ButtonLightMode::Activity;
                self.button_light_behavior = ButtonLightBehavior::InvertState;
            }
            ButtonLightMode::Pressed => {
                self.button_light_mode = ButtonLightMode::Activity;
                self.button_light_behavior = ButtonLightBehavior::Pressed;
            }
        }
        self.button_light_mode != before_mode || self.button_light_behavior != before_behavior
    }

    fn effective_button_light_behavior(&self) -> ButtonLightBehavior {
        match &self.button_light_mode {
            ButtonLightMode::FollowState => ButtonLightBehavior::FollowState,
            ButtonLightMode::InvertState => ButtonLightBehavior::InvertState,
            ButtonLightMode::Pressed => ButtonLightBehavior::Pressed,
            ButtonLightMode::Activity | ButtonLightMode::MappedWhenAssigned => {
                self.button_light_behavior.clone()
            }
        }
    }

    pub fn is_button_binding(&self) -> bool {
        matches!(self.control_kind, BindingControlKind::Button)
            || (matches!(self.control_kind, BindingControlKind::Auto)
                && matches!(
                    self.control.msg_type,
                    MidiMessageType::Note | MidiMessageType::ProgramChange
                ))
    }

    pub fn mapped_button_light_feedback_value(&self) -> Option<f32> {
        self.mapped_button_light_feedback_value_with_availability(|_| true)
    }

    pub fn mapped_button_light_feedback_value_with_availability(
        &self,
        target_is_available: impl Fn(&BindingTarget) -> bool,
    ) -> Option<f32> {
        if !self.is_button_binding()
            || !matches!(&self.button_light_mode, ButtonLightMode::MappedWhenAssigned)
        {
            return None;
        }

        let targets = self.normalized_targets_ref();
        if !targets
            .iter()
            .any(|target| !matches!(target, BindingTarget::Unset))
        {
            return Some(0.0);
        }

        Some(
            if self.has_complete_mapped_button_light_target_with_availability(
                targets,
                &target_is_available,
            ) {
                1.0
            } else {
                0.0
            },
        )
    }

    pub fn custom_feedback_output_control(&self) -> Option<&AuxiliaryControl> {
        let control = self.indicator_control.as_ref()?;
        match control.msg_type {
            MidiMessageType::ControlChange | MidiMessageType::Note => Some(control),
            MidiMessageType::PitchBend if !self.is_button_binding() => Some(control),
            MidiMessageType::PitchBend | MidiMessageType::ProgramChange => None,
        }
    }

    pub fn indicator_feedback_control(&self) -> Option<&AuxiliaryControl> {
        if !self.is_button_binding() {
            return None;
        }

        let control = self.indicator_control.as_ref()?;
        match control.msg_type {
            MidiMessageType::ControlChange | MidiMessageType::Note => Some(control),
            MidiMessageType::PitchBend | MidiMessageType::ProgramChange => None,
        }
    }

    pub fn button_light_feedback_value(
        &self,
        input_active: Option<bool>,
        state_active: Option<bool>,
    ) -> Option<f32> {
        if !self.is_button_binding() {
            return None;
        }

        if let Some(value) = self.mapped_button_light_feedback_value() {
            return Some(value);
        }

        let targets = self.normalized_targets_ref();
        if !targets
            .iter()
            .any(|target| !matches!(target, BindingTarget::Unset))
        {
            return None;
        }

        let input_active = input_active.unwrap_or(false);
        let active = match self.effective_button_light_behavior() {
            ButtonLightBehavior::FollowState => state_active.unwrap_or(input_active),
            ButtonLightBehavior::InvertState => match state_active {
                Some(active) => !active,
                None => !input_active,
            },
            ButtonLightBehavior::Pressed => input_active,
        };

        Some(if active { 1.0 } else { 0.0 })
    }

    #[allow(dead_code)]
    pub fn has_complete_mapped_button_light_target(&self, targets: &[BindingTarget]) -> bool {
        self.has_complete_mapped_button_light_target_with_availability(targets, &|_| true)
    }

    fn has_complete_mapped_button_light_target_with_availability(
        &self,
        targets: &[BindingTarget],
        target_is_available: &impl Fn(&BindingTarget) -> bool,
    ) -> bool {
        macro_rules! available_targets {
            () => {
                targets.iter().filter(|target| target_is_available(target))
            };
        }
        match self.action {
            BindingAction::OpenApplication => {
                available_targets!()
                    .any(|target| matches!(target, BindingTarget::OpenApplication))
                    && self
                        .open_application
                        .as_ref()
                        .map(|mapping| !mapping.path.trim().is_empty())
                        .unwrap_or(false)
            }
            BindingAction::Hotkey => {
                available_targets!()
                    .any(|target| matches!(target, BindingTarget::Hotkey))
                    && self
                        .hotkey
                        .as_ref()
                        .map(|mapping| !mapping.keys.is_empty())
                        .unwrap_or(false)
            }
            BindingAction::RunAutoHotkeyScript => {
                available_targets!()
                    .any(|target| matches!(target, BindingTarget::AutoHotkeyScript))
                    && self
                        .autohotkey_script
                        .as_ref()
                        .map(|mapping| !mapping.path.trim().is_empty())
                        .unwrap_or(false)
            }
            BindingAction::Macro => {
                available_targets!()
                    .any(|target| matches!(target, BindingTarget::Macro))
                    && !normalize_macro_steps(&self.macro_steps).is_empty()
            }
            BindingAction::Soundboard => {
                available_targets!()
                    .any(|target| matches!(target, BindingTarget::Soundboard))
                    && self
                        .soundboard
                        .as_ref()
                        .and_then(SoundboardMapping::normalized)
                        .is_some()
            }
            BindingAction::MediaPlayPause
            | BindingAction::MediaNextTrack
            | BindingAction::MediaPrevTrack
            | BindingAction::MediaStop => available_targets!()
                .any(|target| matches!(target, BindingTarget::MediaControl)),
            BindingAction::FocusWindow => available_targets!().any(|target| {
                matches!(
                    target,
                    BindingTarget::Application { name, .. } if !name.trim().is_empty()
                )
            }),
            BindingAction::FullScreenshot
            | BindingAction::SnipScreenshot
            | BindingAction::ToggleScreenRecording => available_targets!()
                .any(|target| matches!(target, BindingTarget::CaptureControl)),
            BindingAction::SetDefaultDevice => available_targets!().any(|target| {
                matches!(
                    target,
                    BindingTarget::Device { device_id } if !device_id.trim().is_empty()
                )
            }),
            BindingAction::SwitchProfile => available_targets!().any(|target| {
                matches!(target, BindingTarget::Profile { name } if !name.trim().is_empty())
            }),
            BindingAction::SetMainOutputDevice => available_targets!()
                .any(Self::target_is_complete_for_mapped_light),
            BindingAction::Volume | BindingAction::ToggleMute | BindingAction::ToggleEffect => {
                available_targets!()
                    .any(Self::target_is_complete_for_mapped_light)
            }
        }
    }

    pub fn uses_stateful_toggle_feedback(&self) -> bool {
        matches!(
            self.action,
            BindingAction::ToggleMute | BindingAction::ToggleEffect
        ) || self
            .normalized_targets_ref()
            .iter()
            .any(Self::target_uses_stateful_toggle_feedback)
    }

    fn target_uses_stateful_toggle_feedback(target: &BindingTarget) -> bool {
        let BindingTarget::Integration {
            integration_id,
            kind,
            data,
        } = target
        else {
            return false;
        };

        if data
            .get("action_kind")
            .and_then(|value| value.as_str())
            .map(|value| value.eq_ignore_ascii_case("stateful"))
            .unwrap_or(false)
        {
            return true;
        }

        integration_id.eq_ignore_ascii_case("obs")
            && kind.eq_ignore_ascii_case("action")
            && data
                .get("action")
                .and_then(|value| value.as_str())
                .map(|value| value.starts_with("Toggle"))
                .unwrap_or(false)
    }

    fn target_is_complete_for_mapped_light(target: &BindingTarget) -> bool {
        match target {
            BindingTarget::Unset => false,
            BindingTarget::Master
            | BindingTarget::Focus
            | BindingTarget::MonitorBrightness { .. }
            | BindingTarget::MediaControl
            | BindingTarget::CaptureControl
            | BindingTarget::Macro
            | BindingTarget::Soundboard => true,
            BindingTarget::Session { session_id } => !session_id.trim().is_empty(),
            BindingTarget::Application { name, .. } => !name.trim().is_empty(),
            BindingTarget::Device { device_id } => !device_id.trim().is_empty(),
            BindingTarget::Profile { name } => !name.trim().is_empty(),
            BindingTarget::Integration {
                integration_id,
                kind,
                ..
            } => !integration_id.trim().is_empty() && !kind.trim().is_empty(),
            BindingTarget::Hotkey | BindingTarget::OpenApplication => false,
            BindingTarget::AutoHotkeyScript => false,
        }
    }

    pub fn normalized_targets(&self) -> Vec<BindingTarget> {
        if !self.targets.is_empty() {
            self.targets.clone()
        } else if self.target != BindingTarget::Unset {
            vec![self.target.clone()]
        } else {
            Vec::new()
        }
    }

    /// Returns the effective targets without cloning their integration metadata.
    pub fn normalized_targets_ref(&self) -> &[BindingTarget] {
        if !self.targets.is_empty() {
            &self.targets
        } else if self.target != BindingTarget::Unset {
            std::slice::from_ref(&self.target)
        } else {
            &[]
        }
    }

    pub fn primary_target(&self) -> BindingTarget {
        self.normalized_targets()
            .into_iter()
            .next()
            .unwrap_or(BindingTarget::Unset)
    }

    pub fn primary_target_ref(&self) -> &BindingTarget {
        self.normalized_targets_ref()
            .first()
            .unwrap_or(&self.target)
    }

    pub fn ensure_targets(&mut self) {
        if self.targets.is_empty() && self.target != BindingTarget::Unset {
            self.targets.push(self.target.clone());
        }
        let preferred_special = match self.action {
            BindingAction::Macro => Some(BindingTarget::Macro),
            BindingAction::Soundboard => Some(BindingTarget::Soundboard),
            _ => None,
        };
        let mut selected_special: Option<BindingTarget> = None;
        self.targets.retain(|target| match target {
            BindingTarget::Macro | BindingTarget::Soundboard => {
                if preferred_special
                    .as_ref()
                    .is_some_and(|preferred| preferred != target)
                    || selected_special.is_some()
                {
                    false
                } else {
                    selected_special = Some(target.clone());
                    true
                }
            }
            _ => true,
        });
        if self.targets.len() > 1 {
            self.targets.retain(|t| *t != BindingTarget::Unset);
        }
        if self.targets.len() > 8 {
            self.targets.truncate(8);
        }
        selected_special = self
            .targets
            .iter()
            .find(|target| matches!(target, BindingTarget::Macro | BindingTarget::Soundboard))
            .cloned();
        if let Some(preferred) = preferred_special {
            if selected_special.is_none() {
                if self.targets.len() >= 8 {
                    self.targets.truncate(7);
                }
                self.targets.push(preferred.clone());
                selected_special = Some(preferred);
            }
        }
        if let Some(first) = self.targets.first().cloned() {
            self.target = first;
        } else {
            self.target = BindingTarget::Unset;
        }
        self.macro_steps = if matches!(self.action, BindingAction::Macro)
            || self
                .targets
                .iter()
                .any(|target| matches!(target, BindingTarget::Macro))
        {
            normalize_macro_draft_steps(&self.macro_steps)
        } else {
            normalize_macro_steps(&self.macro_steps)
        };
        if !matches!(selected_special, Some(BindingTarget::Macro)) {
            self.macro_name.clear();
            self.macro_steps.clear();
        }
        self.soundboard = self
            .soundboard
            .as_ref()
            .and_then(SoundboardMapping::normalized);
        if !matches!(selected_special, Some(BindingTarget::Soundboard)) {
            self.soundboard = None;
        }
    }
}

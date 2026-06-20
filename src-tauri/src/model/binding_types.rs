use super::midi_types::{MidiControl, MidiMessageType};
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum ButtonLightMode {
    #[default]
    Activity,
    MappedWhenAssigned,
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
    Macro,
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
    if matches!(step.action, BindingAction::Macro) {
        return None;
    }

    let targets: Vec<BindingTarget> = step
        .targets
        .iter()
        .filter(|target| !matches!(target, BindingTarget::Unset | BindingTarget::Macro))
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
    let is_nested_macro_action = matches!(step.action, BindingAction::Macro);
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
            .filter(|target| !matches!(target, BindingTarget::Unset | BindingTarget::Macro))
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
    #[default]
    Add,
    Replace,
}

#[derive(Debug, Clone, Default, Serialize)]
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
    AutoHotkeyScript,
    Macro,
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
            "AutoHotkeyScript" => Ok(BindingTarget::AutoHotkeyScript),
            "Macro" => Ok(BindingTarget::Macro),
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
        "AutoHotkeyScript" => Ok(BindingTarget::AutoHotkeyScript),
        "Macro" => Ok(BindingTarget::Macro),

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
    pub macro_steps: Vec<MacroStep>,
}

impl Binding {
    pub fn is_button_binding(&self) -> bool {
        matches!(self.control_kind, BindingControlKind::Button)
            || (matches!(self.control_kind, BindingControlKind::Auto)
                && matches!(
                    self.control.msg_type,
                    MidiMessageType::Note | MidiMessageType::ProgramChange
                ))
    }

    pub fn mapped_button_light_feedback_value(&self) -> Option<f32> {
        if !self.is_button_binding()
            || !matches!(self.button_light_mode, ButtonLightMode::MappedWhenAssigned)
        {
            return None;
        }

        let targets = self.normalized_targets();
        if !targets
            .iter()
            .any(|target| !matches!(target, BindingTarget::Unset))
        {
            return Some(0.0);
        }

        Some(if self.has_complete_mapped_button_light_target(&targets) {
            1.0
        } else {
            0.0
        })
    }

    pub fn activity_button_light_feedback_value(&self, input_active: bool) -> Option<f32> {
        if !self.is_button_binding()
            || matches!(self.button_light_mode, ButtonLightMode::MappedWhenAssigned)
            || self.uses_stateful_toggle_feedback()
        {
            return None;
        }

        let targets = self.normalized_targets();
        if targets
            .iter()
            .any(|target| !matches!(target, BindingTarget::Unset))
        {
            return Some(if input_active { 1.0 } else { 0.0 });
        }

        None
    }

    pub fn idle_button_light_feedback_value(&self) -> Option<f32> {
        if !self.is_button_binding() {
            return None;
        }

        if let Some(value) = self.mapped_button_light_feedback_value() {
            return Some(value);
        }

        let targets = self.normalized_targets();
        if !self.uses_stateful_toggle_feedback()
            && targets
                .iter()
                .any(|target| !matches!(target, BindingTarget::Unset))
        {
            return Some(0.0);
        }

        None
    }

    pub fn has_complete_mapped_button_light_target(&self, targets: &[BindingTarget]) -> bool {
        match self.action {
            BindingAction::OpenApplication => {
                targets
                    .iter()
                    .any(|target| matches!(target, BindingTarget::OpenApplication))
                    && self
                        .open_application
                        .as_ref()
                        .map(|mapping| !mapping.path.trim().is_empty())
                        .unwrap_or(false)
            }
            BindingAction::Hotkey => {
                targets
                    .iter()
                    .any(|target| matches!(target, BindingTarget::Hotkey))
                    && self
                        .hotkey
                        .as_ref()
                        .map(|mapping| !mapping.keys.is_empty())
                        .unwrap_or(false)
            }
            BindingAction::RunAutoHotkeyScript => {
                targets
                    .iter()
                    .any(|target| matches!(target, BindingTarget::AutoHotkeyScript))
                    && self
                        .autohotkey_script
                        .as_ref()
                        .map(|mapping| !mapping.path.trim().is_empty())
                        .unwrap_or(false)
            }
            BindingAction::Macro => {
                targets
                    .iter()
                    .any(|target| matches!(target, BindingTarget::Macro))
                    && !normalize_macro_steps(&self.macro_steps).is_empty()
            }
            BindingAction::MediaPlayPause
            | BindingAction::MediaNextTrack
            | BindingAction::MediaPrevTrack
            | BindingAction::MediaStop => targets
                .iter()
                .any(|target| matches!(target, BindingTarget::MediaControl)),
            BindingAction::FocusWindow => targets.iter().any(|target| {
                matches!(
                    target,
                    BindingTarget::Application { name, .. } if !name.trim().is_empty()
                )
            }),
            BindingAction::FullScreenshot
            | BindingAction::SnipScreenshot
            | BindingAction::ToggleScreenRecording => targets
                .iter()
                .any(|target| matches!(target, BindingTarget::CaptureControl)),
            BindingAction::SetDefaultDevice => targets.iter().any(|target| {
                matches!(
                    target,
                    BindingTarget::Device { device_id } if !device_id.trim().is_empty()
                )
            }),
            BindingAction::SetMainOutputDevice => targets
                .iter()
                .any(Self::target_is_complete_for_mapped_light),
            BindingAction::Volume | BindingAction::ToggleMute | BindingAction::ToggleEffect => {
                targets
                    .iter()
                    .any(Self::target_is_complete_for_mapped_light)
            }
        }
    }

    pub fn uses_stateful_toggle_feedback(&self) -> bool {
        matches!(
            self.action,
            BindingAction::ToggleMute | BindingAction::ToggleEffect
        ) || self
            .normalized_targets()
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
            | BindingTarget::MediaControl
            | BindingTarget::CaptureControl
            | BindingTarget::Macro => true,
            BindingTarget::Session { session_id } => !session_id.trim().is_empty(),
            BindingTarget::Application { name, .. } => !name.trim().is_empty(),
            BindingTarget::Device { device_id } => !device_id.trim().is_empty(),
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

    pub fn primary_target(&self) -> BindingTarget {
        self.normalized_targets()
            .into_iter()
            .next()
            .unwrap_or(BindingTarget::Unset)
    }

    pub fn ensure_targets(&mut self) {
        if matches!(self.action, BindingAction::Macro)
            && self.targets.is_empty()
            && self.target == BindingTarget::Unset
        {
            self.targets.push(BindingTarget::Macro);
        }
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
    }
}

use super::midi_types::MidiMessageType;
use serde::{Deserialize, Serialize, Serializer};

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

pub(super) fn default_feedback_enabled() -> bool {
    true
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub enum AssignMode {
    Replace,
    Clear,
    #[default]
    // A future assign mode must not make an entire profile store unreadable.
    #[serde(other)]
    Add,
}

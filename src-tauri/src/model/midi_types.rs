use super::binding_types::BindingControlKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_key: Option<String>,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum MidiMessageType {
    #[default]
    ControlChange,
    Note,
    PitchBend,
    ProgramChange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct MidiControl {
    pub channel: u8,
    pub controller: u8,
    #[serde(default)]
    pub msg_type: MidiMessageType,
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
    #[serde(default)]
    pub control_kind: BindingControlKind,
}

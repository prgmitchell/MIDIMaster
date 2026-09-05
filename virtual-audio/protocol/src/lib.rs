//! Stable identifiers and wire data shared by the desktop app, service, and setup helper.
use serde::{Deserialize, Serialize};

pub const SERVICE_NAME: &str = "MIDIMasterVirtualAudio";
pub const SERVICE_DISPLAY_NAME: &str = "MIDIMaster Virtual Audio";
pub const SERVICE_FILE_NAME: &str = "midimaster-virtual-audio-service.exe";
pub const SETUP_HELPER_NAME: &str = "midimaster-virtual-audio-setup.exe";
pub const AUDIO_PIPE_PATH: &str = r"\\.\pipe\MIDIMaster.VirtualAudio.Audio.v1";
pub const STATUS_PIPE_PATH: &str = r"\\.\pipe\MIDIMaster.VirtualAudio.Status.v1";
pub const SAMPLE_RATE: usize = 48_000;
pub const CHANNELS: usize = 2;
pub const BYTES_PER_SAMPLE: usize = 2;

include!(concat!(env!("OUT_DIR"), "/payload.rs"));

/// The original v1 boolean remains readable when an older service omits the port count.
#[derive(Debug, Serialize, Deserialize)]
pub struct StatusSnapshot {
    pub schema_version: u8,
    pub service_running: bool,
    pub usbip_attached: bool,
    #[serde(default)]
    pub attached_port_count: Option<u32>,
    #[serde(default)]
    pub active_sessions: u32,
    pub dropped_bytes: u64,
    pub underrun_bytes: u64,
    #[serde(default)]
    pub limited_frames: u64,
    pub limiter_reduction_db: f32,
    pub last_error: Option<String>,
    #[serde(default)]
    pub timestamp_unix_ms: u128,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_legacy_status_and_preserves_current_wire_fields() {
        let old = r#"{"schema_version":1,"service_running":true,"usbip_attached":true,"dropped_bytes":0,"underrun_bytes":12,"limiter_reduction_db":0.0,"last_error":null}"#;
        let snapshot: StatusSnapshot = serde_json::from_str(old).unwrap();
        assert_eq!(snapshot.attached_port_count, None);
        assert_eq!(snapshot.active_sessions, 0);
        assert_eq!(snapshot.underrun_bytes, 12);
        let current = StatusSnapshot {
            attached_port_count: Some(2),
            active_sessions: 1,
            ..snapshot
        };
        let wire = serde_json::to_value(&current).unwrap();
        assert_eq!(wire["attached_port_count"], 2);
        assert_eq!(wire["schema_version"], 1);
        assert_eq!(
            serde_json::from_value::<StatusSnapshot>(wire)
                .unwrap()
                .attached_port_count,
            Some(2)
        );
    }
}

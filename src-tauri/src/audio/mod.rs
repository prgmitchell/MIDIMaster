use crate::model::SessionInfo;

pub trait AudioBackend: Send + Sync {
    fn list_sessions(&self) -> anyhow::Result<Vec<SessionInfo>>;
    fn list_playback_devices(&self) -> anyhow::Result<Vec<crate::model::PlaybackDeviceInfo>>;
    fn list_recording_devices(&self) -> anyhow::Result<Vec<crate::model::PlaybackDeviceInfo>>;
    fn set_master_volume(&self, volume: f32) -> anyhow::Result<()>;
    fn set_session_volume(&self, session_id: &str, volume: f32) -> anyhow::Result<()>;
    fn set_device_volume(&self, device_id: &str, volume: f32) -> anyhow::Result<()>;
    fn set_focused_session_volume(&self, volume: f32) -> anyhow::Result<()>;
    fn set_application_volume(&self, name: &str, volume: f32) -> anyhow::Result<()>;
    fn focused_session(&self) -> anyhow::Result<Option<SessionInfo>>;

    // Mute methods
    fn set_master_mute(&self, muted: bool) -> anyhow::Result<()>;
    fn set_session_mute(&self, session_id: &str, muted: bool) -> anyhow::Result<()>;
    fn set_focused_session_mute(&self, muted: bool) -> anyhow::Result<()>;
    fn set_application_mute(&self, name: &str, muted: bool) -> anyhow::Result<()>;
    fn set_device_mute(&self, device_id: &str, muted: bool) -> anyhow::Result<()>;
}

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(not(target_os = "windows"))]
pub mod unsupported;

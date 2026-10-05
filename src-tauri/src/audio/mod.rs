use crate::model::SessionInfo;

#[derive(Clone, Debug)]
pub struct SoloAudioSource {
    pub session: SessionInfo,
    pub device_id: String,
    pub wave_link_channel_id: Option<String>,
}

pub trait AudioBackend: Send + Sync {
    /// Created and used entirely on the meter worker, never moved between threads.
    fn create_meter(&self) -> Option<Box<dyn crate::audio_feedback::AudioMeter>> {
        None
    }
    fn list_sessions(&self) -> anyhow::Result<Vec<SessionInfo>>;
    fn list_session_states(&self) -> anyhow::Result<Vec<SessionInfo>> {
        self.list_sessions()
    }
    fn list_solo_sources(&self) -> anyhow::Result<Vec<SoloAudioSource>> {
        Ok(self
            .list_session_states()?
            .into_iter()
            .filter(|session| !session.is_master)
            .map(|session| SoloAudioSource {
                session,
                device_id: String::new(),
                wave_link_channel_id: None,
            })
            .collect())
    }
    fn list_playback_devices(&self) -> anyhow::Result<Vec<crate::model::PlaybackDeviceInfo>>;
    fn list_recording_devices(&self) -> anyhow::Result<Vec<crate::model::PlaybackDeviceInfo>>;
    fn set_master_volume(&self, volume: f32) -> anyhow::Result<()>;
    fn set_session_volume(&self, session_id: &str, volume: f32) -> anyhow::Result<()>;
    fn set_device_volume(&self, device_id: &str, volume: f32) -> anyhow::Result<()>;
    fn set_focused_session_volume(&self, volume: f32) -> anyhow::Result<()>;
    fn set_application_volume(&self, name: &str, volume: f32) -> anyhow::Result<()>;
    fn focused_session(&self) -> anyhow::Result<Option<SessionInfo>>;
    fn focused_session_state(&self) -> anyhow::Result<Option<SessionInfo>> {
        self.focused_session()
    }

    // Mute methods
    fn set_master_mute(&self, muted: bool) -> anyhow::Result<()>;
    fn set_session_mute(&self, session_id: &str, muted: bool) -> anyhow::Result<()>;
    fn set_focused_session_mute(&self, muted: bool) -> anyhow::Result<()>;
    fn set_application_mute(&self, name: &str, muted: bool) -> anyhow::Result<()>;
    fn set_device_mute(&self, device_id: &str, muted: bool) -> anyhow::Result<()>;
    fn set_default_device(&self, device_id: &str) -> anyhow::Result<()>;
}

#[cfg(target_os = "windows")]
pub mod windows;

pub mod target_match;
pub(crate) mod target_state;

#[cfg(not(target_os = "windows"))]
pub mod unsupported;

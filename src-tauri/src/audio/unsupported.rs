use crate::audio::AudioBackend;
use crate::model::SessionInfo;
use anyhow::{anyhow, Result};

pub struct UnsupportedAudioBackend;

impl UnsupportedAudioBackend {
    pub fn new() -> Self {
        Self
    }
}

impl AudioBackend for UnsupportedAudioBackend {
    fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn list_playback_devices(&self) -> Result<Vec<crate::model::PlaybackDeviceInfo>> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn list_recording_devices(&self) -> Result<Vec<crate::model::PlaybackDeviceInfo>> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn set_master_volume(&self, _volume: f32) -> Result<()> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn set_session_volume(&self, _session_id: &str, _volume: f32) -> Result<()> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn set_session_mute(&self, _session_id: &str, _muted: bool) -> Result<()> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn set_device_volume(&self, _device_id: &str, _volume: f32) -> Result<()> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn set_focused_session_volume(&self, _volume: f32) -> Result<()> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn set_application_volume(&self, _name: &str, _volume: f32) -> Result<()> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn focused_session(&self) -> Result<Option<SessionInfo>> {
        Ok(None)
    }

    fn set_master_mute(&self, _muted: bool) -> Result<()> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn set_focused_session_mute(&self, _muted: bool) -> Result<()> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn set_application_mute(&self, _name: &str, _muted: bool) -> Result<()> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }

    fn set_device_mute(&self, _device_id: &str, _muted: bool) -> Result<()> {
        Err(anyhow!("Audio backend not implemented on this OS"))
    }
}

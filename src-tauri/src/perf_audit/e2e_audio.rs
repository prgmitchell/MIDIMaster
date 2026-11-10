//! Isolated audio endpoint boundary for desktop E2E. Routing and MIDI stay real.
use crate::device_target::{parse_device_target, DeviceTargetKind};
use crate::model::PlaybackDeviceInfo;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};

static FIXTURE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Serialize)]
struct Fixture {
    playback: Vec<PlaybackDeviceInfo>,
    recording: Vec<PlaybackDeviceInfo>,
}

impl Fixture {
    fn devices(&mut self, kind: DeviceTargetKind) -> &mut Vec<PlaybackDeviceInfo> {
        match kind {
            DeviceTargetKind::Playback => &mut self.playback,
            DeviceTargetKind::Recording => &mut self.recording,
        }
    }
}

fn with_fixture<T>(apply: impl FnOnce(&mut Fixture, &PathBuf) -> Result<T>) -> Option<Result<T>> {
    if !super::synthetic_targets_enabled() {
        return None;
    }
    let path =
        PathBuf::from(std::env::var_os("MIDIMASTER_PERF_APP_DATA_DIR")?).join("e2e-audio.json");
    let _guard = FIXTURE_LOCK.lock().unwrap();
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => return Some(Err(err.into())),
    };
    Some(
        serde_json::from_slice(&bytes)
            .map_err(Into::into)
            .and_then(|mut fixture| apply(&mut fixture, &path)),
    )
}

pub(crate) fn list_devices(kind: DeviceTargetKind) -> Option<Result<Vec<PlaybackDeviceInfo>>> {
    with_fixture(|fixture, _| Ok(fixture.devices(kind).clone()))
}

pub(crate) fn set_default_device(device_id: &str) -> Option<Result<()>> {
    with_fixture(|fixture, path| {
        let (kind, raw_id) = parse_device_target(device_id);
        let devices = fixture.devices(kind);
        if !devices.iter().any(|device| device.id == raw_id) {
            return Err(anyhow!("Device not found"));
        }
        for device in devices {
            device.is_default = device.id == raw_id;
        }
        fs::write(path, serde_json::to_vec(fixture)?)?;
        Ok(())
    })
}

use super::*;

fn flow(kind: DeviceTargetKind) -> EDataFlow {
    match kind {
        DeviceTargetKind::Playback => eRender,
        DeviceTargetKind::Recording => eCapture,
    }
}

pub(super) fn list(kind: DeviceTargetKind) -> Result<Vec<PlaybackDeviceInfo>> {
    #[cfg(feature = "e2e")]
    if let Some(result) = crate::perf_audit::e2e_audio::list_devices(kind) {
        return result;
    }
    let _com = init_com()?;
    let enumerator = get_device_enumerator()?;
    let flow = flow(kind);
    let default_device = get_default_device_from_flow(&enumerator, flow)?;
    let default_id = device_id_string(&default_device);
    with_shared_icon_cache(|icon_cache| {
        list_devices_for_flow(&enumerator, flow, default_id, icon_cache)
    })
}

pub(super) fn set_default(device_id: &str) -> Result<()> {
    #[cfg(feature = "e2e")]
    if let Some(result) = crate::perf_audit::e2e_audio::set_default_device(device_id) {
        return result;
    }
    let _com = init_com()?;
    let enumerator = get_device_enumerator()?;
    let (kind, raw_id) = parse_device_target(device_id);
    let exists = enumerate_active_devices(&enumerator, flow(kind))?
        .iter()
        .any(|(_, id)| id == raw_id);
    if !exists {
        return Err(anyhow!("Device not found"));
    }
    set_default_audio_endpoint(raw_id)
}

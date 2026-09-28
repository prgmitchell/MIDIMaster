use super::*;
use crate::audio_feedback::{clamp_level, AudioMeter, AudioSample};
use crate::model::BindingTarget;
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;

struct Source {
    targets: Vec<BindingTarget>,
    meter: IAudioMeterInformation,
    endpoint: IAudioEndpointVolume,
    session: Option<ISimpleAudioVolume>,
}

impl Source {
    fn level(&self) -> Option<f32> {
        unsafe {
            if self.endpoint.GetMute().ok()?.as_bool()
                || self
                    .session
                    .as_ref()
                    .map(|s| s.GetMute().map(|v| v.as_bool()))
                    .transpose()
                    .ok()?
                    .unwrap_or(false)
            {
                return Some(0.0);
            }
            self.meter.GetPeakValue().ok().map(clamp_level)
        }
    }
}

/// COM interfaces are acquired, sampled and released on the single meter worker.
pub(super) struct WindowsMeter {
    sources: Vec<Source>,
    enumerator: IMMDeviceEnumerator,
    targets: Vec<BindingTarget>,
    refreshed: Option<Instant>,
    focused_pid: Option<u32>,
    // Declared last so all interfaces drop before CoUninitialize.
    _com: Option<ComGuard>,
}

impl WindowsMeter {
    pub(super) fn new() -> Result<Self> {
        let com = init_com()?;
        Ok(Self {
            sources: Vec::new(),
            enumerator: get_device_enumerator()?,
            targets: Vec::new(),
            refreshed: None,
            focused_pid: None,
            _com: com,
        })
    }

    fn discover(&mut self, targets: &[BindingTarget], focused_pid: Option<u32>) {
        self.sources.clear();
        self.targets = targets.to_vec();
        self.focused_pid = focused_pid;
        self.refreshed = Some(Instant::now());
        let default_id = get_default_device_from(&self.enumerator)
            .ok()
            .and_then(|d| device_id_string(&d));
        let focus_identity = focused_pid.map(query_effective_process_identity_cached);
        let needs_sessions = targets.iter().any(|t| {
            matches!(
                t,
                BindingTarget::Session { .. }
                    | BindingTarget::Application { .. }
                    | BindingTarget::Focus
            )
        });
        for (flow, kind) in [
            (eRender, DeviceTargetKind::Playback),
            (eCapture, DeviceTargetKind::Recording),
        ] {
            let devices = enumerate_active_devices(&self.enumerator, flow).unwrap_or_default();
            for (device, id) in devices {
                let Ok(endpoint) = get_endpoint_volume(&device) else {
                    continue;
                };
                let endpoint_targets: Vec<_> = targets
                    .iter()
                    .filter(|target| match target {
                        BindingTarget::Master => {
                            kind == DeviceTargetKind::Playback && default_id.as_ref() == Some(&id)
                        }
                        BindingTarget::Device { device_id } => {
                            let (target_kind, raw) = parse_device_target(device_id);
                            target_kind == kind && raw == id
                        }
                        _ => false,
                    })
                    .cloned()
                    .collect();
                if !endpoint_targets.is_empty() {
                    if let Ok(meter) =
                        unsafe { device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None) }
                    {
                        self.sources.push(Source {
                            targets: endpoint_targets,
                            meter,
                            endpoint: endpoint.clone(),
                            session: None,
                        });
                    }
                }
                if kind != DeviceTargetKind::Playback || !needs_sessions {
                    continue;
                }
                let _ = visit_audio_sessions::<()>(&device, |control, volume, pid| {
                    let base_id =
                        session_identifier(control, pid).unwrap_or_else(|| format!("pid:{pid}"));
                    let session_id = if default_id.as_ref() == Some(&id) {
                        base_id
                    } else {
                        format!("{id}|{base_id}")
                    };
                    let session_targets: Vec<_> = targets
                        .iter()
                        .filter(|target| match target {
                            BindingTarget::Session {
                                session_id: requested,
                            } => requested == &session_id,
                            BindingTarget::Application { name, .. } => {
                                audio_session_matches_application_name(control, pid, name)
                            }
                            BindingTarget::Focus => focused_pid
                                .zip(focus_identity.as_ref())
                                .is_some_and(|(focused, identity)| {
                                    session_matches_process(pid, focused, identity)
                                }),
                            _ => false,
                        })
                        .cloned()
                        .collect();
                    if !session_targets.is_empty() {
                        if let Ok(meter) = control.cast::<IAudioMeterInformation>() {
                            self.sources.push(Source {
                                targets: session_targets,
                                meter,
                                endpoint: endpoint.clone(),
                                session: Some(volume.clone()),
                            });
                        }
                    }
                    Ok(SessionVisit::Continue)
                });
            }
        }
    }
}

impl AudioMeter for WindowsMeter {
    fn sample(&mut self, targets: &[BindingTarget]) -> Vec<AudioSample> {
        let focused = if targets.contains(&BindingTarget::Focus) {
            foreground_process_id()
        } else {
            None
        };
        // Discovery is bounded separately from the 25 Hz meter reads. It picks up
        // session/device arrivals and default-device changes without retaining dead handles.
        if self.targets != targets
            || self.focused_pid != focused
            || self
                .refreshed
                .is_none_or(|t| t.elapsed() >= Duration::from_millis(750))
        {
            self.discover(targets, focused);
        }
        let mut samples: Vec<_> = targets
            .iter()
            .filter(|t| !matches!(t, BindingTarget::Integration { .. }))
            .map(|target| AudioSample {
                target: target.clone(),
                level: None,
            })
            .collect();
        for source in &self.sources {
            if let Some(level) = source.level() {
                for sample in &mut samples {
                    if source.targets.contains(&sample.target) {
                        sample.level = Some(sample.level.unwrap_or(0.0).max(level));
                    }
                }
            }
        }
        samples
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "reads live Windows playback, recording and session meters"]
    fn live_meter_sources_and_cached_interfaces() {
        let audio = WindowsAudioBackend::new();
        let mut targets = vec![BindingTarget::Master, BindingTarget::Focus];
        for (prefix, devices) in [
            ("playback:", audio.list_playback_devices().unwrap()),
            ("recording:", audio.list_recording_devices().unwrap()),
        ] {
            for device in devices {
                targets.push(BindingTarget::Device {
                    device_id: format!("{prefix}{}", device.id),
                });
            }
        }
        for session in audio
            .list_session_states()
            .unwrap()
            .into_iter()
            .filter(|s| !s.is_master)
        {
            targets.push(BindingTarget::Session {
                session_id: session.id,
            });
            if let Some(name) = session.application_key.or(session.process_name) {
                targets.push(BindingTarget::Application {
                    name,
                    display_name: None,
                    icon_data: None,
                });
            }
        }
        let mut meter = WindowsMeter::new().unwrap();
        let samples = meter.sample(&targets);
        let available = samples.iter().filter(|s| s.level.is_some()).count();
        assert!(available > 0, "at least one live source must be available");
        assert!(samples
            .iter()
            .filter_map(|s| s.level)
            .all(|v| v.is_finite() && (0.0..=1.0).contains(&v)));
        let refreshed = meter.refreshed;
        meter.sample(&targets);
        assert_eq!(
            meter.refreshed, refreshed,
            "no per-frame device/session enumeration"
        );
        println!(
            "Live Windows meters: {available}/{} targets available; cached interfaces reused",
            targets.len()
        );
    }
}

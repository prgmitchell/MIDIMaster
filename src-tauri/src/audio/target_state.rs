use crate::audio::target_match::{application_name_matches, ApplicationMatchInfo};
use crate::device_target::{parse_device_target, DeviceTargetKind};
use crate::model;
use crate::model::Profile;

#[derive(Default)]
pub(crate) struct FeedbackSyncNeeds {
    pub(crate) sessions: bool,
    pub(crate) focused_session: bool,
    pub(crate) playback_devices: bool,
    pub(crate) recording_devices: bool,
}

#[derive(Default)]
pub(crate) struct TargetSnapshot {
    pub(crate) value: Option<f32>,
    pub(crate) muted: Option<bool>,
}

pub(crate) fn feedback_sync_needs(profile: &Profile) -> FeedbackSyncNeeds {
    let mut needs = FeedbackSyncNeeds::default();

    for binding in &profile.bindings {
        if !matches!(
            binding.action,
            model::BindingAction::Volume | model::BindingAction::ToggleMute
        ) {
            continue;
        }

        for target in binding.normalized_targets_ref().iter() {
            match target.feedback_source() {
                model::BindingTargetFeedbackSource::Sessions => needs.sessions = true,
                model::BindingTargetFeedbackSource::FocusedSession => needs.focused_session = true,
                model::BindingTargetFeedbackSource::Device => {
                    let model::BindingTarget::Device { device_id } = target else {
                        continue;
                    };
                    let (kind, _) = parse_device_target(device_id);
                    match kind {
                        DeviceTargetKind::Playback => needs.playback_devices = true,
                        DeviceTargetKind::Recording => needs.recording_devices = true,
                    }
                }
                model::BindingTargetFeedbackSource::None => {}
            }
        }
    }

    needs
}

pub(crate) fn target_snapshot(
    target: &model::BindingTarget,
    sessions: &[model::SessionInfo],
    focused_session: Option<&model::SessionInfo>,
    playback_devices: &[model::PlaybackDeviceInfo],
    recording_devices: &[model::PlaybackDeviceInfo],
) -> TargetSnapshot {
    if target.feedback_source() == model::BindingTargetFeedbackSource::None {
        return TargetSnapshot::default();
    }

    let from_session = |session: Option<&model::SessionInfo>| TargetSnapshot {
        value: session.map(|item| item.volume),
        muted: session.map(|item| item.is_muted),
    };
    let from_device = |device: Option<&model::PlaybackDeviceInfo>| TargetSnapshot {
        value: device.map(|item| item.volume),
        muted: device.map(|item| item.is_muted),
    };

    match target {
        model::BindingTarget::Master => {
            from_session(sessions.iter().find(|session| session.is_master))
        }
        model::BindingTarget::Focus => from_session(focused_session),
        model::BindingTarget::Session { session_id } => {
            from_session(sessions.iter().find(|session| session.id == *session_id))
        }
        model::BindingTarget::Application { name, .. } => {
            from_session(sessions.iter().find(|session| {
                application_name_matches(
                    name,
                    ApplicationMatchInfo {
                        process_path: session.process_path.as_deref(),
                        process_name: session.process_name.as_deref(),
                        display_name: Some(session.display_name.as_str()),
                        application_key: session.application_key.as_deref(),
                        ..Default::default()
                    },
                )
            }))
        }
        model::BindingTarget::Device { device_id } => {
            let (kind, raw_id) = parse_device_target(device_id);
            match kind {
                DeviceTargetKind::Playback => {
                    from_device(playback_devices.iter().find(|device| device.id == raw_id))
                }
                DeviceTargetKind::Recording => {
                    from_device(recording_devices.iter().find(|device| device.id == raw_id))
                }
            }
        }
        _ => TargetSnapshot::default(),
    }
}

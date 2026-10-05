use super::*;
use crate::model::SessionInfo;

#[test]
fn mixer_messages_use_numeric_ids_outside_the_plugin_request_range() {
    let rpc = SoloRpc {
        method: "setMix".into(),
        params: serde_json::json!({"id":"mix", "isMuted":true}),
    };
    let value: serde_json::Value = serde_json::from_str(&rpc_message(&rpc, 4)).unwrap();
    assert_eq!(value["id"].as_i64(), Some(-10004));
    assert_eq!(value["params"]["isMuted"], true);
}

struct TestAudio(Mutex<Vec<SoloAudioSource>>);
impl AudioBackend for TestAudio {
    fn list_sessions(&self) -> anyhow::Result<Vec<SessionInfo>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.session.clone())
            .collect())
    }
    fn list_solo_sources(&self) -> anyhow::Result<Vec<SoloAudioSource>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn set_session_mute(&self, id: &str, muted: bool) -> anyhow::Result<()> {
        self.0
            .lock()
            .unwrap()
            .iter_mut()
            .find(|s| s.session.id == id)
            .unwrap()
            .session
            .is_muted = muted;
        Ok(())
    }
    fn list_playback_devices(&self) -> anyhow::Result<Vec<PlaybackDeviceInfo>> {
        unimplemented!()
    }
    fn list_recording_devices(&self) -> anyhow::Result<Vec<PlaybackDeviceInfo>> {
        unimplemented!()
    }
    fn focused_session(&self) -> anyhow::Result<Option<SessionInfo>> {
        unimplemented!()
    }
    fn set_master_volume(&self, _: f32) -> anyhow::Result<()> {
        unimplemented!()
    }
    fn set_session_volume(&self, _: &str, _: f32) -> anyhow::Result<()> {
        unimplemented!()
    }
    fn set_device_volume(&self, _: &str, _: f32) -> anyhow::Result<()> {
        unimplemented!()
    }
    fn set_focused_session_volume(&self, _: f32) -> anyhow::Result<()> {
        unimplemented!()
    }
    fn set_application_volume(&self, _: &str, _: f32) -> anyhow::Result<()> {
        unimplemented!()
    }
    fn set_master_mute(&self, _: bool) -> anyhow::Result<()> {
        unimplemented!()
    }
    fn set_focused_session_mute(&self, _: bool) -> anyhow::Result<()> {
        unimplemented!()
    }
    fn set_application_mute(&self, _: &str, _: bool) -> anyhow::Result<()> {
        unimplemented!()
    }
    fn set_device_mute(&self, _: &str, _: bool) -> anyhow::Result<()> {
        unimplemented!()
    }
    fn set_default_device(&self, _: &str) -> anyhow::Result<()> {
        unimplemented!()
    }
}

fn source(id: &str, name: Option<&str>, muted: bool, device: &str) -> SoloAudioSource {
    SoloAudioSource {
        session: SessionInfo {
            id: id.into(),
            display_name: name.unwrap_or("Audio session").into(),
            application_key: None,
            process_name: name.map(|n| format!("{n}.exe")),
            process_path: None,
            icon_data: None,
            volume: 0.7,
            is_muted: muted,
            is_master: false,
        },
        device_id: device.into(),
        wave_link_channel_id: None,
    }
}
fn application(name: &str) -> BindingTarget {
    BindingTarget::Application {
        name: name.into(),
        display_name: None,
        icon_data: None,
    }
}
fn active(targets: Vec<BindingTarget>) -> ActiveSolo {
    ActiveSolo {
        restoring: false,
        binding: crate::test_support::binding(),
        targets,
        focused_id: None,
        default_device_id: Some("speakers".into()),
        originals: HashMap::new(),
        wave_link: None,
    }
}
fn mutes(audio: &TestAudio) -> Vec<bool> {
    audio
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|s| s.session.is_muted)
        .collect()
}

#[test]
fn solo_restores_each_original_mute_and_captures_sessions_started_later() {
    let audio = TestAudio(Mutex::new(vec![
        source("game", Some("game"), true, "speakers"),
        source("music", Some("music"), false, "headphones"),
        source("muted", Some("muted"), true, "speakers"),
        source("anonymous", None, false, "hdmi"),
    ]));
    let mut solo = active(vec![application("GAME")]);
    apply_sources(&audio, &mut solo).unwrap();
    assert_eq!(mutes(&audio), [false, true, true, true]);
    // Enforce isolation without overwriting the initial state of an already muted source.
    audio.set_session_mute("muted", false).unwrap();
    audio
        .0
        .lock()
        .unwrap()
        .push(source("new", Some("new"), false, "hdmi"));
    apply_sources(&audio, &mut solo).unwrap();
    assert_eq!(mutes(&audio), [false, true, true, true, true]);
    restore_sources(&audio, &solo).unwrap();
    assert_eq!(mutes(&audio), [true, false, true, false, false]);
    assert!(audio
        .0
        .lock()
        .unwrap()
        .iter()
        .all(|s| s.session.volume == 0.7));
}

#[test]
fn windows_focus_and_session_targets_resolve_to_stable_endpoint_addresses() {
    let s = source(
        "speakers|123:session|instance",
        Some("game"),
        false,
        "speakers",
    );
    assert!(selected(
        &s,
        &[BindingTarget::Session {
            session_id: "123:session|instance".into()
        }],
        None,
        Some("speakers")
    ));
    assert!(selected(
        &s,
        &[BindingTarget::Focus],
        Some("123:session|instance"),
        Some("speakers")
    ));
    assert!(selected(
        &s,
        &[BindingTarget::Session {
            session_id: s.session.id.clone()
        }],
        None,
        Some("other")
    ));
    assert!(!selected(
        &s,
        &[BindingTarget::Session {
            session_id: "123:session|instance".into()
        }],
        None,
        Some("other")
    ));
}

#[test]
fn wave_link_solo_keeps_its_engine_and_virtual_feeds_open_but_mutes_direct_playback() {
    let mut feed = source("feed", Some("game"), false, "virtual");
    feed.wave_link_channel_id = Some("game-channel".into());
    let audio = TestAudio(Mutex::new(vec![
        feed,
        source("engine", Some("Elgato.WaveLink"), false, "speakers"),
        source("direct", Some("browser"), false, "speakers"),
    ]));
    let mut solo = active(vec![BindingTarget::Integration {
        integration_id: "wavelink".into(),
        kind: "channel_mix".into(),
        data: serde_json::json!({}),
    }]);
    solo.wave_link = Some(WaveLinkSoloPlan {
        ws_id: 1,
        apply: vec![],
        restore: vec![],
        allow_virtual_inputs: true,
        virtual_channel_ids: vec!["game-channel".into()],
    });
    apply_sources(&audio, &mut solo).unwrap();
    assert_eq!(mutes(&audio), [false, false, true]);
    restore_sources(&audio, &solo).unwrap();
    assert_eq!(mutes(&audio), [false, false, false]);

    let mut direct_hardware = source("direct-hardware", Some("browser"), false, "virtual-direct");
    direct_hardware.wave_link_channel_id = Some("hardware-direct".into());
    audio.0.lock().unwrap().push(direct_hardware);
    apply_sources(&audio, &mut solo).unwrap();
    assert_eq!(
        mutes(&audio),
        [false, false, true, true],
        "direct playback must not bypass Solo"
    );
    restore_sources(&audio, &solo).unwrap();

    // A Windows app routed through Wave Link keeps only that app's virtual feed.
    solo.targets = vec![application("game")];
    solo.wave_link.as_mut().unwrap().allow_virtual_inputs = false;
    let mut other = source("other-feed", Some("music"), false, "virtual");
    other.wave_link_channel_id = Some("game-channel".into());
    audio.0.lock().unwrap().push(other);
    apply_sources(&audio, &mut solo).unwrap();
    assert_eq!(mutes(&audio), [false, false, true, true, true]);
}

#[test]
fn device_solo_preserves_the_existing_mix_on_its_output() {
    let audio = TestAudio(Mutex::new(vec![
        source("a", Some("game"), false, "headphones"),
        source("b", Some("music"), true, "headphones"),
        source("c", Some("browser"), false, "speakers"),
    ]));
    let mut solo = active(vec![BindingTarget::Device {
        device_id: "playback:headphones".into(),
    }]);
    apply_sources(&audio, &mut solo).unwrap();
    assert_eq!(mutes(&audio), [false, true, true]);
    restore_sources(&audio, &solo).unwrap();
    assert_eq!(mutes(&audio), [false, true, false]);
}

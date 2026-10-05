use super::*;
use crate::{
    app_settings::{AppSettings, AppSettingsStore},
    audio::AudioBackend,
    durable_json_store::new_recovery_notices,
    model::{PlaybackDeviceInfo, SessionInfo},
    profile_store::ProfileStore,
};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Audio {
    sessions: Arc<Mutex<Vec<SessionInfo>>>,
    fail: Arc<Mutex<bool>>,
    writes: Arc<Mutex<Vec<(String, String, f32)>>>,
}
impl Audio {
    fn write(&self, id: &str, field: &str, value: f32) -> anyhow::Result<()> {
        if *self.fail.lock().unwrap() {
            anyhow::bail!("unavailable");
        }
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .iter_mut()
            .find(|session| session.id == id)
            .ok_or_else(|| anyhow::anyhow!("missing"))?;
        if field == "volume" {
            session.volume = value;
        } else {
            session.is_muted = value > 0.5;
        }
        self.writes
            .lock()
            .unwrap()
            .push((id.into(), field.into(), value));
        Ok(())
    }
}
impl AudioBackend for Audio {
    fn list_sessions(&self) -> anyhow::Result<Vec<SessionInfo>> {
        Ok(self.sessions.lock().unwrap().clone())
    }
    fn list_playback_devices(&self) -> anyhow::Result<Vec<PlaybackDeviceInfo>> {
        Ok(vec![])
    }
    fn list_recording_devices(&self) -> anyhow::Result<Vec<PlaybackDeviceInfo>> {
        Ok(vec![])
    }
    fn focused_session(&self) -> anyhow::Result<Option<SessionInfo>> {
        Ok(None)
    }
    fn set_session_volume(&self, id: &str, value: f32) -> anyhow::Result<()> {
        self.write(id, "volume", value)
    }
    fn set_session_mute(&self, id: &str, value: bool) -> anyhow::Result<()> {
        self.write(id, "muted", if value { 1.0 } else { 0.0 })
    }
    fn set_master_volume(&self, _: f32) -> anyhow::Result<()> {
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
fn session(id: &str, volume: f32, muted: bool) -> SessionInfo {
    SessionInfo {
        id: id.into(),
        display_name: id.into(),
        application_key: None,
        process_name: None,
        process_path: None,
        icon_data: None,
        volume,
        is_muted: muted,
        is_master: false,
    }
}
fn target(id: &str) -> BindingTarget {
    BindingTarget::Session {
        session_id: id.into(),
    }
}
fn saved(id: &str, volume: f32, muted: bool) -> ProfileTargetState {
    ProfileTargetState {
        target: target(id),
        state: serde_json::json!({"volume": volume, "muted": muted}),
    }
}
fn profile(states: Vec<ProfileTargetState>) -> Profile {
    let mut binding = crate::test_support::binding();
    binding.targets = vec![target("a"), target("b")];
    binding.feedback_enabled = false; // Capture does not depend on a MIDI output.
    let mut mute = binding.clone();
    mute.id = "mute".into();
    mute.action = BindingAction::ToggleMute;
    mute.targets = vec![target("a")];
    Profile {
        name: "Work".into(),
        bindings: vec![binding, mute],
        target_states: states,
        osd_settings: Default::default(),
        plugin_settings: Default::default(),
        midi_device_preference: Default::default(),
        midi_device_preference_set: false,
    }
}
fn make_state(audio: Audio, directory: &std::path::Path) -> AppState {
    AppState::new(
        Box::new(audio),
        ProfileStore::new(directory.into()),
        AppSettingsStore::new(directory.into()),
        AppSettings::default(),
        new_recovery_notices(),
    )
}
fn activate(state: &AppState, profile: &Profile, restore: bool) {
    state
        .profile_target_state
        .lock()
        .unwrap()
        .activate(profile, restore);
    *state.active_profile.lock().unwrap() = Some(AppState::profile_snapshot(profile.clone()));
}
fn directory() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "midimaster-profile-state-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn independent_target_levels_and_mutes_survive_switching_and_restart() {
    let directory = directory();
    let audio = Audio::default();
    *audio.sessions.lock().unwrap() = vec![session("a", 0.9, false), session("b", 0.8, true)];
    let state = make_state(audio.clone(), &directory);
    let work = profile(vec![saved("a", 0.25, true), saved("b", 0.65, false)]);
    state.profile_store.save_profile(work.clone()).unwrap();
    activate(&state, &work, true);
    state.sync_feedback_values(&work);
    checkpoint(&state).unwrap();
    assert_eq!(audio.sessions.lock().unwrap()[0].volume, 0.25);
    assert!(audio.sessions.lock().unwrap()[0].is_muted);
    assert_eq!(audio.sessions.lock().unwrap()[1].volume, 0.65);
    assert!(!audio.sessions.lock().unwrap()[1].is_muted);
    assert_eq!(
        audio.writes.lock().unwrap().len(),
        4,
        "duplicate targets restore once"
    );
    assert_eq!(
        state
            .profile_store
            .load_profile("Work")
            .unwrap()
            .unwrap()
            .target_states,
        work.target_states,
        "pre-restore feedback cannot replace saved values"
    );
    audio.write("a", "volume", 0.33).unwrap();
    audio.write("b", "muted", 1.0).unwrap();
    state.sync_feedback_values(&work);
    checkpoint(&state).unwrap();
    let stored = state.profile_store.load_profile("Work").unwrap().unwrap();
    assert_eq!(
        stored.target_states,
        vec![saved("a", 0.33, true), saved("b", 0.65, true)]
    );
    let mut play = profile(vec![saved("a", 0.7, false), saved("b", 0.4, false)]);
    play.name = "Play".into();
    activate(&state, &play, true);
    state.sync_feedback_values(&play);
    assert_eq!(audio.sessions.lock().unwrap()[0].volume, 0.7);
    activate(&state, &stored, true);
    state.sync_feedback_values(&stored);
    assert_eq!(audio.sessions.lock().unwrap()[0].volume, 0.33);
    drop(state);
    let restarted = make_state(audio.clone(), &directory);
    let stored = restarted
        .profile_store
        .load_profile("Work")
        .unwrap()
        .unwrap();
    audio.write("a", "volume", 0.99).unwrap();
    activate(&restarted, &stored, true);
    restarted.sync_feedback_values(&stored);
    assert_eq!(audio.sessions.lock().unwrap()[0].volume, 0.33);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn missing_and_failed_targets_keep_saved_state_until_restore_succeeds() {
    let directory = directory();
    let audio = Audio::default();
    let state = make_state(audio.clone(), &directory);
    let profile = profile(vec![saved("a", 0.2, true), saved("b", 0.6, false)]);
    state.profile_store.save_profile(profile.clone()).unwrap();
    activate(&state, &profile, true);
    state.sync_feedback_values(&profile);
    checkpoint(&state).unwrap();
    assert_eq!(
        state
            .profile_store
            .load_profile("Work")
            .unwrap()
            .unwrap()
            .target_states,
        profile.target_states
    );
    *audio.sessions.lock().unwrap() = vec![session("b", 0.99, true)];
    *audio.fail.lock().unwrap() = true;
    state.sync_feedback_values(&profile);
    checkpoint(&state).unwrap();
    assert_eq!(
        state
            .profile_store
            .load_profile("Work")
            .unwrap()
            .unwrap()
            .target_states,
        profile.target_states
    );
    *audio.fail.lock().unwrap() = false;
    state.sync_feedback_values(&profile);
    assert_eq!(audio.sessions.lock().unwrap()[0].volume, 0.6);
    assert!(!audio.sessions.lock().unwrap()[0].is_muted);
    audio
        .sessions
        .lock()
        .unwrap()
        .push(session("a", 0.9, false));
    state.sync_feedback_values(&profile);
    assert_eq!(audio.sessions.lock().unwrap()[1].volume, 0.2);
    assert!(audio.sessions.lock().unwrap()[1].is_muted);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn legacy_profiles_capture_current_values_and_removed_targets_are_pruned() {
    let mut legacy: Profile =
        serde_json::from_value(serde_json::json!({"name": "Old", "bindings": []})).unwrap();
    assert!(legacy.target_states.is_empty());
    legacy.bindings = profile(vec![]).bindings;
    let directory = directory();
    let audio = Audio::default();
    *audio.sessions.lock().unwrap() = vec![session("a", 0.8, false)];
    let state = make_state(audio.clone(), &directory);
    state.profile_store.save_profile(legacy.clone()).unwrap();
    activate(&state, &legacy, true);
    state.sync_feedback_values(&legacy);
    assert!(audio.writes.lock().unwrap().is_empty());
    checkpoint(&state).unwrap();
    assert_eq!(
        state
            .profile_store
            .load_profile("Old")
            .unwrap()
            .unwrap()
            .target_states,
        vec![saved("a", 0.8, false)]
    );
    legacy.bindings.clear();
    activate(&state, &legacy, false);
    checkpoint(&state).unwrap();
    assert!(state
        .profile_store
        .load_profile("Old")
        .unwrap()
        .unwrap()
        .target_states
        .is_empty());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn integration_reconnect_metadata_and_state_checkpoints_preserve_configuration() {
    let directory = directory();
    let state = make_state(Audio::default(), &directory);
    let mut profile = profile(vec![]);
    let target = BindingTarget::Integration {
        integration_id: "fixture".into(),
        kind: "channel".into(),
        data: serde_json::json!({"id":"game", "label":"New label", "icon_data":"derived"}),
    };
    profile.bindings[0].targets = vec![target.clone()];
    profile.bindings[0].name = "Custom binding name".into();
    profile.bindings.pop();
    let mut previous = target.clone();
    if let BindingTarget::Integration { data, .. } = &mut previous {
        data["label"] = serde_json::json!("Old label");
        data.as_object_mut().unwrap().remove("icon_data");
    }
    profile.target_states = vec![ProfileTargetState {
        target: previous,
        state: serde_json::json!({"volume":0.3, "muted":true}),
    }];
    state.profile_store.save_profile(profile.clone()).unwrap();
    activate(&state, &profile, true);
    update_integrations(&state, "Other profile", vec![]).unwrap();
    checkpoint(&state).unwrap();
    assert_eq!(
        state
            .profile_store
            .load_profile("Work")
            .unwrap()
            .unwrap()
            .target_states
            .len(),
        1
    );
    update_integrations(
        &state,
        "Work",
        vec![ProfileTargetState {
            target,
            state: serde_json::json!({"volume":0.7, "muted":false}),
        }],
    )
    .unwrap();
    checkpoint(&state).unwrap();
    let stored = state.profile_store.load_profile("Work").unwrap().unwrap();
    assert_eq!(stored.bindings[0].name, "Custom binding name");
    assert_eq!(stored.target_states.len(), 1);
    assert_eq!(stored.target_states[0].state["volume"], 0.7);
    std::fs::remove_dir_all(directory).unwrap();
}

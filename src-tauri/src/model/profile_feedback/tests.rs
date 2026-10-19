use super::*;
use crate::model::{FaderOutput, FaderOutputKind};
use crate::profile_store::ProfileStore;

// The released 4.9.10 enum deliberately has no fallback: this reproduces the reset.
#[derive(Deserialize)]
enum ReleasedFeedbackMode {
    FollowValue,
    AudioReactive,
}

fn assert_released_modes(profiles: &serde_json::Value) {
    for profile in profiles.as_array().unwrap() {
        for binding in profile["bindings"].as_array().unwrap() {
            serde_json::from_value::<ReleasedFeedbackMode>(binding["feedback_mode"].clone())
                .unwrap();
            if let Some(outputs) = binding["additional_outputs"].as_array() {
                for output in outputs {
                    serde_json::from_value::<ReleasedFeedbackMode>(output["feedback_mode"].clone())
                        .unwrap();
                }
            }
        }
    }
}

fn profile() -> Profile {
    let mut binding = crate::test_support::binding();
    binding.feedback_mode = FeedbackMode::AlwaysOn;
    binding.additional_outputs = vec![FaderOutput {
        id: "steady-led".into(),
        kind: FaderOutputKind::Led,
        control: serde_json::from_value(serde_json::json!({
            "device_id": "midi-dev", "channel": 0, "controller": 42, "msg_type": "Note"
        }))
        .unwrap(),
        enabled: true,
        feedback_mode: FeedbackMode::AlwaysOn,
    }];
    serde_json::from_value(serde_json::json!({
        "name": "Saved profile", "bindings": [binding],
        "plugin_settings": {"obs": {"scene": "Camera"}}
    }))
    .unwrap()
}

#[test]
fn disk_and_export_modes_are_readable_by_4910_and_restore_without_losing_configuration() {
    let original = profile();
    let mut persisted = original.clone();
    // AlwaysOn must remain available to IPC/frontend callers.
    assert_eq!(
        serde_json::to_value(&original).unwrap()["bindings"][0]["feedback_mode"],
        "AlwaysOn"
    );
    assert!(persisted.normalize_for_storage());
    assert!(
        !persisted.normalize_for_storage(),
        "storage normalization is idempotent"
    );
    let raw = serde_json::to_value(vec![persisted]).unwrap();
    assert_released_modes(&raw);
    let mut restored: Vec<Profile> = serde_json::from_value(raw).unwrap();
    assert!(restored[0].restore_from_storage());
    assert!(!restored[0].restore_from_storage());
    assert_eq!(
        serde_json::to_value(&restored[0]).unwrap(),
        serde_json::to_value(original).unwrap()
    );
}

#[test]
fn restart_and_older_version_save_keep_always_on_metadata_for_all_outputs() {
    let dir = std::env::temp_dir().join(format!("midimaster-led-compat-{}", uuid::Uuid::new_v4()));
    let store = ProfileStore::new(dir.clone());
    store.save_profile(profile()).unwrap();
    drop(store);
    let path = dir.join("profiles.json");
    let mut raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_released_modes(&raw);
    // Old releases save these known fields and round-trip opaque plugin settings.
    raw[0]["bindings"][0]["name"] = "Edited in 4.9.10".into();
    std::fs::write(&path, serde_json::to_vec_pretty(&raw).unwrap()).unwrap();
    let restarted = ProfileStore::new(dir.clone());
    let loaded = restarted.load_profile("Saved profile").unwrap().unwrap();
    assert_eq!(loaded.bindings[0].feedback_mode, FeedbackMode::AlwaysOn);
    assert_eq!(
        loaded.bindings[0].additional_outputs[0].feedback_mode,
        FeedbackMode::AlwaysOn
    );
    assert_eq!(loaded.bindings[0].name, "Edited in 4.9.10");
    assert_eq!(loaded.plugin_settings["obs"]["scene"], "Camera");
    restarted.save_profile(loaded.clone()).unwrap();
    let mut unrelated = loaded;
    unrelated.name = "Another profile".into();
    restarted.save_profile(unrelated).unwrap();
    drop(restarted);
    let loaded = ProfileStore::new(dir.clone())
        .load_profile("Saved profile")
        .unwrap()
        .unwrap();
    assert_eq!(loaded.bindings[0].feedback_mode, FeedbackMode::AlwaysOn);
    assert_eq!(
        loaded.bindings[0].additional_outputs[0].feedback_mode,
        FeedbackMode::AlwaysOn
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn changing_modes_or_removing_outputs_does_not_restore_stale_always_on_settings() {
    let mut saved = profile();
    saved.normalize_for_storage();
    saved.restore_from_storage();
    saved.bindings[0].feedback_mode = FeedbackMode::AudioReactive;
    saved.bindings[0].additional_outputs[0].feedback_mode = FeedbackMode::FollowValue;
    saved.normalize_for_storage();
    assert!(!saved.plugin_settings.contains_key(COMPAT_KEY));
    saved.restore_from_storage();
    assert_eq!(saved.bindings[0].feedback_mode, FeedbackMode::AudioReactive);
    assert_eq!(
        saved.bindings[0].additional_outputs[0].feedback_mode,
        FeedbackMode::FollowValue
    );
    let mut removed = profile();
    removed.normalize_for_storage();
    removed.bindings.clear();
    removed.normalize_for_storage();
    assert!(!removed.plugin_settings.contains_key(COMPAT_KEY));
}

#[test]
fn future_feedback_mode_falls_back_without_discarding_the_profile() {
    let mut raw = serde_json::to_value(profile()).unwrap();
    raw["bindings"][0]["feedback_mode"] = "FutureMode".into();
    raw["bindings"][0]["additional_outputs"][0]["feedback_mode"] = "FutureMode".into();
    let restored: Profile = serde_json::from_value(raw).unwrap();
    assert_eq!(restored.bindings.len(), 1);
    assert_eq!(
        restored.bindings[0].feedback_mode,
        FeedbackMode::FollowValue
    );
    assert_eq!(
        restored.bindings[0].additional_outputs[0].feedback_mode,
        FeedbackMode::FollowValue
    );
}

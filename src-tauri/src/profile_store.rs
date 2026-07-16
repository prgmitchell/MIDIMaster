#[cfg(test)]
use crate::durable_json_store::new_recovery_notices;
use crate::{
    durable_json_store::{DurableJsonStore, StorageRecoveryNotices},
    model::{Profile, ProfileSummary},
};
use std::path::PathBuf;

type Result<T> = anyhow::Result<T>;

#[derive(Clone)]
pub struct ProfileStore {
    storage: DurableJsonStore,
}

impl ProfileStore {
    #[cfg(test)]
    pub fn new(config_dir: PathBuf) -> Self {
        Self::with_recovery_notices(config_dir, new_recovery_notices())
    }

    pub(crate) fn with_recovery_notices(
        config_dir: PathBuf,
        recovery_notices: StorageRecoveryNotices,
    ) -> Self {
        let path = config_dir.join("profiles.json");
        Self {
            storage: DurableJsonStore::new(path, "profiles", recovery_notices),
        }
    }

    pub fn list_profiles(&self) -> Result<Vec<ProfileSummary>> {
        let profiles = self.load_all()?;
        Ok(profiles
            .into_iter()
            .map(|profile| ProfileSummary { name: profile.name })
            .collect())
    }

    pub fn load_profile(&self, name: &str) -> Result<Option<Profile>> {
        let profiles = self.load_all()?;
        Ok(profiles.into_iter().find(|profile| profile.name == name))
    }

    pub fn save_profile(&self, profile: Profile) -> Result<()> {
        self.storage.update::<Vec<Profile>, _, _>(|profiles| {
            if let Some(existing) = profiles
                .iter_mut()
                .find(|existing| existing.name == profile.name)
            {
                *existing = profile;
            } else {
                profiles.push(profile);
            }
            normalize_profiles(profiles);
        })
    }

    pub fn delete_profile(&self, name: &str) -> Result<()> {
        self.storage.update::<Vec<Profile>, _, _>(|profiles| {
            profiles.retain(|profile| profile.name != name);
            normalize_profiles(profiles);
        })
    }

    pub fn clear_all(&self) -> Result<()> {
        self.storage.clear()
    }

    fn load_all(&self) -> Result<Vec<Profile>> {
        let mut profiles: Vec<Profile> = self.storage.load_or_default()?;
        for profile in &mut profiles {
            profile.restore_from_storage();
        }
        Ok(profiles)
    }

    #[cfg(test)]
    pub(crate) fn set_failure_point(&self, point: crate::durable_json_store::FailurePoint) {
        self.storage.set_failure_point(point);
    }
}

fn normalize_profiles(profiles: &mut [Profile]) {
    for profile in profiles {
        profile.normalize_for_storage();
    }
}

#[cfg(test)]
mod tests {
    use super::ProfileStore;
    use crate::durable_json_store::new_recovery_notices;
    use crate::model::{AssignMode, Binding, Profile};
    use std::collections::BTreeSet;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("midimaster-profile-store-{name}-{unique}"))
    }

    fn profile(name: &str) -> Profile {
        Profile {
            name: name.to_string(),
            bindings: Vec::new(),
            osd_settings: Default::default(),
            plugin_settings: Default::default(),
            midi_device_preference: Default::default(),
            midi_device_preference_set: false,
        }
    }

    fn profile_with_clear_assign_mode(name: &str) -> Profile {
        let mut profile = profile(name);
        let binding: Binding = serde_json::from_value(serde_json::json!({
            "id": "clear-binding",
            "name": "Clear assign",
            "device_id": "midi:0",
            "control": {
                "channel": 0,
                "controller": 7,
                "msg_type": "ControlChange"
            },
            "control_kind": "Continuous",
            "targets": ["Master"],
            "action": "Volume",
            "mode": "Absolute",
            "deadzone": 0.0,
            "debounce_ms": 0,
            "assign_mode": "Clear"
        }))
        .expect("clear assign binding");
        profile.bindings.push(binding);
        profile
    }

    fn unsafe_light_profiles_json() -> serde_json::Value {
        serde_json::json!([
            {
                "name": "unsafe",
                "bindings": [
                    {
                        "id": "b1",
                        "name": "Binding 1",
                        "device_id": "midi-dev",
                        "control": {
                            "channel": 0,
                            "controller": 22,
                            "msg_type": "Note"
                        },
                        "control_kind": "Button",
                        "targets": ["Master"],
                        "action": "ToggleMute",
                        "mode": "Absolute",
                        "deadzone": 0.0,
                        "debounce_ms": 0,
                        "button_light_mode": "Pressed"
                    }
                ]
            }
        ])
    }

    #[test]
    fn save_profile_keeps_backup_of_previous_profiles() {
        let dir = test_dir("backup");
        let store = ProfileStore::new(dir.clone());

        store.save_profile(profile("first")).expect("save first");
        store.save_profile(profile("second")).expect("save second");

        let backup = std::fs::read_to_string(dir.join("profiles.json.bak")).expect("backup");
        let profiles: Vec<Profile> = serde_json::from_str(&backup).expect("parse backup");
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "first");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn clear_assign_mode_uses_legacy_compatible_storage_and_survives_other_saves() {
        let dir = test_dir("clear-assign-compat");
        let store = ProfileStore::new(dir.clone());

        store
            .save_profile(profile_with_clear_assign_mode("clear"))
            .expect("save clear profile");

        let raw = std::fs::read_to_string(dir.join("profiles.json")).expect("profiles json");
        assert!(!raw.contains(r#""assign_mode": "Clear""#));
        let stored: serde_json::Value = serde_json::from_str(&raw).expect("stored profiles");
        assert_eq!(stored[0]["bindings"][0]["assign_mode"], "Add");
        assert_eq!(
            stored[0]["plugin_settings"]["__midimaster_core_assign_modes"]["clear_binding_ids"][0],
            "clear-binding"
        );

        let loaded = store
            .load_profile("clear")
            .expect("load clear profile")
            .expect("clear profile");
        assert_eq!(loaded.bindings[0].assign_mode, AssignMode::Clear);
        assert!(!loaded
            .plugin_settings
            .contains_key("__midimaster_core_assign_modes"));

        store
            .save_profile(profile("unrelated"))
            .expect("save unrelated profile");
        let reloaded = store
            .load_profile("clear")
            .expect("reload clear profile")
            .expect("clear profile after unrelated save");
        assert_eq!(reloaded.bindings[0].assign_mode, AssignMode::Clear);

        let raw_after_other_save =
            std::fs::read_to_string(dir.join("profiles.json")).expect("profiles json");
        assert!(!raw_after_other_save.contains(r#""assign_mode": "Clear""#));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn load_profile_falls_back_to_backup_when_primary_is_corrupt() {
        let dir = test_dir("fallback");
        let store = ProfileStore::new(dir.clone());

        store.save_profile(profile("recovered")).expect("save");
        std::fs::copy(dir.join("profiles.json"), dir.join("profiles.json.bak")).expect("backup");
        std::fs::write(dir.join("profiles.json"), b"\0\0\0\0").expect("corrupt primary");

        let loaded = store
            .load_profile("recovered")
            .expect("load from backup")
            .expect("profile");
        assert_eq!(loaded.name, "recovered");
        let repaired = std::fs::read_to_string(dir.join("profiles.json")).expect("repaired");
        let repaired_profiles: Vec<Profile> = serde_json::from_str(&repaired).expect("profiles");
        assert_eq!(repaired_profiles[0].name, "recovered");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_profile_does_not_replace_good_backup_with_corrupt_primary() {
        let dir = test_dir("preserve-backup");
        let store = ProfileStore::new(dir.clone());

        store.save_profile(profile("recovered")).expect("save");
        std::fs::copy(dir.join("profiles.json"), dir.join("profiles.json.bak")).expect("backup");
        std::fs::write(dir.join("profiles.json"), b"\0\0\0\0").expect("corrupt primary");

        store
            .save_profile(profile("new"))
            .expect("save after fallback");

        let backup = std::fs::read_to_string(dir.join("profiles.json.bak")).expect("backup");
        let profiles: Vec<Profile> = serde_json::from_str(&backup).expect("parse backup");
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "recovered");

        let loaded = store
            .load_profile("new")
            .expect("load new")
            .expect("new profile");
        assert_eq!(loaded.name, "new");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_profile_can_recreate_primary_when_no_backup_exists() {
        let dir = test_dir("recreate-primary");
        std::fs::create_dir_all(&dir).expect("create dir");
        std::fs::write(dir.join("profiles.json"), b"\0\0\0\0").expect("corrupt primary");
        let store = ProfileStore::new(dir.clone());

        store
            .save_profile(profile("Default"))
            .expect("save default");

        let loaded = store
            .load_profile("Default")
            .expect("load")
            .expect("profile");
        assert_eq!(loaded.name, "Default");
        let backup = std::fs::read_to_string(dir.join("profiles.json.bak")).expect("backup");
        let backup_profiles: Vec<Profile> = serde_json::from_str(&backup).expect("backup json");
        assert!(backup_profiles.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_profile_repairs_unsafe_button_light_modes_for_downgrade() {
        let dir = test_dir("repair-light-mode");
        std::fs::create_dir_all(&dir).expect("create dir");
        std::fs::write(
            dir.join("profiles.json"),
            serde_json::to_vec_pretty(&unsafe_light_profiles_json()).expect("profile json"),
        )
        .expect("write unsafe profile");
        let store = ProfileStore::new(dir.clone());

        store.save_profile(profile("next")).expect("save next");

        let saved = std::fs::read_to_string(dir.join("profiles.json")).expect("profiles");
        let profiles: serde_json::Value = serde_json::from_str(&saved).expect("parse profiles");
        let binding = &profiles[0]["bindings"][0];
        assert_eq!(binding["button_light_mode"], serde_json::json!("Activity"));
        assert_eq!(
            binding["button_light_behavior"],
            serde_json::json!("Pressed")
        );
        assert_eq!(profiles[1]["name"], serde_json::json!("next"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn load_profile_recovers_from_second_backup_when_newer_generations_are_corrupt() {
        let dir = test_dir("second-backup");
        std::fs::create_dir_all(&dir).expect("create dir");
        std::fs::write(dir.join("profiles.json"), b"\0primary").expect("primary");
        std::fs::write(dir.join("profiles.json.bak"), b"").expect("backup");
        std::fs::write(
            dir.join("profiles.json.bak.2"),
            serde_json::to_vec_pretty(&vec![profile("recovered")]).expect("json"),
        )
        .expect("second backup");
        let store = ProfileStore::new(dir.clone());

        let loaded = store
            .load_profile("recovered")
            .expect("load")
            .expect("profile");
        assert_eq!(loaded.name, "recovered");

        let repaired: Vec<Profile> = serde_json::from_slice(
            &std::fs::read(dir.join("profiles.json")).expect("repaired primary"),
        )
        .expect("parse repaired primary");
        assert_eq!(repaired[0].name, "recovered");
        let quarantined_count = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(quarantined_count, 2);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn all_corrupt_generations_are_preserved_before_defaults_are_initialized() {
        let dir = test_dir("all-corrupt");
        std::fs::create_dir_all(&dir).expect("create dir");
        let corrupt_values = [
            b"primary".as_slice(),
            b"\0\0".as_slice(),
            b"backup-two".as_slice(),
        ];
        for (path, value) in [
            (dir.join("profiles.json"), corrupt_values[0]),
            (dir.join("profiles.json.bak"), corrupt_values[1]),
            (dir.join("profiles.json.bak.2"), corrupt_values[2]),
        ] {
            std::fs::write(path, value).expect("write corrupt generation");
        }
        let notices = new_recovery_notices();
        let store = ProfileStore::with_recovery_notices(dir.clone(), notices.clone());

        assert!(store.list_profiles().expect("load defaults").is_empty());
        let notice = notices.lock().expect("notices")[0].clone();
        assert_eq!(notice.store, "profiles");
        assert_eq!(notice.action, "reset_to_defaults");
        assert_eq!(notice.quarantined_paths.len(), 3);

        let preserved = notice
            .quarantined_paths
            .iter()
            .map(std::fs::read)
            .collect::<std::io::Result<Vec<_>>>()
            .expect("read quarantined files")
            .into_iter()
            .collect::<BTreeSet<_>>();
        let expected = corrupt_values
            .into_iter()
            .map(|value| value.to_vec())
            .collect::<BTreeSet<_>>();
        assert_eq!(preserved, expected);
        let primary: Vec<Profile> = serde_json::from_slice(
            &std::fs::read(dir.join("profiles.json")).expect("default primary"),
        )
        .expect("default json");
        assert!(primary.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn first_run_missing_files_do_not_emit_recovery_notice() {
        let dir = test_dir("first-run");
        let notices = new_recovery_notices();
        let store = ProfileStore::with_recovery_notices(dir.clone(), notices.clone());

        assert!(store.list_profiles().expect("first run").is_empty());
        assert!(notices.lock().expect("notices").is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn concurrent_profile_saves_do_not_lose_updates() {
        let dir = test_dir("concurrent");
        let store = ProfileStore::new(dir.clone());
        let threads = (0..12)
            .map(|index| {
                let store = store.clone();
                std::thread::spawn(move || {
                    store
                        .save_profile(profile(&format!("profile-{index}")))
                        .expect("save profile");
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().expect("join");
        }

        let profiles = store.list_profiles().expect("profiles");
        assert_eq!(profiles.len(), 12);
        let names = profiles
            .into_iter()
            .map(|profile| profile.name)
            .collect::<BTreeSet<_>>();
        assert_eq!(names.len(), 12);

        let _ = std::fs::remove_dir_all(dir);
    }
}

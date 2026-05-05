use crate::model::{Profile, ProfileSummary};
use anyhow::{anyhow, Context};
use std::{
    fs,
    path::{Path, PathBuf},
};

type Result<T> = anyhow::Result<T>;

#[derive(Clone)]
pub struct ProfileStore {
    path: PathBuf,
}

impl ProfileStore {
    pub fn new(config_dir: PathBuf) -> Self {
        let path = config_dir.join("profiles.json");
        Self { path }
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
        let mut profiles = self.load_all_for_update()?;
        if let Some(existing) = profiles
            .iter_mut()
            .find(|existing| existing.name == profile.name)
        {
            *existing = profile;
        } else {
            profiles.push(profile);
        }
        self.write_all(&profiles)
    }

    pub fn delete_profile(&self, name: &str) -> Result<()> {
        let profiles = self
            .load_all_for_update()?
            .into_iter()
            .filter(|profile| profile.name != name)
            .collect::<Vec<_>>();
        self.write_all(&profiles)
    }

    pub fn clear_all(&self) -> Result<()> {
        if self.path.exists() {
            self.backup_existing_file()?;
            fs::remove_file(&self.path)
                .with_context(|| format!("Failed deleting {}", self.path.display()))?;
        }
        Ok(())
    }

    fn load_all(&self) -> Result<Vec<Profile>> {
        if !self.path.exists() {
            return self.load_backup_or_empty();
        }
        let data = read_to_string(&self.path)?;
        if data.trim().is_empty() {
            return Ok(Vec::new());
        }
        match serde_json::from_str(&data) {
            Ok(profiles) => Ok(profiles),
            Err(primary_err) => {
                let backup_path = self.backup_path();
                if backup_path.exists() {
                    if let Ok(Some(profiles)) = read_profiles_file(&backup_path) {
                        return Ok(profiles);
                    }
                }
                Err(primary_err).with_context(|| format!("Failed parsing {}", self.path.display()))
            }
        }
    }

    fn write_all(&self, profiles: &[Profile]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed creating {}", parent.display()))?;
        }
        let data = serde_json::to_string_pretty(profiles)?;
        self.write_atomically(data.as_bytes())?;
        Ok(())
    }

    fn write_atomically(&self, data: &[u8]) -> Result<()> {
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, data)
            .with_context(|| format!("Failed writing {}", tmp_path.display()))?;

        self.backup_existing_file()?;
        replace_file(&tmp_path, &self.path)
    }

    fn backup_existing_file(&self) -> Result<()> {
        if matches!(read_profiles_file(&self.path), Ok(Some(_))) {
            fs::copy(&self.path, self.backup_path())
                .with_context(|| format!("Failed backing up {}", self.path.display()))?;
        }
        Ok(())
    }

    fn backup_path(&self) -> PathBuf {
        self.path.with_extension("json.bak")
    }

    fn load_backup_or_empty(&self) -> Result<Vec<Profile>> {
        match read_profiles_file(&self.backup_path())? {
            Some(profiles) => Ok(profiles),
            None => Ok(Vec::new()),
        }
    }

    fn load_all_for_update(&self) -> Result<Vec<Profile>> {
        if !self.path.exists() {
            return self.load_backup_or_empty();
        }

        let data = read_to_string(&self.path)?;
        if data.trim().is_empty() {
            return Ok(Vec::new());
        }

        match serde_json::from_str(&data) {
            Ok(profiles) => Ok(profiles),
            Err(_) => self.load_backup_or_empty(),
        }
    }
}

fn replace_file(tmp_path: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        fs::remove_file(destination)
            .with_context(|| format!("Failed replacing {}", destination.display()))?;
    }

    match fs::rename(tmp_path, destination) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            let _ = fs::remove_file(tmp_path);
            Err(anyhow!(rename_err))
                .with_context(|| format!("Failed replacing {}", destination.display()))
        }
    }
}

fn read_profiles_file(path: &Path) -> Result<Option<Vec<Profile>>> {
    if !path.exists() {
        return Ok(None);
    }

    let data = read_to_string(path)?;
    if data.trim().is_empty() {
        return Ok(Some(Vec::new()));
    }

    let profiles = serde_json::from_str(&data)
        .with_context(|| format!("Failed parsing {}", path.display()))?;
    Ok(Some(profiles))
}

fn read_to_string(path: &Path) -> Result<String> {
    fs::read_to_string(path).with_context(|| format!("Failed reading {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::ProfileStore;
    use crate::model::Profile;
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
        }
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
        assert!(!dir.join("profiles.json.bak").exists());

        let _ = std::fs::remove_dir_all(dir);
    }
}

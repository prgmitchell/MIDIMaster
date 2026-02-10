use crate::model::{Profile, ProfileSummary};
use anyhow::Context;
use std::{fs, path::PathBuf};

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
        let mut profiles = self.load_all()?;
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
            .load_all()?
            .into_iter()
            .filter(|profile| profile.name != name)
            .collect::<Vec<_>>();
        self.write_all(&profiles)
    }

    pub fn clear_all(&self) -> Result<()> {
        if self.path.exists() {
            fs::remove_file(&self.path)
                .with_context(|| format!("Failed deleting {}", self.path.display()))?;
        }
        Ok(())
    }

    fn load_all(&self) -> Result<Vec<Profile>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let data = fs::read_to_string(&self.path)
            .with_context(|| format!("Failed reading {}", self.path.display()))?;
        if data.trim().is_empty() {
            return Ok(Vec::new());
        }
        let profiles = serde_json::from_str(&data)
            .with_context(|| format!("Failed parsing {}", self.path.display()))?;
        Ok(profiles)
    }

    fn write_all(&self, profiles: &[Profile]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed creating {}", parent.display()))?;
        }
        let data = serde_json::to_string_pretty(profiles)?;
        fs::write(&self.path, data)
            .with_context(|| format!("Failed writing {}", self.path.display()))?;
        Ok(())
    }
}

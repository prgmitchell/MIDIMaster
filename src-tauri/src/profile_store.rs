use crate::{
    durable_json_store::{DurableJsonStore, StorageRecoveryNotices},
    model::{Profile, ProfileSummary},
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

type Result<T> = anyhow::Result<T>;

#[derive(Clone)]
pub struct ProfileStore {
    storage: DurableJsonStore,
    storage_path: PathBuf,
    cache: Arc<Mutex<Option<CachedProfiles>>>,
}

#[derive(Clone)]
struct CachedProfiles {
    profiles: Vec<Profile>,
    fingerprint: Option<StorageFingerprint>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StorageFingerprint {
    len: u64,
    modified: Option<SystemTime>,
}

impl ProfileStore {
    pub(crate) fn with_recovery_notices(
        config_dir: PathBuf,
        recovery_notices: StorageRecoveryNotices,
    ) -> Self {
        let path = config_dir.join("profiles.json");
        Self {
            storage: DurableJsonStore::new(path.clone(), "profiles", recovery_notices),
            storage_path: path,
            cache: Arc::new(Mutex::new(None)),
        }
    }

    pub fn list_profiles(&self) -> Result<Vec<ProfileSummary>> {
        let cache = self.cache()?;
        let cache = cache.as_ref().expect("profile cache initialized");
        Ok(cache
            .profiles
            .iter()
            .map(|profile| ProfileSummary {
                name: profile.name.clone(),
            })
            .collect())
    }

    pub fn load_profile(&self, name: &str) -> Result<Option<Profile>> {
        let cache = self.cache()?;
        let cache = cache.as_ref().expect("profile cache initialized");
        Ok(cache
            .profiles
            .iter()
            .find(|profile| profile.name == name)
            .cloned())
    }

    pub fn save_profile(&self, mut profile: Profile) -> Result<()> {
        profile.strip_derived_integration_icons();
        let mut cache = self.cache()?;
        let cache = cache.as_mut().expect("profile cache initialized");
        let mut candidate = cache.profiles.clone();
        if let Some(existing) = candidate
            .iter_mut()
            .find(|existing| existing.name == profile.name)
        {
            *existing = profile;
        } else {
            candidate.push(profile);
        }
        self.commit_candidate(cache, candidate)
    }

    pub fn delete_profile(&self, name: &str) -> Result<()> {
        let mut cache = self.cache()?;
        let cache = cache.as_mut().expect("profile cache initialized");
        let mut candidate = cache.profiles.clone();
        candidate.retain(|profile| profile.name != name);
        self.commit_candidate(cache, candidate)
    }

    pub(crate) fn update_target_states(
        &self,
        name: &str,
        states: Vec<crate::model::ProfileTargetState>,
    ) -> Result<()> {
        let mut cache = self.cache()?;
        let cache = cache.as_mut().expect("profile cache initialized");
        let Some(profile) = cache.profiles.iter().find(|profile| profile.name == name) else {
            return Ok(());
        };
        if profile.target_states == states {
            return Ok(());
        }
        let mut candidate = cache.profiles.clone();
        candidate
            .iter_mut()
            .find(|profile| profile.name == name)
            .unwrap()
            .target_states = states;
        self.commit_candidate(cache, candidate)
    }

    pub fn clear_all(&self) -> Result<()> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| anyhow::anyhow!("profiles cache lock poisoned"))?;
        self.storage.clear()?;
        *cache = Some(CachedProfiles {
            profiles: Vec::new(),
            fingerprint: storage_fingerprint(&self.storage_path),
        });
        Ok(())
    }

    fn cache(&self) -> Result<MutexGuard<'_, Option<CachedProfiles>>> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| anyhow::anyhow!("profiles cache lock poisoned"))?;
        let current_fingerprint = storage_fingerprint(&self.storage_path);
        let cache_is_current = cache
            .as_ref()
            .is_some_and(|cache| cache.fingerprint == current_fingerprint);
        if !cache_is_current {
            *cache = Some(CachedProfiles {
                profiles: self.load_all_uncached()?,
                fingerprint: storage_fingerprint(&self.storage_path),
            });
        }
        Ok(cache)
    }

    fn commit_candidate(&self, cache: &mut CachedProfiles, candidate: Vec<Profile>) -> Result<()> {
        let mut persisted = candidate.clone();
        normalize_profiles(&mut persisted);
        self.storage.save(&persisted)?;
        cache.profiles = candidate;
        cache.fingerprint = storage_fingerprint(&self.storage_path);
        Ok(())
    }

    fn load_all_uncached(&self) -> Result<Vec<Profile>> {
        let mut profiles: Vec<Profile> = self.storage.load_or_default()?;
        for profile in &mut profiles {
            profile.strip_derived_integration_icons();
        }
        for profile in &mut profiles {
            profile.restore_from_storage();
        }
        Ok(profiles)
    }
}

fn storage_fingerprint(path: &std::path::Path) -> Option<StorageFingerprint> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(StorageFingerprint {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn normalize_profiles(profiles: &mut [Profile]) {
    for profile in profiles {
        profile.normalize_for_storage();
    }
}

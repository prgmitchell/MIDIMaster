use crate::run_logger;
use anyhow::{anyhow, Context};
use chrono::Utc;
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use windows::{
    core::PCWSTR,
    Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
};

type Result<T> = anyhow::Result<T>;

pub(crate) type StorageRecoveryNotices = Arc<Mutex<Vec<StorageRecoveryNotice>>>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageRecoveryNotice {
    pub(crate) store: String,
    pub(crate) action: String,
    pub(crate) source_path: Option<String>,
    pub(crate) quarantined_paths: Vec<String>,
}

pub(crate) fn new_recovery_notices() -> StorageRecoveryNotices {
    Arc::new(Mutex::new(Vec::new()))
}

#[derive(Clone)]
pub(crate) struct DurableJsonStore {
    path: PathBuf,
    store_name: &'static str,
    lock: Arc<Mutex<()>>,
    recovery_notices: StorageRecoveryNotices,
}

enum Candidate<T> {
    Missing,
    Valid(T),
    Invalid(String),
}

impl<T> Candidate<T> {
    fn is_invalid(&self) -> bool {
        matches!(self, Self::Invalid(_))
    }
}

impl DurableJsonStore {
    pub(crate) fn new(
        path: PathBuf,
        store_name: &'static str,
        recovery_notices: StorageRecoveryNotices,
    ) -> Self {
        Self {
            path,
            store_name,
            lock: Arc::new(Mutex::new(())),
            recovery_notices,
        }
    }

    pub(crate) fn load_or_default<T>(&self) -> Result<T>
    where
        T: Clone + Default + DeserializeOwned + Serialize,
    {
        let _guard = self.lock()?;
        self.load_or_default_locked()
    }

    pub(crate) fn save<T>(&self, value: &T) -> Result<()>
    where
        T: Clone + Default + DeserializeOwned + Serialize,
    {
        let _guard = self.lock()?;
        self.write_locked(value)
    }

    pub(crate) fn clear(&self) -> Result<()> {
        let _guard = self.lock()?;
        for path in [
            self.path.clone(),
            self.backup_path(),
            self.second_backup_path(),
            self.temp_path(),
            self.backup_temp_path(),
        ] {
            remove_file_if_exists(&path)?;
        }
        Ok(())
    }

    fn lock(&self) -> Result<MutexGuard<'_, ()>> {
        self.lock
            .lock()
            .map_err(|_| anyhow!("{} storage lock poisoned", self.store_name))
    }

    fn load_or_default_locked<T>(&self) -> Result<T>
    where
        T: Clone + Default + DeserializeOwned + Serialize,
    {
        let primary = read_candidate::<T>(&self.path)?;
        if let Candidate::Valid(value) = &primary {
            if let Err(error) = remove_file_if_exists(&self.temp_path()) {
                run_logger::warn(
                    "storage",
                    "stale_temp_cleanup_failed",
                    &format!("store={} error={}", self.store_name, error),
                );
            }
            return Ok(value.clone());
        }

        let backup_path = self.backup_path();
        let backup = read_candidate::<T>(&backup_path)?;
        if let Candidate::Valid(value) = &backup {
            let quarantined = self.quarantine_invalid_candidates([(&self.path, &primary)])?;
            self.write_primary_without_backup_locked(value)?;
            self.record_recovery("restored_backup", Some(&backup_path), quarantined);
            return Ok(value.clone());
        }

        let second_backup_path = self.second_backup_path();
        let second_backup = read_candidate::<T>(&second_backup_path)?;
        if let Candidate::Valid(value) = &second_backup {
            let quarantined = self
                .quarantine_invalid_candidates([(&self.path, &primary), (&backup_path, &backup)])?;
            self.write_primary_without_backup_locked(value)?;
            self.record_recovery("restored_backup", Some(&second_backup_path), quarantined);
            return Ok(value.clone());
        }

        let had_corruption =
            primary.is_invalid() || backup.is_invalid() || second_backup.is_invalid();
        if !had_corruption {
            return Ok(T::default());
        }

        let quarantined = self.quarantine_invalid_candidates([
            (&self.path, &primary),
            (&backup_path, &backup),
            (&second_backup_path, &second_backup),
        ])?;
        let value = T::default();
        self.write_primary_without_backup_locked(&value)?;
        self.record_recovery("reset_to_defaults", None, quarantined);
        Ok(value)
    }

    fn write_locked<T>(&self, value: &T) -> Result<()>
    where
        T: Clone + Default + DeserializeOwned + Serialize,
    {
        let data = serialize_and_validate(value)?;
        let primary = read_candidate::<T>(&self.path)?;
        let temp_path = self.temp_path();
        write_durable_file(&temp_path, &data)?;
        validate_file::<T>(&temp_path)?;

        match primary {
            Candidate::Valid(_) => self.prepare_backups_locked::<T>()?,
            Candidate::Invalid(error) => {
                run_logger::warn(
                    "storage",
                    "primary_invalid_before_save",
                    &format!(
                        "store={} path={} error={}",
                        self.store_name,
                        self.path.display(),
                        error
                    ),
                );
                let _ = self.quarantine_path(&self.path)?;
            }
            Candidate::Missing => {}
        }
        atomic_move(&temp_path, &self.path, true)
            .with_context(|| format!("Failed committing {}", self.path.display()))?;
        Ok(())
    }

    fn write_primary_without_backup_locked<T>(&self, value: &T) -> Result<()>
    where
        T: DeserializeOwned + Serialize,
    {
        let data = serialize_and_validate(value)?;
        let temp_path = self.temp_path();
        write_durable_file(&temp_path, &data)?;
        validate_file::<T>(&temp_path)?;
        atomic_move(&temp_path, &self.path, true)
            .with_context(|| format!("Failed restoring {}", self.path.display()))?;
        Ok(())
    }

    fn prepare_backups_locked<T>(&self) -> Result<()>
    where
        T: DeserializeOwned,
    {
        let backup_path = self.backup_path();
        match read_candidate::<T>(&backup_path)? {
            Candidate::Valid(_) => {
                let second_backup_path = self.second_backup_path();
                if let Candidate::Invalid(_) = read_candidate::<T>(&second_backup_path)? {
                    let _ = self.quarantine_path(&second_backup_path)?;
                }
                atomic_move(&backup_path, &second_backup_path, true).with_context(|| {
                    format!(
                        "Failed rotating {} to {}",
                        backup_path.display(),
                        second_backup_path.display()
                    )
                })?;
            }
            Candidate::Invalid(_) => {
                let _ = self.quarantine_path(&backup_path)?;
            }
            Candidate::Missing => {}
        }

        let data = fs::read(&self.path)
            .with_context(|| format!("Failed reading {} for backup", self.path.display()))?;
        let backup_temp_path = self.backup_temp_path();
        write_durable_file(&backup_temp_path, &data)?;
        validate_file::<T>(&backup_temp_path)?;
        atomic_move(&backup_temp_path, &backup_path, true)
            .with_context(|| format!("Failed committing backup {}", backup_path.display()))?;
        Ok(())
    }

    fn quarantine_invalid_candidates<'a, T, const N: usize>(
        &self,
        candidates: [(&'a Path, &'a Candidate<T>); N],
    ) -> Result<Vec<String>> {
        let mut quarantined = Vec::new();
        for (path, candidate) in candidates {
            if let Candidate::Invalid(error) = candidate {
                run_logger::warn(
                    "storage",
                    "invalid_generation",
                    &format!(
                        "store={} path={} error={}",
                        self.store_name,
                        path.display(),
                        error
                    ),
                );
                quarantined.push(self.quarantine_path(path)?.display().to_string());
            }
        }
        Ok(quarantined)
    }

    fn quarantine_path(&self, path: &Path) -> Result<PathBuf> {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("storage.json");
        let timestamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
        let quarantine_path = path.with_file_name(format!(
            "{}.corrupt-{}-{}",
            file_name,
            timestamp,
            Uuid::new_v4()
        ));
        atomic_move(path, &quarantine_path, false).with_context(|| {
            format!(
                "Failed preserving corrupt file {} as {}",
                path.display(),
                quarantine_path.display()
            )
        })?;
        Ok(quarantine_path)
    }

    fn record_recovery(
        &self,
        action: &str,
        source_path: Option<&Path>,
        quarantined_paths: Vec<String>,
    ) {
        let notice = StorageRecoveryNotice {
            store: self.store_name.to_string(),
            action: action.to_string(),
            source_path: source_path.map(|path| path.display().to_string()),
            quarantined_paths,
        };
        run_logger::warn(
            "storage",
            action,
            &format!(
                "store={} source={} quarantined={}",
                notice.store,
                notice.source_path.as_deref().unwrap_or(""),
                notice.quarantined_paths.join("|")
            ),
        );
        if let Ok(mut notices) = self.recovery_notices.lock() {
            notices.push(notice);
        }
    }

    fn backup_path(&self) -> PathBuf {
        with_appended_extension(&self.path, "bak")
    }

    fn second_backup_path(&self) -> PathBuf {
        with_appended_extension(&self.path, "bak.2")
    }

    fn temp_path(&self) -> PathBuf {
        with_appended_extension(&self.path, "tmp")
    }

    fn backup_temp_path(&self) -> PathBuf {
        with_appended_extension(&self.path, "bak.tmp")
    }
}

fn serialize_and_validate<T>(value: &T) -> Result<Vec<u8>>
where
    T: DeserializeOwned + Serialize,
{
    let mut data = serde_json::to_vec_pretty(value)?;
    data.push(b'\n');
    let _: T = serde_json::from_slice(&data).context("Serialized JSON failed validation")?;
    Ok(data)
}

fn validate_file<T>(path: &Path) -> Result<()>
where
    T: DeserializeOwned,
{
    match read_candidate::<T>(path)? {
        Candidate::Valid(_) => Ok(()),
        Candidate::Missing => Err(anyhow!("{} disappeared before validation", path.display())),
        Candidate::Invalid(error) => Err(anyhow!(error)),
    }
}

fn read_candidate<T>(path: &Path) -> Result<Candidate<T>>
where
    T: DeserializeOwned,
{
    let data = match fs::read(path) {
        Ok(data) => data,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Candidate::Missing),
        Err(error) => {
            // An I/O failure does not prove corruption. Preserve the original
            // file and surface the error instead of restoring older data over it.
            return Err(error).with_context(|| format!("Failed reading {}", path.display()));
        }
    };
    if data.is_empty() || data.iter().all(|byte| *byte == 0) {
        return Ok(Candidate::Invalid(format!(
            "{} is empty or all-NUL",
            path.display()
        )));
    }
    Ok(match serde_json::from_slice(&data) {
        Ok(value) => Candidate::Valid(value),
        Err(error) => Candidate::Invalid(format!("Failed parsing {}: {}", path.display(), error)),
    })
}

fn write_durable_file(path: &Path, data: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed creating {}", parent.display()))?;
    }
    remove_file_if_exists(path)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .with_context(|| format!("Failed creating {}", path.display()))?;
    file.write_all(data)
        .with_context(|| format!("Failed writing {}", path.display()))?;
    file.flush()
        .with_context(|| format!("Failed flushing {}", path.display()))?;
    file.sync_all()
        .with_context(|| format!("Failed syncing {}", path.display()))?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("Failed deleting {}", path.display())),
    }
}

fn with_appended_extension(path: &Path, suffix: &str) -> PathBuf {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!("{}.{}", value, suffix))
        .unwrap_or_else(|| suffix.to_string());
    path.with_extension(extension)
}

#[cfg(target_os = "windows")]
fn atomic_move(source: &Path, destination: &Path, replace_existing: bool) -> Result<()> {
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut flags = MOVEFILE_WRITE_THROUGH;
    if replace_existing {
        flags |= MOVEFILE_REPLACE_EXISTING;
    }
    unsafe {
        MoveFileExW(
            PCWSTR(source_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            flags,
        )
    }
    .with_context(|| {
        format!(
            "Failed moving {} to {}",
            source.display(),
            destination.display()
        )
    })
}

#[cfg(not(target_os = "windows"))]
fn atomic_move(source: &Path, destination: &Path, _replace_existing: bool) -> Result<()> {
    fs::rename(source, destination).with_context(|| {
        format!(
            "Failed moving {} to {}",
            source.display(),
            destination.display()
        )
    })
}

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppSettings {
    pub start_with_windows: bool,
    pub start_in_tray: bool,
    pub minimize_to_tray: bool,
    pub exit_to_tray: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            start_with_windows: false,
            start_in_tray: false,
            minimize_to_tray: false,
            exit_to_tray: false,
        }
    }
}

type Result<T> = anyhow::Result<T>;

#[derive(Clone)]
pub struct AppSettingsStore {
    path: PathBuf,
}

impl AppSettingsStore {
    pub fn new(config_dir: PathBuf) -> Self {
        let path = config_dir.join("app_settings.json");
        Self { path }
    }

    pub fn load(&self) -> Result<AppSettings> {
        if !self.path.exists() {
            return Ok(AppSettings::default());
        }
        let data = fs::read_to_string(&self.path)
            .with_context(|| format!("Failed reading {}", self.path.display()))?;
        if data.trim().is_empty() {
            return Ok(AppSettings::default());
        }
        let settings = serde_json::from_str(&data)
            .with_context(|| format!("Failed parsing {}", self.path.display()))?;
        Ok(settings)
    }

    pub fn save(&self, settings: &AppSettings) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed creating {}", parent.display()))?;
        }
        let data = serde_json::to_string_pretty(settings)?;
        fs::write(&self.path, data)
            .with_context(|| format!("Failed writing {}", self.path.display()))?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        if self.path.exists() {
            fs::remove_file(&self.path)
                .with_context(|| format!("Failed deleting {}", self.path.display()))?;
        }
        Ok(())
    }
}

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub start_with_windows: bool,
    pub start_in_tray: bool,
    pub minimize_to_tray: bool,
    pub exit_to_tray: bool,
    pub ui_theme: String,
    pub midi_input_device_id: Option<String>,
    pub midi_output_device_id: Option<String>,
    pub midi_input_device_name: Option<String>,
    pub midi_output_device_name: Option<String>,
    pub active_profile_name: Option<String>,
    pub auto_check_updates: bool,
    pub language: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            start_with_windows: false,
            start_in_tray: false,
            minimize_to_tray: false,
            exit_to_tray: false,
            ui_theme: "light".to_string(),
            midi_input_device_id: None,
            midi_output_device_id: None,
            midi_input_device_name: None,
            midi_output_device_name: None,
            active_profile_name: None,
            auto_check_updates: true,
            language: "en".to_string(),
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

#[cfg(test)]
mod tests {
    use super::{AppSettings, AppSettingsStore};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn default_language_is_english() {
        assert_eq!(AppSettings::default().language, "en");
    }

    #[test]
    fn missing_language_deserializes_to_english() {
        let json = r#"{
            "start_with_windows": true,
            "start_in_tray": false,
            "minimize_to_tray": true,
            "exit_to_tray": false,
            "ui_theme": "dark",
            "auto_check_updates": true
        }"#;
        let settings: AppSettings = serde_json::from_str(json).expect("settings deserialize");
        assert_eq!(settings.language, "en");
        assert!(settings.start_with_windows);
        assert!(settings.minimize_to_tray);
    }

    #[test]
    fn saved_language_round_trips() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("midimaster-settings-test-{unique}"));
        let store = AppSettingsStore::new(dir.clone());
        let settings = AppSettings {
            language: "fr".to_string(),
            ..AppSettings::default()
        };

        store.save(&settings).expect("save settings");
        let loaded = store.load().expect("load settings");
        assert_eq!(loaded.language, "fr");

        let _ = std::fs::remove_dir_all(dir);
    }
}

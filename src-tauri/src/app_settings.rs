use crate::model::{normalized_routes_with_legacy, FaderCurvePoint, MidiDeviceRoute};
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::PathBuf};

fn default_active_theme_id() -> String {
    "system".to_string()
}

fn default_accent_color() -> String {
    "#5aa7ff".to_string()
}

fn default_color_temperature() -> f64 {
    50.0
}

fn default_corner_radius() -> f64 {
    4.0
}

fn default_true() -> bool {
    true
}

fn default_effect_intensity() -> f64 {
    30.0
}

fn default_surface_contrast() -> f64 {
    50.0
}

fn default_icon_glow() -> f64 {
    50.0
}

fn default_transparency() -> f64 {
    30.0
}

fn default_font_family() -> String {
    "bahnschrift".to_string()
}

fn default_font_size() -> f64 {
    14.0
}

fn default_text_rendering() -> String {
    "auto".to_string()
}

pub const CURRENT_STARTUP_REGISTRATION_VERSION: u32 = 2;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MidiDeviceInventoryConsent {
    #[default]
    Unknown,
    Enabled,
    Disabled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AppearanceTheme {
    pub id: String,
    pub name: String,
    pub scheme: String,
    pub base_preset_id: String,
    pub accent_color: String,
    pub color_temperature: f64,
    pub corner_radius: f64,
    pub animations: bool,
    pub background_effects: bool,
    pub effect_intensity: f64,
    pub surface_contrast: f64,
    pub icon_glow: f64,
    pub transparency: f64,
    pub font_family: String,
    pub font_size: f64,
    pub text_rendering: String,
    pub tokens: BTreeMap<String, String>,
}

impl Default for AppearanceTheme {
    fn default() -> Self {
        Self {
            id: "custom-theme".to_string(),
            name: "Custom Theme".to_string(),
            scheme: "dark".to_string(),
            base_preset_id: "dark".to_string(),
            accent_color: default_accent_color(),
            color_temperature: default_color_temperature(),
            corner_radius: default_corner_radius(),
            animations: true,
            background_effects: true,
            effect_intensity: default_effect_intensity(),
            surface_contrast: default_surface_contrast(),
            icon_glow: default_icon_glow(),
            transparency: default_transparency(),
            font_family: default_font_family(),
            font_size: default_font_size(),
            text_rendering: default_text_rendering(),
            tokens: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AppAppearanceSettings {
    #[serde(default = "default_active_theme_id")]
    pub active_theme_id: String,
    #[serde(default = "default_accent_color")]
    pub accent_color: String,
    #[serde(default = "default_color_temperature")]
    pub color_temperature: f64,
    #[serde(default = "default_corner_radius")]
    pub corner_radius: f64,
    #[serde(default = "default_true")]
    pub animations: bool,
    #[serde(default = "default_true")]
    pub background_effects: bool,
    #[serde(default = "default_effect_intensity")]
    pub effect_intensity: f64,
    #[serde(default = "default_surface_contrast")]
    pub surface_contrast: f64,
    #[serde(default = "default_icon_glow")]
    pub icon_glow: f64,
    #[serde(default = "default_transparency")]
    pub transparency: f64,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default = "default_text_rendering")]
    pub text_rendering: String,
    pub tokens: BTreeMap<String, String>,
    pub custom_themes: Vec<AppearanceTheme>,
}

impl Default for AppAppearanceSettings {
    fn default() -> Self {
        Self {
            active_theme_id: default_active_theme_id(),
            accent_color: default_accent_color(),
            color_temperature: default_color_temperature(),
            corner_radius: default_corner_radius(),
            animations: true,
            background_effects: true,
            effect_intensity: default_effect_intensity(),
            surface_contrast: default_surface_contrast(),
            icon_glow: default_icon_glow(),
            transparency: default_transparency(),
            font_family: default_font_family(),
            font_size: default_font_size(),
            text_rendering: default_text_rendering(),
            tokens: BTreeMap::new(),
            custom_themes: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct FaderCurvePreset {
    pub id: String,
    pub name: String,
    pub points: Vec<FaderCurvePoint>,
}

impl Default for FaderCurvePreset {
    fn default() -> Self {
        Self {
            id: "curve-preset".to_string(),
            name: "Custom Curve".to_string(),
            points: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub start_with_windows: bool,
    #[serde(default)]
    pub startup_registration_version: u32,
    pub start_in_tray: bool,
    pub minimize_to_tray: bool,
    pub exit_to_tray: bool,
    pub ui_theme: String,
    pub midi_input_device_id: Option<String>,
    pub midi_output_device_id: Option<String>,
    pub midi_input_device_name: Option<String>,
    pub midi_output_device_name: Option<String>,
    pub midi_device_routes: Vec<MidiDeviceRoute>,
    pub active_profile_name: Option<String>,
    pub auto_check_updates: bool,
    pub language: String,
    pub appearance: AppAppearanceSettings,
    pub fader_curve_presets: Vec<FaderCurvePreset>,
    pub midi_device_inventory_consent: MidiDeviceInventoryConsent,
    pub midi_device_inventory_notice_version: u32,
    pub midi_device_inventory_last_sent_hash: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            start_with_windows: false,
            startup_registration_version: CURRENT_STARTUP_REGISTRATION_VERSION,
            start_in_tray: false,
            minimize_to_tray: false,
            exit_to_tray: false,
            ui_theme: "system".to_string(),
            midi_input_device_id: None,
            midi_output_device_id: None,
            midi_input_device_name: None,
            midi_output_device_name: None,
            midi_device_routes: Vec::new(),
            active_profile_name: None,
            auto_check_updates: true,
            language: "en".to_string(),
            appearance: AppAppearanceSettings::default(),
            fader_curve_presets: Vec::new(),
            midi_device_inventory_consent: MidiDeviceInventoryConsent::Unknown,
            midi_device_inventory_notice_version: 0,
            midi_device_inventory_last_sent_hash: None,
        }
    }
}

impl AppSettings {
    pub fn normalized_midi_routes(&self) -> Vec<MidiDeviceRoute> {
        normalized_routes_with_legacy(
            &self.midi_device_routes,
            self.midi_input_device_id.clone(),
            self.midi_output_device_id.clone(),
            self.midi_input_device_name.clone(),
            self.midi_output_device_name.clone(),
        )
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
    use super::{
        AppAppearanceSettings, AppSettings, AppSettingsStore, AppearanceTheme, FaderCurvePreset,
        MidiDeviceInventoryConsent,
    };
    use crate::model::FaderCurvePoint;
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn default_language_is_english() {
        assert_eq!(AppSettings::default().language, "en");
    }

    #[test]
    fn default_startup_registration_version_is_current() {
        assert_eq!(
            AppSettings::default().startup_registration_version,
            super::CURRENT_STARTUP_REGISTRATION_VERSION
        );
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
        assert_eq!(settings.startup_registration_version, 0);
        assert!(settings.minimize_to_tray);
        assert_eq!(settings.appearance.active_theme_id, "system");
        assert_eq!(settings.appearance.font_size, 14.0);
        assert_eq!(settings.appearance.surface_contrast, 50.0);
        assert_eq!(settings.appearance.icon_glow, 50.0);
        assert!(settings.fader_curve_presets.is_empty());
        assert_eq!(
            settings.midi_device_inventory_consent,
            MidiDeviceInventoryConsent::Unknown
        );
        assert_eq!(settings.midi_device_inventory_notice_version, 0);
        assert_eq!(settings.midi_device_inventory_last_sent_hash, None);
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

    #[test]
    fn midi_device_inventory_consent_round_trips() {
        let settings = AppSettings {
            midi_device_inventory_consent: MidiDeviceInventoryConsent::Enabled,
            midi_device_inventory_notice_version: 1,
            midi_device_inventory_last_sent_hash: Some("abc123".to_string()),
            ..AppSettings::default()
        };

        let json = serde_json::to_string(&settings).expect("serialize settings");
        let loaded: AppSettings = serde_json::from_str(&json).expect("deserialize settings");

        assert_eq!(
            loaded.midi_device_inventory_consent,
            MidiDeviceInventoryConsent::Enabled
        );
        assert_eq!(loaded.midi_device_inventory_notice_version, 1);
        assert_eq!(
            loaded.midi_device_inventory_last_sent_hash.as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn appearance_defaults_to_system_theme() {
        let appearance = AppAppearanceSettings::default();
        assert_eq!(appearance.active_theme_id, "system");
        assert_eq!(appearance.font_family, "bahnschrift");
        assert_eq!(appearance.font_size, 14.0);
        assert_eq!(appearance.surface_contrast, 50.0);
        assert_eq!(appearance.icon_glow, 50.0);
        assert!(appearance.animations);
    }

    #[test]
    fn saved_appearance_round_trips() {
        let mut tokens = BTreeMap::new();
        tokens.insert("--accent".to_string(), "#24c8d6".to_string());
        let settings = AppSettings {
            appearance: AppAppearanceSettings {
                active_theme_id: "custom-ocean".to_string(),
                surface_contrast: 72.0,
                icon_glow: 64.0,
                custom_themes: vec![AppearanceTheme {
                    id: "custom-ocean".to_string(),
                    name: "Ocean Copy".to_string(),
                    accent_color: "#24c8d6".to_string(),
                    surface_contrast: 38.0,
                    icon_glow: 24.0,
                    tokens,
                    ..AppearanceTheme::default()
                }],
                ..AppAppearanceSettings::default()
            },
            ..AppSettings::default()
        };

        let json = serde_json::to_string(&settings).expect("serialize settings");
        let loaded: AppSettings = serde_json::from_str(&json).expect("deserialize settings");

        assert_eq!(loaded.appearance.active_theme_id, "custom-ocean");
        assert_eq!(loaded.appearance.surface_contrast, 72.0);
        assert_eq!(loaded.appearance.icon_glow, 64.0);
        assert_eq!(loaded.appearance.custom_themes.len(), 1);
        assert_eq!(loaded.appearance.custom_themes[0].surface_contrast, 38.0);
        assert_eq!(loaded.appearance.custom_themes[0].icon_glow, 24.0);
        assert_eq!(
            loaded.appearance.custom_themes[0].tokens.get("--accent"),
            Some(&"#24c8d6".to_string())
        );
    }

    #[test]
    fn saved_fader_curve_presets_round_trip() {
        let settings = AppSettings {
            fader_curve_presets: vec![FaderCurvePreset {
                id: "drums-ride".to_string(),
                name: "Drums Ride".to_string(),
                points: vec![
                    FaderCurvePoint {
                        x: 0.0,
                        y: 0.0,
                        curve: 0.0,
                    },
                    FaderCurvePoint {
                        x: 0.5,
                        y: 0.7,
                        curve: 0.0,
                    },
                    FaderCurvePoint {
                        x: 1.0,
                        y: 1.0,
                        curve: 0.0,
                    },
                ],
            }],
            ..AppSettings::default()
        };

        let json = serde_json::to_string(&settings).expect("serialize settings");
        let loaded: AppSettings = serde_json::from_str(&json).expect("deserialize settings");

        assert_eq!(loaded.fader_curve_presets.len(), 1);
        assert_eq!(loaded.fader_curve_presets[0].id, "drums-ride");
        assert_eq!(loaded.fader_curve_presets[0].name, "Drums Ride");
        assert_eq!(loaded.fader_curve_presets[0].points[1].x, 0.5);
        assert_eq!(loaded.fader_curve_presets[0].points[1].y, 0.7);
    }
}

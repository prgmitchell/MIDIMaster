use crate::{
    durable_json_store::{DurableJsonStore, StorageRecoveryNotices},
    model::{normalized_routes_with_legacy, FaderCurvePoint, MidiDeviceRoute},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

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

fn default_microphone_gain_db() -> f32 {
    0.0
}

fn default_soundboard_gain_db() -> f32 {
    -6.0
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct VirtualAudioSettings {
    pub enabled: bool,
    pub input_device_id: Option<String>,
    pub follow_default_input: bool,
    #[serde(default = "default_microphone_gain_db")]
    pub microphone_gain_db: f32,
    #[serde(default = "default_soundboard_gain_db")]
    pub soundboard_gain_db: f32,
}

impl Default for VirtualAudioSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            input_device_id: None,
            follow_default_input: true,
            microphone_gain_db: default_microphone_gain_db(),
            soundboard_gain_db: default_soundboard_gain_db(),
        }
    }
}

impl VirtualAudioSettings {
    pub fn normalized(&self) -> Self {
        let finite_or = |value: f32, fallback: f32| {
            if value.is_finite() {
                value
            } else {
                fallback
            }
        };
        Self {
            enabled: self.enabled,
            input_device_id: if self.follow_default_input {
                None
            } else {
                self.input_device_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            },
            follow_default_input: self.follow_default_input,
            microphone_gain_db: finite_or(self.microphone_gain_db, 0.0).clamp(-24.0, 24.0),
            soundboard_gain_db: finite_or(self.soundboard_gain_db, -6.0).clamp(-24.0, 12.0),
        }
    }
}

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
    pub compact_bindings: bool,
    pub auto_check_updates: bool,
    pub language: String,
    pub appearance: AppAppearanceSettings,
    pub virtual_audio: VirtualAudioSettings,
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
            compact_bindings: false,
            auto_check_updates: true,
            language: "en".to_string(),
            appearance: AppAppearanceSettings::default(),
            virtual_audio: VirtualAudioSettings::default(),
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
    storage: DurableJsonStore,
}

impl AppSettingsStore {
    pub(crate) fn with_recovery_notices(
        config_dir: PathBuf,
        recovery_notices: StorageRecoveryNotices,
    ) -> Self {
        let path = config_dir.join("app_settings.json");
        Self {
            storage: DurableJsonStore::new(path, "app_settings", recovery_notices),
        }
    }

    pub fn load(&self) -> Result<AppSettings> {
        self.storage.load_or_default()
    }

    pub fn save(&self, settings: &AppSettings) -> Result<()> {
        self.storage.save(settings)
    }

    pub fn clear(&self) -> Result<()> {
        self.storage.clear()
    }
}

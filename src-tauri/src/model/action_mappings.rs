use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HotkeyMapping {
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenApplicationMapping {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub display: String,
    #[serde(default)]
    pub icon_data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AutoHotkeyScriptMapping {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub display: String,
}

fn default_soundboard_volume() -> f32 {
    1.0
}

fn default_soundboard_speed() -> f32 {
    1.0
}

fn default_soundboard_monitor_route() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SoundboardMapping {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub display: String,
    #[serde(default)]
    pub trim_start_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trim_end_ms: Option<u64>,
    #[serde(default = "default_soundboard_volume")]
    pub volume: f32,
    #[serde(default = "default_soundboard_speed")]
    pub speed: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_device_display: Option<String>,
    #[serde(default = "default_soundboard_monitor_route")]
    pub send_to_monitor: bool,
    #[serde(default)]
    pub send_to_virtual_mic: bool,
}

impl SoundboardMapping {
    pub fn normalized(&self) -> Option<Self> {
        let path = self.path.trim();
        if path.is_empty() {
            return None;
        }
        let display = self.display.trim();
        let trim_end_ms = self
            .trim_end_ms
            .map(|end| end.max(self.trim_start_ms.saturating_add(1)));
        let output_device_id = self
            .output_device_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let output_device_display = output_device_id.as_ref().and_then(|_| {
            self.output_device_display
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
        Some(Self {
            path: path.to_string(),
            display: if display.is_empty() {
                std::path::Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(path)
                    .to_string()
            } else {
                display.to_string()
            },
            trim_start_ms: self.trim_start_ms,
            trim_end_ms,
            volume: if self.volume.is_finite() {
                self.volume.clamp(0.0, 1.0)
            } else {
                1.0
            },
            speed: if self.speed.is_finite() {
                self.speed.clamp(0.5, 2.0)
            } else {
                1.0
            },
            output_device_id,
            output_device_display,
            // A clip with no destination is indistinguishable from a broken
            // binding. Keep legacy/invalid payloads useful by restoring the
            // monitor route when neither destination is selected.
            send_to_monitor: self.send_to_monitor || !self.send_to_virtual_mic,
            send_to_virtual_mic: self.send_to_virtual_mic,
        })
    }
}

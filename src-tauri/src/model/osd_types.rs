use serde::{Deserialize, Serialize};

fn default_osd_style() -> String {
    "midnight".to_string()
}

fn default_opacity() -> f64 {
    0.96
}

fn default_scale() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsdSettings {
    pub enabled: bool,
    pub monitor_index: usize,
    #[serde(default)]
    pub monitor_name: Option<String>,
    #[serde(default)]
    pub monitor_id: Option<String>,
    pub anchor: String,
    #[serde(default)]
    pub show_binding_name: bool,
    #[serde(default = "default_osd_style")]
    pub style: String,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default = "default_scale")]
    pub scale: f64,
}

impl Default for OsdSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            monitor_index: 0,
            monitor_name: None,
            monitor_id: None,
            anchor: "top-right".to_string(),
            show_binding_name: false,
            style: default_osd_style(),
            opacity: default_opacity(),
            scale: default_scale(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::OsdSettings;

    #[test]
    fn legacy_settings_default_to_target_names() {
        let settings: OsdSettings = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "monitor_index": 0,
            "anchor": "top-right"
        }))
        .expect("legacy OSD settings should deserialize");

        assert!(!settings.show_binding_name);
    }
}

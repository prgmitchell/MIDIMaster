use std::path::PathBuf;

use tauri::Manager;

pub const APP_DATA_DIR_NAME: &str = "MIDIMaster";
const LEGACY_TAURI_IDENTIFIER_DIRS: &[&str] = &["com.midimaster.app"];

#[cfg(feature = "perf-audit")]
const PERF_APP_DATA_ENV: &str = "MIDIMASTER_PERF_APP_DATA_DIR";

#[cfg(feature = "perf-audit")]
fn perf_app_data_override(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{PERF_APP_DATA_ENV} must not be empty"));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("{PERF_APP_DATA_ENV} must be an absolute path"));
    }
    Ok(path)
}

pub fn app_data_root_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "perf-audit")]
    if let Some(raw) = std::env::var_os(PERF_APP_DATA_ENV) {
        let raw = raw
            .to_str()
            .ok_or_else(|| format!("{PERF_APP_DATA_ENV} must contain valid Unicode"))?;
        let desired = perf_app_data_override(raw)?;
        std::fs::create_dir_all(&desired).map_err(|e| e.to_string())?;
        return Ok(desired);
    }

    let default_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Unable to resolve config directory".to_string())?;

    // Tauri's app_config_dir is derived from the bundle identifier
    // (e.g. "com.midimaster.app"). For user-friendliness we prefer a
    // stable, human-readable folder name.
    let base = default_dir.parent().unwrap_or(&default_dir);
    let desired = base.join(APP_DATA_DIR_NAME);

    // One-time migration for existing installs.
    // Best-effort: if it fails, we keep using the desired directory (fresh).
    if !desired.exists() {
        if default_dir.exists() {
            let _ = std::fs::rename(&default_dir, &desired);
        } else {
            for legacy in LEGACY_TAURI_IDENTIFIER_DIRS {
                let legacy_dir = base.join(legacy);
                if legacy_dir.exists() {
                    let _ = std::fs::rename(&legacy_dir, &desired);
                    break;
                }
            }
        }
    }

    std::fs::create_dir_all(&desired).map_err(|e| e.to_string())?;
    Ok(desired)
}

#[cfg(all(test, feature = "perf-audit"))]
mod tests {
    use super::perf_app_data_override;

    #[test]
    fn perf_app_data_override_requires_absolute_nonempty_path() {
        assert!(perf_app_data_override("").is_err());
        assert!(perf_app_data_override("relative/path").is_err());
        let absolute = if cfg!(windows) {
            r"C:\MIDIMasterPerf"
        } else {
            "/tmp/midimaster-perf"
        };
        assert!(perf_app_data_override(absolute).is_ok());
    }
}

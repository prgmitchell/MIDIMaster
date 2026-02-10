use std::path::PathBuf;

use tauri::Manager;

pub const APP_DATA_DIR_NAME: &str = "MIDIMaster";
const LEGACY_TAURI_IDENTIFIER_DIRS: &[&str] = &["com.midimaster.app"];

pub fn app_data_root_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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

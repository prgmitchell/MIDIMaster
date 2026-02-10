use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

use crate::app_paths::app_data_root_dir;

const BUNDLED_PLUGIN_IDS: &[&str] = &["obs", "wavelink"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: String,
    pub entry: String,
    #[serde(default)]
    pub icon: Option<String>,

    // Augmented fields computed by MIDIMaster.
    #[serde(default)]
    pub bundled: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PluginsState {
    #[serde(default)]
    disabled: Vec<String>,
}

fn plugins_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_root_dir(app).map(|dir| dir.join("plugins_state.json"))
}

fn load_plugins_state(app: &AppHandle) -> PluginsState {
    let Ok(path) = plugins_state_path(app) else {
        return PluginsState::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return PluginsState::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_plugins_state(app: &AppHandle, state: &PluginsState) -> Result<(), String> {
    let path = plugins_state_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

pub fn plugins_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_root_dir(app).map(|dir| dir.join("plugins"))
}

fn is_bundled_plugin(id: &str) -> bool {
    BUNDLED_PLUGIN_IDS
        .iter()
        .any(|p| p.eq_ignore_ascii_case(id))
}

fn plugin_file_path(root: &Path, plugin_id: &str, rel_path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }
    for c in rel.components() {
        if matches!(c, std::path::Component::ParentDir) {
            return Err("Parent path components are not allowed".to_string());
        }
    }
    Ok(root.join(plugin_id).join(rel))
}

pub fn ensure_builtin_plugin(
    app: &AppHandle,
    plugin_id: &str,
    manifest: &str,
    entry: &str,
    assets: &[(&str, &[u8])],
) {
    let Ok(root) = plugins_root_dir(app) else {
        return;
    };
    let plugin_dir = root.join(plugin_id);
    let _ = fs::create_dir_all(&plugin_dir);

    let manifest_path = plugin_dir.join("manifest.json");
    let _ = fs::write(&manifest_path, manifest);
    let entry_path = plugin_dir.join("plugin.mjs");
    let _ = fs::write(&entry_path, entry);

    for (rel, bytes) in assets {
        if rel.is_empty() {
            continue;
        }
        let path = plugin_dir.join(rel);
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, bytes);
    }
}

#[tauri::command]
pub fn get_plugins_dir(app: AppHandle) -> Result<String, String> {
    let root = plugins_root_dir(&app)?;
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_plugins(app: AppHandle) -> Result<Vec<PluginManifest>, String> {
    let root = plugins_root_dir(&app)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let state = load_plugins_state(&app);
    let disabled: HashSet<String> = state.disabled.into_iter().collect();

    let mut plugins = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let text = match fs::read_to_string(&manifest_path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let mut manifest: PluginManifest = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if manifest.id.trim().is_empty() {
            if let Some(dir_name) = path.file_name().and_then(|s| s.to_str()) {
                manifest.id = dir_name.to_string();
            }
        }

        // Compute augmented fields.
        manifest.bundled = is_bundled_plugin(&manifest.id);
        manifest.enabled = !disabled.contains(&manifest.id);

        plugins.push(manifest);
    }
    plugins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(plugins)
}

#[tauri::command]
pub fn read_plugin_text(
    app: AppHandle,
    plugin_id: String,
    rel_path: String,
) -> Result<String, String> {
    let root = plugins_root_dir(&app)?;
    let path = plugin_file_path(&root, &plugin_id, &rel_path)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_plugin_base64(
    app: AppHandle,
    plugin_id: String,
    rel_path: String,
) -> Result<String, String> {
    let root = plugins_root_dir(&app)?;
    let path = plugin_file_path(&root, &plugin_id, &rel_path)?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(b64)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledPluginInfo {
    pub manifest: PluginManifest,
    #[serde(default)]
    pub replaced_existing: bool,
}

fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("Plugin id is required".to_string());
    }
    let ok = id.chars().all(|c| {
        c.is_ascii_lowercase()
            || c.is_ascii_uppercase()
            || c.is_ascii_digit()
            || c == '_'
            || c == '-'
            || c == '.'
    });
    if !ok {
        return Err("Plugin id contains invalid characters".to_string());
    }
    Ok(())
}

fn safe_rel_path(rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }
    for c in p.components() {
        if matches!(c, std::path::Component::ParentDir) {
            return Err("Parent path components are not allowed".to_string());
        }
    }
    Ok(p.to_path_buf())
}

#[tauri::command]
pub fn set_plugin_enabled(app: AppHandle, plugin_id: String, enabled: bool) -> Result<(), String> {
    let mut state = load_plugins_state(&app);
    state.disabled.retain(|id| id != &plugin_id);
    if !enabled {
        state.disabled.push(plugin_id);
        state.disabled.sort();
        state.disabled.dedup();
    }
    save_plugins_state(&app, &state)
}

#[tauri::command]
pub fn uninstall_plugin(app: AppHandle, plugin_id: String) -> Result<(), String> {
    if is_bundled_plugin(&plugin_id) {
        return Err("Bundled plugins cannot be uninstalled".to_string());
    }
    let root = plugins_root_dir(&app)?;
    let dir = root.join(&plugin_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    // Also clear disabled state if present.
    let mut state = load_plugins_state(&app);
    state.disabled.retain(|id| id != &plugin_id);
    let _ = save_plugins_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn install_plugin_package(
    app: AppHandle,
    filename: String,
    bytes_base64: String,
) -> Result<InstalledPluginInfo, String> {
    let _ = filename; // reserved for future use (display/logging)

    // Basic size guard (base64 expands ~4/3)
    if bytes_base64.len() > 80_000_000 {
        return Err("Plugin package is too large".to_string());
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    if bytes.len() > 60_000_000 {
        return Err("Plugin package is too large".to_string());
    }

    let root = plugins_root_dir(&app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    // Read zip
    let reader = Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;

    // Find manifest.json and allow optional single top-level folder.
    let mut manifest_index: Option<usize> = None;
    let mut manifest_name: Option<String> = None;
    for i in 0..zip.len() {
        let file = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_string();
        if name == "manifest.json" || name.ends_with("/manifest.json") {
            manifest_index = Some(i);
            manifest_name = Some(name);
            break;
        }
    }
    let Some(mi) = manifest_index else {
        return Err("Package is missing manifest.json".to_string());
    };
    let manifest_path_in_zip = manifest_name.unwrap_or_else(|| "manifest.json".to_string());
    let prefix = if manifest_path_in_zip == "manifest.json" {
        "".to_string()
    } else {
        // everything up to and including the directory containing manifest.json
        manifest_path_in_zip
            .trim_end_matches("manifest.json")
            .to_string()
    };

    // Read manifest text (scope to drop ZipFile borrow)
    use std::io::Read;
    let text = {
        let mut mf = zip.by_index(mi).map_err(|e| e.to_string())?;
        let mut text = String::new();
        mf.read_to_string(&mut text).map_err(|e| e.to_string())?;
        text
    };
    let mut manifest: PluginManifest = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if manifest.id.trim().is_empty() {
        return Err("manifest.json is missing id".to_string());
    }
    validate_plugin_id(&manifest.id)?;
    if manifest.api_version.trim() != "1" {
        return Err("Unsupported api_version (expected \"1\")".to_string());
    }
    if is_bundled_plugin(&manifest.id) {
        return Err("Cannot install a plugin with a reserved bundled id".to_string());
    }

    // Verify entry exists in archive (after stripping prefix)
    let entry_rel = safe_rel_path(&manifest.entry)?
        .to_string_lossy()
        .to_string();
    let mut entry_found = false;
    for i in 0..zip.len() {
        let file = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name();
        let stripped = name.strip_prefix(&prefix).unwrap_or(name);
        if stripped == entry_rel {
            entry_found = true;
            break;
        }
    }
    if !entry_found {
        return Err("Entry file not found in package".to_string());
    }

    // Extract to temp directory
    let installing_root = root.join(".installing");
    let _ = fs::create_dir_all(&installing_root);
    let temp_dir = installing_root.join(format!("{}-{}", manifest.id, uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_string();
        if name.ends_with('/') {
            continue;
        }
        let stripped = name.strip_prefix(&prefix).unwrap_or(name.as_str());
        if stripped.is_empty() {
            continue;
        }
        let rel = safe_rel_path(stripped)?;
        let out_path = temp_dir.join(&rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
    }

    // Ensure manifest.json exists at extracted root
    let extracted_manifest_path = temp_dir.join("manifest.json");
    if !extracted_manifest_path.exists() {
        return Err("Extracted plugin is missing manifest.json at root".to_string());
    }

    // Install atomically
    let target_dir = root.join(&manifest.id);
    let mut replaced_existing = false;
    if target_dir.exists() {
        replaced_existing = true;
        let backup_root = root.join(".backup");
        let _ = fs::create_dir_all(&backup_root);
        let backup_dir = backup_root.join(format!("{}-{}", manifest.id, uuid::Uuid::new_v4()));
        fs::rename(&target_dir, &backup_dir).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp_dir, &target_dir).map_err(|e| e.to_string())?;

    // Enable by default
    let mut state = load_plugins_state(&app);
    state.disabled.retain(|id| id != &manifest.id);
    let _ = save_plugins_state(&app, &state);

    manifest.bundled = false;
    manifest.enabled = true;

    Ok(InstalledPluginInfo {
        manifest,
        replaced_existing,
    })
}

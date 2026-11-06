use super::PLUGIN_FILE_MAX_BYTES;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(super) fn plugin_file_path(
    root: &Path,
    plugin_id: &str,
    rel_path: &str,
) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    let rel = safe_rel_path(rel_path)?;
    let canonical_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let plugin_dir = fs::canonicalize(root.join(plugin_id)).map_err(|e| e.to_string())?;
    let path = fs::canonicalize(plugin_dir.join(rel)).map_err(|e| e.to_string())?;
    if !plugin_dir.starts_with(&canonical_root) || !path.starts_with(&plugin_dir) {
        return Err("Plugin path escapes its directory".to_string());
    }
    Ok(path)
}

pub(super) fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || id.starts_with('.') || id.ends_with('.') {
        return Err("Invalid plugin id".to_string());
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
    safe_rel_path(id)?;
    Ok(())
}

pub(super) fn safe_rel_path(rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    // Validate Windows names even when packages are inspected on another OS.
    // Reject drive-relative paths, NTFS streams, device names and aliases.
    if rel.is_empty() || rel.starts_with(['/', '\\']) {
        return Err("Invalid relative plugin path".to_string());
    }
    for part in rel.split(['/', '\\']) {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ["COM", "LPT"].iter().any(|prefix| {
                stem.strip_prefix(prefix).is_some_and(|suffix| {
                    matches!(
                        suffix,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            });
        if part.is_empty()
            || part.ends_with(['.', ' '])
            || reserved
            || part
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
        {
            return Err("Invalid relative plugin path component".to_string());
        }
    }
    Ok(p.to_path_buf())
}

pub(super) fn read_plugin_file(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(PLUGIN_FILE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > PLUGIN_FILE_MAX_BYTES {
        return Err("Plugin file is too large".to_string());
    }
    Ok(bytes)
}

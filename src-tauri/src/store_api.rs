use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::plugin_api::{
    install_plugin_package, list_plugins, read_package_manifest, InstalledPluginInfo,
};

// Official store URL.
//
// By default this points at the official MIDIMaster catalog. Forks can override
// this at runtime by setting MIDIMASTER_STORE_URL.
const DEFAULT_OFFICIAL_STORE_URL: &str = "https://store.midimaster.app/catalog.json";

fn official_store_url() -> String {
    std::env::var("MIDIMASTER_STORE_URL").unwrap_or_else(|_| DEFAULT_OFFICIAL_STORE_URL.to_string())
}

// Trusted public keys (hardcoded).
// key_id -> base64(ed25519 public key bytes)
pub const TRUSTED_KEYS: &[(&str, &str)] = &[
    (
        "official-2026-01",
        "/a99SbJ8PwG4zpPXkpCAAndQ7hZWmb2eSYIFE3lCLts=",
    ),
    (
        "official-2026-02",
        "ugJkWqxrzUfjgFyzZWnQCbMhBSOSWJ+WwPF0MBgfh6U=",
    ),
    (
        "official-2026-07",
        "0M4pPY6bE+oTtn4lyKIARCUPWDCdjFcAe0a+gOFDe40=",
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreCatalog {
    pub schema_version: u32,
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub plugins: Vec<StorePlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorePlugin {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub homepage_url: Option<String>,
    #[serde(default)]
    pub icon_url: Option<String>,
    pub latest: StorePluginRelease,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorePluginRelease {
    pub version: String,
    pub api_version: String,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub compatible: bool,
    #[serde(default)]
    pub compatibility_reason: Option<String>,
    pub download_url: String,
    pub sha256: String,
    pub signature: String,
    pub signature_key_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorePluginUpdateResult {
    pub plugin_id: String,
    pub previous_version: Option<String>,
    pub attempted_version: String,
    pub status: String,
    pub error: Option<String>,
}

fn parsed_version(raw: &str, label: &str) -> Result<Version, String> {
    Version::parse(raw.trim()).map_err(|_| format!("Invalid {label}: {raw}"))
}

fn validate_release_manifest(
    plugin: &StorePlugin,
    manifest: &crate::plugin_api::PluginManifest,
) -> Result<(), String> {
    if manifest.id != plugin.id
        || manifest.version != plugin.latest.version
        || manifest.api_version != plugin.latest.api_version
        || manifest.min_app_version != plugin.latest.min_app_version
    {
        return Err("Package manifest does not match Store release metadata".to_string());
    }
    Ok(())
}

fn decorate_compatibility(app: &AppHandle, catalog: &mut StoreCatalog) {
    let current = Version::parse(&app.package_info().version.to_string()).ok();
    let schema_version = catalog.schema_version;
    for plugin in &mut catalog.plugins {
        plugin.latest.compatible = true;
        plugin.latest.compatibility_reason = None;
        if schema_version >= 2 && plugin.latest.min_app_version.is_none() {
            plugin.latest.compatible = false;
            plugin.latest.compatibility_reason =
                Some("Store release is missing compatibility metadata".to_string());
        } else if let Some(required_raw) = plugin.latest.min_app_version.as_deref() {
            match (current.as_ref(), Version::parse(required_raw.trim())) {
                (Some(current), Ok(required)) if current < &required => {
                    plugin.latest.compatible = false;
                    plugin.latest.compatibility_reason =
                        Some(format!("Requires MIDIMaster {} or newer", required));
                }
                (_, Err(_)) => {
                    plugin.latest.compatible = false;
                    plugin.latest.compatibility_reason =
                        Some("Store release has invalid compatibility metadata".to_string());
                }
                (None, _) => {
                    plugin.latest.compatible = false;
                    plugin.latest.compatibility_reason =
                        Some("Unable to determine MIDIMaster version".to_string());
                }
                _ => {}
            }
        }
    }
}

fn canonical_message(plugin_id: &str, version: &str, sha256_hex: &str) -> String {
    format!(
        "MIDIMaster Plugin Package v1\nid={}\nversion={}\nsha256={}\n",
        plugin_id, version, sha256_hex
    )
}

fn find_key_b64(key_id: &str) -> Option<&'static str> {
    TRUSTED_KEYS
        .iter()
        .find(|(id, _)| id.eq_ignore_ascii_case(key_id))
        .map(|(_, k)| *k)
}

fn decode_pubkey(key_id: &str) -> Result<VerifyingKey, String> {
    let b64 = find_key_b64(key_id).ok_or_else(|| "Unknown signature key id".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| e.to_string())?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Invalid public key length".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| e.to_string())
}

fn verify_release_signature(plugin: &StorePlugin, bytes: &[u8]) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let sha = hasher.finalize();
    let sha_hex = hex::encode(sha);

    if sha_hex != plugin.latest.sha256.to_lowercase() {
        return Err("SHA256 mismatch".to_string());
    }

    let msg = canonical_message(&plugin.id, &plugin.latest.version, &sha_hex);
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(plugin.latest.signature.as_bytes())
        .map_err(|e| e.to_string())?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|e| e.to_string())?;

    let key = decode_pubkey(&plugin.latest.signature_key_id)?;
    key.verify(msg.as_bytes(), &sig)
        .map_err(|_| "Signature verification failed".to_string())?;

    Ok(sha_hex)
}

fn is_https(url: &str) -> bool {
    url.to_lowercase().starts_with("https://")
}

fn download_bytes(url: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    #[cfg(feature = "perf-audit")]
    if crate::perf_audit::network_is_offline() {
        return Err("Network disabled by the local performance audit".to_string());
    }
    if !is_https(url) {
        return Err("Only https:// URLs are allowed".to_string());
    }
    let resp = ureq::get(url).call().map_err(|e| e.to_string())?;
    let len = resp
        .header("content-length")
        .and_then(|v| v.parse::<usize>().ok());
    if let Some(l) = len {
        if l > max_bytes {
            return Err("Download too large".to_string());
        }
    }

    let mut reader = resp.into_reader();
    let mut out = Vec::new();
    use std::io::Read;
    reader.read_to_end(&mut out).map_err(|e| e.to_string())?;
    if out.len() > max_bytes {
        return Err("Download too large".to_string());
    }
    Ok(out)
}

fn download_store_catalog(app: &AppHandle) -> Result<StoreCatalog, String> {
    let url = official_store_url();
    let bytes = download_bytes(&url, 2_000_000)?;
    let text = String::from_utf8(bytes).map_err(|_| "Invalid UTF-8".to_string())?;
    let mut catalog: StoreCatalog = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if catalog.schema_version != 1 && catalog.schema_version != 2 {
        return Err("Unsupported Store catalog schema".to_string());
    }
    decorate_compatibility(app, &mut catalog);
    Ok(catalog)
}

#[tauri::command]
pub fn fetch_store_catalog(app: AppHandle) -> Result<StoreCatalog, String> {
    download_store_catalog(&app)
}

fn install_catalog_plugin(
    app: AppHandle,
    catalog: &StoreCatalog,
    plugin_id: &str,
) -> Result<InstalledPluginInfo, String> {
    let plugin = catalog
        .plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| "Plugin not found in catalog".to_string())?
        .clone();

    if !plugin.latest.compatible {
        return Err(plugin.latest.compatibility_reason.unwrap_or_else(|| {
            "Plugin is not compatible with this MIDIMaster version".to_string()
        }));
    }

    let latest_version = parsed_version(&plugin.latest.version, "Store plugin version")?;
    let installed = list_plugins(app.clone())?
        .into_iter()
        .find(|manifest| manifest.id == plugin.id);
    if let Some(current) = installed.as_ref() {
        let current_version = parsed_version(&current.version, "installed plugin version")?;
        if latest_version <= current_version {
            return Err("Store release must be newer than the installed plugin".to_string());
        }
    }

    if !is_https(&plugin.latest.download_url) {
        return Err("Invalid download_url".to_string());
    }

    let pkg = download_bytes(&plugin.latest.download_url, 60_000_000)?;
    let _sha_hex = verify_release_signature(&plugin, &pkg)?;
    let manifest = read_package_manifest(&pkg)?;
    validate_release_manifest(&plugin, &manifest)?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(pkg);
    install_plugin_package(app, format!("{}.midimaster", plugin.id), b64)
}

#[tauri::command]
pub fn install_store_plugin(
    app: AppHandle,
    plugin_id: String,
) -> Result<InstalledPluginInfo, String> {
    let catalog = download_store_catalog(&app)?;
    install_catalog_plugin(app, &catalog, &plugin_id)
}

#[tauri::command]
pub fn install_store_plugins(
    app: AppHandle,
    plugin_ids: Vec<String>,
) -> Result<Vec<StorePluginUpdateResult>, String> {
    let catalog = download_store_catalog(&app)?;
    let installed_versions: std::collections::HashMap<String, String> = list_plugins(app.clone())?
        .into_iter()
        .map(|manifest| (manifest.id, manifest.version))
        .collect();
    let mut results = Vec::new();
    for plugin_id in plugin_ids {
        let attempted_version = catalog
            .plugins
            .iter()
            .find(|plugin| plugin.id == plugin_id)
            .map(|plugin| plugin.latest.version.clone())
            .unwrap_or_default();
        let result = install_catalog_plugin(app.clone(), &catalog, &plugin_id);
        results.push(StorePluginUpdateResult {
            previous_version: installed_versions.get(&plugin_id).cloned(),
            attempted_version,
            status: if result.is_ok() { "updated" } else { "failed" }.to_string(),
            error: result.err(),
            plugin_id,
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_orders_prereleases_correctly() {
        assert!(
            parsed_version("1.0.0", "version").unwrap()
                > parsed_version("1.0.0-beta.2", "version").unwrap()
        );
        assert!(
            parsed_version("1.10.0", "version").unwrap()
                > parsed_version("1.9.9", "version").unwrap()
        );
    }

    #[test]
    fn schema_one_catalog_remains_readable() {
        let catalog: StoreCatalog =
            serde_json::from_str(r#"{"schema_version":1,"plugins":[]}"#).unwrap();
        assert_eq!(catalog.schema_version, 1);
    }

    #[test]
    fn package_manifest_must_match_catalog_compatibility_metadata() {
        let manifest = serde_json::from_str(
            r#"{"id":"demo","name":"Demo","version":"1.0.0","api_version":"1","min_app_version":"4.3.5","entry":"plugin.mjs"}"#,
        )
        .unwrap();
        let plugin = StorePlugin {
            id: "demo".to_string(),
            name: "Demo".to_string(),
            author: None,
            description: None,
            homepage_url: None,
            icon_url: None,
            latest: StorePluginRelease {
                version: "1.0.0".to_string(),
                api_version: "1".to_string(),
                min_app_version: Some("4.4.0".to_string()),
                compatible: true,
                compatibility_reason: None,
                download_url: "https://store.midimaster.app/demo.midimaster".to_string(),
                sha256: String::new(),
                signature: String::new(),
                signature_key_id: "official-2026-07".to_string(),
            },
        };
        assert!(validate_release_manifest(&plugin, &manifest).is_err());
    }
}

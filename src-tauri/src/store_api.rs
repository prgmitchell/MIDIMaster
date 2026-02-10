use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::plugin_api::{install_plugin_package, InstalledPluginInfo};

// Official store URL.
//
// By default this points at the official MIDIMaster catalog. Forks can override
// this at runtime by setting MIDIMASTER_STORE_URL.
const DEFAULT_OFFICIAL_STORE_URL: &str = "https://midimaster.netlify.app/catalog.json";

fn official_store_url() -> String {
    std::env::var("MIDIMASTER_STORE_URL").unwrap_or_else(|_| DEFAULT_OFFICIAL_STORE_URL.to_string())
}

// Trusted public keys (hardcoded).
// key_id -> base64(ed25519 public key bytes)
pub const TRUSTED_KEYS: &[(&str, &str)] = &[(
    "official-2026-01",
    "/a99SbJ8PwG4zpPXkpCAAndQ7hZWmb2eSYIFE3lCLts=",
)];

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
    pub download_url: String,
    pub sha256: String,
    pub signature: String,
    pub signature_key_id: String,
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

#[tauri::command]
pub fn fetch_store_catalog() -> Result<StoreCatalog, String> {
    let url = official_store_url();
    let bytes = download_bytes(&url, 2_000_000)?;
    let text = String::from_utf8(bytes).map_err(|_| "Invalid UTF-8".to_string())?;
    let catalog: StoreCatalog = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(catalog)
}

#[tauri::command]
pub fn install_store_plugin(
    app: AppHandle,
    plugin_id: String,
) -> Result<InstalledPluginInfo, String> {
    let catalog = fetch_store_catalog()?;
    let plugin = catalog
        .plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| "Plugin not found in catalog".to_string())?
        .clone();

    // Basic URL sanity
    if !is_https(&plugin.latest.download_url) {
        return Err("Invalid download_url".to_string());
    }

    let pkg = download_bytes(&plugin.latest.download_url, 60_000_000)?;
    let _sha_hex = verify_release_signature(&plugin, &pkg)?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(pkg);
    install_plugin_package(app, format!("{}.midimaster", plugin.id), b64)
}

use crate::app_settings::VirtualAudioSettings;
use crate::commands::settings::persist_app_settings_update;
use crate::virtual_audio::{self, VirtualAudioInputDevice};
use crate::AppState;
use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest as _, Sha256};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager as _, State};

use midimaster_virtual_audio_protocol::{
    StatusSnapshot as ServicePipeSnapshot, SERVICE_FILE_NAME,
    SERVICE_NAME as VIRTUAL_AUDIO_SERVICE_NAME, SETUP_HELPER_NAME, STATUS_PIPE_PATH,
    USBIP_VERSION as SUPPORTED_USBIP_VERSION,
};
const UNSAFE_USBIP_VERSION: &str = "0.9.7.8";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum VirtualAudioInstallState {
    NotInstalled,
    Installing,
    RestartRequired,
    Ready,
    BlockedUnsafeVersion,
    BlockedUnknownVersion,
    ServiceError,
}

#[derive(Debug, Clone, Serialize)]
pub struct VirtualAudioStatus {
    pub install_state: VirtualAudioInstallState,
    pub usbip_version: Option<String>,
    pub service_running: bool,
    pub endpoint_present: bool,
    pub attached_port_count: u32,
    pub routing_running: bool,
    pub service_update_available: bool,
    pub restart_required: bool,
    pub mic_level: f32,
    pub soundboard_level: f32,
    pub output_level: f32,
    pub limiter_reduction_db: f32,
    pub underruns: u64,
    pub overruns: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum SetupOperation {
    Install,
    Repair,
    Remove,
}

#[derive(Clone)]
struct SystemComponentStatus {
    usbip_version: Option<String>,
    service_installed: bool,
    service_running: bool,
    endpoint_present: bool,
    restart_required: bool,
    service_update_available: bool,
}

static COMPONENT_STATUS_CACHE: OnceLock<Mutex<Option<(Instant, SystemComponentStatus)>>> =
    OnceLock::new();

impl SetupOperation {
    fn argument(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Repair => "repair",
            Self::Remove => "remove",
        }
    }
}

#[tauri::command]
pub fn get_virtual_audio_settings(
    state: State<'_, AppState>,
) -> Result<VirtualAudioSettings, String> {
    state
        .app_settings
        .lock()
        .map(|settings| settings.virtual_audio.clone())
        .map_err(|_| "Virtual Audio settings lock failed".to_string())
}

#[tauri::command]
pub async fn set_virtual_audio_settings(
    app: AppHandle,
    settings: VirtualAudioSettings,
) -> Result<VirtualAudioSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let normalized = settings.normalized();
        let persisted = persist_app_settings_update(state.inner(), |app_settings| {
            app_settings.virtual_audio = normalized.clone();
        })?;
        state
            .soundboard
            .set_virtual_bus_gain_db(normalized.soundboard_gain_db);
        state
            .soundboard
            .set_virtual_routing_enabled(normalized.enabled);
        if let Err(error) = state.virtual_audio.apply_settings(normalized.clone()) {
            crate::run_logger::warn("virtual_audio", "route_update_failed", &error);
        }
        Ok(persisted.virtual_audio)
    })
    .await
    .map_err(|error| format!("Virtual Audio settings task failed: {error}"))?
}

#[tauri::command]
pub async fn list_virtual_audio_input_devices() -> Result<Vec<VirtualAudioInputDevice>, String> {
    tauri::async_runtime::spawn_blocking(virtual_audio::list_input_devices)
        .await
        .map_err(|error| format!("Microphone enumeration task failed: {error}"))?
}

#[tauri::command]
pub async fn get_virtual_audio_status(
    app: AppHandle,
    force: Option<bool>,
) -> Result<VirtualAudioStatus, String> {
    let bundled_service = bundled_service_path(&app);
    tauri::async_runtime::spawn_blocking(move || {
        if force.unwrap_or(false) {
            invalidate_component_status_cache();
        }
        let state = app.state::<AppState>();
        build_status(state.inner(), bundled_service.as_deref())
    })
    .await
    .map_err(|error| format!("Virtual Audio status task failed: {error}"))
}

#[tauri::command]
pub async fn install_virtual_audio(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<VirtualAudioStatus, String> {
    let bundled_service = bundled_service_path(&app);
    run_operation(app, SetupOperation::Install).await?;
    let _ = state.virtual_audio.refresh();
    Ok(build_status(state.inner(), bundled_service.as_deref()))
}

#[tauri::command]
pub async fn repair_virtual_audio(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<VirtualAudioStatus, String> {
    let bundled_service = bundled_service_path(&app);
    state.virtual_audio.stop();
    run_operation(app, SetupOperation::Repair).await?;
    let _ = state.virtual_audio.refresh();
    Ok(build_status(state.inner(), bundled_service.as_deref()))
}

#[tauri::command]
pub async fn remove_virtual_audio(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<VirtualAudioStatus, String> {
    let bundled_service = bundled_service_path(&app);
    state.virtual_audio.stop();
    run_operation(app, SetupOperation::Remove).await?;
    let _ = persist_app_settings_update(state.inner(), |app_settings| {
        app_settings.virtual_audio.enabled = false;
    })?;
    state.soundboard.set_virtual_routing_enabled(false);
    Ok(build_status(state.inner(), bundled_service.as_deref()))
}

#[tauri::command]
pub fn restart_system() -> Result<(), String> {
    hidden_command("shutdown.exe")
        .args(["/r", "/t", "0"])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Unable to restart Windows: {error}"))
}

#[tauri::command]
pub fn copy_virtual_audio_diagnostics(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let bundled_service = bundled_service_path(&app);
    let status = build_status(state.inner(), bundled_service.as_deref());
    let diagnostics = serde_json::to_string_pretty(&status)
        .map_err(|error| format!("Unable to format Virtual Audio diagnostics: {error}"))?;
    let mut child = hidden_command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$input | Set-Clipboard",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to open the Windows clipboard: {error}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(diagnostics.as_bytes())
            .map_err(|error| format!("Unable to copy Virtual Audio diagnostics: {error}"))?;
    }
    let result = child
        .wait()
        .map_err(|error| format!("Unable to finish copying diagnostics: {error}"))?;
    if !result.success() {
        return Err("Windows did not accept the diagnostic text for the clipboard".to_string());
    }
    Ok(diagnostics)
}

fn build_status(state: &AppState, bundled_service: Option<&Path>) -> VirtualAudioStatus {
    let components = system_component_status(false, bundled_service);
    let service_snapshot = read_service_pipe_snapshot();
    let usbip_version = components.usbip_version;
    let service_installed = components.service_installed;
    let service_running = components.service_running
        || service_snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.service_running);
    let attached_port_count = service_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.attached_port_count)
        .or_else(|| {
            service_snapshot
                .as_ref()
                .map(|snapshot| u32::from(snapshot.usbip_attached))
        })
        .unwrap_or(0);
    let single_port_attached = service_snapshot
        .as_ref()
        .map(|snapshot| {
            reports_single_attached_port(snapshot.usbip_attached, snapshot.attached_port_count)
        })
        .unwrap_or(true);
    let endpoint_present = components.endpoint_present && single_port_attached;
    let restart_required = components.restart_required;
    let install_state = resolve_install_state(
        usbip_version.as_deref(),
        service_installed,
        service_running,
        endpoint_present,
        restart_required,
    );
    let routing_enabled = state
        .app_settings
        .lock()
        .map(|settings| settings.virtual_audio.enabled)
        .unwrap_or(false);
    let runtime = state.virtual_audio.snapshot();
    let soundboard_level = state.soundboard.virtual_level();
    let error = match install_state {
        VirtualAudioInstallState::BlockedUnsafeVersion => Some(
            "USBIP 0.9.7.8 is unsafe and must be removed before Virtual Audio can be installed"
                .to_string(),
        ),
        VirtualAudioInstallState::BlockedUnknownVersion => Some(
            "An unsupported USBIP version is installed; MIDIMaster will not replace it automatically"
                .to_string(),
        ),
        VirtualAudioInstallState::ServiceError if service_installed && !service_running => {
            Some("The MIDIMaster Virtual Audio service is not running".to_string())
        }
        VirtualAudioInstallState::ServiceError if attached_port_count > 1 => Some(format!(
            "MIDIMaster has {attached_port_count} virtual audio attachments; run Repair to keep only one"
        )),
        VirtualAudioInstallState::ServiceError
            if single_port_attached && !components.endpoint_present =>
        {
            Some(
                "Windows has one MIDIMaster USBIP attachment, but its microphone endpoint is not available to the audio subsystem"
                    .to_string(),
            )
        }
        VirtualAudioInstallState::ServiceError if !endpoint_present => {
            service_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.last_error.clone())
                .or_else(|| {
                    Some("The MIDIMaster Virtual Audio endpoint is not attached".to_string())
                })
        }
        VirtualAudioInstallState::Ready if routing_enabled && !runtime.running => state
            .virtual_audio
            .last_error()
            .or_else(|| Some("The selected microphone route is not running".to_string())),
        _ => service_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.last_error.clone())
            .or_else(|| state.virtual_audio.last_error()),
    };

    let service_underruns = service_snapshot
        .as_ref()
        .map(|snapshot| snapshot.underrun_bytes / 4)
        .unwrap_or(0);
    let service_overruns = service_snapshot
        .as_ref()
        .map(|snapshot| snapshot.dropped_bytes / 4)
        .unwrap_or(0);

    VirtualAudioStatus {
        install_state,
        usbip_version,
        service_running,
        endpoint_present,
        attached_port_count,
        routing_running: runtime.running,
        service_update_available: components.service_update_available,
        restart_required,
        mic_level: runtime.microphone_level,
        soundboard_level,
        output_level: runtime.output_level.max(soundboard_level),
        limiter_reduction_db: service_snapshot
            .as_ref()
            .map(|snapshot| snapshot.limiter_reduction_db)
            .unwrap_or(0.0),
        underruns: runtime.underruns.saturating_add(service_underruns),
        overruns: runtime.overruns.saturating_add(service_overruns),
        error,
    }
}

fn reports_single_attached_port(
    legacy_usbip_attached: bool,
    attached_port_count: Option<u32>,
) -> bool {
    attached_port_count
        .map(|port_count| port_count == 1)
        .unwrap_or(legacy_usbip_attached)
}

fn read_service_pipe_snapshot() -> Option<ServicePipeSnapshot> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .open(STATUS_PIPE_PATH)
        .ok()?;
    let mut payload = String::new();
    file.take(16 * 1024).read_to_string(&mut payload).ok()?;
    let snapshot: ServicePipeSnapshot = serde_json::from_str(payload.trim()).ok()?;
    (snapshot.schema_version == 1).then_some(snapshot)
}

fn resolve_install_state(
    usbip_version: Option<&str>,
    service_installed: bool,
    service_running: bool,
    endpoint_present: bool,
    restart_required: bool,
) -> VirtualAudioInstallState {
    match usbip_version {
        Some(UNSAFE_USBIP_VERSION) => VirtualAudioInstallState::BlockedUnsafeVersion,
        Some(SUPPORTED_USBIP_VERSION) => {
            if restart_required {
                VirtualAudioInstallState::RestartRequired
            } else if service_running && endpoint_present {
                VirtualAudioInstallState::Ready
            } else if service_installed {
                VirtualAudioInstallState::ServiceError
            } else {
                VirtualAudioInstallState::NotInstalled
            }
        }
        Some(_) => VirtualAudioInstallState::BlockedUnknownVersion,
        None if service_installed => VirtualAudioInstallState::BlockedUnknownVersion,
        None => VirtualAudioInstallState::NotInstalled,
    }
}

async fn run_operation(app: AppHandle, operation: SetupOperation) -> Result<(), String> {
    let helper = setup_helper_path(&app)?;
    let result =
        tauri::async_runtime::spawn_blocking(move || run_elevated_helper(&helper, operation))
            .await
            .map_err(|error| format!("Virtual Audio setup task failed: {error}"))?;
    invalidate_component_status_cache();
    result
}

fn system_component_status(force: bool, bundled_service: Option<&Path>) -> SystemComponentStatus {
    const CACHE_DURATION: Duration = Duration::from_secs(2);
    let cache = COMPONENT_STATUS_CACHE.get_or_init(|| Mutex::new(None));
    if !force {
        if let Ok(guard) = cache.lock() {
            if let Some((checked_at, status)) = guard.as_ref() {
                if checked_at.elapsed() < CACHE_DURATION {
                    return status.clone();
                }
            }
        }
    }
    let (service_installed, service_running) = query_service_state();
    let installed_service = installed_service_path();
    let status = SystemComponentStatus {
        usbip_version: installed_usbip_version(),
        service_installed,
        service_running,
        endpoint_present: virtual_audio::virtual_endpoint_present(),
        restart_required: restart_marker_path().is_file(),
        service_update_available: service_installed
            && service_binary_update_available(bundled_service, installed_service.as_deref()),
    };
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((Instant::now(), status.clone()));
    }
    status
}

fn invalidate_component_status_cache() {
    if let Some(cache) = COMPONENT_STATUS_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            *guard = None;
        }
    }
}

fn setup_helper_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = virtual_audio_resource_dir(app)?.join(SETUP_HELPER_NAME);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "Virtual Audio setup is unavailable in this build ({})",
            path.display()
        ))
    }
}

fn virtual_audio_resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .resource_dir()
        .map_err(|error| format!("Unable to locate MIDIMaster resources: {error}"))?
        .join("virtual-audio"))
}

fn bundled_service_path(app: &AppHandle) -> Option<PathBuf> {
    virtual_audio_resource_dir(app)
        .ok()
        .map(|directory| directory.join(SERVICE_FILE_NAME))
        .filter(|path| path.is_file())
}

fn service_binary_update_available(
    bundled_service: Option<&Path>,
    installed_service: Option<&Path>,
) -> bool {
    let (Some(bundled), Some(installed)) = (bundled_service, installed_service) else {
        return false;
    };
    match (sha256_file(bundled), sha256_file(installed)) {
        (Ok(bundled_hash), Ok(installed_hash)) => bundled_hash != installed_hash,
        _ => false,
    }
}

fn sha256_file(path: &Path) -> std::io::Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

#[cfg(target_os = "windows")]
fn installed_service_path() -> Option<PathBuf> {
    let mut roots = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if roots.is_empty() {
        roots.push(PathBuf::from(r"C:\Program Files"));
    }
    roots.sort();
    roots.dedup();
    roots
        .into_iter()
        .map(|root| {
            root.join("MIDIMaster")
                .join("Virtual Audio")
                .join(SERVICE_FILE_NAME)
        })
        .find(|path| path.is_file())
}

#[cfg(not(target_os = "windows"))]
fn installed_service_path() -> Option<PathBuf> {
    None
}

fn run_elevated_helper(path: &Path, operation: SetupOperation) -> Result<(), String> {
    let escaped_path = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$p = Start-Process -FilePath '{}' -ArgumentList '{}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode",
        escaped_path,
        operation.argument()
    );
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let status = hidden_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .status()
        .map_err(|error| format!("Unable to request administrator permission: {error}"))?;
    match status.code() {
        Some(0) | Some(3010) => Ok(()),
        Some(code) => Err(format!(
            "Virtual Audio {} failed with exit code {code}",
            operation.argument()
        )),
        None => Err("Virtual Audio setup was interrupted".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn installed_usbip_version() -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    use winreg::RegKey;

    for executable in usbip_executable_candidates() {
        if !executable.is_file() {
            continue;
        }
        let output = hidden_command(&executable).arg("--version").output().ok();
        let version_text = output
            .as_ref()
            .map(|output| {
                format!(
                    "{} {}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                )
            })
            .unwrap_or_default();
        if version_text.contains(UNSAFE_USBIP_VERSION) {
            return Some(UNSAFE_USBIP_VERSION.to_string());
        }
        if version_text.contains(SUPPORTED_USBIP_VERSION) {
            return Some(SUPPORTED_USBIP_VERSION.to_string());
        }
        return Some("unknown".to_string());
    }

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    for view in [KEY_READ | KEY_WOW64_64KEY, KEY_READ | KEY_WOW64_32KEY] {
        let Ok(uninstall) = hklm
            .open_subkey_with_flags(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", view)
        else {
            continue;
        };
        for name in uninstall.enum_keys().flatten() {
            let Ok(entry) = uninstall.open_subkey_with_flags(&name, view) else {
                continue;
            };
            let display_name: String = entry.get_value("DisplayName").unwrap_or_default();
            if !display_name.to_ascii_lowercase().contains("usbip") {
                continue;
            }
            let version: String = entry.get_value("DisplayVersion").unwrap_or_default();
            let normalized = version.trim().trim_start_matches('v').to_string();
            if !normalized.is_empty() {
                return Some(normalized);
            }
        }
    }

    None
}

#[cfg(not(target_os = "windows"))]
fn installed_usbip_version() -> Option<String> {
    None
}

fn usbip_executable_candidates() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = ["ProgramW6432", "ProgramFiles"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect();
    if roots.is_empty() {
        roots.push(PathBuf::from(r"C:\Program Files"));
    }
    roots.sort();
    roots.dedup();
    roots
        .into_iter()
        .flat_map(|root| {
            [
                root.join("USBip").join("usbip.exe"),
                root.join("usbip-win2").join("usbip.exe"),
                root.join("usbip").join("usbip.exe"),
            ]
        })
        .collect()
}

fn query_service_state() -> (bool, bool) {
    let Ok(output) = hidden_command("sc.exe")
        .args(["query", VIRTUAL_AUDIO_SERVICE_NAME])
        .output()
    else {
        return (false, false);
    };
    if !output.status.success() {
        return (false, false);
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_uppercase();
    (true, stdout.contains("RUNNING"))
}

fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn restart_marker_path() -> PathBuf {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("MIDIMaster")
        .join("VirtualAudio")
        .join("restart-required")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn unsafe_and_unknown_usbip_versions_are_blocked() {
        assert_eq!(
            resolve_install_state(Some("0.9.7.8"), true, true, true, false),
            VirtualAudioInstallState::BlockedUnsafeVersion
        );
        assert_eq!(
            resolve_install_state(Some("0.9.9.0"), true, true, true, false),
            VirtualAudioInstallState::BlockedUnknownVersion
        );
    }

    #[test]
    fn ready_requires_service_and_endpoint() {
        assert_eq!(
            resolve_install_state(Some("0.9.7.7"), true, true, true, false),
            VirtualAudioInstallState::Ready
        );
        assert_eq!(
            resolve_install_state(Some("0.9.7.7"), true, false, true, false),
            VirtualAudioInstallState::ServiceError
        );
        assert_eq!(
            resolve_install_state(Some("0.9.7.7"), false, false, false, false),
            VirtualAudioInstallState::NotInstalled
        );
    }

    #[test]
    fn restart_marker_takes_priority_after_supported_install() {
        assert_eq!(
            resolve_install_state(Some("0.9.7.7"), true, true, false, true),
            VirtualAudioInstallState::RestartRequired
        );
    }

    #[test]
    fn numeric_port_count_is_authoritative_over_the_legacy_boolean() {
        assert!(reports_single_attached_port(false, Some(1)));
        assert!(!reports_single_attached_port(true, Some(0)));
        assert!(!reports_single_attached_port(true, Some(2)));
        assert!(reports_single_attached_port(true, None));
        assert!(!reports_single_attached_port(false, None));
    }

    #[test]
    fn service_update_detection_compares_bundled_and_installed_binaries() {
        let directory = std::env::temp_dir().join(format!(
            "midimaster-service-update-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should follow the Unix epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&directory).expect("temporary test directory should be created");
        let bundled = directory.join("bundled.exe");
        let installed = directory.join("installed.exe");
        fs::write(&bundled, b"same service").expect("bundled fixture should be written");
        fs::write(&installed, b"same service").expect("installed fixture should be written");

        assert!(!service_binary_update_available(
            Some(&bundled),
            Some(&installed)
        ));

        fs::write(&bundled, b"new service").expect("bundled fixture should be updated");
        assert!(service_binary_update_available(
            Some(&bundled),
            Some(&installed)
        ));
        assert!(!service_binary_update_available(Some(&bundled), None));
        assert!(!service_binary_update_available(
            Some(&directory.join("missing.exe")),
            Some(&installed)
        ));

        fs::remove_dir_all(&directory).expect("temporary test directory should be removed");
    }
}

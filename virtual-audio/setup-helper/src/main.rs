use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use midimaster_virtual_audio_protocol::{
    SERVICE_DISPLAY_NAME, SERVICE_FILE_NAME as SERVICE_FILE, SERVICE_NAME, USBIP_FILE,
    USBIP_SHA256, USBIP_SIZE, USBIP_VERSION,
};
const RESTART_REQUIRED: i32 = 3010;

#[derive(Debug)]
struct SetupError {
    code: i32,
    state: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
struct SetupResult<'a> {
    schema_version: u8,
    operation: &'a str,
    state: &'a str,
    success: bool,
    restart_required: bool,
    message: String,
}

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let operation = args.first().and_then(|arg| arg.to_str()).unwrap_or("");
    let result_file = parse_path_option(&args, "--result-file");
    let payload_dir = parse_payload_dir(&args).unwrap_or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_owned))
            .unwrap_or_else(|| PathBuf::from("."))
    });

    let outcome = match operation {
        "install" | "repair" => install_or_repair(operation, &payload_dir),
        "remove" => remove_component(operation),
        "status" => status(operation),
        _ => Err(SetupError { code: 2, state: "invalid_arguments", message: "usage: midimaster-virtual-audio-setup.exe <install|repair|remove|status> [--payload-dir PATH] [--result-file PATH]".into() }),
    };
    match outcome {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string(&result).expect("serialize setup result")
            );
            let exit_code = if result.restart_required {
                RESTART_REQUIRED
            } else {
                0
            };
            write_result_file(result_file.as_deref(), exit_code);
            if exit_code != 0 {
                std::process::exit(exit_code);
            }
        }
        Err(error) => {
            let exit_code = error.code;
            let result = SetupResult {
                schema_version: 1,
                operation,
                state: error.state,
                success: false,
                restart_required: false,
                message: error.message,
            };
            println!(
                "{}",
                serde_json::to_string(&result).expect("serialize setup error")
            );
            write_result_file(result_file.as_deref(), exit_code);
            std::process::exit(exit_code);
        }
    }
}

fn parse_payload_dir(args: &[OsString]) -> Option<PathBuf> {
    parse_path_option(args, "--payload-dir")
}

fn parse_path_option(args: &[OsString], option: &str) -> Option<PathBuf> {
    args.windows(2)
        .find(|pair| pair[0] == option)
        .map(|pair| PathBuf::from(&pair[1]))
}

fn write_result_file(path: Option<&Path>, exit_code: i32) {
    let Some(path) = path else {
        return;
    };
    if let Err(error) = fs::write(path, exit_code.to_string()) {
        eprintln!(
            "could not write setup result file {}: {error}",
            path.display()
        );
    }
}

fn install_or_repair<'a>(
    operation: &'a str,
    payload_dir: &Path,
) -> Result<SetupResult<'a>, SetupError> {
    ensure_elevated()?;
    let service_source = payload_dir.join(SERVICE_FILE);
    if !service_source.is_file() {
        return Err(SetupError {
            code: 21,
            state: "payload_invalid",
            message: format!("service payload is missing: {}", service_source.display()),
        });
    }

    // A retry before Windows has rebooted must not erase a restart request
    // created by the driver installer. The service removes this marker only
    // after it attaches the device during a later boot.
    let mut restart_required = restart_marker().is_file();
    match inspect_usbip() {
        DriverState::Missing => {
            let installer = payload_dir.join(USBIP_FILE);
            verify_usbip_payload(&installer).map_err(|message| SetupError { code: 21, state: "payload_invalid", message })?;
            let output = run_hidden(Command::new(&installer).args([
                "/VERYSILENT", "/SUPPRESSMSGBOXES", "/SP-", "/NORESTART",
                "/RESTARTEXITCODE=3010", "/TYPE=compact", "/NOICONS",
            ])).map_err(|error| SetupError { code: 22, state: "driver_install_failed", message: error.to_string() })?;
            match output.status.code() {
                Some(0) => {}
                Some(RESTART_REQUIRED) => restart_required = true,
                code => return Err(SetupError { code: 22, state: "driver_install_failed", message: format!("USBIP installer exited {code:?}: {}", String::from_utf8_lossy(&output.stderr).trim()) }),
            }
        }
        DriverState::Supported => {}
        DriverState::Unsafe => return Err(SetupError { code: 23, state: "blocked_unsafe_version", message: "USBIP 0.9.7.8 is installed and is blocked because upstream warns of memory corruption and BSOD risk. Remove it from Windows Installed Apps before retrying.".into() }),
        DriverState::Unknown(version) => return Err(SetupError { code: 24, state: "blocked_unknown_version", message: format!("USBIP version {version} is installed. MIDIMaster only supports the qualified 0.9.7.7 release and will not replace it automatically.") }),
    }

    if let Some(executable) = find_usbip() {
        write_usbip_path(&executable).map_err(service_io_error)?;
    } else if !restart_required {
        return Err(SetupError {
            code: 22,
            state: "driver_install_failed",
            message: "USBIP 0.9.7.7 was reported installed, but usbip.exe could not be located."
                .into(),
        });
    }

    let install_dir = service_install_dir()?;
    fs::create_dir_all(&install_dir).map_err(service_io_error)?;
    let service_target = install_dir.join(SERVICE_FILE);
    let _ = sc(&["stop", SERVICE_NAME]);
    wait_for_service_stop();
    fs::copy(&service_source, &service_target).map_err(service_io_error)?;
    // A failed older service may have accumulated multiple imports of the
    // same URL. The newly staged binary removes all of them before restart.
    require_detach_cleanup(&service_target)?;
    for notice in [
        "THIRD_PARTY_NOTICES.txt",
        "USBIP-WIN2-LICENSE.txt",
        "virtual-audio-build.json",
    ] {
        let source = payload_dir.join(notice);
        if source.is_file() {
            fs::copy(source, install_dir.join(notice)).map_err(service_io_error)?;
        }
    }

    let quoted_binary = format!("\"{}\"", service_target.display());
    if service_exists() {
        require_sc(&[
            "config",
            SERVICE_NAME,
            "binPath=",
            &quoted_binary,
            "start=",
            "auto",
            "DisplayName=",
            SERVICE_DISPLAY_NAME,
        ])?;
    } else {
        require_sc(&[
            "create",
            SERVICE_NAME,
            "binPath=",
            &quoted_binary,
            "start=",
            "auto",
            "DisplayName=",
            SERVICE_DISPLAY_NAME,
        ])?;
    }
    require_sc(&[
        "description",
        SERVICE_NAME,
        "Provides the MIDIMaster localhost virtual USB Audio endpoint.",
    ])?;
    require_sc(&[
        "failure",
        SERVICE_NAME,
        "reset=",
        "86400",
        "actions=",
        "restart/5000/restart/15000/restart/60000",
    ])?;
    let start = sc(&["start", SERVICE_NAME]).map_err(|error| SetupError {
        code: 25,
        state: "service_error",
        message: error.to_string(),
    })?;
    if !start.status.success() && !String::from_utf8_lossy(&start.stdout).contains("1056") {
        return Err(SetupError {
            code: 25,
            state: "service_error",
            message: format!(
                "could not start service: {}",
                String::from_utf8_lossy(&start.stdout).trim()
            ),
        });
    }

    if restart_required {
        write_restart_marker().map_err(service_io_error)?;
    } else {
        remove_restart_marker();
    }
    Ok(SetupResult {
        schema_version: 1,
        operation,
        state: if restart_required {
            "restart_required"
        } else {
            "ready"
        },
        success: true,
        restart_required,
        message: if restart_required {
            "Virtual Audio is installed. Restart Windows to finish installing the USB transport driver.".into()
        } else {
            "MIDIMaster Virtual Audio is installed and running.".into()
        },
    })
}

fn remove_component(operation: &str) -> Result<SetupResult<'_>, SetupError> {
    ensure_elevated()?;
    let install_dir = service_install_dir()?;
    let service_binary = install_dir.join(SERVICE_FILE);
    let _ = sc(&["stop", SERVICE_NAME]);
    wait_for_service_stop();
    if service_binary.is_file() {
        require_detach_cleanup(&service_binary)?;
    }
    if service_exists() {
        require_sc(&["delete", SERVICE_NAME])?;
    }
    for file in [
        SERVICE_FILE,
        "THIRD_PARTY_NOTICES.txt",
        "USBIP-WIN2-LICENSE.txt",
        "virtual-audio-build.json",
    ] {
        let path = install_dir.join(file);
        if path.is_file() {
            fs::remove_file(path).map_err(service_io_error)?;
        }
    }
    let _ = fs::remove_dir(&install_dir);
    let _ = fs::remove_file(
        program_data_dir()
            .join("MIDIMaster")
            .join("VirtualAudio")
            .join("usbip-path"),
    );
    remove_restart_marker();
    Ok(SetupResult {
        schema_version: 1,
        operation,
        state: "not_installed",
        success: true,
        restart_required: false,
        message:
            "MIDIMaster Virtual Audio was removed. The shared USBIP driver was left installed."
                .into(),
    })
}

fn status(operation: &str) -> Result<SetupResult<'_>, SetupError> {
    let restart = restart_marker().is_file();
    let installed = service_exists();
    let state = match inspect_usbip() {
        DriverState::Unsafe => "blocked_unsafe_version",
        DriverState::Unknown(_) => "blocked_unknown_version",
        _ if restart => "restart_required",
        _ if installed => "ready",
        _ => "not_installed",
    };
    Ok(SetupResult {
        schema_version: 1,
        operation,
        state,
        success: true,
        restart_required: restart,
        message: format!("Virtual Audio state: {state}"),
    })
}

#[derive(Debug, PartialEq, Eq)]
enum DriverState {
    Missing,
    Supported,
    Unsafe,
    Unknown(String),
}

fn inspect_usbip() -> DriverState {
    let registered = registered_usbip_versions();
    if registered.iter().any(|version| version == "0.9.7.8") {
        return DriverState::Unsafe;
    }
    if let Some(version) = registered
        .iter()
        .find(|version| version.as_str() != USBIP_VERSION)
    {
        return DriverState::Unknown(format!("{version} (Windows uninstall registry)"));
    }
    let Some(executable) = find_usbip() else {
        return if registered.is_empty() {
            DriverState::Missing
        } else {
            DriverState::Unknown(format!("{USBIP_VERSION} (usbip.exe missing)"))
        };
    };
    let Ok(output) = run_hidden(Command::new(executable).arg("--version")) else {
        return DriverState::Unknown("unreadable".into());
    };
    let combined = format!(
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if combined.contains("0.9.7.8") {
        DriverState::Unsafe
    } else if combined.contains(USBIP_VERSION) {
        DriverState::Supported
    } else {
        DriverState::Unknown(combined.trim().to_owned())
    }
}

fn find_usbip() -> Option<PathBuf> {
    let mut roots = vec![];
    for name in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(name) {
            roots.push(PathBuf::from(root));
        }
    }
    roots.extend(registered_usbip_locations());
    roots.sort();
    roots.dedup();
    let installed = roots
        .into_iter()
        .flat_map(|root| {
            [
                root.join("usbip.exe"),
                root.join("USBip/usbip.exe"),
                root.join("usbip-win2/usbip.exe"),
                root.join("usbip/usbip.exe"),
            ]
        })
        .find(|path| path.is_file());
    if installed.is_some() {
        return installed;
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join("usbip.exe"))
        .find(|path| path.is_file())
}

#[cfg(windows)]
fn registered_usbip_values() -> Vec<(String, Option<PathBuf>)> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut values = Vec::new();
    for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
        let Ok(uninstall) = hklm.open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            KEY_READ | view,
        ) else {
            continue;
        };
        for subkey_name in uninstall.enum_keys().flatten() {
            let Ok(subkey) = uninstall.open_subkey_with_flags(&subkey_name, KEY_READ | view) else {
                continue;
            };
            let display_name: String = subkey.get_value("DisplayName").unwrap_or_default();
            if !display_name.to_ascii_lowercase().contains("usbip") {
                continue;
            }
            let version: String = subkey
                .get_value("DisplayVersion")
                .unwrap_or_else(|_| "unknown".into());
            let location: String = subkey.get_value("InstallLocation").unwrap_or_default();
            values.push((
                version.trim().to_owned(),
                (!location.trim().is_empty()).then(|| PathBuf::from(location)),
            ));
        }
    }
    values.sort();
    values.dedup();
    values
}

#[cfg(not(windows))]
fn registered_usbip_values() -> Vec<(String, Option<PathBuf>)> {
    Vec::new()
}

fn registered_usbip_versions() -> Vec<String> {
    registered_usbip_values()
        .into_iter()
        .map(|(version, _)| version)
        .collect()
}

fn registered_usbip_locations() -> Vec<PathBuf> {
    registered_usbip_values()
        .into_iter()
        .filter_map(|(_, location)| location)
        .collect()
}

fn verify_usbip_payload(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("pinned USBIP installer is missing: {error}"))?;
    if metadata.len() != USBIP_SIZE {
        return Err(format!(
            "USBIP installer length mismatch: expected {USBIP_SIZE}, got {}",
            metadata.len()
        ));
    }
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != USBIP_SHA256 {
        return Err(format!(
            "USBIP installer SHA-256 mismatch: expected {USBIP_SHA256}, got {actual}"
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_elevated() -> Result<(), SetupError> {
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
    ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CREATE_SERVICE)
        .map(|_| ())
        .map_err(|_| SetupError {
            code: 20,
            state: "elevation_required",
            message: "Administrator approval is required to manage Virtual Audio.".into(),
        })
}
#[cfg(not(windows))]
fn ensure_elevated() -> Result<(), SetupError> {
    Err(SetupError {
        code: 20,
        state: "unsupported_platform",
        message: "Virtual Audio is Windows-only.".into(),
    })
}

fn service_install_dir() -> Result<PathBuf, SetupError> {
    let root = std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .ok_or_else(|| SetupError {
            code: 25,
            state: "service_error",
            message: "Program Files directory is unavailable.".into(),
        })?;
    Ok(PathBuf::from(root).join("MIDIMaster").join("Virtual Audio"))
}

fn service_exists() -> bool {
    sc(&["query", SERVICE_NAME]).is_ok_and(|output| output.status.success())
}

fn require_sc(args: &[&str]) -> Result<(), SetupError> {
    let output = sc(args).map_err(|error| SetupError {
        code: 25,
        state: "service_error",
        message: error.to_string(),
    })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(SetupError {
            code: 25,
            state: "service_error",
            message: format!(
                "sc.exe {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stdout).trim()
            ),
        })
    }
}

fn require_detach_cleanup(service_binary: &Path) -> Result<(), SetupError> {
    let output =
        run_hidden(Command::new(service_binary).arg("--detach")).map_err(|error| SetupError {
            code: 25,
            state: "service_error",
            message: format!("could not run Virtual Audio attachment cleanup: {error}"),
        })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(SetupError {
        code: 25,
        state: "service_error",
        message: format!(
            "Virtual Audio attachment cleanup failed (exit {:?}): {detail}",
            output.status.code()
        ),
    })
}

fn sc(args: &[&str]) -> io::Result<Output> {
    run_hidden(Command::new("sc.exe").args(args))
}

fn wait_for_service_stop() {
    for _ in 0..40 {
        let stopped = sc(&["query", SERVICE_NAME])
            .map(|output| !String::from_utf8_lossy(&output.stdout).contains("RUNNING"))
            .unwrap_or(true);
        if stopped {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

fn run_hidden(command: &mut Command) -> io::Result<Output> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.output()
}

fn program_data_dir() -> PathBuf {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
}
fn restart_marker() -> PathBuf {
    program_data_dir()
        .join("MIDIMaster")
        .join("VirtualAudio")
        .join("restart-required")
}
fn write_usbip_path(executable: &Path) -> io::Result<()> {
    let path = program_data_dir()
        .join("MIDIMaster")
        .join("VirtualAudio")
        .join("usbip-path");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, executable.as_os_str().to_string_lossy().as_bytes())
}
fn write_restart_marker() -> io::Result<()> {
    let marker = restart_marker();
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(marker, b"USBIP restart required\r\n")
}
fn remove_restart_marker() {
    let _ = fs::remove_file(restart_marker());
}
fn service_io_error(error: io::Error) -> SetupError {
    SetupError {
        code: 25,
        state: "service_error",
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_constants_are_the_approved_payload() {
        assert_eq!(USBIP_VERSION, "0.9.7.7");
        assert_eq!(USBIP_SIZE, 33_226_344);
        assert_eq!(USBIP_SHA256.len(), 64);
    }

    #[test]
    fn payload_verification_fails_closed() {
        let path =
            std::env::temp_dir().join(format!("midimaster-usbip-test-{}.exe", std::process::id()));
        fs::write(&path, b"not usbip").unwrap();
        let result = verify_usbip_payload(&path);
        let _ = fs::remove_file(path);
        assert!(result.unwrap_err().contains("length mismatch"));
    }

    #[test]
    fn restart_marker_contract_is_stable() {
        assert!(restart_marker()
            .to_string_lossy()
            .ends_with(r"MIDIMaster\VirtualAudio\restart-required"));
    }

    #[test]
    fn result_file_contract_has_only_the_numeric_exit_code() {
        let path = std::env::temp_dir().join(format!(
            "midimaster-virtual-audio-result-test-{}.txt",
            std::process::id()
        ));
        write_result_file(Some(&path), RESTART_REQUIRED);
        assert_eq!(fs::read_to_string(&path).unwrap(), "3010");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn result_file_argument_is_parsed_independently() {
        let args = [
            OsString::from("install"),
            OsString::from("--result-file"),
            OsString::from(r"C:\Temp\result.txt"),
        ];
        assert_eq!(
            parse_path_option(&args, "--result-file"),
            Some(PathBuf::from(r"C:\Temp\result.txt"))
        );
    }
}

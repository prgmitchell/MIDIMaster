use crate::status::ServiceStatus;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

const OWN_URL: &str = "usbip://127.0.0.1:34240/1-1";

pub fn find_usbip() -> Option<PathBuf> {
    let mut roots = Vec::new();
    let configured = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("MIDIMaster")
        .join("VirtualAudio")
        .join("usbip-path");
    if let Ok(value) = std::fs::read_to_string(configured) {
        let candidate = PathBuf::from(value.trim());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    for name in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(name) {
            roots.push(PathBuf::from(root));
        }
    }
    roots.sort();
    roots.dedup();
    for root in roots {
        for relative in ["USBip/usbip.exe", "usbip-win2/usbip.exe", "usbip/usbip.exe"] {
            let candidate = root.join(relative);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join("usbip.exe"))
        .find(|path| path.is_file())
}

pub fn attachment_monitor(stop: Arc<AtomicBool>, status: Arc<ServiceStatus>) {
    while !stop.load(Ordering::Acquire) {
        match find_usbip() {
            Some(executable) => match own_attached_ports(&executable) {
                Ok(ports) if !ports.is_empty() => {
                    let cleanup = detach_ports_with(&ports[1..], |port| {
                        detach_port(&executable, port).map_err(|error| error.to_string())
                    });
                    if let Err(error) = cleanup {
                        status.set_attached_port_count(ports.len() as u32);
                        status
                            .set_error(format!("could not remove duplicate USBIP ports: {error}"));
                    } else {
                        status.set_attached_port_count(1);
                        status.clear_error();
                        clear_restart_marker_after_later_boot();
                    }
                }
                Ok(_) => match run_usbip(
                    &executable,
                    &[
                        "--tcp-port",
                        "34240",
                        "attach",
                        "--remote",
                        "127.0.0.1",
                        "--bus-id",
                        "1-1",
                        "--once",
                    ],
                ) {
                    Ok(output) if output.status.success() => {
                        status.set_attached_port_count(1);
                        status.clear_error();
                        clear_restart_marker_after_later_boot();
                    }
                    Ok(output) => {
                        status.set_attached_port_count(0);
                        status.set_error(format!(
                            "usbip attach exited {:?}: {}",
                            output.status.code(),
                            String::from_utf8_lossy(&output.stderr).trim()
                        ));
                    }
                    Err(error) => {
                        status.set_attached_port_count(0);
                        status.set_error(format!("could not run usbip attach: {error}"));
                    }
                },
                Err(error) => {
                    status.set_attached_port_count(0);
                    status.set_error(format!("could not inspect USBIP ports: {error}"));
                }
            },
            None => {
                status.set_attached_port_count(0);
                status.set_error("usbip.exe 0.9.7.7 is not installed");
            }
        }
        for _ in 0..50 {
            if stop.load(Ordering::Acquire) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}

pub fn detach_own() -> Result<(), String> {
    let Some(executable) = find_usbip() else {
        return Ok(());
    };
    let ports = own_attached_ports(&executable).map_err(|error| error.to_string())?;
    detach_ports_with(&ports, |port| {
        detach_port(&executable, port).map_err(|error| error.to_string())
    })?;
    for _ in 0..50 {
        let remaining = own_attached_ports(&executable).map_err(|error| error.to_string())?;
        if remaining.is_empty() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    let remaining = own_attached_ports(&executable).map_err(|error| error.to_string())?;
    Err(format!(
        "MIDIMaster USBIP ports are still attached after cleanup: {}",
        format_ports(&remaining)
    ))
}

fn detach_port(executable: &Path, port: u8) -> std::io::Result<()> {
    let port = port.to_string();
    let output = run_usbip(executable, &["detach", "--port", &port])?;
    if output.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "usbip detach --port {port} exited {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn own_attached_ports(executable: &Path) -> std::io::Result<Vec<u8>> {
    let output = run_usbip(executable, &["port"])?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    parse_own_attached_ports(&String::from_utf8_lossy(&output.stdout))
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

fn parse_own_attached_ports(text: &str) -> Result<Vec<u8>, String> {
    let mut ports = Vec::new();
    let mut current_port = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Port ") {
            current_port = rest.split(':').next().map(str::trim).map(str::to_owned);
        } else if trimmed.contains(OWN_URL) {
            let raw = current_port
                .take()
                .ok_or_else(|| "USBIP reported a MIDIMaster URL without a port".to_string())?;
            ports.push(parse_port_number(&raw)?);
        }
    }
    ports.sort_unstable();
    ports.dedup();
    Ok(ports)
}

fn parse_port_number(raw: &str) -> Result<u8, String> {
    let value = raw
        .parse::<u16>()
        .map_err(|_| format!("USBIP reported an invalid port number: {raw}"))?;
    u8::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("USBIP port is outside the supported range 1-255: {raw}"))
}

fn detach_ports_with(
    ports: &[u8],
    mut detach: impl FnMut(u8) -> Result<(), String>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for &port in ports {
        if let Err(error) = detach(port) {
            errors.push(format!("port {port}: {error}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn format_ports(ports: &[u8]) -> String {
    ports
        .iter()
        .map(u8::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

fn run_usbip(executable: &Path, args: &[&str]) -> std::io::Result<Output> {
    let mut command = Command::new(executable);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command.output()
}

pub fn marker_predates_boot(marker_modified: SystemTime, boot_time: SystemTime) -> bool {
    marker_modified < boot_time
}

fn restart_marker() -> PathBuf {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("MIDIMaster")
        .join("VirtualAudio")
        .join("restart-required")
}

#[cfg(windows)]
fn current_boot_time() -> SystemTime {
    use windows::Win32::System::SystemInformation::GetTickCount64;
    let uptime = Duration::from_millis(unsafe { GetTickCount64() });
    SystemTime::now()
        .checked_sub(uptime)
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

#[cfg(not(windows))]
fn current_boot_time() -> SystemTime {
    SystemTime::UNIX_EPOCH
}

fn clear_restart_marker_after_later_boot() {
    let marker = restart_marker();
    let Ok(modified) = std::fs::metadata(&marker).and_then(|metadata| metadata.modified()) else {
        return;
    };
    if marker_predates_boot(modified, current_boot_time()) {
        let _ = std::fs::remove_file(marker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_url_is_exact_and_does_not_claim_other_servers() {
        assert!(OWN_URL.ends_with(":34240/1-1"));
        assert!(!OWN_URL.contains(":3240/"));
    }

    #[test]
    fn restart_marker_only_clears_after_a_later_boot() {
        let origin = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert!(marker_predates_boot(
            origin,
            origin + Duration::from_secs(1)
        ));
        assert!(!marker_predates_boot(origin, origin));
        assert!(!marker_predates_boot(
            origin + Duration::from_secs(1),
            origin
        ));
    }

    #[test]
    fn finds_every_duplicate_port_for_its_exact_url() {
        let output = r#"
Port 01: device in use
  -> usbip://127.0.0.1:34240/1-1
Port 08: device in use
  -> usbip://127.0.0.1:34240/1-1
Port 255: device in use
  -> usbip://127.0.0.1:34240/1-1
Port 08: duplicate output row
  -> usbip://127.0.0.1:34240/1-1
Port 03: other device
  -> usbip://127.0.0.1:9999/1-1
"#;
        assert_eq!(parse_own_attached_ports(output).unwrap(), [1, 8, 255]);
    }

    #[test]
    fn rejects_malformed_and_out_of_range_owned_ports() {
        for port in ["0", "256", "nope"] {
            let output = format!("Port {port}: device in use\n  -> {OWN_URL}\n");
            assert!(
                parse_own_attached_ports(&output).is_err(),
                "accepted {port}"
            );
        }
    }

    #[test]
    fn repair_cleanup_attempts_every_normalized_port() {
        let mut detached = Vec::new();
        detach_ports_with(&[1, 8], |port| {
            detached.push(port);
            Ok(())
        })
        .unwrap();
        assert_eq!(detached, [1, 8]);
    }

    #[test]
    fn repair_cleanup_reports_partial_failure_after_trying_every_port() {
        let mut detached = Vec::new();
        let error = detach_ports_with(&[1, 8], |port| {
            detached.push(port);
            if port == 8 {
                Err("simulated failure".into())
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert_eq!(detached, [1, 8]);
        assert!(error.contains("port 8"));
    }

    #[test]
    fn repair_cleanup_is_idempotent_when_no_ports_exist() {
        let mut called = false;
        detach_ports_with(&[], |_| {
            called = true;
            Ok(())
        })
        .unwrap();
        assert!(!called);
    }
}

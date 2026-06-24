#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use windows::core::PCWSTR;

#[cfg(target_os = "windows")]
const APP_NAME: &str = "MIDIMaster";
#[cfg(target_os = "windows")]
const STARTUP_SHORTCUT_NAME: &str = "MIDIMaster.lnk";
#[cfg(target_os = "windows")]
const INSTALL_MARKER_NAME: &str = ".midimaster-installed";
#[cfg(target_os = "windows")]
const RUN_KEY_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(target_os = "windows")]
pub const INSTALL_REQUIRED_ERROR: &str = "Install MIDIMaster before enabling Start with Windows.";

#[cfg(target_os = "windows")]
struct ComGuard;

#[cfg(target_os = "windows")]
impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

#[cfg(target_os = "windows")]
fn init_com() -> Result<Option<ComGuard>, String> {
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

    match unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() } {
        Ok(_) => Ok(Some(ComGuard)),
        Err(err) if err.code() == RPC_E_CHANGED_MODE => Ok(None),
        Err(err) => Err(format!("Failed to initialize Windows Shell: {}", err)),
    }
}

#[cfg(target_os = "windows")]
fn wide_null(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(Some(0)).collect()
}

#[cfg(target_os = "windows")]
fn appdata_dir() -> Result<PathBuf, String> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "Unable to resolve the Windows startup folder".to_string())
}

#[cfg(target_os = "windows")]
fn startup_shortcut_path() -> Result<PathBuf, String> {
    Ok(appdata_dir()?
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup")
        .join(STARTUP_SHORTCUT_NAME))
}

#[cfg(target_os = "windows")]
fn install_marker_path(exe_path: &Path) -> Option<PathBuf> {
    exe_path.parent().map(|dir| dir.join(INSTALL_MARKER_NAME))
}

#[cfg(target_os = "windows")]
fn is_installed_executable(exe_path: &Path) -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    install_marker_path(exe_path)
        .map(|path| path.is_file())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn ensure_installed_executable(exe_path: &Path) -> Result<(), String> {
    if is_installed_executable(exe_path) {
        Ok(())
    } else {
        Err(INSTALL_REQUIRED_ERROR.to_string())
    }
}

#[cfg(target_os = "windows")]
fn create_startup_shortcut(shortcut_path: &Path, exe_path: &Path) -> Result<(), String> {
    use windows::core::Interface;
    use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let _com_guard = init_com()?;
    let link: IShellLinkW = unsafe {
        CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|err| format!("Failed to create startup shortcut: {}", err))?
    };

    let exe_wide = wide_null(exe_path.as_os_str());
    unsafe {
        link.SetPath(PCWSTR(exe_wide.as_ptr()))
            .map_err(|err| format!("Failed to configure startup shortcut: {}", err))?;
    }

    if let Some(parent) = exe_path.parent() {
        let workdir_wide = wide_null(parent.as_os_str());
        unsafe {
            link.SetWorkingDirectory(PCWSTR(workdir_wide.as_ptr()))
                .map_err(|err| format!("Failed to configure startup shortcut: {}", err))?;
        }
    }

    let persist_file: IPersistFile = link
        .cast()
        .map_err(|err| format!("Failed to save startup shortcut: {}", err))?;
    let shortcut_wide = wide_null(shortcut_path.as_os_str());
    unsafe {
        persist_file
            .Save(PCWSTR(shortcut_wide.as_ptr()), true)
            .map_err(|err| format!("Failed to save startup shortcut: {}", err))?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
pub fn clear_windows_autostart_artifacts() -> Result<(), String> {
    let mut first_error: Option<String> = None;

    if let Ok(shortcut_path) = startup_shortcut_path() {
        match std::fs::remove_file(&shortcut_path) {
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => first_error = Some(format!("Failed to remove startup shortcut: {}", err)),
        }
    }

    if let Err(err) = delete_legacy_run_value() {
        if first_error.is_none() {
            first_error = Some(err);
        }
    }

    match first_error {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

#[cfg(target_os = "windows")]
pub fn startup_requires_installed_app(error: &str) -> bool {
    error == INSTALL_REQUIRED_ERROR
}

#[cfg(target_os = "windows")]
pub fn set_windows_autostart(enabled: bool) -> Result<(), String> {
    if !enabled {
        return clear_windows_autostart_artifacts();
    }

    let exe_path =
        std::env::current_exe().map_err(|_| "Failed to resolve executable path".to_string())?;
    ensure_installed_executable(&exe_path)?;

    let shortcut_path = startup_shortcut_path()?;
    let startup_dir = shortcut_path
        .parent()
        .ok_or_else(|| "Unable to resolve the Windows startup folder".to_string())?;
    std::fs::create_dir_all(startup_dir)
        .map_err(|err| format!("Failed to create startup folder: {}", err))?;

    create_startup_shortcut(&shortcut_path, &exe_path)?;
    let _ = delete_legacy_run_value();
    Ok(())
}

#[cfg(target_os = "windows")]
fn delete_legacy_run_value() -> Result<(), String> {
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY_CURRENT_USER, KEY_SET_VALUE,
    };

    let sub_key: Vec<u16> = RUN_KEY_PATH.encode_utf16().chain(Some(0)).collect();
    let value_name: Vec<u16> = APP_NAME.encode_utf16().chain(Some(0)).collect();
    let mut key = Default::default();
    let open_result = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(sub_key.as_ptr()),
            Some(0),
            KEY_SET_VALUE,
            &mut key,
        )
    };
    if open_result.is_err() {
        return Ok(());
    }

    let _ = unsafe { RegDeleteValueW(key, PCWSTR(value_name.as_ptr())) };
    let _ = unsafe { RegCloseKey(key) };
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn clear_windows_autostart_artifacts() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn startup_requires_installed_app(_error: &str) -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
pub fn set_windows_autostart(_enabled: bool) -> Result<(), String> {
    Ok(())
}

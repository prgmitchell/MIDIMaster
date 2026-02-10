#[cfg(target_os = "windows")]
use windows::core::PCWSTR;

#[cfg(target_os = "windows")]
pub fn set_windows_autostart(enabled: bool) -> Result<(), String> {
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY_CURRENT_USER, KEY_READ,
        KEY_WRITE, REG_SZ,
    };

    let sub_key: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Run"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let value_name: Vec<u16> = "MIDIMaster".encode_utf16().chain(Some(0)).collect();
    let mut key = Default::default();
    let open_result = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(sub_key.as_ptr()),
            Some(0),
            KEY_READ | KEY_WRITE,
            &mut key,
        )
    };
    if open_result.is_err() {
        return Err("Failed to open registry key".to_string());
    }

    if enabled {
        let exe_path =
            std::env::current_exe().map_err(|_| "Failed to resolve executable path".to_string())?;
        let exe_string = exe_path.to_string_lossy();
        let data: Vec<u16> = exe_string.encode_utf16().chain(Some(0)).collect();
        let mut bytes = Vec::with_capacity(data.len() * 2);
        for value in data {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let result = unsafe {
            RegSetValueExW(
                key,
                PCWSTR(value_name.as_ptr()),
                Some(0),
                REG_SZ,
                Some(bytes.as_slice()),
            )
        };
        let _ = unsafe { RegCloseKey(key) };
        if result.is_err() {
            return Err("Failed to set autostart".to_string());
        }
    } else {
        let _ = unsafe { RegDeleteValueW(key, PCWSTR(value_name.as_ptr())) };
        let _ = unsafe { RegCloseKey(key) };
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_windows_autostart(_enabled: bool) -> Result<(), String> {
    Ok(())
}

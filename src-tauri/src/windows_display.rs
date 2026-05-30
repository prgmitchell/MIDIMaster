#[cfg(target_os = "windows")]
use std::mem::size_of;

#[cfg(target_os = "windows")]
use windows::core::{PCWSTR, PWSTR};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};

#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};

#[cfg(target_os = "windows")]
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY_LOCAL_MACHINE, KEY_READ,
};

#[cfg(target_os = "windows")]
fn enum_display_device(raw_name: &str) -> Option<DISPLAY_DEVICEW> {
    let mut device = DISPLAY_DEVICEW {
        cb: size_of::<DISPLAY_DEVICEW>() as u32,
        ..Default::default()
    };
    let wide: Vec<u16> = raw_name.encode_utf16().chain(Some(0)).collect();
    let success =
        unsafe { EnumDisplayDevicesW(PCWSTR(wide.as_ptr()), 0, &mut device, 0) }.as_bool();
    if !success {
        None
    } else {
        Some(device)
    }
}

#[cfg(target_os = "windows")]
fn wide_field_to_string(field: &[u16]) -> Option<String> {
    let end = field
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(field.len());
    let value = String::from_utf16_lossy(&field[..end]).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(target_os = "windows")]
pub fn display_device_id(raw_name: &str) -> Option<String> {
    let device = enum_display_device(raw_name)?;
    wide_field_to_string(&device.DeviceID)
}

#[cfg(target_os = "windows")]
fn display_device_string(raw_name: &str) -> Option<String> {
    let device = enum_display_device(raw_name)?;
    let value = wide_field_to_string(&device.DeviceString)?;
    let generic_names = ["Generic PnP Monitor", "Generic Non-PnP Monitor"];
    if generic_names
        .iter()
        .any(|name| value.eq_ignore_ascii_case(name))
    {
        None
    } else {
        Some(value)
    }
}

#[cfg(target_os = "windows")]
fn open_enum_key(sub_path: &str) -> Option<windows::Win32::System::Registry::HKEY> {
    let sub_key_w: Vec<u16> = sub_path.encode_utf16().chain(Some(0)).collect();
    let mut key = Default::default();
    let open_result = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(sub_key_w.as_ptr()),
            Some(0),
            KEY_READ,
            &mut key,
        )
    };
    if open_result.is_err() {
        None
    } else {
        Some(key)
    }
}

#[cfg(target_os = "windows")]
fn enum_registry_subkeys(sub_path: &str) -> Vec<String> {
    let Some(key) = open_enum_key(sub_path) else {
        return Vec::new();
    };

    let mut output = Vec::new();
    let mut index = 0u32;
    loop {
        let mut name = vec![0u16; 256];
        let mut len = name.len() as u32;
        let result = unsafe {
            RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut len,
                None,
                None,
                None,
                None,
            )
        };
        if result == ERROR_NO_MORE_ITEMS {
            break;
        }
        if result == ERROR_SUCCESS {
            output.push(String::from_utf16_lossy(&name[..len as usize]));
        }
        index += 1;
    }

    let _ = unsafe { RegCloseKey(key) };
    output
}

#[cfg(target_os = "windows")]
fn read_registry_string(sub_path: &str, name: &str) -> Option<String> {
    let key = open_enum_key(sub_path)?;
    let value_name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut data_len = 0u32;
    let query_len_result = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value_name.as_ptr()),
            None,
            None,
            None,
            Some(&mut data_len),
        )
    };
    if query_len_result.is_err() || data_len < 2 {
        let _ = unsafe { RegCloseKey(key) };
        return None;
    }

    let mut data = vec![0u8; data_len as usize];
    let query_result = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value_name.as_ptr()),
            None,
            None,
            Some(data.as_mut_ptr()),
            Some(&mut data_len),
        )
    };
    let _ = unsafe { RegCloseKey(key) };
    if query_result.is_err() {
        return None;
    }

    let words: Vec<u16> = data
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .take_while(|value| *value != 0)
        .collect();
    let raw = String::from_utf16_lossy(&words);
    let value = clean_registry_display_name(&raw);
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(target_os = "windows")]
fn clean_registry_display_name(value: &str) -> String {
    value.rsplit(';').next().unwrap_or(value).trim().to_string()
}

#[cfg(target_os = "windows")]
fn read_edid_name(device_id: &str) -> Option<String> {
    let sub_key = format!(
        "SYSTEM\\CurrentControlSet\\Enum\\{}\\Device Parameters",
        device_id
    );
    let key = open_enum_key(&sub_key)?;
    let value_name: Vec<u16> = "EDID".encode_utf16().chain(Some(0)).collect();
    let mut data_len = 0u32;
    let query_len_result = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value_name.as_ptr()),
            None,
            None,
            None,
            Some(&mut data_len),
        )
    };
    if query_len_result.is_err() || data_len == 0 {
        let _ = unsafe { RegCloseKey(key) };
        return None;
    }

    let mut data = vec![0u8; data_len as usize];
    let query_result = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value_name.as_ptr()),
            None,
            None,
            Some(data.as_mut_ptr()),
            Some(&mut data_len),
        )
    };
    let _ = unsafe { RegCloseKey(key) };
    if query_result.is_err() || data.len() < 128 {
        return None;
    }

    for idx in 0..4 {
        let start = 54 + idx * 18;
        if data[start] == 0x00
            && data[start + 1] == 0x00
            && data[start + 2] == 0x00
            && data[start + 3] == 0xFC
        {
            let name_bytes = &data[start + 5..start + 18];
            let raw = String::from_utf8_lossy(name_bytes);
            let name = raw
                .trim_matches(|c: char| c == '\0' || c == '\n' || c == '\r' || c == ' ')
                .to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn read_display_enum_edid_name(device_id: &str) -> Option<String> {
    let mut parts = device_id.split('\\');
    let class = parts.next()?;
    let hardware_id = parts.next()?;
    if !class.eq_ignore_ascii_case("MONITOR") || hardware_id.trim().is_empty() {
        return None;
    }

    let display_key = format!(
        "SYSTEM\\CurrentControlSet\\Enum\\DISPLAY\\{}",
        hardware_id.trim()
    );
    enum_registry_subkeys(&display_key)
        .into_iter()
        .find_map(|instance| read_edid_name(&format!("DISPLAY\\{}\\{}", hardware_id, instance)))
}

#[cfg(target_os = "windows")]
pub fn monitor_display_name(raw_name: &str) -> Option<String> {
    let device_id = display_device_id(raw_name)?;
    let enum_key = format!("SYSTEM\\CurrentControlSet\\Enum\\{}", device_id);
    read_edid_name(&device_id)
        .or_else(|| read_display_enum_edid_name(&device_id))
        .or_else(|| read_registry_string(&enum_key, "FriendlyName"))
        .or_else(|| read_registry_string(&enum_key, "DeviceDesc"))
        .or_else(|| display_device_string(raw_name))
}

#[cfg(not(target_os = "windows"))]
pub fn display_device_id(_raw_name: &str) -> Option<String> {
    None
}

#[cfg(not(target_os = "windows"))]
pub fn monitor_display_name(_raw_name: &str) -> Option<String> {
    None
}

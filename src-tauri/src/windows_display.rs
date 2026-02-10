#[cfg(target_os = "windows")]
use std::mem::size_of;

#[cfg(target_os = "windows")]
use windows::core::PCWSTR;

#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};

#[cfg(target_os = "windows")]
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_LOCAL_MACHINE, KEY_READ,
};

#[cfg(target_os = "windows")]
pub fn display_device_id(raw_name: &str) -> Option<String> {
    let mut device = DISPLAY_DEVICEW::default();
    device.cb = size_of::<DISPLAY_DEVICEW>() as u32;
    let wide: Vec<u16> = raw_name.encode_utf16().chain(Some(0)).collect();
    let success =
        unsafe { EnumDisplayDevicesW(PCWSTR(wide.as_ptr()), 0, &mut device, 0) }.as_bool();
    if !success {
        return None;
    }
    let end = device
        .DeviceID
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(device.DeviceID.len());
    let id = String::from_utf16_lossy(&device.DeviceID[..end]);
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

#[cfg(target_os = "windows")]
fn read_edid_name(device_id: &str) -> Option<String> {
    let sub_key = format!(
        "SYSTEM\\CurrentControlSet\\Enum\\{}\\Device Parameters",
        device_id
    );
    let sub_key_w: Vec<u16> = sub_key.encode_utf16().chain(Some(0)).collect();
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
        return None;
    }

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
pub fn monitor_display_name(raw_name: &str) -> Option<String> {
    let device_id = display_device_id(raw_name)?;
    read_edid_name(&device_id)
}

#[cfg(not(target_os = "windows"))]
pub fn display_device_id(_raw_name: &str) -> Option<String> {
    None
}

#[cfg(not(target_os = "windows"))]
pub fn monitor_display_name(_raw_name: &str) -> Option<String> {
    None
}

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::Path;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Media::Audio::IAudioSessionControl2;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::ExtractIconExW;
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

pub(super) fn icon_data_for_path(
    path: &str,
    icon_cache: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    let cache_key = format!("{}|0", path);
    if let Some(cached) = icon_cache.get(&cache_key) {
        return cached.clone();
    }
    let icon_data = extract_icon_data(path, 0);
    icon_cache.insert(cache_key, icon_data.clone());
    icon_data
}

pub(super) fn icon_data_for_icon_path(
    icon_path: &str,
    icon_cache: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    let (path, index) = parse_icon_location(icon_path)?;
    let cache_key = format!("{}|{}", path, index);
    if let Some(cached) = icon_cache.get(&cache_key) {
        return cached.clone();
    }
    let icon_data = extract_icon_data(&path, index);
    icon_cache.insert(cache_key, icon_data.clone());
    icon_data
}

pub(super) fn parse_icon_location(value: &str) -> Option<(String, i32)> {
    let trimmed = value.trim().trim_matches('"').trim_start_matches('@');
    let (path_raw, index) = match trimmed.rsplit_once(',') {
        Some((path, index)) => (path, index.trim().parse::<i32>().ok().unwrap_or(0)),
        None => (trimmed, 0),
    };
    let expanded = expand_known_env_vars(path_raw.trim());
    if expanded.is_empty() {
        None
    } else {
        Some((expanded, index))
    }
}

pub(super) fn expand_known_env_vars(value: &str) -> String {
    let mut result = value.to_string();
    if let Ok(system_root) = std::env::var("SystemRoot") {
        result = replace_case_insensitive(&result, "%SystemRoot%", &system_root);
    }
    if let Ok(windir) = std::env::var("WINDIR") {
        result = replace_case_insensitive(&result, "%WINDIR%", &windir);
    }
    result
}

pub(super) fn replace_case_insensitive(value: &str, pattern: &str, replacement: &str) -> String {
    let mut result = value.to_string();
    let pattern_lower = pattern.to_ascii_lowercase();
    loop {
        let lower = result.to_ascii_lowercase();
        if let Some(index) = lower.find(&pattern_lower) {
            result.replace_range(index..index + pattern.len(), replacement);
        } else {
            break;
        }
    }
    result
}

pub(super) fn extract_icon_data(path: &str, index: i32) -> Option<String> {
    let wide_path = to_wide_string(path);
    let mut large = [HICON::default(); 1];
    let mut small = [HICON::default(); 1];
    let count = unsafe {
        ExtractIconExW(
            PCWSTR(wide_path.as_ptr()),
            index,
            Some(large.as_mut_ptr()),
            Some(small.as_mut_ptr()),
            1,
        )
    };
    if count == 0 {
        return None;
    }

    let icon = if !large[0].is_invalid() {
        large[0]
    } else {
        small[0]
    };
    if icon.is_invalid() {
        return None;
    }
    let icon_data = icon_to_png_base64(icon);

    unsafe {
        if !large[0].is_invalid() {
            let _ = DestroyIcon(large[0]);
        }
        if !small[0].is_invalid() {
            let _ = DestroyIcon(small[0]);
        }
    }

    icon_data
}

pub fn extract_executable_icon_base64(path: &str) -> Option<String> {
    extract_icon_data(path, 0)
}

pub(super) fn icon_to_png_base64(icon: HICON) -> Option<String> {
    let mut icon_info = ICONINFO::default();
    unsafe { GetIconInfo(icon, &mut icon_info).ok()? };

    let bitmap = if !icon_info.hbmColor.is_invalid() {
        icon_info.hbmColor
    } else {
        icon_info.hbmMask
    };
    if bitmap.is_invalid() {
        return None;
    }

    let mut bitmap_data = BITMAP::default();
    let result = unsafe {
        GetObjectW(
            bitmap.into(),
            size_of::<BITMAP>() as i32,
            Some(&mut bitmap_data as *mut _ as *mut _),
        )
    };
    if result == 0 {
        unsafe {
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());
        }
        return None;
    }

    let width = bitmap_data.bmWidth;
    let height = bitmap_data.bmHeight;
    if width <= 0 || height <= 0 {
        unsafe {
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());
        }
        return None;
    }

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let hdc = unsafe { GetDC(None) };
    if hdc.0.is_null() {
        unsafe {
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());
        }
        return None;
    }
    let lines = unsafe {
        GetDIBits(
            hdc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        ReleaseDC(None, hdc);
        let _ = DeleteObject(icon_info.hbmColor.into());
        let _ = DeleteObject(icon_info.hbmMask.into());
    }

    if lines == 0 {
        return None;
    }

    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2);
    }

    let mut png_data = Vec::new();
    let encoder = PngEncoder::new(&mut png_data);
    encoder
        .write_image(
            &pixels,
            width as u32,
            height as u32,
            ColorType::Rgba8.into(),
        )
        .ok()?;
    Some(BASE64_STANDARD.encode(png_data))
}

pub(super) fn to_wide_string(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

pub(super) fn pwstr_to_string(ptr: PWSTR) -> Option<String> {
    if ptr.0.is_null() {
        return None;
    }
    unsafe {
        let mut length = 0;
        while *ptr.0.add(length) != 0 {
            length += 1;
        }
        let slice = std::slice::from_raw_parts(ptr.0, length);
        let os_string = OsString::from_wide(slice);
        Some(os_string.to_string_lossy().to_string())
    }
}

pub(super) fn owned_pwstr_to_string(ptr: PWSTR) -> Option<String> {
    let output = pwstr_to_string(ptr);
    if !ptr.0.is_null() {
        unsafe {
            CoTaskMemFree(Some(ptr.0 as _));
        }
    }
    output
}

pub(super) fn session_identifier(
    control2: &IAudioSessionControl2,
    process_id: u32,
) -> Option<String> {
    let identifier = unsafe { control2.GetSessionIdentifier() }.ok()?;
    let identifier = owned_pwstr_to_string(identifier)?;
    if identifier.trim().is_empty() {
        None
    } else {
        Some(format!("{}:{}", process_id, identifier))
    }
}

pub(super) fn is_resource_display_name(name: &str) -> bool {
    name.trim().starts_with('@')
}

pub(super) fn should_skip_session(
    process_id: u32,
    display_name: &Option<String>,
    process_name: &Option<String>,
    process_path: &Option<String>,
    friendly_name: &str,
) -> bool {
    if process_id == 0 {
        return true;
    }

    let blocked = [
        "audiosrv",
        "audiodg",
        "msedgewebview2",
        "system sounds",
        "midimaster",
    ];

    let mut labels = Vec::new();
    labels.push(canonical_label(friendly_name));
    if let Some(name) = display_name.as_ref() {
        labels.push(canonical_label(name));
    }
    if let Some(name) = process_name.as_ref() {
        labels.push(canonical_label(name));
    }
    if let Some(path) = process_path.as_ref() {
        if let Some(stem) = Path::new(path).file_stem().and_then(|s| s.to_str()) {
            labels.push(canonical_label(stem));
        }
    }

    if labels
        .iter()
        .any(|label| blocked.iter().any(|blocked| label == blocked))
    {
        return true;
    }

    // Filter out nameless processes that fall back to "PID <id>" or "Unknown"
    if friendly_name.starts_with("PID ") || friendly_name == "Unknown" {
        return true;
    }

    let is_svchost = labels.iter().any(|label| label == "svchost");
    if is_svchost && display_name.is_none() {
        return true;
    }

    false
}

pub(super) fn canonical_label(label: &str) -> String {
    let trimmed = label.trim().to_lowercase();
    let trimmed = trimmed.strip_suffix(".exe").unwrap_or(&trimmed);
    let trimmed = trimmed.strip_suffix(".dll").unwrap_or(trimmed);
    trimmed.to_string()
}

pub(super) fn friendly_process_label(path: &str) -> Option<String> {
    let stem = Path::new(path).file_stem()?.to_string_lossy();
    let cleaned = stem.replace(['_', '-'], " ");
    let label = cleaned
        .split_whitespace()
        .map(humanize_word)
        .collect::<Vec<_>>()
        .join(" ");
    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

pub(super) fn humanize_label(label: &str) -> String {
    let cleaned = label.replace(['_', '-'], " ");
    cleaned
        .split_whitespace()
        .map(humanize_word)
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn humanize_word(word: &str) -> String {
    if word.chars().any(|ch| ch.is_uppercase()) {
        return word.to_string();
    }
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str().to_lowercase()),
        None => String::new(),
    }
}

pub(super) fn query_process_path(process_id: u32) -> Option<String> {
    if process_id == 0 {
        return None;
    }
    let handle =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    if handle.is_invalid() {
        return None;
    }
    let mut buffer = vec![0u16; 4096];
    let mut size = buffer.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    if result.is_err() {
        return None;
    }
    buffer.truncate(size as usize);
    Some(OsString::from_wide(&buffer).to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr;
    use windows::Win32::System::Com::CoTaskMemAlloc;

    #[test]
    fn owned_pwstr_to_string_copies_and_frees_com_allocated_memory() {
        let text: Vec<u16> = "MIDIMaster".encode_utf16().chain(Some(0)).collect();
        let byte_len = text.len() * std::mem::size_of::<u16>();
        let raw = unsafe { CoTaskMemAlloc(byte_len) } as *mut u16;
        assert!(!raw.is_null());

        unsafe {
            ptr::copy_nonoverlapping(text.as_ptr(), raw, text.len());
        }

        let output = owned_pwstr_to_string(PWSTR(raw));
        assert_eq!(output.as_deref(), Some("MIDIMaster"));
    }
}

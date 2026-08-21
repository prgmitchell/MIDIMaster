use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, APPMODEL_ERROR_NO_PACKAGE, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE,
};
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Media::Audio::IAudioSessionControl2;
use windows::Win32::Storage::Packaging::Appx::{
    GetApplicationUserModelId, GetPackageFamilyName, GetPackageFullName, GetPackagePathByFullName,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{ExtractIconExW, SHLoadIndirectString};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct ProcessIdentity {
    pub path: Option<String>,
    pub application_user_model_id: Option<String>,
    pub package_family_name: Option<String>,
    pub package_full_name: Option<String>,
}

impl ProcessIdentity {
    pub(super) fn has_package_identity(&self) -> bool {
        self.application_user_model_id.is_some()
            || self.package_family_name.is_some()
            || self.package_full_name.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessSnapshotEntry {
    process_id: u32,
    parent_process_id: u32,
    exe_name: String,
}

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

pub(super) fn icon_data_for_package(
    identity: &ProcessIdentity,
    icon_cache: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    let package_full_name = identity.package_full_name.as_deref()?;
    let cache_key = format!("package-icon|{}", package_full_name.to_ascii_lowercase());
    if let Some(cached) = icon_cache.get(&cache_key) {
        return cached.clone();
    }

    let icon_data = package_path_by_full_name(package_full_name)
        .and_then(|path| best_package_icon_path(Path::new(&path)))
        .and_then(|path| fs::read(path).ok())
        .map(|bytes| BASE64_STANDARD.encode(bytes));
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

fn restore_legacy_icon_alpha(pixels: &mut [u8], mask_pixels: Option<&[u8]>) {
    if pixels.as_chunks::<4>().0.iter().any(|pixel| pixel[3] != 0) {
        return;
    }

    if let Some(mask) = mask_pixels.filter(|mask| mask.len() >= pixels.len()) {
        for (pixel, mask_pixel) in pixels
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(mask.as_chunks::<4>().0.iter())
        {
            let transparent = mask_pixel[0] != 0 || mask_pixel[1] != 0 || mask_pixel[2] != 0;
            pixel[3] = if transparent { 0 } else { u8::MAX };
        }
        return;
    }

    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel[3] = u8::MAX;
    }
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
    let mask_pixels = if lines != 0
        && pixels.as_chunks::<4>().0.iter().all(|pixel| pixel[3] == 0)
        && !icon_info.hbmColor.is_invalid()
        && !icon_info.hbmMask.is_invalid()
    {
        let mut mask_info = BITMAPINFO {
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
        let mut mask = vec![0u8; pixels.len()];
        let mask_lines = unsafe {
            GetDIBits(
                hdc,
                icon_info.hbmMask,
                0,
                height as u32,
                Some(mask.as_mut_ptr() as *mut _),
                &mut mask_info,
                DIB_RGB_COLORS,
            )
        };
        (mask_lines != 0).then_some(mask)
    } else {
        None
    };
    unsafe {
        ReleaseDC(None, hdc);
        let _ = DeleteObject(icon_info.hbmColor.into());
        let _ = DeleteObject(icon_info.hbmMask.into());
    }

    if lines == 0 {
        return None;
    }

    restore_legacy_icon_alpha(&mut pixels, mask_pixels.as_deref());
    for chunk in pixels.as_chunks_mut::<4>().0 {
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

fn string_from_wide_buffer(buffer: &[u16]) -> Option<String> {
    let len = buffer
        .iter()
        .position(|ch| *ch == 0)
        .unwrap_or(buffer.len());
    if len == 0 {
        return None;
    }
    let text = OsString::from_wide(&buffer[..len])
        .to_string_lossy()
        .trim()
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn package_path_by_full_name(package_full_name: &str) -> Option<String> {
    let wide = to_wide_string(package_full_name);
    let mut length = 0u32;
    let first = unsafe { GetPackagePathByFullName(PCWSTR(wide.as_ptr()), &mut length, None) };
    if first != ERROR_INSUFFICIENT_BUFFER || length == 0 {
        return None;
    }

    let mut buffer = vec![0u16; length as usize];
    let second = unsafe {
        GetPackagePathByFullName(
            PCWSTR(wide.as_ptr()),
            &mut length,
            Some(PWSTR(buffer.as_mut_ptr())),
        )
    };
    if second != ERROR_SUCCESS {
        return None;
    }

    string_from_wide_buffer(&buffer)
}

fn best_package_icon_path(package_path: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    collect_package_icon_candidates(package_path, 0, &mut candidates);

    for manifest_logo in manifest_icon_base_paths(package_path) {
        if let Some(path) = candidates
            .iter()
            .filter(|path| package_icon_matches_manifest_logo(path, package_path, &manifest_logo))
            .max_by_key(|path| package_icon_variant_score(path))
        {
            return Some(path.clone());
        }
    }

    candidates
        .into_iter()
        .max_by_key(|path| package_icon_score(path))
        .filter(|path| package_icon_score(path) > 0)
}

fn manifest_icon_base_paths(package_path: &Path) -> Vec<String> {
    let manifest_path = package_path.join("AppxManifest.xml");
    fs::read_to_string(manifest_path)
        .map(|contents| manifest_icon_base_paths_from_contents(&contents))
        .unwrap_or_default()
}

pub(super) fn package_display_name(identity: &ProcessIdentity) -> Option<String> {
    let package_full_name = identity.package_full_name.as_deref()?;
    package_path_by_full_name(package_full_name)
        .and_then(|path| package_display_name_from_manifest(Path::new(&path)))
}

fn package_display_name_from_manifest(package_path: &Path) -> Option<String> {
    let manifest_path = package_path.join("AppxManifest.xml");
    fs::read_to_string(manifest_path)
        .ok()
        .and_then(|contents| package_display_name_from_manifest_contents(&contents))
}

fn package_display_name_from_manifest_contents(contents: &str) -> Option<String> {
    [
        manifest_element(contents, "DisplayName"),
        manifest_attribute(contents, "DisplayName"),
    ]
    .into_iter()
    .flatten()
    .filter_map(|value| {
        resolve_indirect_display_name(&value).or_else(|| {
            if is_resource_display_name(&value) {
                None
            } else {
                Some(value.trim().to_string())
            }
        })
    })
    .find(|value| !value.trim().is_empty())
}

fn manifest_icon_base_paths_from_contents(contents: &str) -> Vec<String> {
    let values = [
        manifest_attribute(contents, "Square44x44Logo"),
        manifest_element(contents, "Logo"),
        manifest_attribute(contents, "Logo"),
        manifest_attribute(contents, "Square150x150Logo"),
        manifest_attribute(contents, "Square71x71Logo"),
    ];
    let mut paths = Vec::new();

    for value in values.iter().filter_map(|value| value.as_deref()) {
        let normalized = normalize_package_icon_reference(value);
        if !normalized.is_empty() && !paths.contains(&normalized) {
            paths.push(normalized);
        }
    }

    paths
}

fn manifest_attribute(contents: &str, attribute: &str) -> Option<String> {
    let mut offset = 0;
    while let Some(relative_start) = contents[offset..].find(attribute) {
        let start = offset + relative_start;
        let after_name = start + attribute.len();
        let before = contents[..start].chars().next_back();
        let has_name_boundary = before
            .map(|ch| ch.is_ascii_whitespace() || ch == '<')
            .unwrap_or(true);
        if !has_name_boundary {
            offset = after_name;
            continue;
        }

        let mut rest = contents[after_name..].trim_start();
        if !rest.starts_with('=') {
            offset = after_name;
            continue;
        }
        rest = rest[1..].trim_start();

        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            offset = after_name;
            continue;
        }

        let value = &rest[quote.len_utf8()..];
        let value_end = value.find(quote)?;
        return Some(value[..value_end].trim().to_string());
    }

    None
}

fn manifest_element(contents: &str, element: &str) -> Option<String> {
    let open = format!("<{}>", element);
    let close = format!("</{}>", element);
    let value = contents.split_once(&open)?.1.split_once(&close)?.0.trim();

    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn collect_package_icon_candidates(dir: &Path, depth: usize, candidates: &mut Vec<PathBuf>) {
    if depth > 4 || candidates.len() > 512 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_package_icon_candidates(&path, depth + 1, candidates);
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("png"))
            .unwrap_or(false)
        {
            candidates.push(path);
        }
    }
}

fn package_icon_score(path: &Path) -> i32 {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut score = package_icon_variant_score(path);

    if file_name.contains("square44x44logo") {
        score += 100;
    }
    if file_name.contains("applist")
        || file_name.contains("appicon")
        || file_name.contains("app_icon")
    {
        score += 90;
    }
    if file_name.contains("logo") {
        score += 40;
    }

    for bad in ["splash", "badge", "wide", "tile", "lockscreen"] {
        if file_name.contains(bad) {
            score -= 80;
        }
    }

    score
}

fn package_icon_variant_score(path: &Path) -> i32 {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let full_path = path.to_string_lossy().to_ascii_lowercase();
    let mut score = 0;

    if file_name.contains("targetsize-48") || file_name.contains("targetsize-44") {
        score += 80;
    } else if file_name.contains("targetsize-64") {
        score += 70;
    } else if file_name.contains("scale-200") {
        score += 60;
    } else if file_name.contains("scale-100") {
        score += 50;
    } else if file_name.contains("targetsize-256") {
        score += 45;
    } else if file_name.contains("targetsize-32") {
        score += 35;
    }

    if file_name.contains("unplated") {
        score += 25;
    }
    if full_path.contains("\\assets\\") || full_path.contains("/assets/") {
        score += 10;
    }

    score
}

fn package_icon_matches_manifest_logo(
    path: &Path,
    package_path: &Path,
    normalized_manifest_logo: &str,
) -> bool {
    let candidate = normalized_package_icon_path(path, package_path);

    candidate == normalized_manifest_logo
        || candidate
            .strip_prefix(normalized_manifest_logo)
            .map(|suffix| suffix.starts_with('.') || suffix.starts_with('_'))
            .unwrap_or(false)
}

fn normalized_package_icon_path(path: &Path, package_path: &Path) -> String {
    let relative_path = path.strip_prefix(package_path).unwrap_or(path);
    normalize_package_icon_reference(&relative_path.to_string_lossy())
}

fn normalize_package_icon_reference(value: &str) -> String {
    let normalized = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_start_matches(['\\', '/'])
        .replace('\\', "/")
        .to_ascii_lowercase();

    normalized
        .strip_suffix(".png")
        .or_else(|| normalized.strip_suffix(".ico"))
        .unwrap_or(&normalized)
        .to_string()
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

pub(super) fn resolve_indirect_display_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !is_resource_display_name(trimmed) {
        return Some(trimmed.to_string());
    }

    let source = to_wide_string(trimmed);
    let mut buffer = vec![0u16; 2048];
    unsafe { SHLoadIndirectString(PCWSTR(source.as_ptr()), &mut buffer, None).ok()? };
    string_from_wide_buffer(&buffer)
}

pub(super) fn session_display_name(raw_name: Option<&str>) -> Option<String> {
    let raw = raw_name.map(str::trim).filter(|name| !name.is_empty())?;
    resolve_indirect_display_name(raw).or_else(|| Some(raw.to_string()))
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

pub(super) fn stable_application_key(
    identity: &ProcessIdentity,
    process_path: Option<&str>,
    process_name: Option<&str>,
    display_name: Option<&str>,
) -> Option<String> {
    if let Some(aumid) = identity.application_user_model_id.as_deref() {
        let value = normalize_key_part(aumid)?;
        return Some(format!("aumid:{}", value));
    }

    if let Some(package_family) = identity.package_family_name.as_deref() {
        let value = normalize_key_part(package_family)?;
        return Some(format!("package:{}", value));
    }

    process_path
        .and_then(file_stem_key)
        .or_else(|| process_name.and_then(file_stem_key))
        .or_else(|| {
            process_name
                .filter(|name| !is_pid_label(name) && !is_webview2_label(name))
                .and_then(normalize_key_part)
        })
        .or_else(|| {
            display_name
                .filter(|name| !is_pid_label(name) && !is_resource_display_name(name))
                .and_then(normalize_key_part)
        })
}

pub(super) fn package_label(identity: &ProcessIdentity) -> Option<String> {
    identity
        .package_family_name
        .as_deref()
        .or(identity.package_full_name.as_deref())
        .and_then(|value| {
            let package_name = value.split('_').next().unwrap_or(value);
            let product = package_name
                .split('.')
                .rfind(|part| !part.trim().is_empty())
                .unwrap_or(package_name);
            let label = humanize_label(product);
            if label.is_empty() {
                None
            } else {
                Some(label)
            }
        })
}

pub(super) fn should_skip_session(
    process_id: u32,
    display_name: &Option<String>,
    process_name: &Option<String>,
    process_path: &Option<String>,
    friendly_name: &str,
    application_key: &Option<String>,
    identity: &ProcessIdentity,
) -> bool {
    let has_usable_identity = application_key.is_some()
        || identity.has_package_identity()
        || process_path.is_some()
        || process_name
            .as_deref()
            .map(|name| !is_pid_label(name))
            .unwrap_or(false)
        || display_name
            .as_deref()
            .map(|name| !is_resource_display_name(name) && !is_pid_label(name))
            .unwrap_or(false);

    if process_id == 0 && !has_usable_identity {
        return true;
    }

    let blocked = ["audiosrv", "audiodg", "midimaster"];

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
    if let Some(key) = application_key.as_ref() {
        labels.push(canonical_label(key));
    }
    if let Some(name) = identity.application_user_model_id.as_ref() {
        labels.push(canonical_label(name));
    }
    if let Some(name) = identity.package_family_name.as_ref() {
        labels.push(canonical_label(name));
    }
    if let Some(name) = identity.package_full_name.as_ref() {
        labels.push(canonical_label(name));
    }

    if labels
        .iter()
        .any(|label| blocked.iter().any(|blocked| label == blocked))
    {
        return true;
    }

    let has_real_display_name = display_name
        .as_deref()
        .map(|name| {
            let label = canonical_label(name);
            !label.is_empty() && !is_pid_label(name) && !is_webview2_label(&label)
        })
        .unwrap_or(false);
    if labels.iter().any(|label| is_webview2_label(label))
        && !identity.has_package_identity()
        && !has_real_display_name
    {
        return true;
    }

    // Filter out nameless processes that fall back to "PID <id>" or "Unknown"
    if (is_pid_label(friendly_name) || friendly_name == "Unknown") && !has_usable_identity {
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

fn is_pid_label(label: &str) -> bool {
    label.trim().to_ascii_lowercase().starts_with("pid ")
}

fn is_webview2_label(label: &str) -> bool {
    canonical_label(label) == "msedgewebview2"
}

fn normalize_key_part(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_lowercase())
    }
}

fn file_stem_key(path_or_name: &str) -> Option<String> {
    Path::new(path_or_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(normalize_key_part)
        .filter(|name| !is_pid_label(name) && !is_webview2_label(name))
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

pub(super) fn query_effective_process_identity(process_id: u32) -> ProcessIdentity {
    let identity = query_process_identity(process_id);
    if !process_identity_is_webview2(&identity) {
        return identity;
    }

    process_snapshot_entries()
        .and_then(|snapshot| {
            resolve_webview2_owner_identity(
                process_id,
                &identity,
                &snapshot,
                query_process_identity,
            )
        })
        .unwrap_or(identity)
}

pub(super) fn query_process_identity(process_id: u32) -> ProcessIdentity {
    if process_id == 0 {
        return ProcessIdentity::default();
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok();
    let Some(handle) = handle else {
        return ProcessIdentity::default();
    };
    if handle.is_invalid() {
        return ProcessIdentity::default();
    }

    let identity = ProcessIdentity {
        path: query_process_path_from_handle(handle),
        application_user_model_id: query_app_model_string(
            handle,
            AppModelString::ApplicationUserModelId,
        ),
        package_family_name: query_app_model_string(handle, AppModelString::PackageFamilyName),
        package_full_name: query_app_model_string(handle, AppModelString::PackageFullName),
    };

    let _ = unsafe { CloseHandle(handle) };
    identity
}

fn query_process_path_from_handle(handle: HANDLE) -> Option<String> {
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
    if result.is_err() {
        return None;
    }
    buffer.truncate(size as usize);
    Some(OsString::from_wide(&buffer).to_string_lossy().to_string())
}

enum AppModelString {
    ApplicationUserModelId,
    PackageFamilyName,
    PackageFullName,
}

fn query_app_model_string(handle: HANDLE, kind: AppModelString) -> Option<String> {
    let mut length = 0u32;
    let first = unsafe {
        match kind {
            AppModelString::ApplicationUserModelId => {
                GetApplicationUserModelId(handle, &mut length, None)
            }
            AppModelString::PackageFamilyName => GetPackageFamilyName(handle, &mut length, None),
            AppModelString::PackageFullName => GetPackageFullName(handle, &mut length, None),
        }
    };

    if first == APPMODEL_ERROR_NO_PACKAGE || length == 0 {
        return None;
    }
    if first != ERROR_INSUFFICIENT_BUFFER && first != ERROR_SUCCESS {
        return None;
    }

    let mut buffer = vec![0u16; length as usize];
    let second = unsafe {
        match kind {
            AppModelString::ApplicationUserModelId => {
                GetApplicationUserModelId(handle, &mut length, Some(PWSTR(buffer.as_mut_ptr())))
            }
            AppModelString::PackageFamilyName => {
                GetPackageFamilyName(handle, &mut length, Some(PWSTR(buffer.as_mut_ptr())))
            }
            AppModelString::PackageFullName => {
                GetPackageFullName(handle, &mut length, Some(PWSTR(buffer.as_mut_ptr())))
            }
        }
    };
    if second != ERROR_SUCCESS {
        return None;
    }

    string_from_wide_buffer(&buffer)
}

fn process_snapshot_entries() -> Option<Vec<ProcessSnapshotEntry>> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };

    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_err() {
        let _ = unsafe { CloseHandle(snapshot) };
        return None;
    }

    let mut entries = Vec::new();
    loop {
        entries.push(ProcessSnapshotEntry {
            process_id: entry.th32ProcessID,
            parent_process_id: entry.th32ParentProcessID,
            exe_name: string_from_wide_buffer(&entry.szExeFile).unwrap_or_default(),
        });

        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            break;
        }
    }

    let _ = unsafe { CloseHandle(snapshot) };
    Some(entries)
}

fn resolve_webview2_owner_identity(
    process_id: u32,
    identity: &ProcessIdentity,
    snapshot: &[ProcessSnapshotEntry],
    mut identity_for_process: impl FnMut(u32) -> ProcessIdentity,
) -> Option<ProcessIdentity> {
    if !process_identity_is_webview2(identity) {
        return None;
    }

    let by_id = snapshot
        .iter()
        .map(|entry| (entry.process_id, entry))
        .collect::<HashMap<_, _>>();
    let mut visited = HashSet::new();
    let mut current_id = process_id;

    for _ in 0..8 {
        if !visited.insert(current_id) {
            break;
        }

        let parent_id = by_id.get(&current_id)?.parent_process_id;
        if parent_id == 0 || visited.contains(&parent_id) {
            break;
        }

        let parent_identity = identity_for_process(parent_id);
        let parent_is_webview2 = by_id
            .get(&parent_id)
            .map(|entry| {
                is_webview2_label(&entry.exe_name) || process_identity_is_webview2(&parent_identity)
            })
            .unwrap_or_else(|| process_identity_is_webview2(&parent_identity));

        if parent_is_webview2 {
            current_id = parent_id;
            continue;
        }

        return parent_identity
            .has_package_identity()
            .then_some(parent_identity);
    }

    None
}

fn process_identity_is_webview2(identity: &ProcessIdentity) -> bool {
    identity
        .path
        .as_deref()
        .and_then(|path| Path::new(path).file_stem())
        .and_then(|stem| stem.to_str())
        .map(is_webview2_label)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr;
    use windows::Win32::System::Com::CoTaskMemAlloc;

    #[test]
    fn legacy_icon_alpha_uses_the_and_mask_when_color_alpha_is_empty() {
        let mut pixels = vec![10, 20, 30, 0, 40, 50, 60, 0];
        let mask = vec![0, 0, 0, 0, 255, 255, 255, 0];

        restore_legacy_icon_alpha(&mut pixels, Some(&mask));

        assert_eq!(pixels[3], 255);
        assert_eq!(pixels[7], 0);
    }

    #[test]
    fn modern_icon_alpha_is_preserved() {
        let mut pixels = vec![10, 20, 30, 128, 40, 50, 60, 0];
        let original = pixels.clone();

        restore_legacy_icon_alpha(&mut pixels, None);

        assert_eq!(pixels, original);
    }

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

    #[test]
    fn stable_application_key_prefers_aumid_then_package() {
        let identity = ProcessIdentity {
            application_user_model_id: Some(
                "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App".to_string(),
            ),
            package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm".to_string()),
            ..Default::default()
        };

        assert_eq!(
            stable_application_key(&identity, None, None, Some("WhatsApp")).as_deref(),
            Some("aumid:5319275a.whatsappdesktop_cv1g1gvanyjgm!app")
        );

        let identity = ProcessIdentity {
            package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm".to_string()),
            ..Default::default()
        };
        assert_eq!(
            stable_application_key(&identity, None, Some("PID 1234"), Some("WhatsApp")).as_deref(),
            Some("package:5319275a.whatsappdesktop_cv1g1gvanyjgm")
        );
    }

    #[test]
    fn stable_application_key_does_not_use_pid_fallback() {
        assert_eq!(
            stable_application_key(
                &ProcessIdentity::default(),
                None,
                Some("PID 1234"),
                Some("PID 1234")
            ),
            None
        );
    }

    #[test]
    fn stable_application_key_does_not_use_webview2_fallback() {
        assert_eq!(
            stable_application_key(
                &ProcessIdentity::default(),
                Some(
                    "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe"
                ),
                Some("msedgewebview2.exe"),
                Some("WhatsApp")
            )
            .as_deref(),
            Some("whatsapp")
        );
    }

    #[test]
    fn webview_owner_resolution_prefers_packaged_parent() {
        let raw_webview = ProcessIdentity {
            path: Some(
                "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe"
                    .to_string(),
            ),
            ..Default::default()
        };
        let whatsapp = ProcessIdentity {
            path: Some(
                "C:\\Program Files\\WindowsApps\\5319275A.WhatsAppDesktop_2.2620.102.0_x64__cv1g1gvanyjgm\\WhatsApp.Root.exe"
                    .to_string(),
            ),
            package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm".to_string()),
            package_full_name: Some(
                "5319275A.WhatsAppDesktop_2.2620.102.0_x64__cv1g1gvanyjgm".to_string(),
            ),
            ..Default::default()
        };
        let snapshot = vec![
            ProcessSnapshotEntry {
                process_id: 20164,
                parent_process_id: 14788,
                exe_name: "msedgewebview2.exe".to_string(),
            },
            ProcessSnapshotEntry {
                process_id: 14788,
                parent_process_id: 15928,
                exe_name: "msedgewebview2.exe".to_string(),
            },
            ProcessSnapshotEntry {
                process_id: 15928,
                parent_process_id: 7728,
                exe_name: "WhatsApp.Root.exe".to_string(),
            },
        ];

        let owner = resolve_webview2_owner_identity(20164, &raw_webview, &snapshot, |pid| {
            if pid == 15928 {
                whatsapp.clone()
            } else {
                raw_webview.clone()
            }
        });

        assert_eq!(owner, Some(whatsapp));
    }

    #[test]
    fn webview_owner_resolution_ignores_unpackaged_midimaster_parent() {
        let raw_webview = ProcessIdentity {
            path: Some(
                "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe"
                    .to_string(),
            ),
            ..Default::default()
        };
        let midimaster = ProcessIdentity {
            path: Some("C:\\Program Files\\MIDIMaster\\midimaster.exe".to_string()),
            ..Default::default()
        };
        let snapshot = vec![
            ProcessSnapshotEntry {
                process_id: 22584,
                parent_process_id: 11648,
                exe_name: "msedgewebview2.exe".to_string(),
            },
            ProcessSnapshotEntry {
                process_id: 11648,
                parent_process_id: 1000,
                exe_name: "midimaster.exe".to_string(),
            },
        ];

        let owner = resolve_webview2_owner_identity(22584, &raw_webview, &snapshot, |pid| {
            if pid == 11648 {
                midimaster.clone()
            } else {
                raw_webview.clone()
            }
        });

        assert_eq!(owner, None);
    }

    #[test]
    fn skip_pid_only_sessions_but_keep_packaged_sessions() {
        assert!(should_skip_session(
            1234,
            &None,
            &Some("PID 1234".to_string()),
            &None,
            "PID 1234",
            &None,
            &ProcessIdentity::default()
        ));

        let identity = ProcessIdentity {
            package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm".to_string()),
            ..Default::default()
        };
        let application_key = stable_application_key(&identity, None, None, None);
        assert!(!should_skip_session(
            0,
            &None,
            &None,
            &None,
            "WhatsAppDesktop",
            &application_key,
            &identity
        ));
    }

    #[test]
    fn keeps_system_sounds_session_with_stable_key() {
        let display_name = Some("System Sounds".to_string());
        let application_key = stable_application_key(
            &ProcessIdentity::default(),
            None,
            None,
            display_name.as_deref(),
        );

        assert_eq!(application_key.as_deref(), Some("system sounds"));
        assert!(!should_skip_session(
            0,
            &display_name,
            &None,
            &None,
            "System Sounds",
            &application_key,
            &ProcessIdentity::default()
        ));
    }

    #[test]
    fn keeps_webview2_sessions_with_real_display_name() {
        let display_name = Some("WhatsApp".to_string());
        let process_name = Some("msedgewebview2.exe".to_string());
        let process_path = Some(
            "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe"
                .to_string(),
        );
        let application_key = stable_application_key(
            &ProcessIdentity::default(),
            process_path.as_deref(),
            process_name.as_deref(),
            display_name.as_deref(),
        );

        assert_eq!(application_key.as_deref(), Some("whatsapp"));
        assert!(!should_skip_session(
            14788,
            &display_name,
            &process_name,
            &process_path,
            "WhatsApp",
            &application_key,
            &ProcessIdentity::default()
        ));
    }

    #[test]
    fn skips_nameless_webview2_sessions_without_package_owner() {
        let process_name = Some("msedgewebview2.exe".to_string());
        let process_path = Some(
            "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe"
                .to_string(),
        );
        let application_key = stable_application_key(
            &ProcessIdentity::default(),
            process_path.as_deref(),
            process_name.as_deref(),
            None,
        );

        assert_eq!(application_key, None);
        assert!(should_skip_session(
            22584,
            &None,
            &process_name,
            &process_path,
            "Msedgewebview2",
            &application_key,
            &ProcessIdentity::default()
        ));
    }

    #[test]
    fn unresolved_resource_display_names_are_preserved() {
        let raw = "@{Missing.Package/Resources/AppTitle}";

        assert_eq!(session_display_name(Some(raw)).as_deref(), Some(raw));
    }

    #[test]
    fn package_icon_scoring_prefers_app_list_logos() {
        let app_logo =
            Path::new("C:\\Apps\\WhatsApp\\Assets\\AppList.targetsize-48_altform-unplated.png");
        let splash = Path::new("C:\\Apps\\WhatsApp\\Assets\\SplashScreen.scale-200.png");
        let badge = Path::new("C:\\Apps\\WhatsApp\\Assets\\BadgeLogo.scale-200.png");

        assert!(package_icon_score(app_logo) > package_icon_score(splash));
        assert!(package_icon_score(app_logo) > package_icon_score(badge));
    }

    #[test]
    fn manifest_icon_paths_prefer_app_list_logo() {
        let manifest = r#"
            <Package>
                <Properties>
                    <Logo>Assets\StoreLogo.png</Logo>
                </Properties>
                <Applications>
                    <Application Id="App">
                        <uap:VisualElements
                            Square150x150Logo="Assets\MedTile.png"
                            Square44x44Logo="Assets\AppList.png" />
                    </Application>
                </Applications>
            </Package>
        "#;

        assert_eq!(
            manifest_icon_base_paths_from_contents(manifest),
            vec!["assets/applist", "assets/storelogo", "assets/medtile"]
        );
    }

    #[test]
    fn package_manifest_display_name_prefers_app_name() {
        let manifest = r#"
            <Package>
                <Properties>
                    <DisplayName>WhatsApp</DisplayName>
                </Properties>
                <Applications>
                    <Application Id="App">
                        <uap:VisualElements DisplayName="WhatsAppDesktop" />
                    </Application>
                </Applications>
            </Package>
        "#;

        assert_eq!(
            package_display_name_from_manifest_contents(manifest).as_deref(),
            Some("WhatsApp")
        );
    }

    #[test]
    fn manifest_logo_matching_accepts_targetsize_variants() {
        let package_path = Path::new("C:\\Program Files\\WindowsApps\\WhatsApp");
        let app_list_icon = package_path.join("Assets\\AppList.targetsize-48_altform-unplated.png");
        let store_icon = package_path.join("Assets\\StoreLogo.scale-200.png");

        assert!(package_icon_matches_manifest_logo(
            &app_list_icon,
            package_path,
            "assets/applist"
        ));
        assert!(!package_icon_matches_manifest_logo(
            &store_icon,
            package_path,
            "assets/applist"
        ));
    }
}

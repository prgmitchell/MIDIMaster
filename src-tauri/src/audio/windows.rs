use crate::audio::AudioBackend;
use crate::model::{PlaybackDeviceInfo, SessionInfo};
use anyhow::{anyhow, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::Path;
use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, PROPERTYKEY, RPC_E_CHANGED_MODE};
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eCapture, eMultimedia, eRender, EDataFlow, IAudioSessionControl2, IAudioSessionManager2,
    IMMDevice, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::StructuredStorage::{
    PropVariantClear, PropVariantToStringAlloc, PROPVARIANT,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::ExtractIconExW;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetForegroundWindow, GetIconInfo, GetWindowThreadProcessId, HICON, ICONINFO,
};

const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

const PKEY_DEVICE_CLASS_ICON_PATH: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_u128(0x259abffc_50a7_47ce_af08_68c9a7d73366),
    pid: 12,
};

pub struct WindowsAudioBackend;

impl WindowsAudioBackend {
    pub fn new() -> Self {
        Self
    }
}

impl AudioBackend for WindowsAudioBackend {
    fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let default_device = get_default_device_from(&enumerator)?;
        let default_device_id = device_id_string(&default_device);
        let endpoint = get_endpoint_volume(&default_device)?;
        let master_volume = unsafe { endpoint.GetMasterVolumeLevelScalar() }?;
        let master_muted = unsafe { endpoint.GetMute() }?.as_bool();

        let mut sessions = vec![SessionInfo {
            id: "master".to_string(),
            display_name: "Master".to_string(),
            process_name: None,
            process_path: None,
            icon_data: None,
            volume: master_volume,
            is_muted: master_muted,
            is_master: true,
        }];

        let mut seen_ids = HashSet::new();
        let mut icon_cache = HashMap::new();
        for (device, device_id) in enumerate_active_devices(&enumerator, eRender)? {
            let default_id = default_device_id.as_deref();
            let _ = collect_device_sessions(
                &device,
                &device_id,
                default_id,
                &mut sessions,
                &mut seen_ids,
                &mut icon_cache,
            );
        }

        Ok(sessions)
    }

    fn list_playback_devices(&self) -> Result<Vec<PlaybackDeviceInfo>> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let default_device = get_default_device_from_flow(&enumerator, eRender)?;
        let default_id = device_id_string(&default_device);
        list_devices_for_flow(&enumerator, eRender, default_id)
    }

    fn list_recording_devices(&self) -> Result<Vec<PlaybackDeviceInfo>> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let default_device = get_default_device_from_flow(&enumerator, eCapture)?;
        let default_id = device_id_string(&default_device);
        list_devices_for_flow(&enumerator, eCapture, default_id)
    }

    fn set_master_volume(&self, volume: f32) -> Result<()> {
        let _com = init_com()?;
        let device = get_default_device()?;
        let endpoint = get_endpoint_volume(&device)?;
        let clamped = volume.clamp(0.0, 1.0);
        unsafe { endpoint.SetMasterVolumeLevelScalar(clamped, std::ptr::null()) }?;
        Ok(())
    }

    fn set_session_volume(&self, session_id: &str, volume: f32) -> Result<()> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let target_volume = volume.clamp(0.0, 1.0);
        let (device_hint, target_id) = split_session_id(session_id);
        let devices = enumerate_active_devices(&enumerator, eRender)?;

        if let Some(device_id) = device_hint {
            if let Some((device, _)) = devices.iter().find(|(_, id)| id == device_id) {
                if set_session_volume_on_device(device, target_id, target_volume)? {
                    return Ok(());
                }
            }
            return Err(anyhow!("Session not found"));
        }

        let default_device = get_default_device_from(&enumerator)?;
        if set_session_volume_on_device(&default_device, target_id, target_volume)? {
            return Ok(());
        }

        for (device, _device_id) in devices {
            if set_session_volume_on_device(&device, target_id, target_volume)? {
                return Ok(());
            }
        }

        Err(anyhow!("Session not found"))
    }

    fn set_device_volume(&self, device_id: &str, volume: f32) -> Result<()> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let target_volume = volume.clamp(0.0, 1.0);
        let (flow, raw_id) = parse_device_target(device_id);

        for (device, id) in enumerate_active_devices(&enumerator, flow)? {
            if id == raw_id {
                let endpoint = get_endpoint_volume(&device)?;
                unsafe { endpoint.SetMasterVolumeLevelScalar(target_volume, std::ptr::null()) }?;
                return Ok(());
            }
        }

        Err(anyhow!("Device not found"))
    }

    fn set_focused_session_volume(&self, volume: f32) -> Result<()> {
        let _com = init_com()?;
        let process_id =
            foreground_process_id().ok_or_else(|| anyhow!("No focused application"))?;
        let process_path = query_process_path(process_id);
        let enumerator = get_device_enumerator()?;
        let target_volume = volume.clamp(0.0, 1.0);
        let mut updated = false;

        for (device, _id) in enumerate_active_devices(&enumerator, eRender)? {
            if set_session_volume_for_process(
                &device,
                process_id,
                process_path.as_deref(),
                target_volume,
            )? {
                updated = true;
            }
        }

        if updated {
            Ok(())
        } else {
            Err(anyhow!("Focused session not found"))
        }
    }

    fn set_application_volume(&self, name: &str, volume: f32) -> Result<()> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let target_volume = volume.clamp(0.0, 1.0);
        let mut updated = false;

        for (device, _id) in enumerate_active_devices(&enumerator, eRender)? {
            if set_session_volume_by_name(&device, name, target_volume)? {
                updated = true;
            }
        }

        if updated {
            Ok(())
        } else {
            Err(anyhow!("Application not found"))
        }
    }

    fn focused_session(&self) -> Result<Option<SessionInfo>> {
        let _com = init_com()?;
        let process_id = match foreground_process_id() {
            Some(process_id) => process_id,
            None => return Ok(None),
        };
        let process_path = query_process_path(process_id);
        let enumerator = get_device_enumerator()?;
        let default_device = get_default_device_from(&enumerator)?;
        let default_device_id = device_id_string(&default_device);
        let mut icon_cache = HashMap::new();

        for (device, device_id) in enumerate_active_devices(&enumerator, eRender)? {
            if let Some(session) = session_info_for_process(
                &device,
                &device_id,
                default_device_id.as_deref(),
                process_id,
                process_path.as_deref(),
                &mut icon_cache,
            )? {
                return Ok(Some(session));
            }
        }

        Ok(None)
    }

    fn set_master_mute(&self, muted: bool) -> Result<()> {
        let _com = init_com()?;
        let device = get_default_device()?;
        let endpoint = get_endpoint_volume(&device)?;
        unsafe { endpoint.SetMute(muted, std::ptr::null()) }?;
        Ok(())
    }

    fn set_focused_session_mute(&self, muted: bool) -> Result<()> {
        let _com = init_com()?;
        let process_id =
            foreground_process_id().ok_or_else(|| anyhow!("No focused application"))?;
        let process_path = query_process_path(process_id);
        let enumerator = get_device_enumerator()?;
        let mut updated = false;

        for (device, _id) in enumerate_active_devices(&enumerator, eRender)? {
            if set_session_mute_for_process(&device, process_id, process_path.as_deref(), muted)? {
                updated = true;
            }
        }

        if updated {
            Ok(())
        } else {
            Err(anyhow!("Focused session not found"))
        }
    }

    fn set_application_mute(&self, name: &str, muted: bool) -> Result<()> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let mut updated = false;

        for (device, _id) in enumerate_active_devices(&enumerator, eRender)? {
            if set_session_mute_by_name(&device, name, muted)? {
                updated = true;
            }
        }

        if updated {
            Ok(())
        } else {
            Err(anyhow!("Application not found"))
        }
    }

    fn set_device_mute(&self, device_id: &str, muted: bool) -> Result<()> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let (flow, raw_id) = parse_device_target(device_id);

        for (device, id) in enumerate_active_devices(&enumerator, flow)? {
            if id == raw_id {
                let endpoint = get_endpoint_volume(&device)?;
                unsafe { endpoint.SetMute(muted, std::ptr::null()) }?;
                return Ok(());
            }
        }

        Err(anyhow!("Device not found"))
    }

    fn set_session_mute(&self, session_id: &str, muted: bool) -> Result<()> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let (device_hint, target_id) = split_session_id(session_id);
        let devices = enumerate_active_devices(&enumerator, eRender)?;

        if let Some(device_id) = device_hint {
            if let Some((device, _)) = devices.iter().find(|(_, id)| id == device_id) {
                if set_session_mute_on_device(device, target_id, muted)? {
                    return Ok(());
                }
            }
            return Err(anyhow!("Session not found"));
        }

        let default_device = get_default_device_from(&enumerator)?;
        if set_session_mute_on_device(&default_device, target_id, muted)? {
            return Ok(());
        }

        for (device, _device_id) in devices {
            if set_session_mute_on_device(&device, target_id, muted)? {
                return Ok(());
            }
        }

        Err(anyhow!("Session not found"))
    }
}

fn enumerate_active_devices(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
) -> Result<Vec<(IMMDevice, String)>> {
    let collection = unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) }?;
    let count = unsafe { collection.GetCount() }?;
    let mut devices = Vec::new();
    for index in 0..count {
        let device = unsafe { collection.Item(index) }?;
        if let Some(id) = device_id_string(&device) {
            devices.push((device, id));
        }
    }
    Ok(devices)
}

fn list_devices_for_flow(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
    default_id: Option<String>,
) -> Result<Vec<PlaybackDeviceInfo>> {
    let mut icon_cache = HashMap::new();
    let mut devices = Vec::new();

    for (device, device_id) in enumerate_active_devices(enumerator, flow)? {
        let friendly_name = get_device_property_string(&device, &PKEY_DEVICE_FRIENDLY_NAME)
            .unwrap_or_else(|| device_id.clone());
        let icon_path = get_device_property_string(&device, &PKEY_DEVICE_CLASS_ICON_PATH);
        let icon_data = icon_path
            .as_deref()
            .and_then(|path| icon_data_for_icon_path(path, &mut icon_cache));
        let endpoint = get_endpoint_volume(&device)?;
        let volume = unsafe { endpoint.GetMasterVolumeLevelScalar() }?;
        let is_muted = unsafe { endpoint.GetMute() }?.as_bool();
        let is_default = default_id
            .as_ref()
            .map(|id| id == &device_id)
            .unwrap_or(false);

        devices.push(PlaybackDeviceInfo {
            id: device_id,
            display_name: friendly_name,
            icon_data,
            volume,
            is_muted,
            is_default,
        });
    }

    Ok(devices)
}

fn parse_device_target(device_id: &str) -> (EDataFlow, &str) {
    if let Some(raw) = device_id.strip_prefix("recording:") {
        return (eCapture, raw);
    }
    if let Some(raw) = device_id.strip_prefix("playback:") {
        return (eRender, raw);
    }
    (eRender, device_id)
}

fn collect_device_sessions(
    device: &IMMDevice,
    device_id: &str,
    default_device_id: Option<&str>,
    sessions: &mut Vec<SessionInfo>,
    seen_ids: &mut HashSet<String>,
    icon_cache: &mut HashMap<String, Option<String>>,
) -> Result<()> {
    let session_manager = get_session_manager(device)?;
    let enumerator = unsafe { session_manager.GetSessionEnumerator() }?;
    let count = unsafe { enumerator.GetCount() }?;

    for index in 0..count {
        let control = unsafe { enumerator.GetSession(index) }?;
        let control2: IAudioSessionControl2 = control.cast()?;
        let simple: ISimpleAudioVolume = control.cast()?;

        let process_id = unsafe { control2.GetProcessId() }?;
        let base_id = session_identifier(&control2, process_id)
            .unwrap_or_else(|| format!("pid:{}", process_id));
        let session_id = if default_device_id == Some(device_id) {
            base_id
        } else {
            format!("{}|{}", device_id, base_id)
        };

        if !seen_ids.insert(session_id.clone()) {
            continue;
        }

        let display_name = unsafe { control2.GetDisplayName() }
            .ok()
            .and_then(pwstr_to_string)
            .map(|name| name.trim().to_string())
            .filter(|name: &String| !name.is_empty())
            .filter(|name: &String| !is_resource_display_name(name));
        let process_path = query_process_path(process_id);
        let process_name = process_path
            .as_ref()
            .and_then(|path| Path::new(path).file_name())
            .and_then(|name| name.to_str())
            .map(|name| name.to_string())
            .or_else(|| Some(format!("PID {}", process_id)));
        let friendly_name = display_name
            .clone()
            .or_else(|| {
                process_path
                    .as_ref()
                    .and_then(|path| friendly_process_label(path))
            })
            .or_else(|| process_name.as_ref().map(|name| humanize_label(name)))
            .unwrap_or_else(|| "Unknown".to_string());
        if should_skip_session(
            process_id,
            &display_name,
            &process_name,
            &process_path,
            &friendly_name,
        ) {
            continue;
        }
        let icon_data = process_path
            .as_ref()
            .and_then(|path| icon_data_for_path(path, icon_cache));
        let volume = unsafe { simple.GetMasterVolume() }?;
        let is_muted = unsafe { simple.GetMute() }?.as_bool();

        sessions.push(SessionInfo {
            id: session_id,
            display_name: friendly_name,
            process_name,
            process_path,
            icon_data,
            volume,
            is_muted,
            is_master: false,
        });
    }

    Ok(())
}

fn session_info_for_process(
    device: &IMMDevice,
    device_id: &str,
    default_device_id: Option<&str>,
    process_id: u32,
    process_path: Option<&str>,
    icon_cache: &mut HashMap<String, Option<String>>,
) -> Result<Option<SessionInfo>> {
    let session_manager = get_session_manager(device)?;
    let enumerator = unsafe { session_manager.GetSessionEnumerator() }?;
    let count = unsafe { enumerator.GetCount() }?;

    for index in 0..count {
        let control = unsafe { enumerator.GetSession(index) }?;
        let control2: IAudioSessionControl2 = control.cast()?;
        let simple: ISimpleAudioVolume = control.cast()?;

        let session_process_id = unsafe { control2.GetProcessId() }?;
        let mut matches = session_process_id == process_id;

        // Fallback: Check process path if PID mismatch
        if !matches && process_path.is_some() && session_process_id != 0 {
            if let Some(session_path) = query_process_path(session_process_id) {
                if let Some(target_path) = process_path {
                    if session_path == target_path {
                        matches = true;
                    }
                }
            }
        }

        if !matches {
            continue;
        }

        let base_id = session_identifier(&control2, session_process_id)
            .unwrap_or_else(|| format!("pid:{}", session_process_id));
        let session_id = if default_device_id == Some(device_id) {
            base_id
        } else {
            format!("{}|{}", device_id, base_id)
        };

        let display_name = unsafe { control2.GetDisplayName() }
            .ok()
            .and_then(pwstr_to_string)
            .map(|name| name.trim().to_string())
            .filter(|name: &String| !name.is_empty())
            .filter(|name: &String| !is_resource_display_name(name));
        let process_path = query_process_path(session_process_id);
        let process_name = process_path
            .as_ref()
            .and_then(|path| Path::new(path).file_name())
            .and_then(|name| name.to_str())
            .map(|name| name.to_string())
            .or_else(|| Some(format!("PID {}", session_process_id)));
        let friendly_name = display_name
            .clone()
            .or_else(|| {
                process_path
                    .as_ref()
                    .and_then(|path| friendly_process_label(path))
            })
            .or_else(|| process_name.as_ref().map(|name| humanize_label(name)))
            .unwrap_or_else(|| "Unknown".to_string());
        if should_skip_session(
            session_process_id,
            &display_name,
            &process_name,
            &process_path,
            &friendly_name,
        ) {
            continue;
        }
        let icon_data = process_path
            .as_ref()
            .and_then(|path| icon_data_for_path(path, icon_cache));
        let volume = unsafe { simple.GetMasterVolume() }?;
        let is_muted = unsafe { simple.GetMute() }?.as_bool();

        return Ok(Some(SessionInfo {
            id: session_id,
            display_name: friendly_name,
            process_name,
            process_path,
            icon_data,
            volume,
            is_muted,
            is_master: false,
        }));
    }

    Ok(None)
}

fn icon_data_for_path(
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

fn icon_data_for_icon_path(
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

fn parse_icon_location(value: &str) -> Option<(String, i32)> {
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

fn expand_known_env_vars(value: &str) -> String {
    let mut result = value.to_string();
    if let Ok(system_root) = std::env::var("SystemRoot") {
        result = replace_case_insensitive(&result, "%SystemRoot%", &system_root);
    }
    if let Ok(windir) = std::env::var("WINDIR") {
        result = replace_case_insensitive(&result, "%WINDIR%", &windir);
    }
    result
}

fn replace_case_insensitive(value: &str, pattern: &str, replacement: &str) -> String {
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

fn extract_icon_data(path: &str, index: i32) -> Option<String> {
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

fn icon_to_png_base64(icon: HICON) -> Option<String> {
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

    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0 as u32,
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

fn to_wide_string(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn split_session_id(session_id: &str) -> (Option<&str>, &str) {
    if let Some((device_id, inner)) = session_id.split_once('|') {
        (Some(device_id), inner)
    } else {
        (None, session_id)
    }
}

fn set_session_volume_on_device(
    device: &IMMDevice,
    session_id: &str,
    target_volume: f32,
) -> Result<bool> {
    let session_manager = get_session_manager(device)?;
    let enumerator = unsafe { session_manager.GetSessionEnumerator() }?;
    let count = unsafe { enumerator.GetCount() }?;

    for index in 0..count {
        let control = unsafe { enumerator.GetSession(index) }?;
        let control2: IAudioSessionControl2 = control.cast()?;
        let process_id = unsafe { control2.GetProcessId() }?;
        let id = session_identifier(&control2, process_id)
            .unwrap_or_else(|| format!("pid:{}", process_id));
        if id == session_id {
            let simple: ISimpleAudioVolume = control.cast()?;
            unsafe { simple.SetMasterVolume(target_volume, std::ptr::null()) }?;
            return Ok(true);
        }
    }

    Ok(false)
}

fn set_session_volume_for_process(
    device: &IMMDevice,
    process_id: u32,
    process_path: Option<&str>,
    volume: f32,
) -> Result<bool> {
    let session_manager = get_session_manager(device)?;
    let enumerator = unsafe { session_manager.GetSessionEnumerator() }?;
    let count = unsafe { enumerator.GetCount() }?;
    let mut updated = false;

    for index in 0..count {
        let control = unsafe { enumerator.GetSession(index) }?;
        let control2: IAudioSessionControl2 = control.cast()?;
        let simple: ISimpleAudioVolume = control.cast()?;

        let session_process_id = unsafe { control2.GetProcessId() }?;
        let mut matches = session_process_id == process_id;

        if !matches && process_path.is_some() && session_process_id != 0 {
            if let Some(session_path) = query_process_path(session_process_id) {
                if let Some(target_path) = process_path {
                    if session_path == target_path {
                        matches = true;
                    }
                }
            }
        }

        if matches {
            unsafe { simple.SetMasterVolume(volume, std::ptr::null()) }?;
            updated = true;
        }
    }

    Ok(updated)
}

fn set_session_mute_for_process(
    device: &IMMDevice,
    process_id: u32,
    process_path: Option<&str>,
    muted: bool,
) -> Result<bool> {
    let session_manager = get_session_manager(device)?;
    let enumerator = unsafe { session_manager.GetSessionEnumerator() }?;
    let count = unsafe { enumerator.GetCount() }?;
    let mut updated = false;

    for index in 0..count {
        let control = unsafe { enumerator.GetSession(index) }?;
        let control2: IAudioSessionControl2 = control.cast()?;
        let simple: ISimpleAudioVolume = control.cast()?;

        let session_process_id = unsafe { control2.GetProcessId() }?;
        let mut matches = session_process_id == process_id;

        if !matches && process_path.is_some() && session_process_id != 0 {
            if let Some(session_path) = query_process_path(session_process_id) {
                if let Some(target_path) = process_path {
                    if session_path == target_path {
                        matches = true;
                    }
                }
            }
        }

        if matches {
            unsafe { simple.SetMute(muted, std::ptr::null()) }?;
            updated = true;
        }
    }

    Ok(updated)
}

fn set_session_volume_by_name(device: &IMMDevice, name: &str, volume: f32) -> Result<bool> {
    let session_manager = get_session_manager(device)?;
    let enumerator = unsafe { session_manager.GetSessionEnumerator() }?;
    let count = unsafe { enumerator.GetCount() }?;
    let mut updated = false;

    let target_name = name.to_lowercase();

    for index in 0..count {
        let control = unsafe { enumerator.GetSession(index) }?;
        let control2: IAudioSessionControl2 = control.cast()?;
        let simple: ISimpleAudioVolume = control.cast()?;

        let process_id = unsafe { control2.GetProcessId() }?;
        let process_path = query_process_path(process_id);
        let process_name = process_path
            .as_ref()
            .and_then(|path| Path::new(path).file_name())
            .and_then(|name| name.to_str())
            .map(|name| name.to_string());

        let display_name = unsafe { control2.GetDisplayName() }
            .ok()
            .and_then(pwstr_to_string)
            .map(|n| n.trim().to_lowercase());

        let mut matches = false;

        if let Some(path) = &process_path {
            if let Some(stem) = Path::new(&path).file_stem().and_then(|s| s.to_str()) {
                if stem.to_lowercase() == target_name {
                    matches = true;
                }
            }
        }

        if !matches {
            if let Some(name) = &process_name {
                let stem = name.strip_suffix(".exe").unwrap_or(&name);
                if stem.to_lowercase() == target_name {
                    matches = true;
                }
            }
        }

        if !matches {
            if let Some(name) = display_name {
                if name == target_name {
                    matches = true;
                }
            }
        }

        if !matches {
            if let Some(path) = &process_path {
                if let Some(friendly) = friendly_process_label(path) {
                    if friendly.to_lowercase() == target_name {
                        matches = true;
                    }
                }
            }
        }

        if !matches {
            if let Some(name) = &process_name {
                let humanized = humanize_label(name);
                if humanized.to_lowercase() == target_name {
                    matches = true;
                }
            }
        }

        if matches {
            unsafe { simple.SetMasterVolume(volume, std::ptr::null()) }?;
            updated = true;
        }
    }

    Ok(updated)
}

fn set_session_mute_on_device(device: &IMMDevice, session_id: &str, muted: bool) -> Result<bool> {
    let session_manager = get_session_manager(device)?;
    let enumerator = unsafe { session_manager.GetSessionEnumerator() }?;
    let count = unsafe { enumerator.GetCount() }?;

    for index in 0..count {
        let control = unsafe { enumerator.GetSession(index) }?;
        let control2: IAudioSessionControl2 = control.cast()?;
        let process_id = unsafe { control2.GetProcessId() }?;
        let id = session_identifier(&control2, process_id)
            .unwrap_or_else(|| format!("pid:{}", process_id));
        if id == session_id {
            let simple: ISimpleAudioVolume = control.cast()?;
            unsafe { simple.SetMute(muted, std::ptr::null()) }?;
            return Ok(true);
        }
    }

    Ok(false)
}

fn set_session_mute_by_name(device: &IMMDevice, name: &str, muted: bool) -> Result<bool> {
    let session_manager = get_session_manager(device)?;
    let enumerator = unsafe { session_manager.GetSessionEnumerator() }?;
    let count = unsafe { enumerator.GetCount() }?;
    let mut updated = false;

    let target_name = name.to_lowercase();

    for index in 0..count {
        let control = unsafe { enumerator.GetSession(index) }?;
        let control2: IAudioSessionControl2 = control.cast()?;
        let simple: ISimpleAudioVolume = control.cast()?;

        let process_id = unsafe { control2.GetProcessId() }?;
        let process_path = query_process_path(process_id);
        let process_name = process_path
            .as_ref()
            .and_then(|path| Path::new(path).file_name())
            .and_then(|name| name.to_str())
            .map(|name| name.to_string());

        let display_name = unsafe { control2.GetDisplayName() }
            .ok()
            .and_then(pwstr_to_string)
            .map(|n| n.trim().to_lowercase());

        let mut matches = false;

        if let Some(path) = &process_path {
            if let Some(stem) = Path::new(&path).file_stem().and_then(|s| s.to_str()) {
                if stem.to_lowercase() == target_name {
                    matches = true;
                }
            }
        }

        if !matches {
            if let Some(name) = &process_name {
                let stem = name.strip_suffix(".exe").unwrap_or(&name);
                if stem.to_lowercase() == target_name {
                    matches = true;
                }
            }
        }

        if !matches {
            if let Some(name) = display_name {
                if name == target_name {
                    matches = true;
                }
            }
        }

        if matches {
            unsafe { simple.SetMute(muted, std::ptr::null()) }?;
            updated = true;
        }
    }

    Ok(updated)
}

fn foreground_process_id() -> Option<u32> {
    let window = unsafe { GetForegroundWindow() };
    if window.0.is_null() {
        return None;
    }
    let mut process_id = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
    if process_id == 0 {
        None
    } else {
        Some(process_id)
    }
}

struct ComGuard;

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn init_com() -> Result<Option<ComGuard>> {
    match unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() } {
        Ok(_) => Ok(Some(ComGuard)),
        Err(err) if err.code() == RPC_E_CHANGED_MODE => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn get_device_enumerator() -> Result<IMMDeviceEnumerator> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }?;
    Ok(enumerator)
}

fn get_default_device_from_flow(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
) -> Result<IMMDevice> {
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(flow, eMultimedia) }?;
    Ok(device)
}

fn get_default_device_from(enumerator: &IMMDeviceEnumerator) -> Result<IMMDevice> {
    get_default_device_from_flow(enumerator, eRender)
}

fn get_default_device() -> Result<IMMDevice> {
    let enumerator = get_device_enumerator()?;
    get_default_device_from(&enumerator)
}

fn get_endpoint_volume(
    device: &windows::Win32::Media::Audio::IMMDevice,
) -> Result<IAudioEndpointVolume> {
    let endpoint: IAudioEndpointVolume = unsafe { device.Activate(CLSCTX_ALL, None) }?;
    Ok(endpoint)
}

fn get_session_manager(
    device: &windows::Win32::Media::Audio::IMMDevice,
) -> Result<IAudioSessionManager2> {
    let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None) }?;
    Ok(manager)
}

fn device_id_string(device: &IMMDevice) -> Option<String> {
    let id = unsafe { device.GetId() }.ok()?;
    pwstr_to_string(id)
}

fn get_device_property_string(device: &IMMDevice, key: &PROPERTYKEY) -> Option<String> {
    let store: IPropertyStore = unsafe { device.OpenPropertyStore(STGM_READ).ok()? };
    let value: PROPVARIANT = unsafe { store.GetValue(key as *const _).ok()? };
    let allocated = unsafe { PropVariantToStringAlloc(&value).ok()? };
    let _ = unsafe { PropVariantClear(&value as *const _ as *mut _) };
    if allocated.0.is_null() {
        return None;
    }
    let output = pwstr_to_string(allocated);
    unsafe {
        CoTaskMemFree(Some(allocated.0 as _));
    }
    output
}

fn pwstr_to_string(ptr: PWSTR) -> Option<String> {
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

fn session_identifier(control2: &IAudioSessionControl2, process_id: u32) -> Option<String> {
    let identifier = unsafe { control2.GetSessionIdentifier() }.ok()?;
    let identifier = pwstr_to_string(identifier)?;
    if identifier.trim().is_empty() {
        None
    } else {
        Some(format!("{}:{}", process_id, identifier))
    }
}

fn is_resource_display_name(name: &str) -> bool {
    name.trim().starts_with('@')
}

fn should_skip_session(
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

fn canonical_label(label: &str) -> String {
    let trimmed = label.trim().to_lowercase();
    let trimmed = trimmed.strip_suffix(".exe").unwrap_or(&trimmed);
    let trimmed = trimmed.strip_suffix(".dll").unwrap_or(trimmed);
    trimmed.to_string()
}

fn friendly_process_label(path: &str) -> Option<String> {
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

fn humanize_label(label: &str) -> String {
    let cleaned = label.replace(['_', '-'], " ");
    cleaned
        .split_whitespace()
        .map(humanize_word)
        .collect::<Vec<_>>()
        .join(" ")
}

fn humanize_word(word: &str) -> String {
    if word.chars().any(|ch| ch.is_uppercase()) {
        return word.to_string();
    }
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str().to_lowercase()),
        None => String::new(),
    }
}

fn query_process_path(process_id: u32) -> Option<String> {
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

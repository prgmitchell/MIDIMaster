use crate::audio::target_match::{application_name_matches, ApplicationMatchInfo};
use crate::audio::AudioBackend;
use crate::device_target::{parse_device_target, DeviceTargetKind};
use crate::model::{PlaybackDeviceInfo, SessionInfo};
use anyhow::{anyhow, Result};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows::core::{IUnknown_Vtbl, Interface, GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::{PROPERTYKEY, RPC_E_CHANGED_MODE};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eCapture, eCommunications, eConsole, eMultimedia, eRender, EDataFlow, ERole,
    IAudioSessionControl2, IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator,
    ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE, WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::{
    PropVariantClear, PropVariantToStringAlloc, PROPVARIANT,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

#[path = "windows/process_helpers.rs"]
mod process_helpers;
pub use process_helpers::extract_executable_icon_base64;
use process_helpers::*;

const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

const PKEY_DEVICE_CLASS_ICON_PATH: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_u128(0x259abffc_50a7_47ce_af08_68c9a7d73366),
    pid: 12,
};

const PROCESS_IDENTITY_CACHE_TTL: Duration = Duration::from_secs(30);
const PROCESS_IDENTITY_CACHE_MAX: usize = 512;

#[derive(Clone)]
struct CachedProcessIdentity {
    identity: ProcessIdentity,
    updated_at: Instant,
}

fn shared_icon_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn shared_process_identity_cache() -> &'static Mutex<HashMap<u32, CachedProcessIdentity>> {
    static CACHE: OnceLock<Mutex<HashMap<u32, CachedProcessIdentity>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn shared_package_display_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_shared_icon_cache<T>(f: impl FnOnce(&mut HashMap<String, Option<String>>) -> T) -> T {
    if let Ok(mut cache) = shared_icon_cache().lock() {
        f(&mut cache)
    } else {
        let mut cache = HashMap::new();
        f(&mut cache)
    }
}

fn query_effective_process_identity_cached(process_id: u32) -> ProcessIdentity {
    let now = Instant::now();
    if let Ok(cache) = shared_process_identity_cache().lock() {
        if let Some(cached) = cache.get(&process_id) {
            if now.duration_since(cached.updated_at) < PROCESS_IDENTITY_CACHE_TTL {
                return cached.identity.clone();
            }
        }
    }

    let identity = query_effective_process_identity(process_id);
    if let Ok(mut cache) = shared_process_identity_cache().lock() {
        if cache.len() >= PROCESS_IDENTITY_CACHE_MAX {
            cache.retain(|_, cached| {
                now.duration_since(cached.updated_at) < PROCESS_IDENTITY_CACHE_TTL
            });
            if cache.len() >= PROCESS_IDENTITY_CACHE_MAX {
                cache.clear();
            }
        }
        cache.insert(
            process_id,
            CachedProcessIdentity {
                identity: identity.clone(),
                updated_at: now,
            },
        );
    }
    identity
}

fn package_display_name_cached(identity: &ProcessIdentity) -> Option<String> {
    let package_full_name = identity.package_full_name.as_deref()?;
    let key = package_full_name.to_ascii_lowercase();
    if let Ok(cache) = shared_package_display_cache().lock() {
        if let Some(cached) = cache.get(&key) {
            return cached.clone();
        }
    }

    let display_name = package_display_name(identity);
    if let Ok(mut cache) = shared_package_display_cache().lock() {
        cache.insert(key, display_name.clone());
    }
    display_name
}

pub struct WindowsAudioBackend;

impl WindowsAudioBackend {
    pub fn new() -> Self {
        Self
    }
}

fn list_sessions_with_visuals(include_visuals: bool) -> Result<Vec<SessionInfo>> {
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
        application_key: None,
        process_name: None,
        process_path: None,
        icon_data: None,
        volume: master_volume,
        is_muted: master_muted,
        is_master: true,
    }];

    let mut seen_ids = HashSet::new();
    with_shared_icon_cache(|icon_cache| {
        for (device, device_id) in enumerate_active_devices(&enumerator, eRender)? {
            let default_id = default_device_id.as_deref();
            let _ = collect_device_sessions(
                &device,
                &device_id,
                default_id,
                &mut sessions,
                &mut seen_ids,
                icon_cache,
                include_visuals,
            );
        }
        Ok::<(), anyhow::Error>(())
    })?;

    Ok(sessions)
}

fn focused_session_with_visuals(include_visuals: bool) -> Result<Option<SessionInfo>> {
    let _com = init_com()?;
    let process_id = match foreground_process_id() {
        Some(process_id) => process_id,
        None => return Ok(None),
    };
    let process_identity = query_effective_process_identity_cached(process_id);
    let enumerator = get_device_enumerator()?;
    let default_device = get_default_device_from(&enumerator)?;
    let default_device_id = device_id_string(&default_device);
    with_shared_icon_cache(|icon_cache| {
        for (device, device_id) in enumerate_active_devices(&enumerator, eRender)? {
            if let Some(session) = session_info_for_process(
                &device,
                &device_id,
                default_device_id.as_deref(),
                process_id,
                &process_identity,
                icon_cache,
                include_visuals,
            )? {
                return Ok(Some(session));
            }
        }

        Ok(None)
    })
}

impl AudioBackend for WindowsAudioBackend {
    fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        list_sessions_with_visuals(true)
    }

    fn list_session_states(&self) -> Result<Vec<SessionInfo>> {
        list_sessions_with_visuals(false)
    }

    fn list_playback_devices(&self) -> Result<Vec<PlaybackDeviceInfo>> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let default_device = get_default_device_from_flow(&enumerator, eRender)?;
        let default_id = device_id_string(&default_device);
        with_shared_icon_cache(|icon_cache| {
            list_devices_for_flow(&enumerator, eRender, default_id, icon_cache)
        })
    }

    fn list_recording_devices(&self) -> Result<Vec<PlaybackDeviceInfo>> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let default_device = get_default_device_from_flow(&enumerator, eCapture)?;
        let default_id = device_id_string(&default_device);
        with_shared_icon_cache(|icon_cache| {
            list_devices_for_flow(&enumerator, eCapture, default_id, icon_cache)
        })
    }

    fn set_master_volume(&self, volume: f32) -> Result<()> {
        let _com = init_com()?;
        let device = get_default_device()?;
        let endpoint = get_endpoint_volume(&device)?;
        let clamped = volume.clamp(0.0, 1.0);
        let previous_volume = unsafe { endpoint.GetMasterVolumeLevelScalar() }?;
        let previous_muted = unsafe { endpoint.GetMute() }?.as_bool();
        unsafe { endpoint.SetMasterVolumeLevelScalar(clamped, std::ptr::null()) }?;
        // Keep mute and volume independent for master endpoint writes.
        // Some Windows systems auto-mute at 0 volume; this ensures that:
        // - writing 0% does not force a muted state
        // - raising from a 0%+muted state restores audible output
        let was_effectively_zero = previous_volume <= f32::EPSILON;
        if clamped <= f32::EPSILON || (previous_muted && was_effectively_zero && clamped > 0.0) {
            unsafe { endpoint.SetMute(false, std::ptr::null()) }?;
        }
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
        let (kind, raw_id) = parse_device_target(device_id);
        let flow = match kind {
            DeviceTargetKind::Playback => eRender,
            DeviceTargetKind::Recording => eCapture,
        };

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
        let process_identity = query_effective_process_identity_cached(process_id);
        let enumerator = get_device_enumerator()?;
        let target_volume = volume.clamp(0.0, 1.0);
        let mut updated = false;

        for (device, _id) in enumerate_active_devices(&enumerator, eRender)? {
            if set_session_volume_for_process(
                &device,
                process_id,
                &process_identity,
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
        focused_session_with_visuals(true)
    }

    fn focused_session_state(&self) -> Result<Option<SessionInfo>> {
        focused_session_with_visuals(false)
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
        let process_identity = query_effective_process_identity_cached(process_id);
        let enumerator = get_device_enumerator()?;
        let mut updated = false;

        for (device, _id) in enumerate_active_devices(&enumerator, eRender)? {
            if set_session_mute_for_process(&device, process_id, &process_identity, muted)? {
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
        let (kind, raw_id) = parse_device_target(device_id);
        let flow = match kind {
            DeviceTargetKind::Playback => eRender,
            DeviceTargetKind::Recording => eCapture,
        };

        for (device, id) in enumerate_active_devices(&enumerator, flow)? {
            if id == raw_id {
                let endpoint = get_endpoint_volume(&device)?;
                unsafe { endpoint.SetMute(muted, std::ptr::null()) }?;
                return Ok(());
            }
        }

        Err(anyhow!("Device not found"))
    }

    fn set_default_device(&self, device_id: &str) -> Result<()> {
        let _com = init_com()?;
        let enumerator = get_device_enumerator()?;
        let (kind, raw_id) = parse_device_target(device_id);
        let flow = match kind {
            DeviceTargetKind::Playback => eRender,
            DeviceTargetKind::Recording => eCapture,
        };

        let exists = enumerate_active_devices(&enumerator, flow)?
            .iter()
            .any(|(_, id)| id == raw_id);
        if !exists {
            return Err(anyhow!("Device not found"));
        }

        set_default_audio_endpoint(raw_id)?;
        Ok(())
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

fn set_default_audio_endpoint(device_id: &str) -> Result<()> {
    let policy: IPolicyConfig =
        unsafe { CoCreateInstance(&CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL) }?;
    let wide = to_wide(device_id);
    unsafe {
        policy.set_default_endpoint(PCWSTR(wide.as_ptr()), eConsole)?;
        policy.set_default_endpoint(PCWSTR(wide.as_ptr()), eMultimedia)?;
        policy.set_default_endpoint(PCWSTR(wide.as_ptr()), eCommunications)?;
    }
    Ok(())
}

fn to_wide(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

#[repr(transparent)]
#[derive(Clone, PartialEq, Eq)]
struct IPolicyConfig(windows::core::IUnknown);

unsafe impl Interface for IPolicyConfig {
    type Vtable = IPolicyConfig_Vtbl;
    const IID: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
}

impl IPolicyConfig {
    unsafe fn set_default_endpoint(
        &self,
        device_id: PCWSTR,
        role: ERole,
    ) -> windows::core::Result<()> {
        (Interface::vtable(self).SetDefaultEndpoint)(Interface::as_raw(self), device_id, role).ok()
    }
}

#[repr(C)]
#[allow(non_snake_case)]
struct IPolicyConfig_Vtbl {
    pub base__: IUnknown_Vtbl,
    pub GetMixFormat: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PCWSTR,
        *mut *mut WAVEFORMATEX,
    ) -> HRESULT,
    pub GetDeviceFormat: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PCWSTR,
        i32,
        *mut *mut WAVEFORMATEX,
    ) -> HRESULT,
    pub ResetDeviceFormat: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR) -> HRESULT,
    pub SetDeviceFormat: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PCWSTR,
        *mut WAVEFORMATEX,
        *mut WAVEFORMATEX,
    ) -> HRESULT,
    pub GetProcessingPeriod: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PCWSTR,
        i32,
        *mut i64,
        *mut i64,
    ) -> HRESULT,
    pub SetProcessingPeriod:
        unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, *mut i64) -> HRESULT,
    pub GetShareMode: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PCWSTR,
        *mut core::ffi::c_void,
    ) -> HRESULT,
    pub SetShareMode: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PCWSTR,
        *mut core::ffi::c_void,
    ) -> HRESULT,
    pub GetPropertyValue: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PCWSTR,
        *const PROPERTYKEY,
        *mut PROPVARIANT,
    ) -> HRESULT,
    pub SetPropertyValue: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PCWSTR,
        *const PROPERTYKEY,
        *const PROPVARIANT,
    ) -> HRESULT,
    pub SetDefaultEndpoint:
        unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, ERole) -> HRESULT,
    pub SetEndpointVisibility:
        unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, i32) -> HRESULT,
}

fn list_devices_for_flow(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
    default_id: Option<String>,
    icon_cache: &mut HashMap<String, Option<String>>,
) -> Result<Vec<PlaybackDeviceInfo>> {
    let mut devices = Vec::new();

    for (device, device_id) in enumerate_active_devices(enumerator, flow)? {
        let friendly_name = get_device_property_string(&device, &PKEY_DEVICE_FRIENDLY_NAME)
            .unwrap_or_else(|| device_id.clone());
        let icon_path = get_device_property_string(&device, &PKEY_DEVICE_CLASS_ICON_PATH);
        let icon_data = icon_path
            .as_deref()
            .and_then(|path| icon_data_for_icon_path(path, icon_cache));
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

fn collect_device_sessions(
    device: &IMMDevice,
    device_id: &str,
    default_device_id: Option<&str>,
    sessions: &mut Vec<SessionInfo>,
    seen_ids: &mut HashSet<String>,
    icon_cache: &mut HashMap<String, Option<String>>,
    include_visuals: bool,
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

        if let Some(session) = session_info_from_control(
            &control2,
            &simple,
            session_id,
            process_id,
            icon_cache,
            include_visuals,
        )? {
            if !seen_ids.insert(session.id.clone()) {
                continue;
            }
            sessions.push(session);
        }
    }

    Ok(())
}

fn session_info_for_process(
    device: &IMMDevice,
    device_id: &str,
    default_device_id: Option<&str>,
    process_id: u32,
    process_identity: &ProcessIdentity,
    icon_cache: &mut HashMap<String, Option<String>>,
    include_visuals: bool,
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
        if !matches && session_process_id != 0 {
            let session_identity = query_effective_process_identity_cached(session_process_id);
            matches = process_identities_match(&session_identity, process_identity);
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

        if let Some(session) = session_info_from_control(
            &control2,
            &simple,
            session_id,
            session_process_id,
            icon_cache,
            include_visuals,
        )? {
            return Ok(Some(session));
        }
    }

    Ok(None)
}

fn session_info_from_control(
    control2: &IAudioSessionControl2,
    simple: &ISimpleAudioVolume,
    session_id: String,
    process_id: u32,
    icon_cache: &mut HashMap<String, Option<String>>,
    include_visuals: bool,
) -> Result<Option<SessionInfo>> {
    let raw_display_name = unsafe { control2.GetDisplayName() }
        .ok()
        .and_then(owned_pwstr_to_string);
    let display_name = session_display_name(raw_display_name.as_deref());
    let identity = query_effective_process_identity_cached(process_id);
    let process_path = identity.path.clone();
    let process_name = process_path
        .as_ref()
        .and_then(|path| Path::new(path).file_name())
        .and_then(|name| name.to_str())
        .map(|name| name.to_string());
    let application_key = stable_application_key(
        &identity,
        process_path.as_deref(),
        process_name.as_deref(),
        display_name.as_deref(),
    );
    let friendly_name = if include_visuals {
        friendly_session_name(
            display_name.as_deref(),
            process_path.as_deref(),
            process_name.as_deref(),
            &identity,
        )
    } else {
        display_name
            .as_deref()
            .filter(|name| !is_resource_display_name(name))
            .map(|name| name.to_string())
            .or_else(|| process_path.as_deref().and_then(friendly_process_label))
            .or_else(|| process_name.as_deref().map(humanize_label))
            .or_else(|| application_key.clone())
            .unwrap_or_else(|| "Unknown".to_string())
    };

    if should_skip_session(
        process_id,
        &display_name,
        &process_name,
        &process_path,
        &friendly_name,
        &application_key,
        &identity,
    ) {
        return Ok(None);
    }

    let icon_data = if include_visuals {
        icon_data_for_package(&identity, icon_cache).or_else(|| {
            process_path
                .as_ref()
                .and_then(|path| icon_data_for_path(path, icon_cache))
        })
    } else {
        None
    };
    let volume = unsafe { simple.GetMasterVolume() }?;
    let is_muted = unsafe { simple.GetMute() }?.as_bool();

    Ok(Some(SessionInfo {
        id: session_id,
        display_name: friendly_name,
        application_key,
        process_name,
        process_path,
        icon_data,
        volume,
        is_muted,
        is_master: false,
    }))
}

fn friendly_session_name(
    display_name: Option<&str>,
    process_path: Option<&str>,
    process_name: Option<&str>,
    identity: &ProcessIdentity,
) -> String {
    package_display_name_cached(identity)
        .or_else(|| {
            display_name
                .filter(|name| !is_resource_display_name(name))
                .map(|name| name.to_string())
        })
        .filter(|name| !is_resource_display_name(name))
        .or_else(|| package_label(identity))
        .or_else(|| process_path.and_then(friendly_process_label))
        .or_else(|| process_name.map(humanize_label))
        .or_else(|| display_name.map(|name| name.to_string()))
        .unwrap_or_else(|| "Unknown".to_string())
}

fn process_identities_match(left: &ProcessIdentity, right: &ProcessIdentity) -> bool {
    optional_identity_match(left.path.as_deref(), right.path.as_deref())
        || optional_identity_match(
            left.application_user_model_id.as_deref(),
            right.application_user_model_id.as_deref(),
        )
        || optional_identity_match(
            left.package_family_name.as_deref(),
            right.package_family_name.as_deref(),
        )
        || optional_identity_match(
            left.package_full_name.as_deref(),
            right.package_full_name.as_deref(),
        )
}

fn optional_identity_match(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            !left.trim().is_empty() && left.trim().eq_ignore_ascii_case(right.trim())
        }
        _ => false,
    }
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
    process_identity: &ProcessIdentity,
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

        if !matches && session_process_id != 0 {
            let session_identity = query_effective_process_identity_cached(session_process_id);
            matches = process_identities_match(&session_identity, process_identity);
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
    process_identity: &ProcessIdentity,
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

        if !matches && session_process_id != 0 {
            let session_identity = query_effective_process_identity_cached(session_process_id);
            matches = process_identities_match(&session_identity, process_identity);
        }

        if matches {
            unsafe { simple.SetMute(muted, std::ptr::null()) }?;
            updated = true;
        }
    }

    Ok(updated)
}

fn session_matches_application_name(
    target_name: &str,
    process_path: Option<&str>,
    process_name: Option<&str>,
    display_name: Option<&str>,
    identity: &ProcessIdentity,
) -> bool {
    let friendly = process_path.and_then(friendly_process_label);
    let humanized = process_name.map(humanize_label);
    let application_key =
        stable_application_key(identity, process_path, process_name, display_name);
    application_name_matches(
        target_name,
        ApplicationMatchInfo {
            process_path,
            process_name,
            display_name,
            friendly_process_label: friendly.as_deref(),
            humanized_process_name: humanized.as_deref(),
            application_key: application_key.as_deref(),
            package_family_name: identity.package_family_name.as_deref(),
            package_full_name: identity.package_full_name.as_deref(),
            application_user_model_id: identity.application_user_model_id.as_deref(),
        },
    )
}

fn set_session_volume_by_name(device: &IMMDevice, name: &str, volume: f32) -> Result<bool> {
    let session_manager = get_session_manager(device)?;
    let enumerator = unsafe { session_manager.GetSessionEnumerator() }?;
    let count = unsafe { enumerator.GetCount() }?;
    let mut updated = false;

    for index in 0..count {
        let control = unsafe { enumerator.GetSession(index) }?;
        let control2: IAudioSessionControl2 = control.cast()?;
        let simple: ISimpleAudioVolume = control.cast()?;

        let process_id = unsafe { control2.GetProcessId() }?;
        let identity = query_effective_process_identity_cached(process_id);
        let process_path = identity.path.clone();
        let process_name = process_path
            .as_ref()
            .and_then(|path| Path::new(path).file_name())
            .and_then(|name| name.to_str())
            .map(|name| name.to_string());

        let matches = session_matches_application_name(
            name,
            process_path.as_deref(),
            process_name.as_deref(),
            None,
            &identity,
        ) || {
            let display_name = unsafe { control2.GetDisplayName() }
                .ok()
                .and_then(owned_pwstr_to_string)
                .and_then(|name| session_display_name(Some(&name)));
            session_matches_application_name(
                name,
                process_path.as_deref(),
                process_name.as_deref(),
                display_name.as_deref(),
                &identity,
            )
        };

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

    for index in 0..count {
        let control = unsafe { enumerator.GetSession(index) }?;
        let control2: IAudioSessionControl2 = control.cast()?;
        let simple: ISimpleAudioVolume = control.cast()?;

        let process_id = unsafe { control2.GetProcessId() }?;
        let identity = query_effective_process_identity_cached(process_id);
        let process_path = identity.path.clone();
        let process_name = process_path
            .as_ref()
            .and_then(|path| Path::new(path).file_name())
            .and_then(|name| name.to_str())
            .map(|name| name.to_string());

        let matches = session_matches_application_name(
            name,
            process_path.as_deref(),
            process_name.as_deref(),
            None,
            &identity,
        ) || {
            let display_name = unsafe { control2.GetDisplayName() }
                .ok()
                .and_then(owned_pwstr_to_string)
                .and_then(|name| session_display_name(Some(&name)));
            session_matches_application_name(
                name,
                process_path.as_deref(),
                process_name.as_deref(),
                display_name.as_deref(),
                &identity,
            )
        };

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
    owned_pwstr_to_string(id)
}

fn get_device_property_string(device: &IMMDevice, key: &PROPERTYKEY) -> Option<String> {
    let store: IPropertyStore = unsafe { device.OpenPropertyStore(STGM_READ).ok()? };
    let value: PROPVARIANT = unsafe { store.GetValue(key as *const _).ok()? };
    let allocated = unsafe { PropVariantToStringAlloc(&value).ok() };
    let _ = unsafe { PropVariantClear(&value as *const _ as *mut _) };
    owned_pwstr_to_string(allocated?)
}

use crate::run_logger;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct ParameterRef {
    pub scope: String,
    pub index: usize,
    pub property: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParameterWrite {
    #[serde(flatten)]
    pub parameter: ParameterRef,
    pub value: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParameterValue {
    #[serde(flatten)]
    pub parameter: ParameterRef,
    pub value: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParameterReadError {
    #[serde(flatten)]
    pub parameter: ParameterRef,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VoicemeeterCapabilities {
    pub strip_count: usize,
    pub physical_strip_count: usize,
    pub bus_count: usize,
    pub physical_bus_count: usize,
    pub virtual_bus_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoicemeeterStatus {
    pub installed: bool,
    pub connected: bool,
    pub edition: Option<String>,
    pub edition_code: Option<i32>,
    pub version: Option<String>,
    pub capabilities: Option<VoicemeeterCapabilities>,
    pub installed_editions: Vec<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceDescriptor {
    pub direction: String,
    pub driver_type: String,
    pub name: String,
    pub hardware_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceAssignment {
    pub scope: String,
    pub index: usize,
    pub direction: String,
    pub driver_type: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceState {
    pub scope: String,
    pub index: usize,
    pub name: String,
    pub sample_rate: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeterValue {
    pub scope: String,
    pub index: usize,
    pub level: f32,
}

fn validate_device_slot(
    scope: &str,
    direction: &str,
    index: usize,
    caps: &VoicemeeterCapabilities,
) -> Result<&'static str, String> {
    let (prefix, max) = if scope == "strip" && direction == "input" {
        ("Strip", caps.physical_strip_count)
    } else if scope == "bus" && direction == "output" {
        ("Bus", caps.physical_bus_count)
    } else {
        return Err("Invalid Voicemeeter device assignment target".to_string());
    };
    if index >= max {
        return Err("Voicemeeter device assignment index is out of range".to_string());
    }
    Ok(prefix)
}

fn supported_device_drivers(scope: &str, index: usize) -> &'static [&'static str] {
    if scope == "bus" && index == 0 {
        &["mme", "wdm", "ks", "asio"]
    } else {
        &["mme", "wdm", "ks"]
    }
}

fn validate_device_driver(scope: &str, index: usize, driver: &str) -> Result<(), String> {
    if driver == "asio" && (scope != "bus" || index != 0) {
        return Err("ASIO output devices are supported only on hardware output A1".to_string());
    }
    if !supported_device_drivers(scope, index).contains(&driver) {
        return Err("Unsupported Voicemeeter device driver type".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct VoicemeeterSnapshot {
    pub status: VoicemeeterStatus,
    pub dirty: bool,
    pub macro_dirty: bool,
    pub revision: u64,
    pub values: Vec<ParameterValue>,
    pub errors: Vec<ParameterReadError>,
    pub strip_labels: Vec<String>,
    pub bus_labels: Vec<String>,
    pub input_devices: Vec<String>,
    pub output_devices: Vec<String>,
    pub meters: Vec<MeterValue>,
}

fn capabilities_for(code: i32) -> Option<VoicemeeterCapabilities> {
    match code {
        1 => Some(VoicemeeterCapabilities {
            strip_count: 3,
            physical_strip_count: 2,
            bus_count: 2,
            physical_bus_count: 1,
            virtual_bus_count: 1,
        }),
        2 => Some(VoicemeeterCapabilities {
            strip_count: 5,
            physical_strip_count: 3,
            bus_count: 5,
            physical_bus_count: 3,
            virtual_bus_count: 2,
        }),
        3 => Some(VoicemeeterCapabilities {
            strip_count: 8,
            physical_strip_count: 5,
            bus_count: 8,
            physical_bus_count: 5,
            virtual_bus_count: 3,
        }),
        _ => None,
    }
}

fn edition_name(code: i32) -> Option<&'static str> {
    match code {
        1 => Some("standard"),
        2 => Some("banana"),
        3 => Some("potato"),
        _ => None,
    }
}

fn property_spec(scope: &str, property: &str) -> Option<(f32, f32, i32)> {
    let boolean = (0.0, 1.0, 1);
    match scope {
        "strip" => match property {
            "gain" => Some((-60.0, 12.0, 1)),
            "mute" | "solo" | "mono" | "mc" | "a1" | "b1" | "vaio" => Some(boolean),
            "a2" | "a3" | "b2" => Some((0.0, 1.0, 2)),
            "a4" | "a5" | "b3" => Some((0.0, 1.0, 3)),
            "pan_x" | "color_x" => Some((-0.5, 0.5, 1)),
            "pan_y" | "color_y" => Some((-0.5, 1.0, 1)),
            "fx_x" => Some((-0.5, 0.5, 2)),
            "fx_y" => Some((0.0, 1.0, 2)),
            "audibility" => Some((0.0, 10.0, 1)),
            "comp" | "gate" => Some((0.0, 10.0, 2)),
            "denoiser" => Some((0.0, 10.0, 3)),
            "limit" => Some((-40.0, 12.0, 2)),
            "eqgain1" | "eqgain2" | "eqgain3" => Some((-12.0, 12.0, 1)),
            "eq.on" | "eq.ab" => Some((0.0, 1.0, 3)),
            "reverb" | "delay" | "fx1" | "fx2" => Some((0.0, 10.0, 3)),
            "postreverb" | "postdelay" | "postfx1" | "postfx2" => Some((0.0, 1.0, 3)),
            _ => None,
        },
        "bus" => {
            match property {
                "gain" => Some((-60.0, 12.0, 1)),
                "mute" | "vaio" | "mode.normal" | "mode.amix" | "mode.repeat"
                | "mode.composite" => Some(boolean),
                "mono" => Some((0.0, 2.0, 1)),
                "eq.on" | "eq.ab" | "mode.bmix" | "mode.tvmix" | "mode.upmix21"
                | "mode.upmix41" | "mode.upmix61" | "mode.centeronly" | "mode.lfeonly"
                | "mode.rearonly" => Some((0.0, 1.0, 2)),
                "sel" | "monitor" => Some((0.0, 1.0, 3)),
                "returnreverb" | "returndelay" | "returnfx1" | "returnfx2" => Some((0.0, 10.0, 3)),
                _ => None,
            }
        }
        "macro" => match property {
            "state" | "state_only" | "trigger" => Some(boolean),
            _ => None,
        },
        _ => None,
    }
}

fn validate_parameter(
    parameter: &ParameterRef,
    edition_code: i32,
    write_value: Option<f32>,
) -> Result<(), String> {
    let caps = capabilities_for(edition_code)
        .ok_or_else(|| "Unsupported Voicemeeter edition".to_string())?;
    let scope = parameter.scope.to_ascii_lowercase();
    let property = parameter.property.to_ascii_lowercase();
    let max_index = match scope.as_str() {
        "strip" => caps.strip_count,
        "bus" => caps.bus_count,
        "macro" => 80,
        _ => return Err("Unsupported Voicemeeter parameter scope".to_string()),
    };
    if parameter.index >= max_index {
        return Err(format!("Voicemeeter {} index is out of range", scope));
    }
    let (min, max, minimum_edition) = property_spec(&scope, &property)
        .ok_or_else(|| format!("Unsupported Voicemeeter {} property", scope))?;
    if edition_code < minimum_edition {
        return Err("Property is not available in the running Voicemeeter edition".to_string());
    }
    if let Some(value) = write_value {
        if !value.is_finite() || value < min || value > max {
            return Err(format!("Voicemeeter value must be between {min} and {max}"));
        }
    }
    Ok(())
}

fn canonical_parameter(parameter: &ParameterRef) -> String {
    let prefix = if parameter.scope.eq_ignore_ascii_case("bus") {
        "Bus"
    } else {
        "Strip"
    };
    format!("{}[{}].{}", prefix, parameter.index, parameter.property)
}

fn parameter_key_for_log(parameter: &ParameterRef) -> String {
    format!(
        "{}:{}:{}",
        parameter.scope.to_ascii_lowercase(),
        parameter.index,
        parameter.property.to_ascii_lowercase()
    )
}

fn should_refresh_snapshot(force: bool, dirty: bool, macro_dirty: bool) -> bool {
    force || dirty || macro_dirty
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use libloading::Library;
    use std::ffi::{c_char, c_int, CString};
    use std::path::{Path, PathBuf};
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
    use winreg::RegKey;

    type NoArg = unsafe extern "system" fn() -> c_int;
    type Run = unsafe extern "system" fn(c_int) -> c_int;
    type GetInt = unsafe extern "system" fn(*mut c_int) -> c_int;
    type GetFloat = unsafe extern "system" fn(*const c_char, *mut f32) -> c_int;
    type SetFloat = unsafe extern "system" fn(*const c_char, f32) -> c_int;
    type GetStringW = unsafe extern "system" fn(*const c_char, *mut u16) -> c_int;
    type SetStringW = unsafe extern "system" fn(*const c_char, *const u16) -> c_int;
    type GetLevel = unsafe extern "system" fn(c_int, c_int, *mut f32) -> c_int;
    type DeviceNumber = unsafe extern "system" fn() -> c_int;
    type DeviceDescW = unsafe extern "system" fn(c_int, *mut c_int, *mut u16, *mut u16) -> c_int;
    type MacroGet = unsafe extern "system" fn(c_int, *mut f32, c_int) -> c_int;
    type MacroSet = unsafe extern "system" fn(c_int, f32, c_int) -> c_int;

    pub struct RemoteApi {
        _library: Library,
        login: NoArg,
        logout: NoArg,
        run: Run,
        get_type: GetInt,
        get_version: GetInt,
        is_dirty: NoArg,
        get_float: GetFloat,
        set_float: SetFloat,
        get_string_w: GetStringW,
        set_string_w: SetStringW,
        get_level: GetLevel,
        input_count: DeviceNumber,
        input_desc: DeviceDescW,
        output_count: DeviceNumber,
        output_desc: DeviceDescW,
        macro_dirty: NoArg,
        macro_get: MacroGet,
        macro_set: MacroSet,
    }

    impl RemoteApi {
        unsafe fn load_symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, String> {
            library
                .get::<T>(name)
                .map(|symbol| *symbol)
                .map_err(|error| error.to_string())
        }

        pub fn load() -> Result<Self, String> {
            let dll_path = dll_path().ok_or_else(|| "Voicemeeter is not installed".to_string())?;
            let library = unsafe { Library::new(&dll_path) }
                .map_err(|error| format!("Unable to load {}: {error}", dll_path.display()))?;
            unsafe {
                Ok(Self {
                    login: Self::load_symbol(&library, b"VBVMR_Login\0")?,
                    logout: Self::load_symbol(&library, b"VBVMR_Logout\0")?,
                    run: Self::load_symbol(&library, b"VBVMR_RunVoicemeeter\0")?,
                    get_type: Self::load_symbol(&library, b"VBVMR_GetVoicemeeterType\0")?,
                    get_version: Self::load_symbol(&library, b"VBVMR_GetVoicemeeterVersion\0")?,
                    is_dirty: Self::load_symbol(&library, b"VBVMR_IsParametersDirty\0")?,
                    get_float: Self::load_symbol(&library, b"VBVMR_GetParameterFloat\0")?,
                    set_float: Self::load_symbol(&library, b"VBVMR_SetParameterFloat\0")?,
                    get_string_w: Self::load_symbol(&library, b"VBVMR_GetParameterStringW\0")?,
                    set_string_w: Self::load_symbol(&library, b"VBVMR_SetParameterStringW\0")?,
                    get_level: Self::load_symbol(&library, b"VBVMR_GetLevel\0")?,
                    input_count: Self::load_symbol(&library, b"VBVMR_Input_GetDeviceNumber\0")?,
                    input_desc: Self::load_symbol(&library, b"VBVMR_Input_GetDeviceDescW\0")?,
                    output_count: Self::load_symbol(&library, b"VBVMR_Output_GetDeviceNumber\0")?,
                    output_desc: Self::load_symbol(&library, b"VBVMR_Output_GetDeviceDescW\0")?,
                    macro_dirty: Self::load_symbol(&library, b"VBVMR_MacroButton_IsDirty\0")?,
                    macro_get: Self::load_symbol(&library, b"VBVMR_MacroButton_GetStatus\0")?,
                    macro_set: Self::load_symbol(&library, b"VBVMR_MacroButton_SetStatus\0")?,
                    _library: library,
                })
            }
        }

        fn call_result(code: c_int, action: &str) -> Result<c_int, String> {
            if code < 0 {
                Err(format!("Voicemeeter {action} failed ({code})"))
            } else {
                Ok(code)
            }
        }

        pub fn login(&self) -> Result<c_int, String> {
            Self::call_result(unsafe { (self.login)() }, "login")
        }
        pub fn logout(&self) {
            unsafe {
                (self.logout)();
            }
        }
        pub fn run(&self, edition: i32) -> Result<(), String> {
            Self::call_result(unsafe { (self.run)(edition) }, "launch").map(|_| ())
        }
        pub fn edition(&self) -> Result<i32, String> {
            let mut value = 0;
            Self::call_result(unsafe { (self.get_type)(&mut value) }, "edition query")?;
            Ok(value)
        }
        pub fn version(&self) -> Result<i32, String> {
            let mut value = 0;
            Self::call_result(unsafe { (self.get_version)(&mut value) }, "version query")?;
            Ok(value)
        }
        pub fn dirty(&self) -> Result<bool, String> {
            Self::call_result(unsafe { (self.is_dirty)() }, "dirty-state query").map(|v| v > 0)
        }
        pub fn macro_dirty(&self) -> Result<bool, String> {
            Self::call_result(
                unsafe { (self.macro_dirty)() },
                "MacroButtons dirty-state query",
            )
            .map(|v| v > 0)
        }

        pub fn get_float(&self, name: &str) -> Result<f32, String> {
            let name = CString::new(name).map_err(|_| "Invalid parameter name".to_string())?;
            let mut value = 0.0;
            Self::call_result(
                unsafe { (self.get_float)(name.as_ptr(), &mut value) },
                "parameter read",
            )?;
            Ok(value)
        }
        pub fn set_float(&self, name: &str, value: f32) -> Result<(), String> {
            let name = CString::new(name).map_err(|_| "Invalid parameter name".to_string())?;
            Self::call_result(
                unsafe { (self.set_float)(name.as_ptr(), value) },
                "parameter write",
            )
            .map(|_| ())
        }
        pub fn get_string(&self, name: &str) -> Result<String, String> {
            let name = CString::new(name).map_err(|_| "Invalid parameter name".to_string())?;
            let mut buffer = vec![0u16; 1024];
            Self::call_result(
                unsafe { (self.get_string_w)(name.as_ptr(), buffer.as_mut_ptr()) },
                "string read",
            )?;
            let length = buffer.iter().position(|v| *v == 0).unwrap_or(buffer.len());
            Ok(String::from_utf16_lossy(&buffer[..length])
                .trim()
                .to_string())
        }
        pub fn set_string(&self, name: &str, value: &str) -> Result<(), String> {
            let name = CString::new(name).map_err(|_| "Invalid parameter name".to_string())?;
            let mut wide: Vec<u16> = value.encode_utf16().collect();
            wide.push(0);
            Self::call_result(
                unsafe { (self.set_string_w)(name.as_ptr(), wide.as_ptr()) },
                "string write",
            )
            .map(|_| ())
        }
        pub fn level(&self, kind: i32, channel: i32) -> Result<f32, String> {
            let mut value = 0.0;
            Self::call_result(
                unsafe { (self.get_level)(kind, channel, &mut value) },
                "meter read",
            )?;
            Ok(value.clamp(0.0, 1.0))
        }
        pub fn macro_get(&self, index: usize, property: &str) -> Result<f32, String> {
            let mode = macro_mode(property)?;
            let mut value = 0.0;
            Self::call_result(
                unsafe { (self.macro_get)(index as i32, &mut value, mode) },
                "MacroButton read",
            )?;
            Ok(value)
        }
        pub fn macro_set(&self, index: usize, property: &str, value: f32) -> Result<(), String> {
            let mode = macro_mode(property)?;
            Self::call_result(
                unsafe { (self.macro_set)(index as i32, value, mode) },
                "MacroButton write",
            )
            .map(|_| ())
        }
        pub fn devices(&self, direction: &str) -> Result<Vec<DeviceDescriptor>, String> {
            let (count_fn, desc_fn) = if direction == "input" {
                (self.input_count, self.input_desc)
            } else {
                (self.output_count, self.output_desc)
            };
            let count = Self::call_result(unsafe { count_fn() }, "device enumeration")?;
            let mut devices = Vec::new();
            for index in 0..count {
                let mut kind = 0;
                let mut name = vec![0u16; 512];
                let mut hardware_id = vec![0u16; 512];
                if unsafe {
                    desc_fn(
                        index,
                        &mut kind,
                        name.as_mut_ptr(),
                        hardware_id.as_mut_ptr(),
                    )
                } != 0
                {
                    continue;
                }
                let decode = |buffer: &[u16]| {
                    let len = buffer.iter().position(|v| *v == 0).unwrap_or(buffer.len());
                    String::from_utf16_lossy(&buffer[..len]).trim().to_string()
                };
                let driver_type = match kind {
                    1 => "mme",
                    3 => "wdm",
                    4 => "ks",
                    5 => "asio",
                    _ => continue,
                };
                devices.push(DeviceDescriptor {
                    direction: direction.to_string(),
                    driver_type: driver_type.to_string(),
                    name: decode(&name),
                    hardware_id: decode(&hardware_id),
                });
            }
            Ok(devices)
        }
    }

    fn macro_mode(property: &str) -> Result<i32, String> {
        match property.to_ascii_lowercase().as_str() {
            "state" => Ok(0),
            "state_only" => Ok(2),
            "trigger" => Ok(3),
            _ => Err("Unsupported MacroButton property".to_string()),
        }
    }

    fn discover_installation_dir() -> Option<PathBuf> {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let path = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\VB:Voicemeeter {17359A74-1236-5467}";
        for flags in [KEY_READ, KEY_READ | KEY_WOW64_32KEY] {
            if let Ok(key) = hklm.open_subkey_with_flags(path, flags) {
                if let Ok(uninstall) = key.get_value::<String, _>("UninstallString") {
                    if let Some(parent) = Path::new(uninstall.trim_matches('"')).parent() {
                        return Some(parent.to_path_buf());
                    }
                }
            }
        }
        [
            r"C:\Program Files (x86)\VB\Voicemeeter",
            r"C:\Program Files\VB\Voicemeeter",
        ]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
    }

    fn installation_dir() -> Option<PathBuf> {
        static INSTALLATION_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
        INSTALLATION_DIR
            .get_or_init(discover_installation_dir)
            .clone()
    }

    pub fn dll_path() -> Option<PathBuf> {
        installation_dir()
            .map(|dir| {
                dir.join(if cfg!(target_pointer_width = "64") {
                    "VoicemeeterRemote64.dll"
                } else {
                    "VoicemeeterRemote.dll"
                })
            })
            .filter(|p| p.exists())
    }

    pub fn installed_editions() -> Vec<String> {
        static EDITIONS: OnceLock<Vec<String>> = OnceLock::new();
        EDITIONS
            .get_or_init(|| {
                let Some(dir) = installation_dir() else {
                    return Vec::new();
                };
                [
                    ("standard", "voicemeeter_x64.exe"),
                    ("banana", "voicemeeterpro_x64.exe"),
                    ("potato", "voicemeeter8x64.exe"),
                ]
                .into_iter()
                .filter(|(_, exe)| dir.join(exe).exists())
                .map(|(name, _)| name.to_string())
                .collect()
            })
            .clone()
    }

    pub fn is_installed() -> bool {
        dll_path().is_some()
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::*;
    pub struct RemoteApi;
    impl RemoteApi {
        pub fn load() -> Result<Self, String> {
            Err("Voicemeeter is supported only on Windows".to_string())
        }
    }
    pub fn installed_editions() -> Vec<String> {
        Vec::new()
    }
    pub fn is_installed() -> bool {
        false
    }
}

struct BridgeInner {
    api: Option<platform::RemoteApi>,
    logged_in: bool,
    revision: u64,
}

impl Drop for BridgeInner {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        if self.logged_in {
            if let Some(api) = self.api.as_ref() {
                api.logout();
            }
        }
    }
}

pub struct VoicemeeterState {
    inner: Mutex<BridgeInner>,
}
impl VoicemeeterState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(BridgeInner {
                api: None,
                logged_in: false,
                revision: 0,
            }),
        }
    }

    pub(crate) fn disconnect_for_shutdown(&self) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Voicemeeter bridge lock failed".to_string())?;
        disconnect_inner(&mut inner);
        Ok(())
    }

    pub(crate) fn try_disconnect_for_shutdown(&self) -> Result<(), String> {
        let mut inner = self
            .inner
            .try_lock()
            .map_err(|_| "Voicemeeter bridge is busy".to_string())?;
        disconnect_inner(&mut inner);
        Ok(())
    }
}

fn disconnect_inner(inner: &mut BridgeInner) {
    #[cfg(target_os = "windows")]
    if inner.logged_in {
        if let Some(api) = inner.api.as_ref() {
            api.logout();
        }
    }
    inner.logged_in = false;
    inner.api = None;
    inner.revision = inner.revision.wrapping_add(1);
}

#[cfg(target_os = "windows")]
fn status_from_inner(inner: &BridgeInner) -> VoicemeeterStatus {
    let installed_editions = platform::installed_editions();
    let Some(api) = inner.api.as_ref() else {
        return VoicemeeterStatus {
            installed: platform::is_installed(),
            connected: false,
            edition: None,
            edition_code: None,
            version: None,
            capabilities: None,
            installed_editions,
            detail: if platform::is_installed() {
                "Not connected"
            } else {
                "Voicemeeter is not installed"
            }
            .to_string(),
        };
    };
    if !inner.logged_in {
        return VoicemeeterStatus {
            installed: true,
            connected: false,
            edition: None,
            edition_code: None,
            version: None,
            capabilities: None,
            installed_editions,
            detail: "Not connected".to_string(),
        };
    }
    let Ok(code) = api.edition() else {
        return VoicemeeterStatus {
            installed: true,
            connected: false,
            edition: None,
            edition_code: None,
            version: None,
            capabilities: None,
            installed_editions,
            detail: "Voicemeeter is not running".to_string(),
        };
    };
    let version = api.version().ok().map(format_version);
    VoicemeeterStatus {
        installed: true,
        connected: true,
        edition: edition_name(code).map(str::to_string),
        edition_code: Some(code),
        version,
        capabilities: capabilities_for(code),
        installed_editions,
        detail: "Connected".to_string(),
    }
}

#[cfg(not(target_os = "windows"))]
fn status_from_inner(_inner: &BridgeInner) -> VoicemeeterStatus {
    VoicemeeterStatus {
        installed: false,
        connected: false,
        edition: None,
        edition_code: None,
        version: None,
        capabilities: None,
        installed_editions: Vec::new(),
        detail: "Voicemeeter is supported only on Windows".to_string(),
    }
}

fn format_version(value: i32) -> String {
    format!(
        "{}.{}.{}.{}",
        (value >> 24) & 0xff,
        (value >> 16) & 0xff,
        (value >> 8) & 0xff,
        value & 0xff
    )
}

#[tauri::command]
pub fn voicemeeter_status(
    state: tauri::State<'_, VoicemeeterState>,
) -> Result<VoicemeeterStatus, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Voicemeeter bridge lock failed".to_string())?;
    Ok(status_from_inner(&inner))
}

#[tauri::command]
pub fn voicemeeter_connect(
    state: tauri::State<'_, VoicemeeterState>,
) -> Result<VoicemeeterStatus, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Voicemeeter bridge lock failed".to_string())?;
    #[cfg(target_os = "windows")]
    {
        if inner.api.is_none() {
            inner.api = Some(platform::RemoteApi::load()?);
        }
        if !inner.logged_in {
            inner
                .api
                .as_ref()
                .ok_or_else(|| "Voicemeeter API unavailable".to_string())?
                .login()?;
            inner.logged_in = true;
            inner.revision = inner.revision.wrapping_add(1);
        }
    }
    Ok(status_from_inner(&inner))
}

#[tauri::command]
pub fn voicemeeter_disconnect(state: tauri::State<'_, VoicemeeterState>) -> Result<(), String> {
    state.disconnect_for_shutdown()
}

#[tauri::command]
pub fn voicemeeter_write_parameters(
    state: tauri::State<'_, VoicemeeterState>,
    writes: Vec<ParameterWrite>,
) -> Result<(), String> {
    if writes.is_empty() || writes.len() > 128 {
        return Err("Voicemeeter write batch must contain 1 to 128 values".to_string());
    }
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Voicemeeter bridge lock failed".to_string())?;
    let status = status_from_inner(&inner);
    let edition = status
        .edition_code
        .ok_or_else(|| "Voicemeeter is not running".to_string())?;
    #[cfg(target_os = "windows")]
    {
        let api = inner
            .api
            .as_ref()
            .ok_or_else(|| "Voicemeeter API unavailable".to_string())?;
        for write in &writes {
            validate_parameter(&write.parameter, edition, Some(write.value))?;
            if write.parameter.scope.eq_ignore_ascii_case("macro") {
                api.macro_set(
                    write.parameter.index,
                    &write.parameter.property,
                    write.value,
                )?;
            } else {
                api.set_float(&canonical_parameter(&write.parameter), write.value)?;
            }
        }
    }
    inner.revision = inner.revision.wrapping_add(1);
    Ok(())
}

#[tauri::command]
pub fn voicemeeter_snapshot(
    state: tauri::State<'_, VoicemeeterState>,
    parameters: Vec<ParameterRef>,
    include_meters: bool,
    force: bool,
) -> Result<VoicemeeterSnapshot, String> {
    if parameters.len() > 512 {
        return Err("Too many Voicemeeter parameters requested".to_string());
    }
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Voicemeeter bridge lock failed".to_string())?;
    let status = status_from_inner(&inner);
    let Some(edition) = status.edition_code else {
        return Ok(VoicemeeterSnapshot {
            status,
            dirty: false,
            macro_dirty: false,
            revision: inner.revision,
            values: Vec::new(),
            errors: Vec::new(),
            strip_labels: Vec::new(),
            bus_labels: Vec::new(),
            input_devices: Vec::new(),
            output_devices: Vec::new(),
            meters: Vec::new(),
        });
    };
    let caps =
        capabilities_for(edition).ok_or_else(|| "Unsupported Voicemeeter edition".to_string())?;
    #[cfg(target_os = "windows")]
    {
        let (
            dirty,
            macro_dirty,
            values,
            errors,
            strip_labels,
            bus_labels,
            input_devices,
            output_devices,
            meters,
        ) = {
            let api = inner
                .api
                .as_ref()
                .ok_or_else(|| "Voicemeeter API unavailable".to_string())?;
            let dirty = api.dirty().unwrap_or(false);
            let macro_dirty = api.macro_dirty().unwrap_or(false);
            let refresh_parameters = should_refresh_snapshot(force, dirty, macro_dirty);
            let mut values = Vec::new();
            let mut errors = Vec::new();
            if refresh_parameters {
                for parameter in parameters {
                    let result = if let Err(error) = validate_parameter(&parameter, edition, None) {
                        Err(error)
                    } else if parameter.scope.eq_ignore_ascii_case("macro") {
                        api.macro_get(parameter.index, &parameter.property)
                    } else {
                        api.get_float(&canonical_parameter(&parameter))
                    };
                    match result {
                        Ok(value) => values.push(ParameterValue { parameter, value }),
                        Err(error) => {
                            run_logger::warn(
                                "voicemeeter",
                                "parameter_read_failed",
                                &format!(
                                    "parameter={} error={}",
                                    parameter_key_for_log(&parameter),
                                    error
                                ),
                            );
                            errors.push(ParameterReadError { parameter, error });
                        }
                    }
                }
            }
            let strip_labels = if refresh_parameters {
                (0..caps.strip_count)
                    .map(|i| {
                        api.get_string(&format!("Strip[{i}].Label"))
                            .unwrap_or_default()
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let bus_labels = if refresh_parameters {
                (0..caps.bus_count)
                    .map(|i| {
                        api.get_string(&format!("Bus[{i}].Label"))
                            .unwrap_or_default()
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let input_devices = if refresh_parameters {
                (0..caps.physical_strip_count)
                    .map(|i| {
                        api.get_string(&format!("Strip[{i}].device.name"))
                            .unwrap_or_default()
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let output_devices = if refresh_parameters {
                (0..caps.physical_bus_count)
                    .map(|i| {
                        api.get_string(&format!("Bus[{i}].device.name"))
                            .unwrap_or_default()
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let meters = if include_meters {
                collect_meters(api, &caps)
            } else {
                Vec::new()
            };
            (
                dirty,
                macro_dirty,
                values,
                errors,
                strip_labels,
                bus_labels,
                input_devices,
                output_devices,
                meters,
            )
        };
        if dirty || macro_dirty {
            inner.revision = inner.revision.wrapping_add(1);
        }
        Ok(VoicemeeterSnapshot {
            status,
            dirty,
            macro_dirty,
            revision: inner.revision,
            values,
            errors,
            strip_labels,
            bus_labels,
            input_devices,
            output_devices,
            meters,
        })
    }
    #[cfg(not(target_os = "windows"))]
    unreachable!()
}

#[cfg(target_os = "windows")]
fn collect_meters(api: &platform::RemoteApi, caps: &VoicemeeterCapabilities) -> Vec<MeterValue> {
    let mut out = Vec::new();
    for index in 0..caps.strip_count {
        let (base, width) = if index < caps.physical_strip_count {
            (index * 2, 2)
        } else {
            (
                caps.physical_strip_count * 2 + (index - caps.physical_strip_count) * 8,
                8,
            )
        };
        let level = (base..base + width)
            .filter_map(|channel| api.level(2, channel as i32).ok())
            .fold(0.0f32, f32::max);
        out.push(MeterValue {
            scope: "strip".to_string(),
            index,
            level,
        });
    }
    for index in 0..caps.bus_count {
        let level = (index * 8..index * 8 + 8)
            .filter_map(|channel| api.level(3, channel as i32).ok())
            .fold(0.0f32, f32::max);
        out.push(MeterValue {
            scope: "bus".to_string(),
            index,
            level,
        });
    }
    out
}

#[tauri::command]
pub fn voicemeeter_list_devices(
    state: tauri::State<'_, VoicemeeterState>,
    direction: String,
) -> Result<Vec<DeviceDescriptor>, String> {
    let direction = direction.to_ascii_lowercase();
    if direction != "input" && direction != "output" {
        return Err("Device direction must be input or output".to_string());
    }
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Voicemeeter bridge lock failed".to_string())?;
    if !status_from_inner(&inner).connected {
        return Err("Voicemeeter is not running".to_string());
    }
    #[cfg(target_os = "windows")]
    return inner
        .api
        .as_ref()
        .ok_or_else(|| "Voicemeeter API unavailable".to_string())?
        .devices(&direction);
    #[cfg(not(target_os = "windows"))]
    Err("Voicemeeter is supported only on Windows".to_string())
}

#[tauri::command]
pub fn voicemeeter_device_state(
    state: tauri::State<'_, VoicemeeterState>,
    scope: String,
    index: usize,
) -> Result<DeviceState, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Voicemeeter bridge lock failed".to_string())?;
    let status = status_from_inner(&inner);
    let caps = status
        .capabilities
        .ok_or_else(|| "Voicemeeter is not running".to_string())?;
    let scope = scope.to_ascii_lowercase();
    let direction = if scope == "strip" { "input" } else { "output" };
    let prefix = validate_device_slot(&scope, direction, index, &caps)?;
    #[cfg(target_os = "windows")]
    {
        let api = inner
            .api
            .as_ref()
            .ok_or_else(|| "Voicemeeter API unavailable".to_string())?;
        let name = api.get_string(&format!("{prefix}[{index}].device.name"))?;
        let sample_rate = if name.is_empty() {
            0.0
        } else {
            api.get_float(&format!("{prefix}[{index}].device.sr"))?
        };
        Ok(DeviceState {
            scope,
            index,
            name,
            sample_rate,
        })
    }
    #[cfg(not(target_os = "windows"))]
    Err("Voicemeeter is supported only on Windows".to_string())
}

#[tauri::command]
pub fn voicemeeter_assign_device(
    state: tauri::State<'_, VoicemeeterState>,
    assignment: DeviceAssignment,
) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Voicemeeter bridge lock failed".to_string())?;
    let status = status_from_inner(&inner);
    let caps = status
        .capabilities
        .ok_or_else(|| "Voicemeeter is not running".to_string())?;
    let scope = assignment.scope.to_ascii_lowercase();
    let direction = assignment.direction.to_ascii_lowercase();
    let prefix = validate_device_slot(&scope, &direction, assignment.index, &caps)?;
    #[cfg(target_os = "windows")]
    {
        let api = inner
            .api
            .as_ref()
            .ok_or_else(|| "Voicemeeter API unavailable".to_string())?;
        let name = assignment.name.unwrap_or_default();
        if name.is_empty() {
            for driver in supported_device_drivers(&scope, assignment.index) {
                api.set_string(
                    &format!("{prefix}[{}].device.{driver}", assignment.index),
                    "",
                )?;
            }
        } else {
            let driver = assignment
                .driver_type
                .unwrap_or_default()
                .to_ascii_lowercase();
            validate_device_driver(&scope, assignment.index, &driver)?;
            let found = api
                .devices(&direction)?
                .into_iter()
                .any(|device| device.driver_type == driver && device.name == name);
            if !found {
                return Err("Selected audio device is no longer available".to_string());
            }
            api.set_string(
                &format!("{prefix}[{}].device.{driver}", assignment.index),
                &name,
            )?;
        }
    }
    inner.revision = inner.revision.wrapping_add(1);
    Ok(())
}

#[tauri::command]
pub fn voicemeeter_launch(
    state: tauri::State<'_, VoicemeeterState>,
    edition: String,
) -> Result<(), String> {
    let code = match edition.to_ascii_lowercase().as_str() {
        "standard" => 1,
        "banana" => 2,
        "potato" => 3,
        _ => return Err("Unknown Voicemeeter edition".to_string()),
    };
    if !platform::installed_editions()
        .iter()
        .any(|item| item == &edition.to_ascii_lowercase())
    {
        return Err("Selected Voicemeeter edition is not installed".to_string());
    }
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Voicemeeter bridge lock failed".to_string())?;
    #[cfg(target_os = "windows")]
    {
        if inner.api.is_none() {
            inner.api = Some(platform::RemoteApi::load()?);
        }
        if !inner.logged_in {
            inner
                .api
                .as_ref()
                .ok_or_else(|| "Voicemeeter API unavailable".to_string())?
                .login()?;
            inner.logged_in = true;
        }
        inner
            .api
            .as_ref()
            .ok_or_else(|| "Voicemeeter API unavailable".to_string())?
            .run(code)?;
    }
    inner.revision = inner.revision.wrapping_add(1);
    Ok(())
}

#[tauri::command]
pub fn voicemeeter_safe_command(
    state: tauri::State<'_, VoicemeeterState>,
    action: String,
    index: Option<usize>,
) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Voicemeeter bridge lock failed".to_string())?;
    if !status_from_inner(&inner).connected {
        return Err("Voicemeeter is not running".to_string());
    }
    let parameter = match action.to_ascii_lowercase().as_str() {
        "show" => "Command.Show".to_string(),
        "restart" => "Command.Restart".to_string(),
        "preset" => {
            let slot = index.ok_or_else(|| "Preset slot is required".to_string())?;
            if slot > 255 {
                return Err("Preset slot must be between 0 and 255".to_string());
            }
            format!("Command.Preset[{slot}].Recall")
        }
        _ => return Err("Unsupported Voicemeeter command".to_string()),
    };
    #[cfg(target_os = "windows")]
    inner
        .api
        .as_ref()
        .ok_or_else(|| "Voicemeeter API unavailable".to_string())?
        .set_float(&parameter, 1.0)?;
    inner.revision = inner.revision.wrapping_add(1);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edition_capabilities_match_documented_layouts() {
        assert_eq!(capabilities_for(1).unwrap().strip_count, 3);
        assert_eq!(capabilities_for(2).unwrap().physical_bus_count, 3);
        assert_eq!(capabilities_for(3).unwrap().bus_count, 8);
    }
    #[test]
    fn parameter_validation_rejects_unsupported_or_out_of_range_values() {
        let gain = ParameterRef {
            scope: "strip".into(),
            index: 0,
            property: "gain".into(),
        };
        assert!(validate_parameter(&gain, 2, Some(0.0)).is_ok());
        assert!(validate_parameter(&gain, 2, Some(13.0)).is_err());
        let a4 = ParameterRef {
            scope: "strip".into(),
            index: 0,
            property: "a4".into(),
        };
        assert!(validate_parameter(&a4, 2, Some(1.0)).is_err());
        assert!(validate_parameter(&a4, 3, Some(1.0)).is_ok());
    }
    #[test]
    fn canonical_names_are_constructed_internally() {
        assert_eq!(
            canonical_parameter(&ParameterRef {
                scope: "bus".into(),
                index: 2,
                property: "mute".into()
            }),
            "Bus[2].mute"
        );
    }
    #[test]
    fn version_number_is_formatted_by_byte() {
        assert_eq!(format_version(0x02010508), "2.1.5.8");
    }

    #[test]
    fn device_validation_enforces_asio_a1_only() {
        let caps = capabilities_for(3).unwrap();
        assert!(validate_device_slot("bus", "output", 0, &caps).is_ok());
        assert!(validate_device_driver("bus", 0, "asio").is_ok());
        assert!(validate_device_driver("bus", 1, "asio")
            .unwrap_err()
            .contains("A1"));
        for driver in ["mme", "wdm", "ks"] {
            assert!(validate_device_driver("bus", 4, driver).is_ok());
            assert!(validate_device_driver("strip", 4, driver).is_ok());
        }
    }

    #[test]
    fn device_validation_rejects_invalid_targets_and_drivers() {
        let caps = capabilities_for(2).unwrap();
        assert!(validate_device_slot("bus", "output", 3, &caps).is_err());
        assert!(validate_device_slot("strip", "output", 0, &caps).is_err());
        assert!(validate_device_driver("bus", 0, "directsound").is_err());
        assert_eq!(
            supported_device_drivers("bus", 0),
            &["mme", "wdm", "ks", "asio"]
        );
        assert_eq!(supported_device_drivers("bus", 1), &["mme", "wdm", "ks"]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn installed_remote_api_exports_can_be_loaded() {
        if platform::is_installed() {
            platform::RemoteApi::load().expect("installed Voicemeeter Remote API should load");
        }
    }

    #[test]
    fn idle_snapshots_skip_parameter_and_metadata_reads() {
        assert!(!should_refresh_snapshot(false, false, false));
        assert!(should_refresh_snapshot(true, false, false));
        assert!(should_refresh_snapshot(false, true, false));
        assert!(should_refresh_snapshot(false, false, true));
    }
}

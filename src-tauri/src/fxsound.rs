//! Control the user's installed FxSound through its supported command line.
//! All calls are serialized; fresh status files are required before reporting a connection.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EqBand {
    pub index: usize,
    pub frequency: f32,
    pub gain: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Equalizer {
    pub num_bands: usize,
    pub master_gain: f32,
    pub bands: Vec<EqBand>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Preset {
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Presets {
    pub built_in: Vec<Preset>,
    pub user_defined: Vec<Preset>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FxSoundStatus {
    pub version: String,
    pub power: bool,
    pub selected_preset: String,
    pub presets: Presets,
    pub equalizer: Equalizer,
    pub effects: BTreeMap<String, f32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FxSoundSnapshot {
    pub installed: bool,
    pub connected: bool,
    pub detail: String,
    pub status: Option<FxSoundStatus>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FxSoundWrite {
    Band { index: usize, value: f32 },
    Effect { key: String, value: f32 },
    MasterGain { value: f32 },
    Power { value: bool },
}

#[derive(Default)]
struct Runtime {
    cached: Option<(Instant, FxSoundSnapshot)>,
}

#[derive(Default)]
pub struct FxSoundState {
    runtime: Arc<Mutex<Runtime>>,
}

fn checked(value: f32, min: f32, max: f32) -> Result<f32, String> {
    if !value.is_finite() || value < min || value > max {
        return Err(format!("FxSound value must be between {min} and {max}"));
    }
    Ok(value)
}

fn parse_status(bytes: &[u8]) -> Result<FxSoundStatus, String> {
    let status: FxSoundStatus = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let version: Vec<u32> = status
        .version
        .split('.')
        .filter_map(|part| part.parse().ok())
        .collect();
    if version.len() != 4 || version.as_slice() < [1, 2, 11, 0].as_slice() {
        return Err("FxSound 1.2.11.0 or newer is required for MIDI control".into());
    }
    let eq = &status.equalizer;
    if ![5, 10, 15, 20, 31].contains(&eq.num_bands) || eq.bands.len() != eq.num_bands {
        return Err("FxSound returned an invalid equalizer layout".into());
    }
    let mut indices = std::collections::HashSet::new();
    for band in &eq.bands {
        if band.index >= eq.num_bands || !indices.insert(band.index) {
            return Err("FxSound returned duplicate or invalid band indices".into());
        }
        checked(band.frequency, 1.0, 24_000.0)?;
        checked(band.gain, -12.0, 12.0)?;
    }
    checked(eq.master_gain, -20.0, 20.0)?;
    for value in status.effects.values() {
        checked(*value, 0.0, 10.0)?;
    }
    Ok(status)
}

fn write_arguments(writes: &[FxSoundWrite], status: &FxSoundStatus) -> Result<Vec<String>, String> {
    if writes.is_empty() || writes.len() > 64 {
        return Err("Send between 1 and 64 FxSound controls at a time".into());
    }
    let mut bands = BTreeMap::new();
    let mut effects = BTreeMap::new();
    let mut options = BTreeMap::new();
    for write in writes {
        match write {
            FxSoundWrite::Band { index, value } => {
                if !status
                    .equalizer
                    .bands
                    .iter()
                    .any(|band| band.index == *index)
                {
                    return Err("This FxSound EQ band is no longer available".into());
                }
                bands.insert(*index, checked(*value, -12.0, 12.0)?);
            }
            FxSoundWrite::Effect { key, value } => {
                if !["clarity", "ambience", "surround", "dynamicboost", "bass"]
                    .contains(&key.as_str())
                    || !status.effects.contains_key(key)
                {
                    return Err("Unsupported FxSound effect".into());
                }
                effects.insert(key, checked(*value, 0.0, 10.0)?);
            }
            FxSoundWrite::MasterGain { value } => {
                options.insert(
                    "master_gain",
                    checked(*value, -20.0, 20.0)?.round().to_string(),
                );
            }
            FxSoundWrite::Power { value } => {
                options.insert("power", u8::from(*value).to_string());
            }
        }
    }
    let mut args: Vec<String> = options
        .iter()
        .map(|(key, value)| format!("--{key}={value}"))
        .collect();
    if !bands.is_empty() {
        args.push(format!(
            "--set_band_gain={}",
            bands
                .iter()
                .map(|(i, v)| format!("{i}:{v:.4}"))
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    if !effects.is_empty() {
        args.push(format!(
            "--set_effect={}",
            effects
                .iter()
                .map(|(key, v)| format!("{key}:{v:.4}"))
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    Ok(args)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        fs,
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        thread,
    };
    use windows::Win32::{
        Foundation::{CloseHandle, HWND},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        UI::WindowsAndMessaging::{
            FindWindowW, GetForegroundWindow, IsIconic, IsWindow, IsWindowVisible,
            SetForegroundWindow, ShowWindow, SW_SHOWMINNOACTIVE,
        },
    };
    use winreg::{
        enums::{
            HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
        },
        RegKey,
    };

    pub(super) fn executable() -> Option<PathBuf> {
        let mut candidates = Vec::new();
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for flags in [KEY_READ | KEY_WOW64_64KEY, KEY_READ | KEY_WOW64_32KEY] {
                let Ok(root) = RegKey::predef(hive).open_subkey_with_flags(
                    r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                    flags,
                ) else {
                    continue;
                };
                for name in root.enum_keys().flatten() {
                    let Ok(key) = root.open_subkey(name) else {
                        continue;
                    };
                    if key
                        .get_value::<String, _>("DisplayName")
                        .is_ok_and(|name| name.eq_ignore_ascii_case("FxSound"))
                    {
                        if let Ok(dir) = key.get_value::<String, _>("InstallLocation") {
                            candidates
                                .push(PathBuf::from(dir.trim_matches('"')).join("FxSound.exe"));
                        }
                    }
                }
            }
        }
        for variable in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(variable) {
                candidates.push(PathBuf::from(root).join("FxSound LLC/FxSound/FxSound.exe"));
            }
        }
        candidates
            .into_iter()
            .find(|path| path.is_absolute() && path.is_file())
    }

    pub(super) fn running() -> Result<bool, String> {
        unsafe {
            let snapshot =
                CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| e.to_string())?;
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
            let mut found = false;
            while more {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..end])
                    .eq_ignore_ascii_case("FxSound.exe")
                {
                    found = true;
                    break;
                }
                more = Process32NextW(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
            Ok(found)
        }
    }

    pub(super) fn visible_window() -> Option<HWND> {
        unsafe {
            FindWindowW(None, windows::core::w!("FxSound"))
                .ok()
                .filter(|window| IsWindowVisible(*window).as_bool())
        }
    }

    pub(super) fn run(executable: &std::path::Path, args: &[String]) -> Result<(), String> {
        let status_only = args.iter().any(|arg| arg == "--status");
        let window = visible_window();
        let foreground = unsafe { GetForegroundWindow() };
        let minimized = window.is_some_and(|window| unsafe { IsIconic(window).as_bool() });
        let mut args = args.to_vec();
        // FxSound's CLI always shows or hides its GUI on writes. Keep an open
        // window open, and use its tray flag only when it was already hidden.
        // Status requests return before FxSound touches window visibility.
        if !status_only && window.is_none() {
            args.push("--run_minimized".into());
        }
        let result = run_command(executable, &args);
        if !status_only {
            if let Some(window) = window {
                unsafe {
                    if minimized && IsWindow(Some(window)).as_bool() {
                        let _ = ShowWindow(window, SW_SHOWMINNOACTIVE);
                    }
                    // FxSound also brings visible windows forward. Give focus
                    // back only if this command took it from another window.
                    if foreground != window
                        && GetForegroundWindow() == window
                        && IsWindow(Some(foreground)).as_bool()
                    {
                        let _ = SetForegroundWindow(foreground);
                    }
                }
            }
        }
        result
    }

    pub(super) fn run_command(executable: &std::path::Path, args: &[String]) -> Result<(), String> {
        let mut child = Command::new(executable)
            .args(args)
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Cannot run installed FxSound: {e}"))?;
        let started = Instant::now();
        loop {
            if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
                return if exit.success() {
                    Ok(())
                } else {
                    Err(format!("FxSound command failed: {exit}"))
                };
            }
            if started.elapsed() > Duration::from_secs(3) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("FxSound control command timed out".into());
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub(super) fn read_status(executable: &std::path::Path) -> Result<FxSoundStatus, String> {
        if !running()? {
            return Err("Start FxSound, then connect again".into());
        }
        let path = PathBuf::from(
            std::env::var_os("APPDATA").ok_or("Windows app data folder is unavailable")?,
        )
        .join("FxSound/status.json");
        let before = fs::metadata(&path).and_then(|m| m.modified()).ok();
        run(executable, &["--status".into()])?;
        let started = Instant::now();
        loop {
            if let Ok(metadata) = fs::metadata(&path) {
                if metadata.len() <= 128_000
                    && metadata
                        .modified()
                        .ok()
                        .is_some_and(|modified| before.is_none_or(|old| modified > old))
                {
                    if let Ok(bytes) = fs::read(&path) {
                        // The writer may still be finishing its JSON. Retry an incomplete read.
                        if let Ok(status) = parse_status(&bytes) {
                            return Ok(status);
                        }
                        if serde_json::from_slice::<serde_json::Value>(&bytes).is_ok() {
                            return parse_status(&bytes);
                        }
                    }
                }
            }
            if started.elapsed() > Duration::from_secs(2) {
                return Err("FxSound did not return fresh status. Use FxSound 1.2.11.0 or newer; if it was just installed, quit it from the tray and reopen normally (without administrator privileges).".into());
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

impl Runtime {
    fn snapshot(&mut self, force: bool) -> FxSoundSnapshot {
        if !force {
            if let Some((at, snapshot)) = &self.cached {
                if at.elapsed() < Duration::from_millis(750) {
                    return snapshot.clone();
                }
            }
        }
        #[cfg(windows)]
        let snapshot = match platform::executable() {
            Some(exe) => match platform::read_status(&exe) {
                Ok(status) => FxSoundSnapshot {
                    installed: true,
                    connected: true,
                    detail: format!("Connected to FxSound {}", status.version),
                    status: Some(status),
                },
                Err(detail) => FxSoundSnapshot {
                    installed: true,
                    connected: false,
                    detail,
                    status: None,
                },
            },
            None => FxSoundSnapshot {
                installed: false,
                connected: false,
                detail: "Install FxSound 1.2.11.0 or newer, then start it".into(),
                status: None,
            },
        };
        #[cfg(not(windows))]
        let snapshot = FxSoundSnapshot {
            installed: false,
            connected: false,
            detail: "FxSound control is available on Windows".into(),
            status: None,
        };
        self.cached = Some((Instant::now(), snapshot.clone()));
        snapshot
    }

    fn write(&mut self, writes: &[FxSoundWrite]) -> Result<(), String> {
        let snapshot = self.snapshot(false);
        let status = snapshot.status.ok_or(snapshot.detail)?;
        let args = write_arguments(writes, &status)?;
        self.execute(&args)
    }

    fn execute(&mut self, args: &[String]) -> Result<(), String> {
        self.cached = None;
        #[cfg(windows)]
        {
            if !platform::running()? {
                return Err("Start FxSound before using its controls".into());
            }
            let exe = platform::executable().ok_or("FxSound is not installed")?;
            platform::run(&exe, args)
        }
        #[cfg(not(windows))]
        {
            let _ = args;
            Err("FxSound control is available on Windows".into())
        }
    }

    fn preset(&mut self, name: &str) -> Result<(), String> {
        let snapshot = self.snapshot(false);
        let status = snapshot.status.ok_or(snapshot.detail)?;
        if name.is_empty()
            || name.len() > 256
            || name.chars().any(|c| c.is_control() || c == '"')
            || !status
                .presets
                .built_in
                .iter()
                .chain(&status.presets.user_defined)
                .any(|preset| preset.name == name)
        {
            return Err("Select an available FxSound preset".into());
        }
        if !status.power {
            return Err("Enable FxSound processing before selecting a preset".into());
        }
        self.execute(&[format!("--preset={name}")])
    }
}

#[tauri::command]
pub async fn fxsound_snapshot(
    state: tauri::State<'_, FxSoundState>,
    force: Option<bool>,
) -> Result<FxSoundSnapshot, String> {
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(runtime
            .lock()
            .map_err(|_| "FxSound controller unavailable")?
            .snapshot(force.unwrap_or(false)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fxsound_write(
    state: tauri::State<'_, FxSoundState>,
    writes: Vec<FxSoundWrite>,
) -> Result<(), String> {
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime
            .lock()
            .map_err(|_| "FxSound controller unavailable")?
            .write(&writes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fxsound_select_preset(
    state: tauri::State<'_, FxSoundState>,
    name: String,
) -> Result<(), String> {
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime
            .lock()
            .map_err(|_| "FxSound controller unavailable")?
            .preset(&name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> FxSoundStatus {
        parse_status(include_bytes!("../../scripts/fixtures/fxsound-status.json")).unwrap()
    }

    #[test]
    fn rejects_invalid_controls_and_stale_band_indices() {
        let status = fixture();
        for write in [
            FxSoundWrite::Band {
                index: 31,
                value: 0.0,
            },
            FxSoundWrite::Band {
                index: 0,
                value: f32::NAN,
            },
            FxSoundWrite::Effect {
                key: "--power".into(),
                value: 1.0,
            },
            FxSoundWrite::MasterGain { value: 21.0 },
        ] {
            assert!(write_arguments(&[write], &status).is_err());
        }
        assert!(write_arguments(&[], &status).is_err());
        let args = write_arguments(
            &[
                FxSoundWrite::Band {
                    index: 0,
                    value: -3.0,
                },
                FxSoundWrite::Band {
                    index: 0,
                    value: -2.0,
                },
                FxSoundWrite::Effect {
                    key: "bass".into(),
                    value: 4.0,
                },
            ],
            &status,
        )
        .unwrap();
        assert_eq!(
            args,
            ["--set_band_gain=0:-2.0000", "--set_effect=bass:4.0000"]
        );
    }

    #[test]
    fn validates_status_and_supported_versions() {
        let bytes = include_bytes!("../../scripts/fixtures/fxsound-status.json");
        let mut raw: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        raw["version"] = "1.2.10.0".into();
        assert!(parse_status(&serde_json::to_vec(&raw).unwrap()).is_err());
        raw["version"] = "1.2.13.0".into();
        raw["equalizer"]["bands"][1]["index"] = 0.into();
        assert!(parse_status(&serde_json::to_vec(&raw).unwrap()).is_err());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Requires installed FxSound; exercises and restores its window visibility"]
    fn installed_fxsound_window_visibility() {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, IsIconic, SetForegroundWindow, ShowWindow, SW_SHOWMINNOACTIVE,
        };
        let exe = platform::executable().expect("installed FxSound");
        let original = platform::read_status(&exe).expect("running FxSound");
        let window = platform::visible_window();
        let minimized = window.is_some_and(|window| unsafe { IsIconic(window).as_bool() });
        let foreground = unsafe { GetForegroundWindow() };
        struct Restore(PathBuf, bool, bool, windows::Win32::Foundation::HWND);
        impl Drop for Restore {
            fn drop(&mut self) {
                let args = if self.1 {
                    vec![]
                } else {
                    vec!["--run_minimized".into()]
                };
                platform::run_command(&self.0, &args).expect("restore FxSound window state");
                unsafe {
                    if self.2 {
                        if let Some(window) = platform::visible_window() {
                            let _ = ShowWindow(window, SW_SHOWMINNOACTIVE);
                        }
                    }
                    let _ = SetForegroundWindow(self.3);
                }
            }
        }
        let _restore = Restore(exe.clone(), window.is_some(), minimized, foreground);
        let band = &original.equalizer.bands[0];
        let args = write_arguments(
            &[FxSoundWrite::Band {
                index: band.index,
                value: band.gain,
            }],
            &original,
        )
        .unwrap();
        for (visible, minimized) in [(true, false), (true, true), (false, false)] {
            let visibility_args = if visible {
                vec![]
            } else {
                vec!["--run_minimized".into()]
            };
            platform::run_command(&exe, &visibility_args).unwrap();
            if minimized {
                unsafe {
                    let _ = ShowWindow(
                        platform::visible_window().expect("visible FxSound"),
                        SW_SHOWMINNOACTIVE,
                    );
                }
            }
            platform::run(&exe, &args).unwrap();
            let after = platform::visible_window();
            assert_eq!(
                after.is_some(),
                visible,
                "EQ writes must preserve open/hidden state"
            );
            assert_eq!(
                after.is_some_and(|window| unsafe { IsIconic(window).as_bool() }),
                minimized,
                "EQ writes must preserve minimized state"
            );
            let status = platform::read_status(&exe).unwrap();
            assert_eq!(
                platform::visible_window().is_some(),
                visible,
                "status polling must preserve visibility"
            );
            assert!((status.equalizer.bands[0].gain - band.gain).abs() < 0.01);
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Requires installed, running FxSound; changes and restores one EQ band"]
    fn installed_fxsound_round_trip() {
        let exe = platform::executable().expect("installed FxSound");
        let original = platform::read_status(&exe).expect("running FxSound");
        let window_was_visible = platform::visible_window().is_some();
        struct Restore(PathBuf, FxSoundStatus);
        impl Drop for Restore {
            fn drop(&mut self) {
                let writes = self
                    .1
                    .equalizer
                    .bands
                    .iter()
                    .map(|b| FxSoundWrite::Band {
                        index: b.index,
                        value: b.gain,
                    })
                    .collect::<Vec<_>>();
                let args = write_arguments(&writes, &self.1).unwrap();
                platform::run(&self.0, &args).expect("restore original FxSound EQ");
            }
        }
        let restore = Restore(exe.clone(), original.clone());
        let band = &original.equalizer.bands[0];
        let target = if band.gain > -11.0 {
            band.gain - 1.0
        } else {
            band.gain + 1.0
        };
        let started = Instant::now();
        let mut runtime = Runtime::default();
        runtime
            .write(&[FxSoundWrite::Band {
                index: band.index,
                value: target,
            }])
            .unwrap();
        let changed = platform::read_status(&exe).unwrap();
        assert!((changed.equalizer.bands[0].gain - target).abs() < 0.01);
        assert_eq!(changed.power, original.power);
        assert_eq!(changed.selected_preset, original.selected_preset);
        assert_eq!(
            platform::visible_window().is_some(),
            window_was_visible,
            "EQ writes must preserve FxSound window visibility"
        );
        println!(
            "FxSound write + verified read: {} ms",
            started.elapsed().as_millis()
        );
        drop(restore);
        let restored = platform::read_status(&exe).unwrap();
        for (before, after) in original
            .equalizer
            .bands
            .iter()
            .zip(&restored.equalizer.bands)
        {
            assert!((before.gain - after.gain).abs() < 0.01);
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Requires installed FxSound; changes and restores preset, EQ, and effects"]
    fn installed_fxsound_preset_and_effects() {
        let exe = platform::executable().expect("installed FxSound");
        let original = platform::read_status(&exe).expect("running FxSound");
        if !original.power {
            return;
        }
        struct Restore(PathBuf, FxSoundStatus);
        impl Drop for Restore {
            fn drop(&mut self) {
                platform::run(&self.0, &[format!("--preset={}", self.1.selected_preset)])
                    .expect("restore preset");
                let mut writes = self
                    .1
                    .equalizer
                    .bands
                    .iter()
                    .map(|b| FxSoundWrite::Band {
                        index: b.index,
                        value: b.gain,
                    })
                    .collect::<Vec<_>>();
                writes.extend(
                    self.1
                        .effects
                        .iter()
                        .map(|(key, value)| FxSoundWrite::Effect {
                            key: key.clone(),
                            value: *value,
                        }),
                );
                writes.push(FxSoundWrite::MasterGain {
                    value: self.1.equalizer.master_gain,
                });
                platform::run(&self.0, &write_arguments(&writes, &self.1).unwrap())
                    .expect("restore EQ and effects");
            }
        }
        let restore = Restore(exe.clone(), original.clone());
        let mut runtime = Runtime::default();
        runtime.preset("Light Processing").unwrap();
        let preset = platform::read_status(&exe).unwrap();
        assert_eq!(
            preset.selected_preset, "Light Processing",
            "preset names with spaces must reach FxSound"
        );
        let clarity = if preset.effects["clarity"] > 0.1 {
            preset.effects["clarity"] - 0.1
        } else {
            preset.effects["clarity"] + 0.1
        };
        runtime
            .write(&[
                FxSoundWrite::Effect {
                    key: "clarity".into(),
                    value: clarity,
                },
                FxSoundWrite::MasterGain { value: -1.0 },
            ])
            .unwrap();
        let changed = platform::read_status(&exe).unwrap();
        assert!((changed.effects["clarity"] - clarity).abs() < 0.01);
        assert_eq!(changed.equalizer.master_gain, -1.0);
        drop(restore);
        let restored = platform::read_status(&exe).unwrap();
        assert_eq!(restored.selected_preset, original.selected_preset);
        assert_eq!(
            restored.equalizer.master_gain,
            original.equalizer.master_gain
        );
        for (key, value) in original.effects {
            assert!((restored.effects[&key] - value).abs() < 0.01);
        }
        for (before, after) in original
            .equalizer
            .bands
            .iter()
            .zip(&restored.equalizer.bands)
        {
            assert!((before.gain - after.gain).abs() < 0.01);
        }
    }
}

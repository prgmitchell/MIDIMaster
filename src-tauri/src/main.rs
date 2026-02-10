#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_paths;
mod app_settings;
mod audio;
mod bindings;
mod commands;
mod midi;
mod model;
mod plugin_api;
mod profile_store;
mod store_api;
mod windows_autostart;
mod windows_display;
mod ws_bridge;

use app_paths::app_data_root_dir;
use app_settings::{AppSettings, AppSettingsStore};
use audio::AudioBackend;
use bindings::{apply_midi_event, find_binding, BindingKey, BindingState};
use commands::*;
use midi::MidiManager;
use model::{LearnedControl, MidiEvent, OsdSettings, Profile};
use windows_autostart::set_windows_autostart;
use windows_display::{display_device_id, monitor_display_name};

#[derive(Clone, Copy)]
enum DeviceTargetKind {
    Playback,
    Recording,
}

fn parse_device_target(device_id: &str) -> (DeviceTargetKind, &str) {
    if let Some(raw) = device_id.strip_prefix("recording:") {
        return (DeviceTargetKind::Recording, raw);
    }
    if let Some(raw) = device_id.strip_prefix("playback:") {
        return (DeviceTargetKind::Playback, raw);
    }
    (DeviceTargetKind::Playback, device_id)
}

use profile_store::ProfileStore;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tokio::time::sleep;

use plugin_api::{
    ensure_builtin_plugin, get_plugins_dir, install_plugin_package, list_plugins,
    read_plugin_base64, read_plugin_text, set_plugin_enabled, uninstall_plugin,
};
use store_api::{fetch_store_catalog, install_store_plugin};
use ws_bridge::{ws_close, ws_open, ws_send, WsHub};

#[cfg(target_os = "windows")]
use audio::windows::WindowsAudioBackend;

#[cfg(not(target_os = "windows"))]
use audio::unsupported::UnsupportedAudioBackend;

struct AppState {
    audio: Box<dyn AudioBackend>,
    midi: Arc<Mutex<MidiManager>>,
    profile_store: ProfileStore,
    app_settings_store: AppSettingsStore,
    active_profile: Mutex<Option<Profile>>,
    binding_state: Arc<Mutex<HashMap<BindingKey, BindingState>>>,
    feedback_values: Arc<Mutex<HashMap<BindingKey, f32>>>,
    learn_pending: Mutex<bool>,
    learn_candidate: Mutex<Option<(LearnedControl, Instant)>>,
    learned_control: Mutex<Option<LearnedControl>>,
    osd_last_update: Mutex<Option<Instant>>,
    osd_settings: Mutex<OsdSettings>,
    app_settings: Mutex<AppSettings>,
}

impl AppState {
    fn apply_osd_settings(app: &AppHandle, settings: &OsdSettings) {
        let Some(osd_window) = app.get_webview_window("osd") else {
            return;
        };

        if !settings.enabled {
            let _ = osd_window.hide();
            return;
        }

        let _ = osd_window.set_always_on_top(true);

        // Force topmost on Windows using native API for fullscreen game compatibility
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
            };

            if let Ok(hwnd) = osd_window.hwnd() {
                unsafe {
                    let _ = SetWindowPos(
                        HWND(hwnd.0 as _),
                        Some(HWND_TOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE,
                    );
                }
            }
        }

        let monitor = app
            .available_monitors()
            .ok()
            .and_then(|monitors| {
                // First try to find by monitor_id if provided
                if let Some(ref id) = settings.monitor_id {
                    if let Some(m) = monitors.iter().find(|m| {
                        let raw_name = m.name().cloned().unwrap_or_default();
                        let m_id = display_device_id(&raw_name).unwrap_or_else(|| raw_name);
                        m_id == *id
                    }) {
                        return Some(m.clone());
                    }
                }
                // Then try to find by name if provided (legacy)
                if let Some(ref name) = settings.monitor_name {
                    if let Some(m) = monitors.iter().find(|m| {
                        let raw_name = m.name().cloned().unwrap_or_default();
                        let m_name = monitor_display_name(&raw_name).unwrap_or_else(|| raw_name);
                        m_name == *name
                    }) {
                        return Some(m.clone());
                    }
                }
                // Fall back to index
                monitors
                    .get(settings.monitor_index)
                    .cloned()
                    .or_else(|| monitors.first().cloned())
            })
            .or_else(|| app.primary_monitor().ok().flatten());

        if let Some(monitor) = monitor {
            let scale_factor = monitor.scale_factor();
            let size = monitor.size();
            let position = monitor.position();
            let width = 320.0;
            let height = 800.0;
            let padding = 24.0;
            let logical_width = size.width as f64 / scale_factor;
            let logical_height = size.height as f64 / scale_factor;
            let origin_x = position.x as f64 / scale_factor;
            let origin_y = position.y as f64 / scale_factor;
            let anchor = settings.anchor.as_str();
            let (mut x, mut y) = match anchor {
                "top-left" => (origin_x + padding, origin_y + padding),
                "top-center" => (origin_x + (logical_width - width) / 2.0, origin_y + padding),
                "top-right" => (
                    origin_x + logical_width - width - padding,
                    origin_y + padding,
                ),
                "center-left" => (
                    origin_x + padding,
                    origin_y + (logical_height - height) / 2.0,
                ),
                "center" => (
                    origin_x + (logical_width - width) / 2.0,
                    origin_y + (logical_height - height) / 2.0,
                ),
                "center-right" => (
                    origin_x + logical_width - width - padding,
                    origin_y + (logical_height - height) / 2.0,
                ),
                "bottom-left" => (
                    origin_x + padding,
                    origin_y + logical_height - height - padding,
                ),
                "bottom-center" => (
                    origin_x + (logical_width - width) / 2.0,
                    origin_y + logical_height - height - padding,
                ),
                "bottom-right" => (
                    origin_x + logical_width - width - padding,
                    origin_y + logical_height - height - padding,
                ),
                _ => (
                    origin_x + logical_width - width - padding,
                    origin_y + padding,
                ),
            };
            x = x.max(origin_x + padding);
            y = y.max(origin_y + padding);
            let _ = osd_window.set_size(LogicalSize::new(width, height));
            let _ = osd_window.set_position(LogicalPosition::new(x, y));
        }
    }

    fn apply_app_settings(_app: &AppHandle, settings: &AppSettings) {
        #[cfg(target_os = "windows")]
        {
            let _ = set_windows_autostart(settings.start_with_windows);
        }
    }

    fn apply_midi_event(&self, app: &AppHandle, event: MidiEvent) -> Result<(), String> {
        let mut learn_pending = self.learn_pending.lock().map_err(|_| "Lock poisoned")?;
        if *learn_pending {
            let msg_type = event.msg_type.clone();
            let learned = LearnedControl {
                device_id: event.device_id.clone(),
                channel: event.channel,
                controller: event.controller,
                msg_type: msg_type.clone(),
            };

            if matches!(msg_type, model::MidiMessageType::Note) {
                // Buffer note events as candidates to filter out touch-sense faders
                if let Ok(mut candidate) = self.learn_candidate.lock() {
                    *candidate = Some((learned, Instant::now()));
                }
                return Ok(());
            }

            // Immediate accept for non-Note events (CC, PitchBend)
            *learn_pending = false;
            drop(learn_pending);

            // Clear any pending candidate
            if let Ok(mut candidate) = self.learn_candidate.lock() {
                *candidate = None;
            }

            *self.learned_control.lock().map_err(|_| "Lock poisoned")? = Some(learned.clone());
            // println!(
            //   "MIDI learn: device={} channel={} controller={} msg_type={:?}",
            //   learned.device_id, learned.channel, learned.controller, learned.msg_type
            // );
            return Ok(());
        }

        let profile = match self
            .active_profile
            .lock()
            .map_err(|_| "Lock poisoned")?
            .clone()
        {
            Some(profile) => profile,
            None => return Ok(()),
        };
        let key = BindingKey::from_event(&event);
        // println!("Looking for binding: Key={:?} DeviceID={}", key, event.device_id);
        let binding = match find_binding(&profile, &key) {
            Some(binding) => {
                // println!("Found binding: {} -> {:?}", binding.name, binding.target);
                binding.clone()
            }
            None => {
                // println!("No binding found. Available keys in profile:");
                // for b in &profile.bindings {
                //      println!("  - {:?}", BindingKey::from_binding(b));
                // }
                return Ok(());
            }
        };

        let volume = {
            let mut states = self.binding_state.lock().map_err(|_| "Lock poisoned")?;
            let state = states.entry(key.clone()).or_insert_with(|| BindingState {
                last_value: 0.0,
                last_update: Instant::now(),
            });
            apply_midi_event(&binding, &event, state)
        };

        let volume = match volume {
            Some(v) => v,
            None => return Ok(()),
        };

        // Handle toggle mute action for button bindings
        if binding.action == model::BindingAction::ToggleMute {
            // Mark user activity to prevent stale feedback loop
            if let Ok(mut states) = self.binding_state.lock() {
                if let Some(state) = states.get_mut(&key) {
                    state.last_update = Instant::now();
                }
            }

            // On button release (value == 0), re-send current state to enforce latching check
            // This fixes controllers that turn off LED on release (momentary behavior)
            if event.value == 0 {
                let key_clone = key.clone();
                // Clone Arcs for async task
                let feedback_arc = self.feedback_values.clone();
                let midi_arc = self.midi.clone();

                let device_id = binding.device_id.clone();
                let channel = binding.control.channel;
                let controller = binding.control.controller;
                let msg_type = binding.control.msg_type.clone();

                tauri::async_runtime::spawn(async move {
                    // Sleep for 20ms to allow the hardware to process the "Note Off" completely
                    tokio::time::sleep(Duration::from_millis(20)).await;

                    if let Ok(feedback) = feedback_arc.lock() {
                        let current_val = feedback.get(&key_clone).cloned().unwrap_or(0.0);
                        if let Ok(mut midi) = midi_arc.lock() {
                            let _ = midi.send_feedback(
                                &device_id,
                                channel,
                                controller,
                                current_val,
                                msg_type,
                            );
                        }
                    }
                });
                return Ok(());
            }

            let muted = match &binding.target {
                model::BindingTarget::Master => {
                    let sessions = self.audio.list_sessions().map_err(|err| err.to_string())?;
                    let master = sessions.iter().find(|session| session.is_master);
                    let current_muted = master.map(|session| session.is_muted).unwrap_or(false);
                    let new_muted = !current_muted;
                    self.audio
                        .set_master_mute(new_muted)
                        .map_err(|err| err.to_string())?;
                    new_muted
                }
                model::BindingTarget::Focus => {
                    if let Some(focused) = self.audio.focused_session().ok().flatten() {
                        let new_muted = !focused.is_muted;
                        self.audio
                            .set_focused_session_mute(new_muted)
                            .map_err(|err| err.to_string())?;
                        new_muted
                    } else {
                        return Ok(());
                    }
                }
                model::BindingTarget::Application { name } => {
                    let sessions = self.audio.list_sessions().map_err(|err| err.to_string())?;
                    let target = name.to_lowercase();
                    let session = sessions.iter().find(|session| {
                        if let Some(path) = &session.process_path {
                            if let Some(stem) = std::path::Path::new(path)
                                .file_stem()
                                .and_then(|s| s.to_str())
                            {
                                if stem.to_lowercase() == target {
                                    return true;
                                }
                            }
                        }
                        if let Some(name) = &session.process_name {
                            let stem = name.strip_suffix(".exe").unwrap_or(name);
                            if stem.to_lowercase() == target {
                                return true;
                            }
                        }
                        session.display_name.to_lowercase() == target
                    });
                    if let Some(session) = session {
                        let new_muted = !session.is_muted;
                        self.audio
                            .set_application_mute(name, new_muted)
                            .map_err(|err| err.to_string())?;
                        new_muted
                    } else {
                        return Ok(());
                    }
                }
                model::BindingTarget::Device { device_id } => {
                    let playback = self.audio.list_playback_devices().unwrap_or_default();
                    let recording = self.audio.list_recording_devices().unwrap_or_default();
                    let (kind, raw_id) = parse_device_target(device_id);
                    let device = match kind {
                        DeviceTargetKind::Playback => {
                            playback.iter().find(|device| device.id == raw_id)
                        }
                        DeviceTargetKind::Recording => {
                            recording.iter().find(|device| device.id == raw_id)
                        }
                    };
                    if let Some(device) = device {
                        let new_muted = !device.is_muted;
                        self.audio
                            .set_device_mute(device_id, new_muted)
                            .map_err(|err| err.to_string())?;
                        new_muted
                    } else {
                        return Ok(());
                    }
                }
                model::BindingTarget::Integration {
                    integration_id,
                    kind,
                    data,
                } => {
                    let current_val = self
                        .feedback_values
                        .lock()
                        .ok()
                        .and_then(|fb| fb.get(&key).cloned())
                        .unwrap_or(0.0);
                    let is_currently_muted = current_val > 0.5;
                    let new_muted = !is_currently_muted;

                    let payload = serde_json::json!({
                      "binding_id": binding.id,
                      "action": "ToggleMute",
                      "value": if new_muted { 1.0 } else { 0.0 },
                      "target": {
                        "integration_id": integration_id,
                        "kind": kind,
                        "data": data,
                      }
                    });
                    let _ = app.emit("integration_binding_triggered", payload);
                    return Ok(());
                }
                _ => {
                    return Ok(());
                }
            };

            if let Ok(mut last_update) = self.osd_last_update.lock() {
                *last_update = Some(Instant::now());
            }

            if let Ok(mut feedback) = self.feedback_values.lock() {
                feedback.insert(key.clone(), if muted { 1.0 } else { 0.0 });
            }

            if let Ok(mut midi) = self.midi.lock() {
                // println!("MIDI Event Matched Binding: {:?} -> {:?}", binding.name, binding.target);
                let _ = midi.send_feedback(
                    &binding.device_id,
                    binding.control.channel,
                    binding.control.controller,
                    if muted { 1.0 } else { 0.0 },
                    binding.control.msg_type.clone(),
                );
            }

            let focus_session = if matches!(&binding.target, model::BindingTarget::Focus) {
                self.audio.focused_session().ok().flatten()
            } else {
                None
            };

            let payload = serde_json::json!({
              "target": binding.target,
              "muted": muted,
              "action": "toggle_mute",
              "focus_session": focus_session,
            });
            let _ = app.emit("mute_update", payload.clone());

            let settings_enabled = self
                .osd_settings
                .lock()
                .map(|settings| settings.enabled)
                .unwrap_or(true);

            if settings_enabled {
                if let Some(osd_window) = app.get_webview_window("osd") {
                    let _ = osd_window.show();
                    let _ = osd_window.emit("mute_update", payload.clone());
                    if let Ok(payload_json) = serde_json::to_string(&payload) {
                        let script = format!(
                            "window.__OSD_UPDATE__ && window.__OSD_UPDATE__({});",
                            payload_json
                        );
                        let _ = osd_window.eval(&script);
                    }
                }
            }

            return Ok(());
        }

        match &binding.target {
            model::BindingTarget::Master => self
                .audio
                .set_master_volume(volume)
                .map_err(|err| err.to_string())?,
            model::BindingTarget::Focus => self
                .audio
                .set_focused_session_volume(volume)
                .map_err(|err| err.to_string())?,
            model::BindingTarget::Session { session_id } => self
                .audio
                .set_session_volume(session_id, volume)
                .map_err(|err| err.to_string())?,
            model::BindingTarget::Application { name } => self
                .audio
                .set_application_volume(name, volume)
                .map_err(|err| err.to_string())?,
            model::BindingTarget::Device { device_id } => self
                .audio
                .set_device_volume(device_id, volume)
                .map_err(|err| err.to_string())?,
            model::BindingTarget::Unset => {
                return Ok(());
            }
            model::BindingTarget::Integration {
                integration_id,
                kind,
                data,
            } => {
                let payload = serde_json::json!({
                  "binding_id": binding.id,
                  "action": "Volume",
                  "value": volume,
                  "target": {
                    "integration_id": integration_id,
                    "kind": kind,
                    "data": data,
                  }
                });
                let _ = app.emit("integration_binding_triggered", payload);
                return Ok(());
            }
        }

        if let Ok(mut feedback) = self.feedback_values.lock() {
            feedback.insert(key.clone(), volume);
        }

        if let Ok(mut last_update) = self.osd_last_update.lock() {
            *last_update = Some(Instant::now());
        }

        if let Ok(mut midi) = self.midi.lock() {
            let _ = midi.send_feedback(
                &binding.device_id,
                binding.control.channel,
                binding.control.controller,
                volume,
                binding.control.msg_type.clone(),
            );
        }

        let focus_session = if matches!(&binding.target, model::BindingTarget::Focus) {
            self.audio.focused_session().ok().flatten()
        } else {
            None
        };
        let payload = serde_json::json!({
          "target": binding.target,
          "volume": volume,
          "focus_session": focus_session,
          "binding_id": binding.id
        });
        let _ = app.emit("volume_update", payload.clone());
        let settings_enabled = self
            .osd_settings
            .lock()
            .map(|settings| settings.enabled)
            .unwrap_or(true);
        if settings_enabled {
            if let Some(osd_window) = app.get_webview_window("osd") {
                let _ = osd_window.show();
                let _ = osd_window.emit("volume_update", payload.clone());
                if let Ok(payload_json) = serde_json::to_string(&payload) {
                    let script = format!(
                        "window.__OSD_UPDATE__ && window.__OSD_UPDATE__({});",
                        payload_json
                    );
                    let _ = osd_window.eval(&script);
                }
            }
        }

        Ok(())
    }

    fn sync_feedback_values(&self, profile: &Profile) {
        let sessions = match self.audio.list_sessions() {
            Ok(sessions) => sessions,
            Err(_) => return,
        };
        let playback_devices = self.audio.list_playback_devices().unwrap_or_default();
        let recording_devices = self.audio.list_recording_devices().unwrap_or_default();
        let mut feedback = match self.feedback_values.lock() {
            Ok(feedback) => feedback,
            Err(_) => return,
        };

        for binding in &profile.bindings {
            let value = if binding.action == model::BindingAction::ToggleMute {
                match &binding.target {
                    model::BindingTarget::Master => sessions
                        .iter()
                        .find(|session| session.is_master)
                        .map(|session| if session.is_muted { 1.0 } else { 0.0 }),
                    model::BindingTarget::Focus => self
                        .audio
                        .focused_session()
                        .ok()
                        .flatten()
                        .map(|s| if s.is_muted { 1.0 } else { 0.0 }),
                    model::BindingTarget::Session { session_id } => sessions
                        .iter()
                        .find(|session| session.id == *session_id)
                        .map(|session| if session.is_muted { 1.0 } else { 0.0 }),
                    model::BindingTarget::Application { name } => {
                        let target = name.to_lowercase();
                        sessions
                            .iter()
                            .find(|session| {
                                if let Some(path) = &session.process_path {
                                    if let Some(stem) = Path::new(path)
                                        .file_stem()
                                        .and_then(|s: &std::ffi::OsStr| s.to_str())
                                    {
                                        if stem.to_lowercase() == target {
                                            return true;
                                        }
                                    }
                                }
                                if let Some(name) = &session.process_name {
                                    let stem = name.strip_suffix(".exe").unwrap_or(name);
                                    if stem.to_lowercase() == target {
                                        return true;
                                    }
                                }
                                session.display_name.to_lowercase() == target
                            })
                            .map(|session| if session.is_muted { 1.0 } else { 0.0 })
                    }
                    model::BindingTarget::Device { device_id } => {
                        let (kind, raw_id) = parse_device_target(device_id);
                        match kind {
                            DeviceTargetKind::Playback => playback_devices
                                .iter()
                                .find(|device| device.id == raw_id)
                                .map(|device| if device.is_muted { 1.0 } else { 0.0 }),
                            DeviceTargetKind::Recording => recording_devices
                                .iter()
                                .find(|device| device.id == raw_id)
                                .map(|device| if device.is_muted { 1.0 } else { 0.0 }),
                        }
                    }
                    model::BindingTarget::Unset => None,
                    model::BindingTarget::Integration { .. } => None,
                }
            } else {
                match &binding.target {
                    model::BindingTarget::Master => sessions
                        .iter()
                        .find(|session| session.is_master)
                        .map(|session| session.volume),
                    model::BindingTarget::Focus => None,
                    model::BindingTarget::Session { session_id } => sessions
                        .iter()
                        .find(|session| session.id == *session_id)
                        .map(|session| session.volume),
                    model::BindingTarget::Application { name } => {
                        let target = name.to_lowercase();
                        sessions
                            .iter()
                            .find(|session| {
                                if let Some(path) = &session.process_path {
                                    if let Some(stem) = Path::new(path)
                                        .file_stem()
                                        .and_then(|s: &std::ffi::OsStr| s.to_str())
                                    {
                                        if stem.to_lowercase() == target {
                                            return true;
                                        }
                                    }
                                }
                                if let Some(name) = &session.process_name {
                                    let stem = name.strip_suffix(".exe").unwrap_or(name);
                                    if stem.to_lowercase() == target {
                                        return true;
                                    }
                                }
                                session.display_name.to_lowercase() == target
                            })
                            .map(|session| session.volume)
                    }
                    model::BindingTarget::Device { device_id } => {
                        let (kind, raw_id) = parse_device_target(device_id);
                        match kind {
                            DeviceTargetKind::Playback => playback_devices
                                .iter()
                                .find(|device| device.id == raw_id)
                                .map(|device| device.volume),
                            DeviceTargetKind::Recording => recording_devices
                                .iter()
                                .find(|device| device.id == raw_id)
                                .map(|device| device.volume),
                        }
                    }
                    model::BindingTarget::Unset => None,
                    model::BindingTarget::Integration { .. } => None,
                }
            };

            if let Some(val) = value {
                feedback.insert(BindingKey::from_binding(binding), val);
            }
        }
    }
}

fn shutdown_lights(state: &AppState) {
    if let Ok(profile_guard) = state.active_profile.lock() {
        if let Some(profile) = profile_guard.as_ref() {
            if let Ok(mut midi) = state.midi.lock() {
                for binding in &profile.bindings {
                    let _ = midi.send_feedback(
                        &binding.device_id,
                        binding.control.channel,
                        binding.control.controller,
                        0.0,
                        binding.control.msg_type.clone(),
                    );
                }
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        ^ tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .setup(|app| {
            let config_dir = app_data_root_dir(&app.handle())
                .map_err(|_| "Unable to resolve config directory".to_string())?;

            // Ensure bundled plugins exist in the runtime plugins directory.
            ensure_builtin_plugin(
                &app.handle(),
                "wavelink",
                include_str!("../builtin_plugins/wavelink/manifest.json"),
                include_str!("../builtin_plugins/wavelink/plugin.mjs"),
                &[(
                    "WaveLinkLogo.png",
                    include_bytes!("../builtin_plugins/wavelink/WaveLinkLogo.png") as &[u8],
                )],
            );
            ensure_builtin_plugin(
                &app.handle(),
                "obs",
                include_str!("../builtin_plugins/obs/manifest.json"),
                include_str!("../builtin_plugins/obs/plugin.mjs"),
                &[(
                    "OBSLogo.png",
                    include_bytes!("../builtin_plugins/obs/OBSLogo.png") as &[u8],
                )],
            );
            let profile_store = ProfileStore::new(config_dir.clone());
            let app_settings_store = AppSettingsStore::new(config_dir);
            let app_settings = app_settings_store.load().unwrap_or_default();
            let audio: Box<dyn AudioBackend> = {
                #[cfg(target_os = "windows")]
                {
                    Box::new(WindowsAudioBackend::new())
                }
                #[cfg(not(target_os = "windows"))]
                {
                    Box::new(UnsupportedAudioBackend::new())
                }
            };

            // Shared WebSocket bridge for integration plugins.
            app.manage(WsHub::new());

            app.manage(AppState {
                audio,
                midi: Arc::new(Mutex::new(MidiManager::new())),
                profile_store,
                app_settings_store,
                active_profile: Mutex::new(None),
                binding_state: Arc::new(Mutex::new(HashMap::new())),
                feedback_values: Arc::new(Mutex::new(HashMap::new())),
                learn_pending: Mutex::new(false),
                learn_candidate: Mutex::new(None),
                learned_control: Mutex::new(None),
                osd_last_update: Mutex::new(None),
                osd_settings: Mutex::new(OsdSettings::default()),
                app_settings: Mutex::new(app_settings.clone()),
            });

            let osd_window =
                WebviewWindowBuilder::new(app, "osd", WebviewUrl::App("index.html?osd=1".into()))
                    .title("MIDIMaster OSD")
                    .decorations(false)
                    .transparent(true)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .resizable(false)
                    .focused(false)
                    .shadow(false)
                    .inner_size(320.0, 120.0)
                    .build()?;
            let _ = osd_window.set_ignore_cursor_events(true);
            let _ = osd_window.hide();
            if let Ok(settings) = app.state::<AppState>().osd_settings.lock() {
                AppState::apply_osd_settings(&app.handle(), &settings);
            }
            if let Ok(settings) = app.state::<AppState>().app_settings.lock() {
                AppState::apply_app_settings(&app.handle(), &settings);
                if let Some(window) = app.get_webview_window("main") {
                    if settings.start_in_tray {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let mut tray_builder = TrayIconBuilder::new().menu(&tray_menu);
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            tray_builder
                .on_menu_event(
                    |app: &AppHandle, event: MenuEvent| match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            let state = app.state::<AppState>();
                            shutdown_lights(&state);
                            app.exit(0);
                        }
                        _ => {}
                    },
                )
                .build(app)?;

            let app_handle = app.handle().clone();
            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle = app_handle.clone();
                let main_window_handle = main_window.clone();
                main_window.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        let exit_to_tray = app_handle
                            .state::<AppState>()
                            .app_settings
                            .lock()
                            .map(|settings| settings.exit_to_tray)
                            .unwrap_or(false);
                        if exit_to_tray {
                            api.prevent_close();
                            let _ = main_window_handle.hide();
                            return;
                        }
                        if let Some(osd_window) = app_handle.get_webview_window("osd") {
                            let _ = osd_window.close();
                        }
                        let state = app_handle.state::<AppState>();
                        shutdown_lights(&state);
                        app_handle.exit(0);
                    }
                    tauri::WindowEvent::Destroyed => {
                        let state = app_handle.state::<AppState>();
                        shutdown_lights(&state);
                        app_handle.exit(0);
                    }
                    tauri::WindowEvent::Resized(_) => {
                        let minimize_to_tray = app_handle
                            .state::<AppState>()
                            .app_settings
                            .lock()
                            .map(|settings| settings.minimize_to_tray)
                            .unwrap_or(false);
                        if minimize_to_tray {
                            if let Ok(true) = main_window_handle.is_minimized() {
                                let _ = main_window_handle.hide();
                            }
                        }
                    }
                    _ => {}
                });
            }

            let _app_handle = app.handle().clone();

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut last_known_volumes: HashMap<BindingKey, f32> = HashMap::new();
                loop {
                    let state = app_handle.state::<AppState>();

                    // Check for expired learn candidates
                    let mut commit_candidate = None;
                    if let Ok(mut candidate_guard) = state.learn_candidate.lock() {
                        if let Some((_, time)) = &*candidate_guard {
                            if time.elapsed() > Duration::from_millis(150) {
                                commit_candidate = candidate_guard.take().map(|(l, _)| l);
                            }
                        }
                    }
                    if let Some(candidate) = commit_candidate {
                        if let Ok(mut pending) = state.learn_pending.lock() {
                            if *pending {
                                *pending = false;
                                if let Ok(mut learned) = state.learned_control.lock() {
                                    *learned = Some(candidate.clone());
                                }
                            }
                        }
                    }

                    let profile = state
                        .active_profile
                        .lock()
                        .ok()
                        .and_then(|profile| profile.clone());
                    if let Some(profile) = profile {
                        state.sync_feedback_values(&profile);
                        let feedback = state
                            .feedback_values
                            .lock()
                            .map(|values| values.clone())
                            .unwrap_or_default();

                        if let Ok(mut midi) = state.midi.lock() {
                            for binding in &profile.bindings {
                                let key = BindingKey::from_binding(binding);
                                if let Some(volume) = feedback.get(&key).cloned() {
                                    // Volume Protection & Clamp Logic

                                    last_known_volumes.insert(key.clone(), volume);

                                    let _ = midi.send_feedback(
                                        &binding.device_id,
                                        binding.control.channel,
                                        binding.control.controller,
                                        volume,
                                        binding.control.msg_type.clone(),
                                    );
                                }
                            }
                        }
                    }

                    let settings_enabled = state
                        .osd_settings
                        .lock()
                        .map(|settings| settings.enabled)
                        .unwrap_or(true);
                    if settings_enabled {
                        let should_hide = state
                            .osd_last_update
                            .lock()
                            .ok()
                            .and_then(|value| {
                                value.map(|time| time.elapsed() > Duration::from_millis(1200))
                            })
                            .unwrap_or(false);
                        if should_hide {
                            if let Some(osd_window) = app_handle.get_webview_window("osd") {
                                let _ = osd_window.hide();
                            }
                            if let Ok(mut guard) = state.osd_last_update.lock() {
                                *guard = None;
                            }
                        }
                    }

                    sleep(Duration::from_millis(50)).await;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_midi_devices,
            list_midi_output_devices,
            start_midi_device,
            stop_midi_device,
            list_sessions,
            list_monitors,
            get_osd_settings,
            update_osd_settings,
            get_app_settings,
            update_app_settings,
            reset_app_data,
            list_playback_devices,
            list_recording_devices,
            set_master_volume,
            set_session_volume,
            set_application_volume,
            set_device_volume,
            set_master_mute,
            set_session_mute,
            set_application_mute,
            set_device_mute,
            list_profiles,
            load_profile,
            save_profile,
            delete_profile,
            get_active_profile,
            start_midi_learn,
            consume_learned_control,
            add_binding,
            remove_binding,
            update_midi_feedback,
            set_binding_feedback,
            get_plugins_dir,
            list_plugins,
            read_plugin_text,
            read_plugin_base64,
            install_plugin_package,
            uninstall_plugin,
            set_plugin_enabled,
            ws_open,
            ws_send,
            ws_close,
            fetch_store_catalog,
            install_store_plugin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use crate::app_settings::{AppSettings, AppSettingsStore};
use crate::audio::AudioBackend;
use crate::bindings::{BindingKey, BindingState};
use crate::device_target::{parse_device_target, DeviceTargetKind};
use crate::midi::MidiManager;
use crate::midi_event_queue::MidiEventQueue;
use crate::model::{self, LearnedControl, MidiEvent, OsdSettings, Profile};
use crate::profile_store::ProfileStore;
use crate::run_logger;
use crate::runtime_helpers::LearnCandidate;
use crate::windows_autostart::set_windows_autostart;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[cfg(target_os = "windows")]
use windows::core::PWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::CloseHandle;
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

#[cfg(target_os = "windows")]
pub(crate) fn focused_application_name() -> Option<String> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return None;
    }

    let mut process_id = 0u32;
    unsafe {
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    if process_id == 0 {
        return None;
    }

    let process_handle =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()? };

    let mut buffer = vec![0u16; 1024];
    let mut length = buffer.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(
            process_handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .is_ok()
    };
    let _ = unsafe { CloseHandle(process_handle) };
    if !ok || length == 0 {
        return None;
    }

    let path = String::from_utf16_lossy(&buffer[..length as usize]);
    Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn focused_application_name() -> Option<String> {
    None
}

pub(crate) struct AppState {
    pub(crate) audio: Box<dyn AudioBackend>,
    pub(crate) midi: Arc<Mutex<MidiManager>>,
    pub(crate) midi_event_queue: Arc<Mutex<MidiEventQueue>>,
    pub(crate) profile_store: ProfileStore,
    pub(crate) app_settings_store: AppSettingsStore,
    pub(crate) active_profile: Mutex<Option<Profile>>,
    pub(crate) binding_state: Arc<Mutex<HashMap<BindingKey, BindingState>>>,
    pub(crate) feedback_values: Arc<Mutex<HashMap<BindingKey, f32>>>,
    pub(crate) last_mute_input_active: Mutex<HashMap<BindingKey, bool>>,
    pub(crate) focus_volume_failure_logs: Mutex<HashMap<String, Instant>>,
    pub(crate) mute_transition_until: Mutex<HashMap<BindingKey, Instant>>,
    pub(crate) last_target_mute_state: Mutex<HashMap<BindingKey, bool>>,
    pub(crate) learn_pending: Mutex<bool>,
    pub(crate) learn_candidate: Mutex<Option<LearnCandidate>>,
    pub(crate) learned_control: Mutex<Option<LearnedControl>>,
    pub(crate) osd_last_update: Mutex<Option<Instant>>,
    pub(crate) osd_settings: Mutex<OsdSettings>,
    pub(crate) app_settings: Mutex<AppSettings>,
}

impl AppState {
    fn clear_focus_volume_failure_log(&self, binding_id: &str) {
        if let Ok(mut logs) = self.focus_volume_failure_logs.lock() {
            logs.remove(binding_id);
        }
    }

    fn should_log_focus_volume_failure(&self, binding_id: &str) -> bool {
        const LOG_THROTTLE: Duration = Duration::from_secs(2);
        let now = Instant::now();
        if let Ok(mut logs) = self.focus_volume_failure_logs.lock() {
            if let Some(last) = logs.get(binding_id) {
                if now.duration_since(*last) < LOG_THROTTLE {
                    return false;
                }
            }
            logs.insert(binding_id.to_string(), now);
            return true;
        }
        true
    }

    pub(crate) fn apply_focus_volume_with_retry(&self, binding_id: &str, volume: f32) -> bool {
        if self.audio.set_focused_session_volume(volume).is_ok() {
            self.clear_focus_volume_failure_log(binding_id);
            return true;
        }

        let fallback_focus = self.audio.focused_session().ok().flatten();
        if let Some(ref session) = fallback_focus {
            if self.audio.set_session_volume(&session.id, volume).is_ok() {
                self.clear_focus_volume_failure_log(binding_id);
                run_logger::info(
                    "bindings",
                    "set_focus_volume_fallback_applied",
                    &format!("binding_id={} session_id={}", binding_id, session.id),
                );
                return true;
            }
        }

        if self.should_log_focus_volume_failure(binding_id) {
            run_logger::error(
                "bindings",
                "set_focus_volume_failed",
                &format!(
                    "binding_id={} error=Focused session not found; fallback_session_present={}",
                    binding_id,
                    fallback_focus.is_some()
                ),
            );
        }
        false
    }

    pub(crate) fn apply_osd_settings(app: &AppHandle, settings: &OsdSettings) {
        crate::osd_window::apply_osd_settings(app, settings);
    }

    pub(crate) fn emit_osd_update(
        app: &AppHandle,
        state: &AppState,
        payload: &serde_json::Value,
        silent: bool,
    ) {
        crate::osd_window::emit_osd_update(app, state, payload, silent);
    }
    pub(crate) fn apply_app_settings(_app: &AppHandle, settings: &AppSettings) {
        #[cfg(target_os = "windows")]
        {
            let _ = set_windows_autostart(settings.start_with_windows);
        }
    }

    pub(crate) fn binding_matches_aux(
        mapping: &model::AuxiliaryControl,
        event: &MidiEvent,
    ) -> bool {
        mapping.device_id == event.device_id
            && mapping.channel == event.channel
            && mapping.controller == event.controller
            && mapping.msg_type == event.msg_type
    }

    pub(crate) fn resolve_target_mute_state(
        event_value: u8,
        current_muted: bool,
        behavior: model::MuteBehavior,
        previous_input_active: Option<bool>,
    ) -> Option<bool> {
        let input_active = event_value > 0;
        match behavior {
            model::MuteBehavior::ToggleOnPress => {
                if event_value == 0 {
                    None
                } else {
                    Some(!current_muted)
                }
            }
            model::MuteBehavior::SetFromValue => {
                if let Some(previous_input_active) = previous_input_active {
                    if previous_input_active == input_active {
                        return None;
                    }
                    Some(!current_muted)
                } else if input_active == current_muted {
                    None
                } else {
                    Some(!current_muted)
                }
            }
        }
    }

    pub(crate) fn apply_midi_event(&self, app: &AppHandle, event: MidiEvent) -> Result<(), String> {
        crate::runtime_midi::apply_midi_event(self, app, event)
    }

    pub(crate) fn sync_feedback_values(&self, profile: &Profile) {
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
        let mut mute_transition_until = match self.mute_transition_until.lock() {
            Ok(map) => map,
            Err(_) => return,
        };
        let mut last_target_mute_state = match self.last_target_mute_state.lock() {
            Ok(map) => map,
            Err(_) => return,
        };
        let now = Instant::now();

        for binding in &profile.bindings {
            let key = BindingKey::from_binding(binding);
            let primary_target = binding.primary_target();
            if matches!(
                binding.action,
                model::BindingAction::MediaPlayPause
                    | model::BindingAction::MediaNextTrack
                    | model::BindingAction::MediaPrevTrack
                    | model::BindingAction::MediaStop
                    | model::BindingAction::Hotkey
                    | model::BindingAction::OpenApplication
                    | model::BindingAction::SetDefaultDevice
            ) {
                continue;
            }

            let mut current_target_muted: Option<bool> = None;
            let value = if binding.action == model::BindingAction::ToggleMute {
                match &primary_target {
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
                    model::BindingTarget::Application { name, .. } => {
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
                    model::BindingTarget::MediaControl => None,
                    model::BindingTarget::CaptureControl => None,
                    model::BindingTarget::Hotkey => None,
                    model::BindingTarget::OpenApplication => None,
                    model::BindingTarget::Integration { .. } => None,
                }
            } else {
                match &primary_target {
                    model::BindingTarget::Master => sessions
                        .iter()
                        .find(|session| session.is_master)
                        .map(|session| {
                            current_target_muted = Some(session.is_muted);
                            session.volume
                        }),
                    model::BindingTarget::Focus => None,
                    model::BindingTarget::Session { session_id } => sessions
                        .iter()
                        .find(|session| session.id == *session_id)
                        .map(|session| {
                            current_target_muted = Some(session.is_muted);
                            session.volume
                        }),
                    model::BindingTarget::Application { name, .. } => {
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
                            .map(|session| {
                                current_target_muted = Some(session.is_muted);
                                session.volume
                            })
                    }
                    model::BindingTarget::Device { device_id } => {
                        let (kind, raw_id) = parse_device_target(device_id);
                        match kind {
                            DeviceTargetKind::Playback => playback_devices
                                .iter()
                                .find(|device| device.id == raw_id)
                                .map(|device| {
                                    current_target_muted = Some(device.is_muted);
                                    device.volume
                                }),
                            DeviceTargetKind::Recording => recording_devices
                                .iter()
                                .find(|device| device.id == raw_id)
                                .map(|device| {
                                    current_target_muted = Some(device.is_muted);
                                    device.volume
                                }),
                        }
                    }
                    model::BindingTarget::Unset => None,
                    model::BindingTarget::MediaControl => None,
                    model::BindingTarget::CaptureControl => None,
                    model::BindingTarget::Hotkey => None,
                    model::BindingTarget::OpenApplication => None,
                    model::BindingTarget::Integration { .. } => None,
                }
            };

            if let Some(mut val) = value {
                if binding.action != model::BindingAction::ToggleMute {
                    if let Some(muted) = current_target_muted {
                        if let Some(previous_muted) = last_target_mute_state.get(&key).cloned() {
                            if previous_muted != muted {
                                mute_transition_until
                                    .insert(key.clone(), now + Duration::from_millis(700));
                            }
                        }
                        last_target_mute_state.insert(key.clone(), muted);
                    }

                    if let Some(until) = mute_transition_until.get(&key).cloned() {
                        if now < until {
                            if let Some(previous_val) = feedback.get(&key).cloned() {
                                val = previous_val;
                            }
                        } else {
                            mute_transition_until.remove(&key);
                        }
                    }
                }

                feedback.insert(key, val);
            }
        }
    }
}

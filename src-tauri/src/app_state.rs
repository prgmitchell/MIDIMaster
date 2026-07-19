use crate::app_settings::{AppSettings, AppSettingsStore};
use crate::audio::target_match::{application_name_matches, ApplicationMatchInfo};
use crate::audio::AudioBackend;
use crate::bindings::{BindingKey, BindingState};
use crate::device_target::{parse_device_target, DeviceTargetKind};
use crate::durable_json_store::StorageRecoveryNotices;
use crate::feedback;
use crate::midi::MidiManager;
use crate::midi_event_queue::MidiEventQueue;
use crate::model::{self, LearnedControl, MidiEvent, OsdSettings, Profile};
use crate::profile_store::ProfileStore;
use crate::run_logger;
use crate::runtime_helpers::LearnCandidate;
use crate::soundboard::SoundboardService;
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
    pub(crate) binding_action_values: Arc<Mutex<HashMap<BindingKey, f32>>>,
    pub(crate) integration_connection_states: Mutex<HashMap<String, bool>>,
    pub(crate) activity_button_light_generations: Arc<Mutex<HashMap<BindingKey, u64>>>,
    pub(crate) running_macros: Arc<Mutex<std::collections::HashSet<String>>>,
    pub(crate) soundboard: Arc<SoundboardService>,
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
    pub(crate) storage_recovery_notices: StorageRecoveryNotices,
}

pub(crate) struct FeedbackSyncSnapshot {
    pub(crate) focused_session: Option<model::SessionInfo>,
}

#[derive(Default)]
struct FeedbackSyncNeeds {
    sessions: bool,
    focused_session: bool,
    playback_devices: bool,
    recording_devices: bool,
}

fn feedback_sync_needs(profile: &Profile) -> FeedbackSyncNeeds {
    let mut needs = FeedbackSyncNeeds::default();

    for binding in &profile.bindings {
        if !matches!(
            binding.action,
            model::BindingAction::Volume | model::BindingAction::ToggleMute
        ) {
            continue;
        }

        match binding.primary_target() {
            model::BindingTarget::Master
            | model::BindingTarget::Session { .. }
            | model::BindingTarget::Application { .. } => {
                needs.sessions = true;
            }
            model::BindingTarget::Focus => {
                needs.focused_session = true;
            }
            model::BindingTarget::Device { device_id } => {
                let (kind, _) = parse_device_target(&device_id);
                match kind {
                    DeviceTargetKind::Playback => needs.playback_devices = true,
                    DeviceTargetKind::Recording => needs.recording_devices = true,
                }
            }
            model::BindingTarget::Unset
            | model::BindingTarget::MonitorBrightness { .. }
            | model::BindingTarget::MediaControl
            | model::BindingTarget::CaptureControl
            | model::BindingTarget::Hotkey
            | model::BindingTarget::OpenApplication
            | model::BindingTarget::AutoHotkeyScript
            | model::BindingTarget::Profile { .. }
            | model::BindingTarget::Macro
            | model::BindingTarget::Soundboard
            | model::BindingTarget::Integration { .. } => {}
        }
    }

    needs
}

impl AppState {
    pub(crate) fn set_integration_connection_state(
        &self,
        integration_id: &str,
        connected: bool,
    ) -> bool {
        if let Ok(mut states) = self.integration_connection_states.lock() {
            if states.get(integration_id).copied() == Some(connected) {
                return false;
            }
            states.insert(integration_id.to_string(), connected);
            return true;
        }
        false
    }

    fn binding_target_is_available(&self, target: &model::BindingTarget) -> bool {
        let model::BindingTarget::Integration { integration_id, .. } = target else {
            return true;
        };
        self.integration_connection_states
            .lock()
            .ok()
            .and_then(|states| states.get(integration_id).copied())
            .unwrap_or(true)
    }

    pub(crate) fn binding_has_available_target(&self, binding: &model::Binding) -> bool {
        let targets = binding
            .normalized_targets()
            .into_iter()
            .filter(|target| !matches!(target, model::BindingTarget::Unset))
            .collect::<Vec<_>>();
        targets.is_empty()
            || targets
                .iter()
                .any(|target| self.binding_target_is_available(target))
    }

    pub(crate) fn button_light_feedback_value(
        &self,
        binding: &model::Binding,
        input_active: Option<bool>,
        state_active: Option<bool>,
    ) -> Option<f32> {
        if binding.is_button_binding() && !self.binding_has_available_target(binding) {
            return Some(0.0);
        }
        if let Some(value) =
            binding.mapped_button_light_feedback_value_with_availability(|target| {
                self.binding_target_is_available(target)
            })
        {
            return Some(value);
        }
        binding.button_light_feedback_value(input_active, state_active)
    }

    pub(crate) fn button_light_hold_feedback_value(
        &self,
        binding: &model::Binding,
        input_active: bool,
    ) -> Option<f32> {
        let value = self.button_light_feedback_value(binding, Some(input_active), None)?;
        (value > 0.5).then_some(value)
    }

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
    pub(crate) fn apply_app_settings(_app: &AppHandle, _settings: &AppSettings) {
        // Reserved for applying non-persistent app settings at runtime.
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

    pub(crate) fn activity_button_light_input_active(&self, key: &BindingKey) -> bool {
        self.binding_state
            .lock()
            .ok()
            .and_then(|states| states.get(key).map(|state| state.last_value > 0.0))
            .unwrap_or(false)
    }

    pub(crate) fn set_binding_action_value(&self, key: &BindingKey, value: f32) {
        if let Ok(mut values) = self.binding_action_values.lock() {
            values.insert(key.clone(), value.clamp(0.0, 1.0));
        }
    }

    pub(crate) fn binding_action_value(&self, key: &BindingKey) -> Option<f32> {
        self.binding_action_values
            .lock()
            .ok()
            .and_then(|values| values.get(key).copied())
    }

    pub(crate) fn sync_relative_volume_binding_state(&self, binding: &model::Binding, value: f32) {
        if binding.action != model::BindingAction::Volume
            || binding.mode != model::MidiMode::Relative
        {
            return;
        }

        let key = BindingKey::from_binding(binding);
        let normalized = value.clamp(0.0, 1.0);
        let now = Instant::now();
        let idle_update = now.checked_sub(Duration::from_secs(1)).unwrap_or(now);

        if let Ok(mut states) = self.binding_state.lock() {
            match states.entry(key.clone()) {
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    let state = entry.get_mut();
                    let user_active = match key.msg_type {
                        model::MidiMessageType::Note => state.last_value > 0.0,
                        _ => state.last_update.elapsed().as_millis() < 500,
                    };
                    if !user_active {
                        state.last_value = normalized;
                    }
                }
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(BindingState {
                        last_value: normalized,
                        last_update: idle_update,
                        relative_auto_format: None,
                        relative_seen_midpoint: false,
                        relative_seen_sign_band: false,
                        relative_seen_high_negative: false,
                        relative_seen_low_negative_hint: false,
                    });
                }
            }
        }
    }

    pub(crate) fn current_target_mute_state(&self, target: &model::BindingTarget) -> Option<bool> {
        match target {
            model::BindingTarget::Master => self
                .audio
                .list_sessions()
                .ok()
                .and_then(|sessions| sessions.into_iter().find(|s| s.is_master))
                .map(|s| s.is_muted)
                .or(Some(false)),
            model::BindingTarget::Focus => self
                .audio
                .focused_session()
                .ok()
                .flatten()
                .map(|s| s.is_muted)
                .or(Some(false)),
            model::BindingTarget::Session { session_id } => self
                .audio
                .list_sessions()
                .ok()
                .and_then(|sessions| sessions.into_iter().find(|s| s.id == *session_id))
                .map(|s| s.is_muted)
                .or(Some(false)),
            model::BindingTarget::Application { name, .. } => self
                .audio
                .list_sessions()
                .ok()
                .and_then(|sessions| {
                    sessions.into_iter().find(|s| {
                        application_name_matches(
                            name,
                            ApplicationMatchInfo {
                                process_path: s.process_path.as_deref(),
                                process_name: s.process_name.as_deref(),
                                display_name: Some(s.display_name.as_str()),
                                application_key: s.application_key.as_deref(),
                                ..Default::default()
                            },
                        )
                    })
                })
                .map(|s| s.is_muted),
            model::BindingTarget::Device { device_id } => {
                let (kind, raw_id) = parse_device_target(device_id);
                match kind {
                    DeviceTargetKind::Playback => self
                        .audio
                        .list_playback_devices()
                        .ok()
                        .and_then(|devices| devices.into_iter().find(|d| d.id == raw_id))
                        .map(|d| d.is_muted)
                        .or(Some(false)),
                    DeviceTargetKind::Recording => self
                        .audio
                        .list_recording_devices()
                        .ok()
                        .and_then(|devices| devices.into_iter().find(|d| d.id == raw_id))
                        .map(|d| d.is_muted)
                        .or(Some(false)),
                }
            }
            model::BindingTarget::Integration { .. } => None,
            _ => Some(false),
        }
    }

    pub(crate) fn current_binding_toggle_state(
        &self,
        targets: &[model::BindingTarget],
        key: &BindingKey,
    ) -> bool {
        targets
            .first()
            .and_then(|target| self.current_target_mute_state(target))
            .or_else(|| self.binding_action_value(key).map(|value| value > 0.5))
            .unwrap_or(false)
    }

    pub(crate) fn cancel_activity_button_light_holds(&self) {
        if let Ok(mut generations) = self.activity_button_light_generations.lock() {
            generations.clear();
        }
    }

    pub(crate) fn sync_feedback_values(&self, profile: &Profile) -> FeedbackSyncSnapshot {
        let needs = feedback_sync_needs(profile);
        let sessions = if needs.sessions {
            match self.audio.list_session_states() {
                Ok(sessions) => sessions,
                Err(_) => {
                    return FeedbackSyncSnapshot {
                        focused_session: None,
                    }
                }
            }
        } else {
            Vec::new()
        };
        let focused_session = if needs.focused_session {
            self.audio.focused_session_state().ok().flatten()
        } else {
            None
        };
        let playback_devices = if needs.playback_devices {
            self.audio.list_playback_devices().unwrap_or_default()
        } else {
            Vec::new()
        };
        let recording_devices = if needs.recording_devices {
            self.audio.list_recording_devices().unwrap_or_default()
        } else {
            Vec::new()
        };
        let mut feedback = match self.feedback_values.lock() {
            Ok(feedback) => feedback,
            Err(_) => {
                return FeedbackSyncSnapshot {
                    focused_session: None,
                }
            }
        };
        let mut mute_transition_until = match self.mute_transition_until.lock() {
            Ok(map) => map,
            Err(_) => {
                return FeedbackSyncSnapshot {
                    focused_session: None,
                }
            }
        };
        let mut last_target_mute_state = match self.last_target_mute_state.lock() {
            Ok(map) => map,
            Err(_) => {
                return FeedbackSyncSnapshot {
                    focused_session: None,
                }
            }
        };
        let now = Instant::now();
        let mut relative_volume_state_updates = Vec::new();

        for binding in &profile.bindings {
            let key = BindingKey::from_binding(binding);
            if let Some((assign_control, value)) = feedback::assign_button_feedback(binding) {
                feedback.insert(assign_control.to_binding_key(), value);
            }
            if !self.binding_has_available_target(binding) {
                let output_key = feedback::binding_feedback_control_key(binding).to_binding_key();
                if binding.is_button_binding() {
                    feedback.insert(key.clone(), 0.0);
                    if output_key != key {
                        feedback.insert(output_key, 0.0);
                    }
                } else {
                    feedback.remove(&key);
                    if output_key != key {
                        feedback.remove(&output_key);
                    }
                }
                continue;
            }
            let input_active = self.activity_button_light_input_active(&key);
            let cached_state_active = if binding.uses_stateful_toggle_feedback() {
                self.binding_action_value(&key).map(|value| value > 0.5)
            } else {
                None
            };
            let idle_feedback_value =
                self.button_light_feedback_value(binding, Some(input_active), cached_state_active);

            let primary_target = binding.primary_target();
            if matches!(
                binding.action,
                model::BindingAction::MediaPlayPause
                    | model::BindingAction::MediaNextTrack
                    | model::BindingAction::MediaPrevTrack
                    | model::BindingAction::MediaStop
                    | model::BindingAction::Hotkey
                    | model::BindingAction::OpenApplication
                    | model::BindingAction::RunAutoHotkeyScript
                    | model::BindingAction::SwitchProfile
                    | model::BindingAction::SetDefaultDevice
            ) {
                if let Some(value) = idle_feedback_value {
                    let output_key =
                        feedback::binding_feedback_control_key(binding).to_binding_key();
                    feedback.insert(key.clone(), value);
                    if output_key != key {
                        feedback.insert(output_key, value);
                    }
                }
                continue;
            }

            let mut current_target_muted: Option<bool> = None;
            let value = if binding.action == model::BindingAction::ToggleMute {
                match &primary_target {
                    model::BindingTarget::Master => sessions
                        .iter()
                        .find(|session| session.is_master)
                        .map(|session| if session.is_muted { 1.0 } else { 0.0 }),
                    model::BindingTarget::Focus => {
                        focused_session
                            .as_ref()
                            .map(|session| if session.is_muted { 1.0 } else { 0.0 })
                    }
                    model::BindingTarget::Session { session_id } => sessions
                        .iter()
                        .find(|session| session.id == *session_id)
                        .map(|session| if session.is_muted { 1.0 } else { 0.0 }),
                    model::BindingTarget::Application { name, .. } => sessions
                        .iter()
                        .find(|session| {
                            application_name_matches(
                                name,
                                ApplicationMatchInfo {
                                    process_path: session.process_path.as_deref(),
                                    process_name: session.process_name.as_deref(),
                                    display_name: Some(session.display_name.as_str()),
                                    application_key: session.application_key.as_deref(),
                                    ..Default::default()
                                },
                            )
                        })
                        .map(|session| if session.is_muted { 1.0 } else { 0.0 }),
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
                    model::BindingTarget::MonitorBrightness { .. } => None,
                    model::BindingTarget::MediaControl => None,
                    model::BindingTarget::CaptureControl => None,
                    model::BindingTarget::Hotkey => None,
                    model::BindingTarget::OpenApplication => None,
                    model::BindingTarget::AutoHotkeyScript => None,
                    model::BindingTarget::Profile { .. } => None,
                    model::BindingTarget::Macro => None,
                    model::BindingTarget::Soundboard => None,
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
                    model::BindingTarget::Focus => focused_session.as_ref().map(|session| {
                        current_target_muted = Some(session.is_muted);
                        session.volume
                    }),
                    model::BindingTarget::Session { session_id } => sessions
                        .iter()
                        .find(|session| session.id == *session_id)
                        .map(|session| {
                            current_target_muted = Some(session.is_muted);
                            session.volume
                        }),
                    model::BindingTarget::Application { name, .. } => sessions
                        .iter()
                        .find(|session| {
                            application_name_matches(
                                name,
                                ApplicationMatchInfo {
                                    process_path: session.process_path.as_deref(),
                                    process_name: session.process_name.as_deref(),
                                    display_name: Some(session.display_name.as_str()),
                                    application_key: session.application_key.as_deref(),
                                    ..Default::default()
                                },
                            )
                        })
                        .map(|session| {
                            current_target_muted = Some(session.is_muted);
                            session.volume
                        }),
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
                    model::BindingTarget::MonitorBrightness { .. } => None,
                    model::BindingTarget::MediaControl => None,
                    model::BindingTarget::CaptureControl => None,
                    model::BindingTarget::Hotkey => None,
                    model::BindingTarget::OpenApplication => None,
                    model::BindingTarget::AutoHotkeyScript => None,
                    model::BindingTarget::Profile { .. } => None,
                    model::BindingTarget::Macro => None,
                    model::BindingTarget::Soundboard => None,
                    model::BindingTarget::Integration { .. } => None,
                }
            };

            if let Some(mut val) = value {
                self.set_binding_action_value(&key, val);
                if binding.action == model::BindingAction::Volume
                    && binding.mode == model::MidiMode::Relative
                {
                    relative_volume_state_updates.push((binding.clone(), val));
                }
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
                } else {
                    last_target_mute_state.insert(key.clone(), val > 0.5);
                }

                let state_active = if binding.action == model::BindingAction::ToggleMute {
                    Some(val > 0.5)
                } else {
                    cached_state_active
                };
                let feedback_value = self
                    .button_light_feedback_value(binding, Some(input_active), state_active)
                    .unwrap_or(val);
                let output_key = feedback::binding_feedback_control_key(binding).to_binding_key();
                feedback.insert(key.clone(), feedback_value);
                if output_key != key {
                    feedback.insert(output_key, feedback_value);
                }
            } else if let Some(value) = idle_feedback_value {
                let output_key = feedback::binding_feedback_control_key(binding).to_binding_key();
                feedback.insert(key.clone(), value);
                if output_key != key {
                    feedback.insert(output_key, value);
                }
            }
        }

        drop(last_target_mute_state);
        drop(mute_transition_until);
        drop(feedback);

        for (binding, value) in relative_volume_state_updates {
            self.sync_relative_volume_binding_state(&binding, value);
        }

        FeedbackSyncSnapshot { focused_session }
    }

    pub(crate) fn send_idle_button_light_feedback_values(&self, profile: &Profile) {
        self.cancel_activity_button_light_holds();

        if let Ok(mut feedback_values) = self.feedback_values.lock() {
            for binding in &profile.bindings {
                let key = BindingKey::from_binding(binding);
                let state_active = if binding.uses_stateful_toggle_feedback() {
                    self.binding_action_value(&key).map(|value| value > 0.5)
                } else {
                    None
                };
                if let Some(value) =
                    self.button_light_feedback_value(binding, Some(false), state_active)
                {
                    feedback_values.insert(key.clone(), value);
                    let output_key =
                        feedback::button_light_feedback_control_key(binding).to_binding_key();
                    if output_key != key {
                        feedback_values.insert(output_key, value);
                    }
                }
            }
        }

        if let Ok(mut midi) = self.midi.lock() {
            for binding in &profile.bindings {
                let key = BindingKey::from_binding(binding);
                let state_active = if binding.uses_stateful_toggle_feedback() {
                    self.binding_action_value(&key).map(|value| value > 0.5)
                } else {
                    None
                };
                let Some(value) =
                    self.button_light_feedback_value(binding, Some(false), state_active)
                else {
                    continue;
                };
                let _ = midi.send_binding_light_feedback(binding, value);
            }
        }

        for binding in &profile.bindings {
            feedback::send_assign_button_feedback(
                self,
                binding,
                true,
                &format!("assign_idle:{}", binding.id),
            );
        }
    }
}

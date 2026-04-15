#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_paths;
mod app_settings;
mod audio;
mod bindings;
mod commands;
mod device_target;
mod midi;
mod model;
mod monitors;
mod plugin_api;
mod profile_store;
mod run_logger;
mod runtime_helpers;
mod store_api;
mod windows_autostart;
mod windows_display;
mod ws_bridge;

use app_paths::app_data_root_dir;
use app_settings::{AppSettings, AppSettingsStore};
use audio::AudioBackend;
use bindings::{apply_midi_event, find_binding, BindingKey, BindingState};
use commands::*;
use device_target::{parse_device_target, DeviceTargetKind};
use midi::MidiManager;
use model::{LearnedControl, MidiEvent, OsdSettings, Profile};
use monitors::resolve_monitor_for_osd;
use runtime_helpers::{classify_learned_control, send_hotkey, send_media_key, LearnCandidate};
use windows_autostart::set_windows_autostart;

use profile_store::ProfileStore;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command as ProcessCommand;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tokio::time::sleep;

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

pub(crate) use monitors::collect_monitor_descriptors;
use plugin_api::{
    ensure_builtin_plugin, get_plugins_dir, hue_api_get, hue_api_put, hue_discover_bridges,
    hue_pair_bridge, install_plugin_package, list_plugins, read_plugin_base64, read_plugin_text,
    set_plugin_enabled, uninstall_plugin,
};
use store_api::{fetch_store_catalog, install_store_plugin};
use ws_bridge::{get_wavelink_ws_port, ws_close, ws_open, ws_send, WsHub};

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
    focus_volume_failure_logs: Mutex<HashMap<String, Instant>>,
    mute_transition_until: Mutex<HashMap<BindingKey, Instant>>,
    last_target_mute_state: Mutex<HashMap<BindingKey, bool>>,
    learn_pending: Mutex<bool>,
    learn_candidate: Mutex<Option<LearnCandidate>>,
    learned_control: Mutex<Option<LearnedControl>>,
    osd_last_update: Mutex<Option<Instant>>,
    osd_settings: Mutex<OsdSettings>,
    app_settings: Mutex<AppSettings>,
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

        let selected = resolve_monitor_for_osd(app, settings);
        if let Some(selected) = selected {
            let monitor = selected;
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

    fn binding_matches_aux(mapping: &model::AuxiliaryControl, event: &MidiEvent) -> bool {
        mapping.device_id == event.device_id
            && mapping.channel == event.channel
            && mapping.controller == event.controller
            && mapping.msg_type == event.msg_type
    }

    fn apply_midi_event(&self, app: &AppHandle, event: MidiEvent) -> Result<(), String> {
        let mut learn_pending = self.learn_pending.lock().map_err(|_| "Lock poisoned")?;
        if *learn_pending {
            run_logger::debug(
                "learn",
                "event_received",
                &format!(
                    "device_id={} channel={} controller={} value={} msg_type={:?}",
                    event.device_id, event.channel, event.controller, event.value, event.msg_type
                ),
            );
            let msg_type = event.msg_type.clone();
            let base_learned = LearnedControl {
                device_id: event.device_id.clone(),
                channel: event.channel,
                controller: event.controller,
                msg_type: msg_type.clone(),
                control_kind: model::BindingControlKind::Auto,
            };

            if matches!(msg_type, model::MidiMessageType::Note) {
                // Buffer note events first. Touch-sensitive faders may emit a Note before
                // the actual CC/PitchBend movement event, which should win.
                if let Ok(mut candidate_guard) = self.learn_candidate.lock() {
                    let now = Instant::now();
                    *candidate_guard = Some(LearnCandidate {
                        control: base_learned,
                        last_seen_at: now,
                        saw_zero: event.value == 0,
                        saw_max: event.value == 127,
                    });
                }
                return Ok(());
            }

            if matches!(msg_type, model::MidiMessageType::PitchBend) {
                // Pitch bend is continuous by definition.
                let mut learned = base_learned.clone();
                learned.control_kind = model::BindingControlKind::Continuous;
                run_logger::info(
                    "learn",
                    "pitch_bend_classified",
                    &format!(
                        "device_id={} channel={} controller={} control_kind={:?}",
                        learned.device_id,
                        learned.channel,
                        learned.controller,
                        learned.control_kind
                    ),
                );
                *learn_pending = false;
                drop(learn_pending);
                if let Ok(mut candidate) = self.learn_candidate.lock() {
                    *candidate = None;
                }
                *self.learned_control.lock().map_err(|_| "Lock poisoned")? = Some(learned);
                return Ok(());
            }

            // For CC, sample a short stream to detect button-like 127/0 press-release pairs.
            if let Ok(mut candidate_guard) = self.learn_candidate.lock() {
                let now = Instant::now();
                let is_zero = event.value == 0;
                let is_max = event.value == 127;
                match candidate_guard.as_mut() {
                    Some(candidate)
                        if candidate.control.device_id == base_learned.device_id
                            && candidate.control.channel == base_learned.channel
                            && candidate.control.controller == base_learned.controller
                            && candidate.control.msg_type == base_learned.msg_type =>
                    {
                        candidate.last_seen_at = now;
                        candidate.saw_zero |= is_zero;
                        candidate.saw_max |= is_max;
                    }
                    _ => {
                        *candidate_guard = Some(LearnCandidate {
                            control: base_learned,
                            last_seen_at: now,
                            saw_zero: is_zero,
                            saw_max: is_max,
                        });
                    }
                }
            }
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
        let binding = match find_binding(&profile, &key) {
            Some(binding) => binding.clone(),
            None => {
                let aux_match = profile.bindings.iter().find_map(|candidate| {
                    if let Some(mapping) = candidate.mute_control.as_ref() {
                        if Self::binding_matches_aux(mapping, &event) {
                            return Some((candidate.clone(), "mute", mapping.clone()));
                        }
                    }
                    if let Some(mapping) = candidate.assign_control.as_ref() {
                        if Self::binding_matches_aux(mapping, &event) {
                            return Some((candidate.clone(), "assign", mapping.clone()));
                        }
                    }
                    None
                });

                if let Some((owner, role, aux_mapping)) = aux_match {
                    let mut targets = owner.normalized_targets();
                    targets.retain(|t| *t != model::BindingTarget::Unset);
                    if role == "mute" && targets.is_empty() {
                        return Ok(());
                    }

                    let resolve_target_muted = |target: &model::BindingTarget| -> Option<bool> {
                        match target {
                            model::BindingTarget::Master => self
                                .audio
                                .list_sessions()
                                .ok()
                                .and_then(|sessions| sessions.iter().find(|s| s.is_master).cloned())
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
                                .and_then(|sessions| {
                                    sessions.into_iter().find(|s| s.id == *session_id)
                                })
                                .map(|s| s.is_muted)
                                .or(Some(false)),
                            model::BindingTarget::Application { name } => self
                                .audio
                                .list_sessions()
                                .ok()
                                .and_then(|sessions| {
                                    sessions.into_iter().find(|s| {
                                        let base = s.process_name.as_deref().unwrap_or_default();
                                        let stem = base.strip_suffix(".exe").unwrap_or(base);
                                        stem.eq_ignore_ascii_case(name)
                                            || s.display_name.eq_ignore_ascii_case(name)
                                    })
                                })
                                .map(|s| s.is_muted)
                                .or(Some(false)),
                            model::BindingTarget::Device { device_id } => {
                                let (kind, raw_id) = parse_device_target(device_id);
                                match kind {
                                    DeviceTargetKind::Playback => self
                                        .audio
                                        .list_playback_devices()
                                        .ok()
                                        .and_then(|devices| {
                                            devices.into_iter().find(|d| d.id == raw_id)
                                        })
                                        .map(|d| d.is_muted)
                                        .or(Some(false)),
                                    DeviceTargetKind::Recording => self
                                        .audio
                                        .list_recording_devices()
                                        .ok()
                                        .and_then(|devices| {
                                            devices.into_iter().find(|d| d.id == raw_id)
                                        })
                                        .map(|d| d.is_muted)
                                        .or(Some(false)),
                                }
                            }
                            model::BindingTarget::Integration { .. } => None,
                            _ => Some(false),
                        }
                    };

                    if event.value == 0 {
                        if role == "mute" {
                            let fallback_muted = self
                                .feedback_values
                                .lock()
                                .ok()
                                .and_then(|feedback| feedback.get(&key).cloned())
                                .map(|v| v > 0.5)
                                .unwrap_or(false);
                            let muted_now = targets
                                .first()
                                .and_then(&resolve_target_muted)
                                .unwrap_or(fallback_muted);
                            let midi_arc = self.midi.clone();
                            let device_id = aux_mapping.device_id.clone();
                            let channel = aux_mapping.channel;
                            let controller = aux_mapping.controller;
                            let msg_type = aux_mapping.msg_type.clone();
                            tauri::async_runtime::spawn(async move {
                                tokio::time::sleep(Duration::from_millis(20)).await;
                                if let Ok(mut midi) = midi_arc.lock() {
                                    let _ = midi.send_feedback(
                                        &device_id,
                                        channel,
                                        controller,
                                        if muted_now { 1.0 } else { 0.0 },
                                        msg_type,
                                    );
                                }
                            });
                        }
                        return Ok(());
                    }

                    if role == "assign" {
                        let focused = self
                            .audio
                            .focused_session()
                            .map_err(|err| err.to_string())?;
                        let app_name = if let Some(focused) = focused {
                            focused
                                .process_name
                                .as_deref()
                                .and_then(|name| name.strip_suffix(".exe").or(Some(name)))
                                .map(|name| name.trim().to_string())
                                .filter(|name| !name.is_empty())
                                .unwrap_or_else(|| focused.display_name.clone())
                        } else {
                            focused_application_name().unwrap_or_default()
                        };
                        if !app_name.is_empty() {
                            let new_target = model::BindingTarget::Application { name: app_name };
                            let already_present = targets.iter().any(|t| *t == new_target);
                            let should_replace =
                                matches!(owner.assign_mode, model::AssignMode::Replace);
                            if should_replace || !already_present {
                                if !should_replace && targets.len() >= 8 {
                                    let _ = app.emit(
                                        "binding_aux_error",
                                        serde_json::json!({
                                            "binding_id": owner.id,
                                            "kind": "assign",
                                            "reason": "target_list_full"
                                        }),
                                    );
                                } else {
                                    let mut updated_targets: Option<Vec<model::BindingTarget>> =
                                        None;
                                    let mut guard = self
                                        .active_profile
                                        .lock()
                                        .map_err(|_| "Lock poisoned".to_string())?;
                                    if let Some(active_profile) = guard.as_mut() {
                                        if let Some(stored) = active_profile
                                            .bindings
                                            .iter_mut()
                                            .find(|b| b.id == owner.id)
                                        {
                                            stored.ensure_targets();
                                            if should_replace {
                                                stored.targets = vec![new_target.clone()];
                                                stored.ensure_targets();
                                                updated_targets = Some(stored.normalized_targets());
                                            } else if !stored
                                                .targets
                                                .iter()
                                                .any(|t| *t == new_target)
                                            {
                                                stored.targets.push(new_target.clone());
                                                stored.ensure_targets();
                                                updated_targets = Some(stored.normalized_targets());
                                            }
                                        }
                                        if updated_targets.is_some() {
                                            self.profile_store
                                                .save_profile(active_profile.clone())
                                                .map_err(|err| err.to_string())?;
                                            self.sync_feedback_values(active_profile);
                                        }
                                    }
                                    if let Some(updated_targets) = updated_targets {
                                        let _ = app.emit(
                                            "binding_aux_assign_update",
                                            serde_json::json!({
                                                "binding_id": owner.id,
                                                "target": new_target,
                                                "targets": updated_targets
                                            }),
                                        );
                                    }
                                }
                            }
                        } else {
                            let _ = app.emit(
                                "binding_aux_error",
                                serde_json::json!({
                                    "binding_id": owner.id,
                                    "kind": "assign",
                                    "reason": "focused_app_unavailable"
                                }),
                            );
                        }
                        return Ok(());
                    }

                    let fallback_muted = self
                        .feedback_values
                        .lock()
                        .ok()
                        .and_then(|feedback| feedback.get(&key).cloned())
                        .map(|v| v > 0.5)
                        .unwrap_or(false);
                    let current_muted = targets
                        .first()
                        .and_then(&resolve_target_muted)
                        .unwrap_or(fallback_muted);
                    let next_muted = !current_muted;
                    for (target_index, target) in targets.iter().enumerate() {
                        match target {
                            model::BindingTarget::Master => {
                                let _ = self.audio.set_master_mute(next_muted);
                            }
                            model::BindingTarget::Focus => {
                                let _ = self.audio.set_focused_session_mute(next_muted);
                            }
                            model::BindingTarget::Session { session_id } => {
                                let _ = self.audio.set_session_mute(session_id, next_muted);
                            }
                            model::BindingTarget::Application { name } => {
                                let _ = self.audio.set_application_mute(name, next_muted);
                            }
                            model::BindingTarget::Device { device_id } => {
                                let _ = self.audio.set_device_mute(device_id, next_muted);
                            }
                            model::BindingTarget::Integration {
                                integration_id,
                                kind,
                                data,
                            } => {
                                let payload = serde_json::json!({
                                  "binding_id": owner.id,
                                  "action": "ToggleMute",
                                  "value": if next_muted { 1.0 } else { 0.0 },
                                  "target_index": target_index,
                                  "target_count": targets.len(),
                                  "is_primary_target": target_index == 0,
                                  "target": {
                                    "integration_id": integration_id,
                                    "kind": kind,
                                    "data": data,
                                  }
                                });
                                let _ = app.emit("integration_binding_triggered", payload);
                            }
                            _ => {}
                        }
                    }
                    if let Ok(mut feedback) = self.feedback_values.lock() {
                        feedback.insert(key.clone(), if next_muted { 1.0 } else { 0.0 });
                    }
                    if let Ok(mut midi) = self.midi.lock() {
                        let _ = midi.send_feedback(
                            &aux_mapping.device_id,
                            aux_mapping.channel,
                            aux_mapping.controller,
                            if next_muted { 1.0 } else { 0.0 },
                            aux_mapping.msg_type.clone(),
                        );
                    }

                    if let Ok(mut last_update) = self.osd_last_update.lock() {
                        *last_update = Some(Instant::now());
                    }

                    let _ = app.emit(
                        "binding_aux_mute_update",
                        serde_json::json!({
                            "binding_id": owner.id,
                            "muted": next_muted
                        }),
                    );

                    let settings_enabled = self
                        .osd_settings
                        .lock()
                        .map(|settings| settings.enabled)
                        .unwrap_or(true);

                    for target in &targets {
                        let focus_session = if matches!(target, model::BindingTarget::Focus) {
                            self.audio.focused_session().ok().flatten()
                        } else {
                            None
                        };
                        let payload = serde_json::json!({
                          "target": target,
                          "muted": next_muted,
                          "action": "toggle_mute",
                          "focus_session": focus_session,
                          "binding_id": owner.id
                        });
                        let _ = app.emit("mute_update", payload.clone());

                        if settings_enabled {
                            if let Some(osd_window) = app.get_webview_window("osd") {
                                let _ = osd_window.show();
                                let _ = osd_window.set_always_on_top(true);
                                #[cfg(target_os = "windows")]
                                if let Ok(hwnd) = osd_window.hwnd() {
                                    use windows::Win32::Foundation::HWND;
                                    use windows::Win32::UI::WindowsAndMessaging::{
                                        SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
                                    };
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
                    }
                    return Ok(());
                }

                run_logger::debug(
                    "bindings",
                    "event_unmatched",
                    &format!(
                        "device_id={} channel={} controller={} value={} msg_type={:?}",
                        event.device_id,
                        event.channel,
                        event.controller,
                        event.value,
                        event.msg_type
                    ),
                );
                return Ok(());
            }
        };
        let targets = binding.normalized_targets();
        if targets.is_empty() {
            run_logger::warn(
                "bindings",
                "binding_has_no_targets",
                &format!("binding_id={} action={:?}", binding.id, binding.action),
            );
            return Ok(());
        }
        run_logger::debug(
            "bindings",
            "event_matched",
            &format!(
                "binding_id={} action={:?} targets={} control_kind={:?} msg_type={:?}",
                binding.id,
                binding.action,
                targets.len(),
                binding.control_kind,
                binding.control.msg_type
            ),
        );

        let volume = {
            let mut states = self.binding_state.lock().map_err(|_| "Lock poisoned")?;
            let state = states.entry(key.clone()).or_insert_with(|| BindingState {
                last_value: 0.0,
                last_update: Instant::now(),
                relative_auto_format: None,
                relative_seen_midpoint: false,
                relative_seen_sign_band: false,
                relative_seen_high_negative: false,
                relative_seen_low_negative_hint: false,
            });
            apply_midi_event(&binding, &event, state)
        };

        let volume = match volume {
            Some(v) => v,
            None => return Ok(()),
        };

        // Handle media key actions (fire-and-forget, no state tracking)
        if matches!(
            binding.action,
            model::BindingAction::MediaPlayPause
                | model::BindingAction::MediaNextTrack
                | model::BindingAction::MediaPrevTrack
                | model::BindingAction::MediaStop
        ) {
            if event.value == 0 {
                run_logger::debug(
                    "bindings",
                    "media_action_ignored_release",
                    &format!("binding_id={} action={:?}", binding.id, binding.action),
                );
                return Ok(());
            }
            let vk: u16 = match binding.action {
                model::BindingAction::MediaPlayPause => 0xB3,
                model::BindingAction::MediaNextTrack => 0xB0,
                model::BindingAction::MediaPrevTrack => 0xB1,
                model::BindingAction::MediaStop => 0xB2,
                _ => unreachable!(),
            };
            send_media_key(vk);
            run_logger::info(
                "bindings",
                "media_action_sent",
                &format!(
                    "binding_id={} action={:?} keycode={}",
                    binding.id, binding.action, vk
                ),
            );
            return Ok(());
        }

        if binding.action == model::BindingAction::Hotkey {
            if event.value == 0 {
                run_logger::debug(
                    "bindings",
                    "hotkey_action_ignored_release",
                    &format!("binding_id={} action={:?}", binding.id, binding.action),
                );
                return Ok(());
            }
            if let Some(hotkey) = &binding.hotkey {
                if !hotkey.keys.is_empty() {
                    send_hotkey(&hotkey.keys);
                    run_logger::info(
                        "bindings",
                        "hotkey_action_sent",
                        &format!(
                            "binding_id={} action={:?} hotkey={}",
                            binding.id, binding.action, hotkey.display
                        ),
                    );
                }
            }
            return Ok(());
        }

        if binding.action == model::BindingAction::OpenApplication {
            if event.value == 0 {
                run_logger::debug(
                    "bindings",
                    "open_application_ignored_release",
                    &format!("binding_id={} action={:?}", binding.id, binding.action),
                );
                return Ok(());
            }

            let Some(open_app) = binding.open_application.as_ref() else {
                run_logger::warn(
                    "bindings",
                    "open_application_missing_config",
                    &format!("binding_id={}", binding.id),
                );
                let _ = app.emit(
                    "binding_action_error",
                    serde_json::json!({
                        "reason": "open_application_missing_config",
                        "binding_id": binding.id,
                        "title": "Open Application Not Configured",
                        "message": "Choose an executable for this binding's Open Application action.",
                    }),
                );
                return Ok(());
            };

            let app_path = open_app.path.trim();
            if app_path.is_empty() || !Path::new(app_path).is_file() {
                run_logger::warn(
                    "bindings",
                    "open_application_path_missing",
                    &format!("binding_id={} path={}", binding.id, app_path),
                );
                let app_name = open_app.display.trim();
                let display = if app_name.is_empty() {
                    app_path
                } else {
                    app_name
                };
                let _ = app.emit(
                    "binding_action_error",
                    serde_json::json!({
                        "reason": "open_application_path_missing",
                        "binding_id": binding.id,
                        "title": "Application Not Found",
                        "message": format!("MIDIMaster couldn't find \"{}\". Re-select the .exe path in this binding.", display),
                    }),
                );
                return Ok(());
            }

            match ProcessCommand::new(app_path).spawn() {
                Ok(_) => {
                    run_logger::info(
                        "bindings",
                        "open_application_launched",
                        &format!("binding_id={} path={}", binding.id, app_path),
                    );
                }
                Err(err) => {
                    run_logger::error(
                        "bindings",
                        "open_application_launch_failed",
                        &format!("binding_id={} path={} error={}", binding.id, app_path, err),
                    );
                    let _ = app.emit(
                        "binding_action_error",
                        serde_json::json!({
                            "reason": "open_application_launch_failed",
                            "binding_id": binding.id,
                            "title": "Launch Failed",
                            "message": format!("MIDIMaster couldn't open this application: {}", err),
                        }),
                    );
                }
            }
            return Ok(());
        }

        if binding.action == model::BindingAction::SetDefaultDevice {
            if event.value == 0 {
                run_logger::debug(
                    "bindings",
                    "set_default_device_ignored_release",
                    &format!("binding_id={} action={:?}", binding.id, binding.action),
                );
                return Ok(());
            }

            let mut any_applied = false;
            for target in &targets {
                if let model::BindingTarget::Device { device_id } = target {
                    if let Err(err) = self.audio.set_default_device(device_id) {
                        run_logger::error(
                            "bindings",
                            "set_default_device_failed",
                            &format!(
                                "binding_id={} device_id={} error={}",
                                binding.id, device_id, err
                            ),
                        );
                    } else {
                        any_applied = true;
                    }
                }
            }

            if !any_applied {
                run_logger::warn(
                    "bindings",
                    "set_default_device_no_target_applied",
                    &format!("binding_id={} targets={}", binding.id, targets.len()),
                );
            }

            return Ok(());
        }

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
                run_logger::debug(
                    "bindings",
                    "toggle_mute_release_resend",
                    &format!("binding_id={} device_id={}", binding.id, binding.device_id),
                );
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

            let current_val = self
                .feedback_values
                .lock()
                .ok()
                .and_then(|fb| fb.get(&key).cloned())
                .unwrap_or(0.0);
            let muted = !(current_val > 0.5);
            let mut any_applied = false;

            for (target_index, target) in targets.iter().enumerate() {
                match target {
                    model::BindingTarget::Master => {
                        if let Err(err) = self.audio.set_master_mute(muted) {
                            run_logger::error(
                                "bindings",
                                "toggle_mute_master_failed",
                                &format!("binding_id={} error={}", binding.id, err),
                            );
                        } else {
                            any_applied = true;
                        }
                    }
                    model::BindingTarget::Focus => {
                        if let Some(_focused) = self.audio.focused_session().ok().flatten() {
                            if let Err(err) = self.audio.set_focused_session_mute(muted) {
                                run_logger::error(
                                    "bindings",
                                    "toggle_mute_focus_failed",
                                    &format!("binding_id={} error={}", binding.id, err),
                                );
                            } else {
                                any_applied = true;
                            }
                        }
                    }
                    model::BindingTarget::Session { session_id } => {
                        if let Err(err) = self.audio.set_session_mute(session_id, muted) {
                            run_logger::error(
                                "bindings",
                                "toggle_mute_session_failed",
                                &format!(
                                    "binding_id={} session_id={} error={}",
                                    binding.id, session_id, err
                                ),
                            );
                        } else {
                            any_applied = true;
                        }
                    }
                    model::BindingTarget::Application { name } => {
                        if let Err(err) = self.audio.set_application_mute(name, muted) {
                            run_logger::error(
                                "bindings",
                                "toggle_mute_application_failed",
                                &format!("binding_id={} app={} error={}", binding.id, name, err),
                            );
                        } else {
                            any_applied = true;
                        }
                    }
                    model::BindingTarget::Device { device_id } => {
                        if let Err(err) = self.audio.set_device_mute(device_id, muted) {
                            run_logger::error(
                                "bindings",
                                "toggle_mute_device_failed",
                                &format!(
                                    "binding_id={} device_id={} error={}",
                                    binding.id, device_id, err
                                ),
                            );
                        } else {
                            any_applied = true;
                        }
                    }
                    model::BindingTarget::Integration {
                        integration_id,
                        kind,
                        data,
                    } => {
                        let payload = serde_json::json!({
                          "binding_id": binding.id,
                          "action": "ToggleMute",
                          "value": if muted { 1.0 } else { 0.0 },
                          "target_index": target_index,
                          "target_count": targets.len(),
                          "is_primary_target": target_index == 0,
                          "target": {
                            "integration_id": integration_id,
                            "kind": kind,
                            "data": data,
                          }
                        });
                        let _ = app.emit("integration_binding_triggered", payload);
                        any_applied = true;
                    }
                    model::BindingTarget::Unset
                    | model::BindingTarget::MediaControl
                    | model::BindingTarget::Hotkey
                    | model::BindingTarget::OpenApplication => {}
                }
            }

            if !any_applied {
                run_logger::warn(
                    "bindings",
                    "toggle_mute_no_target_applied",
                    &format!("binding_id={} targets={}", binding.id, targets.len()),
                );
                return Ok(());
            }

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

            let settings_enabled = self
                .osd_settings
                .lock()
                .map(|settings| settings.enabled)
                .unwrap_or(true);

            for target in &targets {
                let focus_session = if matches!(target, model::BindingTarget::Focus) {
                    self.audio.focused_session().ok().flatten()
                } else {
                    None
                };
                let payload = serde_json::json!({
                  "target": target,
                  "muted": muted,
                  "action": "toggle_mute",
                  "focus_session": focus_session,
                  "binding_id": binding.id
                });
                let _ = app.emit("mute_update", payload.clone());

                if settings_enabled {
                    if let Some(osd_window) = app.get_webview_window("osd") {
                        let _ = osd_window.show();
                        let _ = osd_window.set_always_on_top(true);
                        #[cfg(target_os = "windows")]
                        if let Ok(hwnd) = osd_window.hwnd() {
                            use windows::Win32::Foundation::HWND;
                            use windows::Win32::UI::WindowsAndMessaging::{
                                SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
                            };
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
            }

            return Ok(());
        }

        let mut any_applied = false;
        for (target_index, target) in targets.iter().enumerate() {
            match target {
                model::BindingTarget::Master => {
                    if let Err(err) = self.audio.set_master_volume(volume) {
                        run_logger::error(
                            "bindings",
                            "set_master_volume_failed",
                            &format!("binding_id={} error={}", binding.id, err),
                        );
                    } else {
                        any_applied = true;
                    }
                }
                model::BindingTarget::Focus => {
                    if self.apply_focus_volume_with_retry(&binding.id, volume) {
                        any_applied = true;
                    }
                }
                model::BindingTarget::Session { session_id } => {
                    if let Err(err) = self.audio.set_session_volume(session_id, volume) {
                        run_logger::error(
                            "bindings",
                            "set_session_volume_failed",
                            &format!(
                                "binding_id={} session_id={} error={}",
                                binding.id, session_id, err
                            ),
                        );
                    } else {
                        any_applied = true;
                    }
                }
                model::BindingTarget::Application { name } => {
                    if let Err(err) = self.audio.set_application_volume(name, volume) {
                        run_logger::error(
                            "bindings",
                            "set_application_volume_failed",
                            &format!("binding_id={} app={} error={}", binding.id, name, err),
                        );
                    } else {
                        any_applied = true;
                    }
                }
                model::BindingTarget::Device { device_id } => {
                    if let Err(err) = self.audio.set_device_volume(device_id, volume) {
                        run_logger::error(
                            "bindings",
                            "set_device_volume_failed",
                            &format!(
                                "binding_id={} device_id={} error={}",
                                binding.id, device_id, err
                            ),
                        );
                    } else {
                        any_applied = true;
                    }
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
                      "target_index": target_index,
                      "target_count": targets.len(),
                      "is_primary_target": target_index == 0,
                      "target": {
                        "integration_id": integration_id,
                        "kind": kind,
                        "data": data,
                      }
                    });
                    let _ = app.emit("integration_binding_triggered", payload);
                    any_applied = true;
                }
                model::BindingTarget::Unset
                | model::BindingTarget::MediaControl
                | model::BindingTarget::Hotkey
                | model::BindingTarget::OpenApplication => {}
            }
        }

        if !any_applied {
            run_logger::warn(
                "bindings",
                "volume_no_target_applied",
                &format!("binding_id={} targets={}", binding.id, targets.len()),
            );
            return Ok(());
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

        let settings_enabled = self
            .osd_settings
            .lock()
            .map(|settings| settings.enabled)
            .unwrap_or(true);
        for target in &targets {
            let focus_session = if matches!(target, model::BindingTarget::Focus) {
                self.audio.focused_session().ok().flatten()
            } else {
                None
            };
            let payload = serde_json::json!({
              "target": target,
              "volume": volume,
              "focus_session": focus_session,
              "binding_id": binding.id
            });
            let _ = app.emit("volume_update", payload.clone());

            if settings_enabled {
                if let Some(osd_window) = app.get_webview_window("osd") {
                    let _ = osd_window.show();
                    let _ = osd_window.set_always_on_top(true);
                    #[cfg(target_os = "windows")]
                    if let Ok(hwnd) = osd_window.hwnd() {
                        use windows::Win32::Foundation::HWND;
                        use windows::Win32::UI::WindowsAndMessaging::{
                            SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
                        };
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
                    model::BindingTarget::MediaControl => None,
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

#[cfg(target_os = "windows")]
fn focused_application_name() -> Option<String> {
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
fn focused_application_name() -> Option<String> {
    None
}

fn shutdown_lights(state: &AppState) {
    run_logger::info("app", "shutdown_lights_start", "");
    if let Ok(profile_guard) = state.active_profile.lock() {
        if let Some(profile) = profile_guard.as_ref() {
            run_logger::info(
                "app",
                "shutdown_lights_profile",
                &format!("binding_count={}", profile.bindings.len()),
            );
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
    run_logger::info("app", "shutdown_lights_done", "");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate_with_values(
        msg_type: model::MidiMessageType,
        saw_zero: bool,
        saw_max: bool,
    ) -> LearnCandidate {
        let now = Instant::now();
        LearnCandidate {
            control: LearnedControl {
                device_id: "midi:0".to_string(),
                channel: 0,
                controller: 1,
                msg_type,
                control_kind: model::BindingControlKind::Auto,
            },
            last_seen_at: now,
            saw_zero,
            saw_max,
        }
    }

    #[test]
    fn learn_note_is_classified_as_button() {
        let candidate = candidate_with_values(model::MidiMessageType::Note, false, false);
        let learned = classify_learned_control(&candidate);
        assert_eq!(learned.control_kind, model::BindingControlKind::Button);
    }

    #[test]
    fn learn_cc_127_and_0_is_classified_as_button() {
        let candidate = candidate_with_values(model::MidiMessageType::ControlChange, true, true);
        let learned = classify_learned_control(&candidate);
        assert_eq!(learned.control_kind, model::BindingControlKind::Button);
    }

    #[test]
    fn learn_cc_varied_values_without_min_max_is_continuous() {
        let candidate = candidate_with_values(model::MidiMessageType::ControlChange, false, false);
        let learned = classify_learned_control(&candidate);
        assert_eq!(learned.control_kind, model::BindingControlKind::Continuous);
    }

    #[test]
    fn learn_cc_single_127_only_is_continuous() {
        let candidate = candidate_with_values(model::MidiMessageType::ControlChange, false, true);
        let learned = classify_learned_control(&candidate);
        assert_eq!(learned.control_kind, model::BindingControlKind::Continuous);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
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
            if let Err(err) = run_logger::init(&config_dir) {
                eprintln!("[midimaster-log-init-failed] {}", err);
            }
            run_logger::info(
                "app",
                "startup",
                &format!("config_dir={}", config_dir.display()),
            );

            // Ensure bundled plugins exist in the runtime plugins directory.
            ensure_builtin_plugin(
                &app.handle(),
                "hue",
                include_str!("../builtin_plugins/hue/manifest.json"),
                include_str!("../builtin_plugins/hue/plugin.mjs"),
                &[(
                    "HueLogo.svg",
                    include_bytes!("../builtin_plugins/hue/HueLogo.svg") as &[u8],
                )],
            );
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
            run_logger::info(
                "app",
                "settings_loaded",
                &format!(
                    "start_with_windows={} start_in_tray={} minimize_to_tray={} exit_to_tray={}",
                    app_settings.start_with_windows,
                    app_settings.start_in_tray,
                    app_settings.minimize_to_tray,
                    app_settings.exit_to_tray
                ),
            );
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
                focus_volume_failure_logs: Mutex::new(HashMap::new()),
                mute_transition_until: Mutex::new(HashMap::new()),
                last_target_mute_state: Mutex::new(HashMap::new()),
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
                            run_logger::info("app", "tray_quit", "shutdown requested from tray");
                            shutdown_lights(&state);
                            app.exit(0);
                        }
                        _ => {}
                    },
                )
                .build(app)?;

            // Open devtools if --devtools flag or MIDIMASTER_DEVTOOLS env var is set
            let open_devtools = std::env::args().any(|a| a == "--devtools")
                || std::env::var("MIDIMASTER_DEVTOOLS").map_or(false, |v| v == "1");
            if open_devtools {
                if let Some(w) = app.get_webview_window("main") {
                    w.open_devtools();
                }
            }

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
                            run_logger::info("app", "close_to_tray", "main window hidden to tray");
                            return;
                        }
                        if let Some(osd_window) = app_handle.get_webview_window("osd") {
                            let _ = osd_window.close();
                        }
                        let state = app_handle.state::<AppState>();
                        run_logger::info("app", "window_close", "main window close requested");
                        shutdown_lights(&state);
                        app_handle.exit(0);
                    }
                    tauri::WindowEvent::Destroyed => {
                        let state = app_handle.state::<AppState>();
                        run_logger::info("app", "window_destroyed", "main window destroyed");
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
                        if let Some(candidate) = &*candidate_guard {
                            if candidate.last_seen_at.elapsed() > Duration::from_millis(150) {
                                commit_candidate =
                                    candidate_guard.take().map(|c| classify_learned_control(&c));
                            }
                        }
                    }
                    if let Some(candidate) = commit_candidate {
                        if let Ok(mut pending) = state.learn_pending.lock() {
                            if *pending {
                                run_logger::info(
                                    "learn",
                                    "candidate_committed",
                                    &format!(
                                        "device_id={} channel={} controller={} msg_type={:?} control_kind={:?}",
                                        candidate.device_id,
                                        candidate.channel,
                                        candidate.controller,
                                        candidate.msg_type,
                                        candidate.control_kind
                                    ),
                                );
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
            set_theme_preference,
            set_midi_device_preferences,
            clear_midi_device_preferences,
            set_active_profile_preference,
            reset_app_data,
            open_logs_folder,
            pick_executable_path,
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
            apply_binding_action,
            get_plugins_dir,
            list_plugins,
            read_plugin_text,
            read_plugin_base64,
            install_plugin_package,
            uninstall_plugin,
            set_plugin_enabled,
            hue_discover_bridges,
            hue_pair_bridge,
            hue_api_get,
            hue_api_put,
            ws_open,
            ws_send,
            ws_close,
            get_wavelink_ws_port,
            fetch_store_catalog,
            install_store_plugin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

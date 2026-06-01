use crate::bindings::BindingKey;
use crate::midi_event_queue::log_queue_stats;
use crate::model::{BindingTarget, SessionInfo};
use crate::run_logger;
use crate::runtime_helpers::classify_learned_control;
use crate::AppState;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::sleep;

fn focused_sessions_match(left: &Option<SessionInfo>, right: &Option<SessionInfo>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            left.id == right.id
                && left.display_name == right.display_name
                && left.process_name == right.process_name
                && left.process_path == right.process_path
                && left.icon_data == right.icon_data
                && left.is_muted == right.is_muted
                && left.is_master == right.is_master
                && (left.volume - right.volume).abs() < 0.0005
        }
        (None, None) => true,
        _ => false,
    }
}

fn profile_has_focus_target(profile: &crate::model::Profile) -> bool {
    profile.bindings.iter().any(|binding| {
        binding
            .normalized_targets()
            .iter()
            .any(|target| matches!(target, BindingTarget::Focus))
    })
}

pub(crate) fn spawn_midi_event_queue_loop(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app_handle.state::<AppState>();
            let (events, stats) = state
                .midi_event_queue
                .lock()
                .map(|mut queue| {
                    let events = queue.drain();
                    let stats = queue.take_stats();
                    (events, stats)
                })
                .unwrap_or_default();

            log_queue_stats(stats);

            for event in events {
                let _ = app_handle.emit("midi_event", &event);
                if let Err(err) = state.apply_midi_event(&app_handle, event) {
                    run_logger::error(
                        "midi_queue",
                        "event_apply_failed",
                        &format!("error={}", err),
                    );
                }
            }

            sleep(Duration::from_millis(8)).await;
        }
    });
}

pub(crate) fn spawn_feedback_refresh_loop(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_focused_session: Option<SessionInfo> = None;
        loop {
            let state = app_handle.state::<AppState>();

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
                let feedback_snapshot = state.sync_feedback_values(&profile);
                if profile_has_focus_target(&profile)
                    && !focused_sessions_match(
                        &last_focused_session,
                        &feedback_snapshot.focused_session,
                    )
                {
                    last_focused_session = feedback_snapshot.focused_session.clone();
                    let _ = app_handle.emit("focused_session_update", &last_focused_session);
                }
                let feedback = state
                    .feedback_values
                    .lock()
                    .map(|values| values.clone())
                    .unwrap_or_default();

                if let Ok(mut midi) = state.midi.lock() {
                    for binding in &profile.bindings {
                        let key = BindingKey::from_binding(binding);
                        if let Some(volume) = feedback.get(&key).cloned() {
                            let _ = midi.send_binding_feedback(binding, volume);
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
}

use crate::bindings::BindingKey;
use crate::feedback;
use crate::midi_event_queue::log_queue_stats;
use crate::model::{BindingTarget, Profile, SessionInfo};
use crate::run_logger;
use crate::runtime_helpers::classify_learned_control;
use crate::AppState;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::sleep;

const MIDI_QUEUE_BATCH_DELAY: Duration = Duration::from_millis(4);
const FEEDBACK_SYNC_INTERVAL: Duration = Duration::from_millis(750);
const FOCUS_FEEDBACK_SYNC_INTERVAL: Duration = Duration::from_millis(250);
const FULL_FEEDBACK_RESEND_INTERVAL: Duration = Duration::from_secs(10);
const LEARN_COMMIT_CHECK_INTERVAL: Duration = Duration::from_millis(25);
const OSD_HIDE_CHECK_INTERVAL: Duration = Duration::from_millis(100);
const IDLE_BACKGROUND_INTERVAL: Duration = Duration::from_secs(1);
const MIDI_FEEDBACK_EPSILON: f32 = 0.005;

static MIDI_EVENT_QUEUE_NOTIFY: OnceLock<Arc<tokio::sync::Notify>> = OnceLock::new();

fn midi_event_queue_notify() -> Arc<tokio::sync::Notify> {
    MIDI_EVENT_QUEUE_NOTIFY
        .get_or_init(|| Arc::new(tokio::sync::Notify::new()))
        .clone()
}

pub(crate) fn notify_midi_event_queued() {
    midi_event_queue_notify().notify_one();
}

fn focused_sessions_match(left: &Option<SessionInfo>, right: &Option<SessionInfo>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            left.id == right.id
                && left.display_name == right.display_name
                && left.application_key == right.application_key
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

fn feedback_context_signature(profile: &Profile, active_routes: Vec<(String, String)>) -> String {
    let binding_ids = profile
        .bindings
        .iter()
        .map(|binding| binding.id.as_str())
        .collect::<Vec<_>>()
        .join("|");
    let active_routes = active_routes
        .into_iter()
        .map(|(input, output)| format!("{}->{}", input, output))
        .collect::<Vec<_>>()
        .join("|");

    format!("{}:{}:{}", profile.name, active_routes, binding_ids)
}

fn should_send_feedback(
    last_sent_feedback: &mut HashMap<BindingKey, f32>,
    key: BindingKey,
    value: f32,
    force: bool,
) -> bool {
    if !force {
        if let Some(previous) = last_sent_feedback.get(&key) {
            if (previous - value).abs() < MIDI_FEEDBACK_EPSILON {
                return false;
            }
        }
    }

    last_sent_feedback.insert(key, value);
    true
}

pub(crate) fn spawn_midi_event_queue_loop(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let notify = midi_event_queue_notify();
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

            if events.is_empty() && stats.coalesced == 0 && stats.dropped == 0 {
                notify.notified().await;
                sleep(MIDI_QUEUE_BATCH_DELAY).await;
                continue;
            }

            let had_events = !events.is_empty();
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
            if had_events {
                sleep(MIDI_QUEUE_BATCH_DELAY).await;
            }
        }
    });
}

pub(crate) fn spawn_feedback_refresh_loop(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_focused_session: Option<SessionInfo> = None;
        let mut last_feedback_sync = Instant::now()
            .checked_sub(FEEDBACK_SYNC_INTERVAL)
            .unwrap_or_else(Instant::now);
        let mut last_full_feedback_resend = Instant::now()
            .checked_sub(FULL_FEEDBACK_RESEND_INTERVAL)
            .unwrap_or_else(Instant::now);
        let mut last_learn_commit_check = Instant::now()
            .checked_sub(LEARN_COMMIT_CHECK_INTERVAL)
            .unwrap_or_else(Instant::now);
        let mut last_osd_hide_check = Instant::now()
            .checked_sub(OSD_HIDE_CHECK_INTERVAL)
            .unwrap_or_else(Instant::now);
        let mut last_feedback_context = String::new();
        let mut last_sent_feedback: HashMap<BindingKey, f32> = HashMap::new();

        loop {
            let loop_started = Instant::now();
            let state = app_handle.state::<AppState>();

            if last_learn_commit_check.elapsed() >= LEARN_COMMIT_CHECK_INTERVAL {
                last_learn_commit_check = loop_started;
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
            }

            let profile = state
                .active_profile
                .lock()
                .ok()
                .and_then(|profile| profile.clone());
            let profile_active = profile.is_some();
            if let Some(profile) = profile.as_ref() {
                let sync_interval = if profile_has_focus_target(profile) {
                    FOCUS_FEEDBACK_SYNC_INTERVAL
                } else {
                    FEEDBACK_SYNC_INTERVAL
                };

                if last_feedback_sync.elapsed() >= sync_interval {
                    last_feedback_sync = loop_started;

                    let active_routes = state
                        .midi
                        .lock()
                        .map(|midi| midi.active_routes())
                        .unwrap_or_default();
                    let context = feedback_context_signature(profile, active_routes);
                    let context_changed = context != last_feedback_context;
                    if context_changed {
                        last_feedback_context = context;
                        last_sent_feedback.clear();
                    }

                    let force_feedback_resend = context_changed
                        || last_full_feedback_resend.elapsed() >= FULL_FEEDBACK_RESEND_INTERVAL;
                    if force_feedback_resend {
                        last_full_feedback_resend = loop_started;
                    }

                    let feedback_snapshot = state.sync_feedback_values(profile);
                    if profile_has_focus_target(profile)
                        && !focused_sessions_match(
                            &last_focused_session,
                            &feedback_snapshot.focused_session,
                        )
                    {
                        last_focused_session = feedback_snapshot.focused_session.clone();
                        let _ = app_handle.emit("focused_session_update", &last_focused_session);
                    }
                    let feedback_snapshot = state
                        .feedback_values
                        .lock()
                        .map(|values| values.clone())
                        .unwrap_or_default();

                    if let Ok(mut midi) = state.midi.lock() {
                        for binding in &profile.bindings {
                            let key = BindingKey::from_binding(binding);
                            if let Some(volume) = feedback_snapshot.get(&key).cloned() {
                                let output_key = feedback::binding_feedback_control_key(binding)
                                    .to_binding_key();
                                if should_send_feedback(
                                    &mut last_sent_feedback,
                                    output_key,
                                    volume,
                                    force_feedback_resend,
                                ) {
                                    if binding.is_button_binding() {
                                        let _ = midi.send_binding_light_feedback(binding, volume);
                                    } else {
                                        let _ = midi.send_binding_feedback(binding, volume);
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                last_focused_session = None;
                last_feedback_context.clear();
                last_sent_feedback.clear();
            }

            if last_osd_hide_check.elapsed() >= OSD_HIDE_CHECK_INTERVAL {
                last_osd_hide_check = loop_started;
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
            }

            let learn_active = state
                .learn_pending
                .lock()
                .map(|pending| *pending)
                .unwrap_or(false)
                || state
                    .learn_candidate
                    .lock()
                    .map(|candidate| candidate.is_some())
                    .unwrap_or(false);
            let osd_active = state
                .osd_last_update
                .lock()
                .map(|last_update| last_update.is_some())
                .unwrap_or(false);
            let active_profile_has_focus_target = state
                .active_profile
                .lock()
                .ok()
                .and_then(|profile| profile.as_ref().map(profile_has_focus_target))
                .unwrap_or(false);

            let next_sleep = if learn_active {
                LEARN_COMMIT_CHECK_INTERVAL
            } else if osd_active {
                OSD_HIDE_CHECK_INTERVAL
            } else if active_profile_has_focus_target {
                FOCUS_FEEDBACK_SYNC_INTERVAL
            } else if profile_active {
                FEEDBACK_SYNC_INTERVAL
            } else {
                IDLE_BACKGROUND_INTERVAL
            };

            sleep(next_sleep).await;
        }
    });
}

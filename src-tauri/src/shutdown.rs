use crate::run_logger;
use crate::voicemeeter::VoicemeeterState;
use crate::ws_bridge::WsHub;
use crate::AppState;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};
use tokio::sync::watch;
use tokio::time::timeout;

const BACKGROUND_TASK_TIMEOUT: Duration = Duration::from_millis(500);
const WEBSOCKET_CLOSE_TIMEOUT: Duration = Duration::from_millis(250);
const RESOURCE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShutdownAction {
    Exit(i32),
    Restart,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum ShutdownPhase {
    Running = 0,
    Cleaning = 1,
    Complete = 2,
}

impl ShutdownPhase {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Cleaning,
            2 => Self::Complete,
            _ => Self::Running,
        }
    }
}

pub(crate) struct ShutdownCoordinator {
    phase: AtomicU8,
    cancel_tx: watch::Sender<bool>,
    background_tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Default for ShutdownCoordinator {
    fn default() -> Self {
        let (cancel_tx, _) = watch::channel(false);
        Self {
            phase: AtomicU8::new(ShutdownPhase::Running as u8),
            cancel_tx,
            background_tasks: Mutex::new(Vec::new()),
        }
    }
}

impl ShutdownCoordinator {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<bool> {
        self.cancel_tx.subscribe()
    }

    pub(crate) fn track_background_task(&self, task: JoinHandle<()>) {
        if let Ok(mut tasks) = self.background_tasks.lock() {
            if self.phase() == ShutdownPhase::Running {
                tasks.push(task);
                return;
            }
        }
        task.abort();
    }

    fn phase(&self) -> ShutdownPhase {
        ShutdownPhase::from_u8(self.phase.load(Ordering::Acquire))
    }

    fn try_begin(&self) -> bool {
        self.phase
            .compare_exchange(
                ShutdownPhase::Running as u8,
                ShutdownPhase::Cleaning as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn signal_cancellation(&self) {
        self.cancel_tx.send_replace(true);
    }

    fn take_background_tasks(&self) -> Vec<JoinHandle<()>> {
        self.background_tasks
            .lock()
            .map(|mut tasks| std::mem::take(&mut *tasks))
            .unwrap_or_default()
    }

    fn mark_complete(&self) {
        self.phase
            .store(ShutdownPhase::Complete as u8, Ordering::Release);
    }

    fn is_complete(&self) -> bool {
        self.phase() == ShutdownPhase::Complete
    }

    fn abort_background_tasks(&self) {
        self.signal_cancellation();
        for task in self.take_background_tasks() {
            task.abort();
        }
    }
}

async fn wait_for_background_tasks(tasks: &mut [JoinHandle<()>], wait_timeout: Duration) -> bool {
    timeout(wait_timeout, async {
        for task in tasks {
            if let Err(err) = task.await {
                run_logger::warn(
                    "app",
                    "shutdown_background_task_failed",
                    &format!("error={err}"),
                );
            }
        }
    })
    .await
    .is_ok()
}

fn hide_windows(app: &AppHandle) {
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
}

async fn stop_background_tasks(app: &AppHandle) {
    let coordinator = app.state::<ShutdownCoordinator>();
    coordinator.signal_cancellation();
    let mut tasks = coordinator.take_background_tasks();
    let task_count = tasks.len();
    if task_count == 0 {
        return;
    }

    let completed = wait_for_background_tasks(&mut tasks, BACKGROUND_TASK_TIMEOUT).await;

    if completed {
        run_logger::info(
            "app",
            "shutdown_background_tasks_stopped",
            &format!("task_count={task_count}"),
        );
    } else {
        for task in &tasks {
            task.abort();
        }
        run_logger::warn(
            "app",
            "shutdown_background_tasks_timeout",
            &format!(
                "task_count={task_count} timeout_ms={}",
                BACKGROUND_TASK_TIMEOUT.as_millis()
            ),
        );
    }
}

fn stop_managed_resources(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.soundboard.stop_all();
    state.virtual_audio.stop();
    state.cancel_activity_button_light_holds();

    let profile = state
        .active_profile
        .lock()
        .ok()
        .and_then(|profile| profile.clone());

    match state.midi.lock() {
        Ok(mut midi) => {
            if let Some(profile) = profile {
                run_logger::info(
                    "app",
                    "shutdown_lights_profile",
                    &format!("binding_count={}", profile.bindings.len()),
                );
                for binding in &profile.bindings {
                    if binding.is_button_binding() {
                        let _ = midi.send_binding_light_feedback(binding, 0.0);
                    } else {
                        let _ = midi.send_binding_feedback_position(binding, 0.0);
                    }
                }
            }
            midi.stop();
            run_logger::info("app", "shutdown_midi_stopped", "");
        }
        Err(_) => {
            run_logger::warn("app", "shutdown_midi_lock_failed", "");
        }
    }

    if let Err(err) = app.state::<VoicemeeterState>().disconnect_for_shutdown() {
        run_logger::warn(
            "app",
            "shutdown_voicemeeter_disconnect_failed",
            &format!("error={err}"),
        );
    }
}

fn stop_managed_resources_best_effort(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.soundboard.stop_all();
    state.virtual_audio.stop();
    state.cancel_activity_button_light_holds();

    let profile = state
        .active_profile
        .try_lock()
        .ok()
        .and_then(|profile| profile.clone());
    if let Ok(mut midi) = state.midi.try_lock() {
        if let Some(profile) = profile {
            for binding in &profile.bindings {
                if binding.is_button_binding() {
                    let _ = midi.send_binding_light_feedback(binding, 0.0);
                } else {
                    let _ = midi.send_binding_feedback_position(binding, 0.0);
                }
            }
        }
        midi.stop();
    } else {
        run_logger::warn("app", "shutdown_midi_busy_at_exit", "");
    }

    if let Err(err) = app
        .state::<VoicemeeterState>()
        .try_disconnect_for_shutdown()
    {
        run_logger::warn(
            "app",
            "shutdown_voicemeeter_busy_at_exit",
            &format!("error={err}"),
        );
    }
}

async fn perform_cleanup(app: AppHandle) {
    stop_background_tasks(&app).await;

    let blocking_app = app.clone();
    match timeout(
        RESOURCE_CLEANUP_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || stop_managed_resources(&blocking_app)),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(err)) => run_logger::warn(
            "app",
            "shutdown_resource_task_failed",
            &format!("error={err}"),
        ),
        Err(_) => run_logger::warn(
            "app",
            "shutdown_resource_cleanup_timeout",
            &format!("timeout_ms={}", RESOURCE_CLEANUP_TIMEOUT.as_millis()),
        ),
    }

    if !app
        .state::<WsHub>()
        .shutdown_all(WEBSOCKET_CLOSE_TIMEOUT)
        .await
    {
        run_logger::warn(
            "app",
            "shutdown_websocket_timeout",
            &format!("timeout_ms={}", WEBSOCKET_CLOSE_TIMEOUT.as_millis()),
        );
    }
}

async fn perform_cleanup_with_deadline(app: AppHandle) {
    if timeout(SHUTDOWN_TIMEOUT, perform_cleanup(app))
        .await
        .is_err()
    {
        run_logger::warn(
            "app",
            "shutdown_timeout",
            &format!("timeout_ms={}", SHUTDOWN_TIMEOUT.as_millis()),
        );
    }
}

pub(crate) fn request_shutdown(app: AppHandle, action: ShutdownAction, source: &'static str) {
    let coordinator = app.state::<ShutdownCoordinator>();
    if !coordinator.try_begin() {
        run_logger::info(
            "app",
            "shutdown_request_ignored",
            &format!("source={source} phase={:?}", coordinator.phase()),
        );
        return;
    }

    let started = Instant::now();
    run_logger::info(
        "app",
        "shutdown_start",
        &format!("source={source} action={action:?}"),
    );
    hide_windows(&app);
    coordinator.signal_cancellation();
    app.state::<WsHub>().begin_shutdown();

    tauri::async_runtime::spawn(async move {
        perform_cleanup_with_deadline(app.clone()).await;

        app.state::<ShutdownCoordinator>().mark_complete();
        run_logger::info(
            "app",
            "shutdown_complete",
            &format!(
                "source={source} action={action:?} elapsed_ms={}",
                started.elapsed().as_millis()
            ),
        );
        run_logger::flush_pending_repeats();

        match action {
            ShutdownAction::Exit(code) => app.exit(code),
            ShutdownAction::Restart => app.request_restart(),
        }
    });
}

pub(crate) fn prepare_for_updater_exit(app: &AppHandle) {
    let coordinator = app.state::<ShutdownCoordinator>();
    if !coordinator.try_begin() {
        let started = Instant::now();
        while !coordinator.is_complete() && started.elapsed() < SHUTDOWN_TIMEOUT {
            std::thread::sleep(Duration::from_millis(10));
        }
        return;
    }

    let started = Instant::now();
    run_logger::info(
        "app",
        "shutdown_start",
        "source=updater_install action=UpdaterInstall",
    );
    hide_windows(app);
    coordinator.signal_cancellation();
    app.state::<WsHub>().begin_shutdown();

    let (completion_tx, completion_rx) = std::sync::mpsc::sync_channel(1);
    let cleanup_app = app.clone();
    let worker = std::thread::Builder::new()
        .name("midimaster-updater-cleanup".to_string())
        .spawn(move || {
            tauri::async_runtime::block_on(perform_cleanup_with_deadline(cleanup_app.clone()));
            cleanup_app.state::<ShutdownCoordinator>().mark_complete();
            run_logger::info(
                "app",
                "shutdown_complete",
                &format!(
                    "source=updater_install action=UpdaterInstall elapsed_ms={}",
                    started.elapsed().as_millis()
                ),
            );
            run_logger::flush_pending_repeats();
            let _ = completion_tx.send(());
        });

    if let Err(err) = worker {
        run_logger::warn(
            "app",
            "updater_cleanup_thread_failed",
            &format!("error={err}"),
        );
        finish_unexpected_exit(app);
        return;
    }

    if completion_rx.recv_timeout(SHUTDOWN_TIMEOUT).is_err() {
        run_logger::warn(
            "app",
            "updater_cleanup_wait_timeout",
            &format!("timeout_ms={}", SHUTDOWN_TIMEOUT.as_millis()),
        );
        run_logger::flush_pending_repeats();
    }
}

pub(crate) fn handle_exit_requested(
    app: &AppHandle,
    code: Option<i32>,
    api: &tauri::ExitRequestApi,
) {
    let coordinator = app.state::<ShutdownCoordinator>();
    if coordinator.is_complete() {
        return;
    }

    api.prevent_exit();
    let action = if code == Some(tauri::RESTART_EXIT_CODE) {
        ShutdownAction::Restart
    } else {
        ShutdownAction::Exit(code.unwrap_or(0))
    };
    request_shutdown(app.clone(), action, "run_event_exit_requested");
}

pub(crate) fn finish_unexpected_exit(app: &AppHandle) {
    let coordinator = app.state::<ShutdownCoordinator>();
    if coordinator.is_complete() {
        return;
    }

    run_logger::warn(
        "app",
        "shutdown_exit_fallback",
        &format!("phase={:?}", coordinator.phase()),
    );
    coordinator.abort_background_tasks();
    app.state::<WsHub>().shutdown_now();
    stop_managed_resources_best_effort(app);
    coordinator.mark_complete();
    run_logger::flush_pending_repeats();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_coordinator_only_begins_once() {
        let coordinator = ShutdownCoordinator::new();
        assert_eq!(coordinator.phase(), ShutdownPhase::Running);
        assert!(coordinator.try_begin());
        assert!(!coordinator.try_begin());
        assert_eq!(coordinator.phase(), ShutdownPhase::Cleaning);
        coordinator.mark_complete();
        assert!(coordinator.is_complete());
    }

    #[test]
    fn shutdown_signal_reaches_existing_and_late_subscribers() {
        let coordinator = ShutdownCoordinator::new();
        let existing = coordinator.subscribe();
        assert!(!*existing.borrow());

        coordinator.signal_cancellation();
        assert!(*existing.borrow());
        assert!(*coordinator.subscribe().borrow());
    }

    #[test]
    fn background_task_wait_is_bounded() {
        tauri::async_runtime::block_on(async {
            let task = tauri::async_runtime::spawn(async {
                std::future::pending::<()>().await;
            });
            let mut tasks = vec![task];
            assert!(
                !wait_for_background_tasks(&mut tasks, Duration::from_millis(1)).await,
                "a stuck background task must not hold shutdown open"
            );
            for task in tasks {
                task.abort();
            }
        });
    }
}

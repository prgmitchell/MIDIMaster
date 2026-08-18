#![cfg_attr(feature = "perf-audit", allow(dead_code))]

mod app_paths;
mod app_settings;
mod app_state;
mod audio;
mod background_tasks;
mod binding_actions;
mod bindings;
mod builtin_plugins;
mod commands;
mod device_target;
mod durable_json_store;
mod feedback;
mod midi;
mod midi_event_queue;
pub mod model;
mod monitor_brightness;
mod monitors;
mod osd_window;
#[cfg(feature = "perf-audit")]
mod perf_audit;
mod plugin_api;
mod profile_snapshot;
mod profile_store;
mod run_logger;
mod runtime_helpers;
mod runtime_midi;
mod shutdown;
mod soundboard;
mod store_api;
mod telemetry;
mod virtual_audio;
mod voicemeeter;
mod windows_autostart;
mod windows_display;
mod ws_bridge;

#[cfg(feature = "perf-audit")]
pub mod perf_bench;
#[cfg(feature = "perf-audit")]
pub use audio::target_match;

use app_paths::app_data_root_dir;
use app_settings::{AppSettings, AppSettingsStore, CURRENT_STARTUP_REGISTRATION_VERSION};
pub(crate) use app_state::AppState;
use audio::AudioBackend;
use commands::*;
use durable_json_store::new_recovery_notices;
use profile_store::ProfileStore;
use shutdown::{ShutdownAction, ShutdownCoordinator};

#[cfg(test)]
use std::collections::HashMap;

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) use monitors::collect_monitor_descriptors;
use plugin_api::{
    get_plugins_dir, hue_api_get, hue_api_put, hue_discover_bridges, hue_pair_bridge,
    install_plugin_package, list_plugins, plugin_http_post_json, read_plugin_base64,
    read_plugin_text, set_plugin_enabled, uninstall_plugin,
};
use store_api::{fetch_store_catalog, install_store_plugin, install_store_plugins};
use voicemeeter::{
    voicemeeter_assign_device, voicemeeter_connect, voicemeeter_device_state,
    voicemeeter_disconnect, voicemeeter_launch, voicemeeter_list_devices, voicemeeter_safe_command,
    voicemeeter_snapshot, voicemeeter_status, voicemeeter_write_parameters, VoicemeeterState,
};
use ws_bridge::{get_wavelink_ws_port, ws_close, ws_open, ws_send, WsHub};

#[cfg(target_os = "windows")]
use audio::windows::WindowsAudioBackend;

#[cfg(not(target_os = "windows"))]
use audio::unsupported::UnsupportedAudioBackend;

#[cfg(feature = "perf-audit")]
fn log_startup_milestone(
    milestone: &str,
    phase_started: std::time::Instant,
    setup_started: std::time::Instant,
) {
    let run_id = std::env::var("MIDIMASTER_PERF_RUN_ID").unwrap_or_else(|_| "manual".to_string());
    let scenario = std::env::var("MIDIMASTER_PERF_SCENARIO_ID")
        .or_else(|_| std::env::var("MIDIMASTER_PERF_SCENARIO"))
        .unwrap_or_else(|_| "startup".to_string());
    let variant =
        std::env::var("MIDIMASTER_PERF_VARIANT").unwrap_or_else(|_| "current".to_string());
    run_logger::info(
        "perf_audit",
        milestone,
        &format!(
            "schema_version=1 run_id={} scenario_id={} variant={} duration_us={} setup_duration_us={}",
            run_id,
            scenario,
            variant,
            phase_started.elapsed().as_micros(),
            setup_started.elapsed().as_micros()
        ),
    );
}

fn migrate_startup_registration_if_needed(
    app_settings_store: &AppSettingsStore,
    app_settings: &mut AppSettings,
) {
    if app_settings.startup_registration_version >= CURRENT_STARTUP_REGISTRATION_VERSION {
        return;
    }

    let migration_result = if app_settings.start_with_windows {
        windows_autostart::set_windows_autostart(true)
    } else {
        windows_autostart::clear_windows_autostart_artifacts()
    };

    match migration_result {
        Ok(()) => {
            let mut updated = app_settings.clone();
            updated.startup_registration_version = CURRENT_STARTUP_REGISTRATION_VERSION;
            if let Err(err) = app_settings_store.save(&updated) {
                run_logger::warn(
                    "app",
                    "startup_registration_migration_save_failed",
                    &err.to_string(),
                );
            } else {
                *app_settings = updated;
                run_logger::info(
                    "app",
                    "startup_registration_migrated",
                    &format!("start_with_windows={}", app_settings.start_with_windows),
                );
            }
        }
        Err(err) if windows_autostart::startup_requires_installed_app(&err) => {
            let _ = windows_autostart::clear_windows_autostart_artifacts();
            let mut updated = app_settings.clone();
            updated.start_with_windows = false;
            updated.startup_registration_version = CURRENT_STARTUP_REGISTRATION_VERSION;
            if let Err(save_err) = app_settings_store.save(&updated) {
                run_logger::warn(
                    "app",
                    "startup_registration_migration_save_failed",
                    &save_err.to_string(),
                );
            } else {
                *app_settings = updated;
            }
            run_logger::warn("app", "startup_registration_disabled_uninstalled", &err);
        }
        Err(err) => {
            run_logger::warn("app", "startup_registration_migration_failed", &err);
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
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
                        ^ tauri_plugin_window_state::StateFlags::POSITION
                        ^ tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .setup(|app| {
            #[cfg(feature = "perf-audit")]
            let setup_started = std::time::Instant::now();
            #[cfg(feature = "perf-audit")]
            let mut phase_started = setup_started;
            let config_dir = app_data_root_dir(app.handle())
                .map_err(|_| "Unable to resolve config directory".to_string())?;
            if let Err(err) = run_logger::init(&config_dir) {
                eprintln!("[midimaster-log-init-failed] {}", err);
            }
            #[cfg(feature = "perf-audit")]
            {
                log_startup_milestone("logger_initialized", phase_started, setup_started);
                phase_started = std::time::Instant::now();
            }
            run_logger::info(
                "app",
                "startup",
                &format!("config_dir={}", config_dir.display()),
            );

            builtin_plugins::ensure_builtin_plugins(app.handle());
            #[cfg(feature = "perf-audit")]
            {
                log_startup_milestone("builtin_plugins_synchronized", phase_started, setup_started);
                phase_started = std::time::Instant::now();
            }
            let recovery_notices = new_recovery_notices();
            let profile_store =
                ProfileStore::with_recovery_notices(config_dir.clone(), recovery_notices.clone());
            let app_settings_store =
                AppSettingsStore::with_recovery_notices(config_dir, recovery_notices.clone());
            let mut app_settings = app_settings_store
                .load()
                .map_err(|err| format!("Unable to load app settings: {err}"))?;
            migrate_startup_registration_if_needed(&app_settings_store, &mut app_settings);
            if app_settings.start_with_windows {
                match windows_autostart::repair_windows_autostart_if_missing() {
                    Ok(true) => run_logger::info(
                        "app",
                        "startup_registration_repaired",
                        "reason=missing_shortcut",
                    ),
                    Ok(false) => {}
                    Err(err) => run_logger::warn("app", "startup_registration_repair_failed", &err),
                }
            }
            #[cfg(feature = "perf-audit")]
            {
                log_startup_milestone("settings_loaded", phase_started, setup_started);
                phase_started = std::time::Instant::now();
            }
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
            app.manage(VoicemeeterState::new());
            app.manage(ShutdownCoordinator::new());

            app.manage(AppState::new(
                audio,
                profile_store,
                app_settings_store,
                app_settings.clone(),
                recovery_notices,
            ));

            #[cfg(feature = "perf-audit")]
            let osd_url = "osd.html?perf-audit=1";
            #[cfg(not(feature = "perf-audit"))]
            let osd_url = "osd.html";
            let osd_window = WebviewWindowBuilder::new(app, "osd", WebviewUrl::App(osd_url.into()))
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
            #[cfg(feature = "perf-audit")]
            {
                log_startup_milestone("osd_window_created", phase_started, setup_started);
                phase_started = std::time::Instant::now();
            }

            if let Ok(settings) = app.state::<AppState>().osd_settings.lock() {
                AppState::apply_osd_settings(app.handle(), &settings);
            }
            if let Ok(settings) = app.state::<AppState>().app_settings.lock() {
                AppState::apply_app_settings(app.handle(), &settings);
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
            let restart_item = MenuItem::with_id(app, "restart", "Restart", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &restart_item, &quit_item])?;
            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            tray_builder
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .on_menu_event(
                    |app: &AppHandle, event: MenuEvent| match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "restart" => {
                            run_logger::info("app", "tray_restart", "restart requested from tray");
                            shutdown::request_shutdown(
                                app.clone(),
                                ShutdownAction::Restart,
                                "tray_restart",
                            );
                        }
                        "quit" => {
                            run_logger::info("app", "tray_quit", "shutdown requested from tray");
                            shutdown::request_shutdown(
                                app.clone(),
                                ShutdownAction::Exit(0),
                                "tray_quit",
                            );
                        }
                        _ => {}
                    },
                )
                .build(app)?;

            // Open devtools if --devtools flag or MIDIMASTER_DEVTOOLS env var is set
            let open_devtools = std::env::args().any(|a| a == "--devtools")
                || std::env::var("MIDIMASTER_DEVTOOLS").is_ok_and(|v| v == "1");
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
                        api.prevent_close();
                        run_logger::info("app", "window_close", "main window close requested");
                        shutdown::request_shutdown(
                            app_handle.clone(),
                            ShutdownAction::Exit(0),
                            "window_close",
                        );
                    }
                    tauri::WindowEvent::Destroyed => {
                        run_logger::info("app", "window_destroyed", "main window destroyed");
                        shutdown::request_shutdown(
                            app_handle.clone(),
                            ShutdownAction::Exit(0),
                            "window_destroyed",
                        );
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

            let shutdown = app.state::<ShutdownCoordinator>();
            let midi_queue_task = background_tasks::spawn_midi_event_queue_loop(
                app.handle().clone(),
                shutdown.subscribe(),
            );
            shutdown.track_background_task(midi_queue_task);
            let feedback_task = background_tasks::spawn_feedback_refresh_loop(
                app.handle().clone(),
                shutdown.subscribe(),
            );
            shutdown.track_background_task(feedback_task);
            let virtual_audio_task = background_tasks::spawn_virtual_audio_refresh_loop(
                app.handle().clone(),
                shutdown.subscribe(),
            );
            shutdown.track_background_task(virtual_audio_task);

            #[cfg(feature = "perf-audit")]
            log_startup_milestone("rust_setup_complete", phase_started, setup_started);

            Ok(())
        })
        .invoke_handler(commands::command_registry!())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                shutdown::handle_exit_requested(app, code, &api);
            }
            tauri::RunEvent::Exit => {
                shutdown::finish_unexpected_exit(app);
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bindings::{BindingKey, BindingState};
    use crate::model::LearnedControl;
    use crate::runtime_helpers::{
        cc_learn_value_is_definitely_continuous, classify_learned_control, LearnCandidate,
    };
    use anyhow::Result;
    use std::time::{Duration, Instant};

    struct TestAudioBackend {
        sessions: Vec<model::SessionInfo>,
        playback_devices: Vec<model::PlaybackDeviceInfo>,
        recording_devices: Vec<model::PlaybackDeviceInfo>,
        focused_session: Option<model::SessionInfo>,
    }

    impl TestAudioBackend {
        fn new(sessions: Vec<model::SessionInfo>) -> Self {
            Self {
                sessions,
                playback_devices: Vec::new(),
                recording_devices: Vec::new(),
                focused_session: None,
            }
        }

        fn with_focused_session(mut self, focused_session: model::SessionInfo) -> Self {
            self.focused_session = Some(focused_session);
            self
        }
    }

    impl AudioBackend for TestAudioBackend {
        fn list_sessions(&self) -> Result<Vec<model::SessionInfo>> {
            Ok(self.sessions.clone())
        }

        fn list_playback_devices(&self) -> Result<Vec<model::PlaybackDeviceInfo>> {
            Ok(self.playback_devices.clone())
        }

        fn list_recording_devices(&self) -> Result<Vec<model::PlaybackDeviceInfo>> {
            Ok(self.recording_devices.clone())
        }

        fn set_master_volume(&self, _volume: f32) -> Result<()> {
            Ok(())
        }

        fn set_session_volume(&self, _session_id: &str, _volume: f32) -> Result<()> {
            Ok(())
        }

        fn set_device_volume(&self, _device_id: &str, _volume: f32) -> Result<()> {
            Ok(())
        }

        fn set_focused_session_volume(&self, _volume: f32) -> Result<()> {
            Ok(())
        }

        fn set_application_volume(&self, _name: &str, _volume: f32) -> Result<()> {
            Ok(())
        }

        fn focused_session(&self) -> Result<Option<model::SessionInfo>> {
            Ok(self.focused_session.clone())
        }

        fn set_master_mute(&self, _muted: bool) -> Result<()> {
            Ok(())
        }

        fn set_session_mute(&self, _session_id: &str, _muted: bool) -> Result<()> {
            Ok(())
        }

        fn set_focused_session_mute(&self, _muted: bool) -> Result<()> {
            Ok(())
        }

        fn set_application_mute(&self, _name: &str, _muted: bool) -> Result<()> {
            Ok(())
        }

        fn set_device_mute(&self, _device_id: &str, _muted: bool) -> Result<()> {
            Ok(())
        }

        fn set_default_device(&self, _device_id: &str) -> Result<()> {
            Ok(())
        }
    }

    fn test_app_state(audio: TestAudioBackend) -> AppState {
        let config_dir = std::env::temp_dir().join(format!(
            "midimaster-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        AppState::new(
            Box::new(audio),
            ProfileStore::new(config_dir.clone()),
            AppSettingsStore::new(config_dir),
            app_settings::AppSettings::default(),
            new_recovery_notices(),
        )
    }

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

    fn session_info(name: &str, volume: f32, is_muted: bool) -> model::SessionInfo {
        model::SessionInfo {
            id: format!("session-{}", name.to_lowercase()),
            display_name: name.to_string(),
            application_key: None,
            process_name: Some(format!("{}.exe", name.to_lowercase())),
            process_path: Some(format!("C:\\Program Files\\{}\\{}.exe", name, name)),
            icon_data: None,
            volume,
            is_muted,
            is_master: false,
        }
    }

    fn relative_application_volume_binding(app_name: &str) -> model::Binding {
        model::Binding {
            id: "binding-relative-app".to_string(),
            name: "Relative App".to_string(),
            macro_name: String::new(),
            device_id: "device".to_string(),
            control: model::MidiControl {
                channel: 0,
                controller: 42,
                msg_type: model::MidiMessageType::ControlChange,
            },
            control_kind: model::BindingControlKind::Continuous,
            targets: vec![model::BindingTarget::Application {
                name: app_name.to_string(),
                display_name: Some("Firefox".to_string()),
                icon_data: None,
            }],
            target: model::BindingTarget::Application {
                name: app_name.to_string(),
                display_name: Some("Firefox".to_string()),
                icon_data: None,
            },
            action: model::BindingAction::Volume,
            mode: model::MidiMode::Relative,
            relative_format: model::RelativeFormat::Auto,
            fader_curve: model::FaderCurve::Linear,
            custom_curve: Vec::new(),
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: model::MuteBehavior::ToggleOnPress,
            button_light_mode: model::ButtonLightMode::Activity,
            button_light_behavior: model::ButtonLightBehavior::FollowState,
            feedback_enabled: true,
            indicator_control: None,
            mute_control: None,
            assign_control: None,
            assign_mode: model::AssignMode::Add,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
            soundboard: None,
            macro_steps: Vec::new(),
        }
    }

    fn focus_volume_binding(mode: model::MidiMode) -> model::Binding {
        model::Binding {
            id: "binding-focus".to_string(),
            name: "Focused App".to_string(),
            macro_name: String::new(),
            device_id: "device".to_string(),
            control: model::MidiControl {
                channel: 0,
                controller: 43,
                msg_type: model::MidiMessageType::ControlChange,
            },
            control_kind: model::BindingControlKind::Continuous,
            targets: vec![model::BindingTarget::Focus],
            target: model::BindingTarget::Focus,
            action: model::BindingAction::Volume,
            mode,
            relative_format: model::RelativeFormat::Auto,
            fader_curve: model::FaderCurve::Linear,
            custom_curve: Vec::new(),
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: model::MuteBehavior::ToggleOnPress,
            button_light_mode: model::ButtonLightMode::Activity,
            button_light_behavior: model::ButtonLightBehavior::FollowState,
            feedback_enabled: true,
            indicator_control: None,
            mute_control: None,
            assign_control: None,
            assign_mode: model::AssignMode::Add,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
            soundboard: None,
            macro_steps: Vec::new(),
        }
    }

    fn profile_with_binding(binding: model::Binding) -> model::Profile {
        model::Profile {
            name: "Default".to_string(),
            bindings: vec![binding],
            osd_settings: model::OsdSettings::default(),
            plugin_settings: HashMap::new(),
            midi_device_preference: model::MidiDevicePreference::default(),
            midi_device_preference_set: false,
        }
    }

    fn binding_state_with_update(last_value: f32, last_update: Instant) -> BindingState {
        BindingState {
            last_value,
            last_update,
            last_absolute_input: None,
            absolute_input_direction: 0,
            relative_auto_format: None,
            relative_seen_midpoint: false,
            relative_seen_sign_band: false,
            relative_seen_high_negative: false,
            relative_seen_low_negative_hint: false,
        }
    }

    #[test]
    fn learn_note_is_classified_as_button() {
        let candidate = candidate_with_values(model::MidiMessageType::Note, false, false);
        let learned = classify_learned_control(&candidate);
        assert_eq!(learned.control_kind, model::BindingControlKind::Button);
    }

    #[test]
    fn learn_program_change_is_classified_as_button() {
        let candidate = candidate_with_values(model::MidiMessageType::ProgramChange, false, true);
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

    #[test]
    fn learn_cc_midpoint_value_can_commit_as_continuous_immediately() {
        assert!(cc_learn_value_is_definitely_continuous(64));
        assert!(cc_learn_value_is_definitely_continuous(1));
        assert!(!cc_learn_value_is_definitely_continuous(0));
        assert!(!cc_learn_value_is_definitely_continuous(127));
    }

    #[test]
    fn match_mode_toggles_on_latched_state_changes() {
        assert_eq!(
            AppState::resolve_target_mute_state(0, false, model::MuteBehavior::SetFromValue, None),
            None
        );
        assert_eq!(
            AppState::resolve_target_mute_state(
                127,
                false,
                model::MuteBehavior::SetFromValue,
                None
            ),
            Some(true)
        );
        assert_eq!(
            AppState::resolve_target_mute_state(
                0,
                true,
                model::MuteBehavior::SetFromValue,
                Some(true)
            ),
            Some(false)
        );
        assert_eq!(
            AppState::resolve_target_mute_state(
                127,
                true,
                model::MuteBehavior::SetFromValue,
                Some(true)
            ),
            None
        );
        assert_eq!(
            AppState::resolve_target_mute_state(
                0,
                false,
                model::MuteBehavior::SetFromValue,
                Some(false)
            ),
            None
        );
    }

    #[test]
    fn match_mode_ignores_duplicate_latched_values() {
        assert_eq!(
            AppState::resolve_target_mute_state(
                127,
                true,
                model::MuteBehavior::SetFromValue,
                Some(true)
            ),
            None
        );
        assert_eq!(
            AppState::resolve_target_mute_state(
                0,
                false,
                model::MuteBehavior::SetFromValue,
                Some(false)
            ),
            None
        );
    }

    #[test]
    fn toggle_on_press_ignores_zero_and_toggles_on_press() {
        assert_eq!(
            AppState::resolve_target_mute_state(0, false, model::MuteBehavior::ToggleOnPress, None),
            None
        );
        assert_eq!(
            AppState::resolve_target_mute_state(
                127,
                false,
                model::MuteBehavior::ToggleOnPress,
                Some(false)
            ),
            Some(true)
        );
        assert_eq!(
            AppState::resolve_target_mute_state(
                127,
                true,
                model::MuteBehavior::ToggleOnPress,
                Some(true)
            ),
            Some(false)
        );
    }

    #[test]
    fn relative_volume_state_syncs_from_live_application_volume() {
        let state = test_app_state(TestAudioBackend::new(vec![model::SessionInfo {
            id: "session-firefox".to_string(),
            display_name: "Firefox".to_string(),
            application_key: None,
            process_name: Some("firefox.exe".to_string()),
            process_path: Some("C:\\Program Files\\Mozilla Firefox\\firefox.exe".to_string()),
            icon_data: None,
            volume: 1.0,
            is_muted: false,
            is_master: false,
        }]));
        let binding = relative_application_volume_binding("firefox");
        let key = BindingKey::from_binding(&binding);
        state.binding_state.lock().unwrap().insert(
            key.clone(),
            binding_state_with_update(
                0.5,
                Instant::now()
                    .checked_sub(Duration::from_secs(1))
                    .unwrap_or_else(Instant::now),
            ),
        );

        state.sync_feedback_values(&profile_with_binding(binding));

        let synced = state
            .binding_state
            .lock()
            .unwrap()
            .get(&key)
            .map(|value| value.last_value)
            .unwrap();
        assert!((synced - 1.0).abs() < f32::EPSILON);
        assert!((state.binding_action_value(&key).unwrap() - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn disabled_custom_feedback_does_not_erase_an_enabled_binding_on_the_same_address() {
        let state = test_app_state(TestAudioBackend::new(vec![model::SessionInfo {
            id: "session-firefox".to_string(),
            display_name: "Firefox".to_string(),
            application_key: None,
            process_name: Some("firefox.exe".to_string()),
            process_path: Some("C:\\Program Files\\Mozilla Firefox\\firefox.exe".to_string()),
            icon_data: None,
            volume: 0.75,
            is_muted: false,
            is_master: false,
        }]));
        let enabled = relative_application_volume_binding("firefox");
        let enabled_key = BindingKey::from_binding(&enabled);
        let mut disabled = enabled.clone();
        disabled.id = "binding-disabled".to_string();
        disabled.control.controller = 43;
        disabled.feedback_enabled = false;
        disabled.indicator_control = Some(model::AuxiliaryControl {
            device_id: enabled.device_id.clone(),
            channel: enabled.control.channel,
            controller: enabled.control.controller,
            msg_type: enabled.control.msg_type.clone(),
            control_kind: model::BindingControlKind::Continuous,
            mode: model::MidiMode::Absolute,
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: model::MuteBehavior::ToggleOnPress,
        });
        let profile = model::Profile {
            name: "Default".to_string(),
            bindings: vec![enabled, disabled],
            osd_settings: model::OsdSettings::default(),
            plugin_settings: HashMap::new(),
            midi_device_preference: model::MidiDevicePreference::default(),
            midi_device_preference_set: false,
        };

        state.sync_feedback_values(&profile);

        let value = state
            .feedback_values
            .lock()
            .unwrap()
            .get(&enabled_key)
            .copied();
        assert_eq!(value, Some(0.75));
    }

    #[test]
    fn relative_volume_state_sync_preserves_active_user_input() {
        let state = test_app_state(TestAudioBackend::new(vec![model::SessionInfo {
            id: "session-firefox".to_string(),
            display_name: "Firefox".to_string(),
            application_key: None,
            process_name: Some("firefox.exe".to_string()),
            process_path: Some("C:\\Program Files\\Mozilla Firefox\\firefox.exe".to_string()),
            icon_data: None,
            volume: 1.0,
            is_muted: false,
            is_master: false,
        }]));
        let binding = relative_application_volume_binding("firefox");
        let key = BindingKey::from_binding(&binding);
        state
            .binding_state
            .lock()
            .unwrap()
            .insert(key.clone(), binding_state_with_update(0.5, Instant::now()));

        state.sync_feedback_values(&profile_with_binding(binding));

        let synced = state
            .binding_state
            .lock()
            .unwrap()
            .get(&key)
            .map(|value| value.last_value)
            .unwrap();
        assert!((synced - 0.5).abs() < f32::EPSILON);
        assert!((state.binding_action_value(&key).unwrap() - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn focus_volume_feedback_syncs_from_focused_session() {
        let focused = session_info("Firefox", 0.76, false);
        let state = test_app_state(TestAudioBackend::new(vec![]).with_focused_session(focused));
        let binding = focus_volume_binding(model::MidiMode::Absolute);
        let key = BindingKey::from_binding(&binding);

        state.sync_feedback_values(&profile_with_binding(binding));

        assert!((state.binding_action_value(&key).unwrap() - 0.76).abs() < f32::EPSILON);
        assert!(
            (state
                .feedback_values
                .lock()
                .unwrap()
                .get(&key)
                .copied()
                .unwrap()
                - 0.76)
                .abs()
                < f32::EPSILON
        );
    }

    #[test]
    fn relative_focus_volume_state_syncs_from_focused_session_when_idle() {
        let focused = session_info("Firefox", 0.76, false);
        let state = test_app_state(TestAudioBackend::new(vec![]).with_focused_session(focused));
        let binding = focus_volume_binding(model::MidiMode::Relative);
        let key = BindingKey::from_binding(&binding);
        state.binding_state.lock().unwrap().insert(
            key.clone(),
            binding_state_with_update(
                0.5,
                Instant::now()
                    .checked_sub(Duration::from_secs(1))
                    .unwrap_or_else(Instant::now),
            ),
        );

        state.sync_feedback_values(&profile_with_binding(binding));

        let synced = state
            .binding_state
            .lock()
            .unwrap()
            .get(&key)
            .map(|value| value.last_value)
            .unwrap();
        assert!((synced - 0.76).abs() < f32::EPSILON);
        assert!((state.binding_action_value(&key).unwrap() - 0.76).abs() < f32::EPSILON);
    }

    #[test]
    fn relative_focus_volume_state_preserves_active_user_input() {
        let focused = session_info("Firefox", 0.76, false);
        let state = test_app_state(TestAudioBackend::new(vec![]).with_focused_session(focused));
        let binding = focus_volume_binding(model::MidiMode::Relative);
        let key = BindingKey::from_binding(&binding);
        state
            .binding_state
            .lock()
            .unwrap()
            .insert(key.clone(), binding_state_with_update(0.5, Instant::now()));

        state.sync_feedback_values(&profile_with_binding(binding));

        let synced = state
            .binding_state
            .lock()
            .unwrap()
            .get(&key)
            .map(|value| value.last_value)
            .unwrap();
        assert!((synced - 0.5).abs() < f32::EPSILON);
        assert!((state.binding_action_value(&key).unwrap() - 0.76).abs() < f32::EPSILON);
    }

    #[test]
    fn focus_volume_without_focused_session_preserves_existing_feedback() {
        let state = test_app_state(TestAudioBackend::new(vec![]));
        let binding = focus_volume_binding(model::MidiMode::Absolute);
        let key = BindingKey::from_binding(&binding);
        state
            .feedback_values
            .lock()
            .unwrap()
            .insert(key.clone(), 0.33);
        state.set_binding_action_value(&key, 0.44);

        state.sync_feedback_values(&profile_with_binding(binding));

        assert!((state.binding_action_value(&key).unwrap() - 0.44).abs() < f32::EPSILON);
        assert!(
            (state
                .feedback_values
                .lock()
                .unwrap()
                .get(&key)
                .copied()
                .unwrap()
                - 0.33)
                .abs()
                < f32::EPSILON
        );
    }

    #[test]
    fn mapped_light_feedback_cache_does_not_drive_toggle_state() {
        let state = test_app_state(TestAudioBackend::new(vec![model::SessionInfo {
            id: "session-firefox".to_string(),
            display_name: "Firefox".to_string(),
            application_key: None,
            process_name: Some("firefox.exe".to_string()),
            process_path: Some("C:\\Program Files\\Mozilla Firefox\\firefox.exe".to_string()),
            icon_data: None,
            volume: 0.8,
            is_muted: false,
            is_master: false,
        }]));
        let key = bindings::BindingKey {
            device_id: "device".to_string(),
            channel: 0,
            controller: 42,
            msg_type: model::MidiMessageType::Note,
        };
        state
            .feedback_values
            .lock()
            .unwrap()
            .insert(key.clone(), 1.0);
        state.set_binding_action_value(&key, 1.0);

        let targets = vec![model::BindingTarget::Application {
            name: "firefox".to_string(),
            display_name: Some("Firefox".to_string()),
            icon_data: None,
        }];

        assert!(!state.current_binding_toggle_state(&targets, &key));
    }

    #[test]
    fn disconnected_integration_clears_continuous_feedback_cache() {
        let state = test_app_state(TestAudioBackend::new(vec![]));
        let mut binding = focus_volume_binding(model::MidiMode::Absolute);
        let obs_target = model::BindingTarget::Integration {
            integration_id: "obs".to_string(),
            kind: "input".to_string(),
            data: serde_json::json!({ "input_name": "Mic/Aux" }),
        };
        binding.targets = vec![obs_target.clone()];
        binding.target = obs_target;
        let key = BindingKey::from_binding(&binding);
        state
            .feedback_values
            .lock()
            .unwrap()
            .insert(key.clone(), 0.8);

        state.set_integration_connection_state("obs", false);
        state.sync_feedback_values(&profile_with_binding(binding));

        assert!(!state.feedback_values.lock().unwrap().contains_key(&key));
    }

    #[test]
    fn disconnected_integration_keeps_mapped_button_feedback_off() {
        let state = test_app_state(TestAudioBackend::new(vec![]));
        let mut binding = focus_volume_binding(model::MidiMode::Absolute);
        let obs_target = model::BindingTarget::Integration {
            integration_id: "obs".to_string(),
            kind: "input".to_string(),
            data: serde_json::json!({ "input_name": "Mic/Aux" }),
        };
        binding.targets = vec![obs_target.clone()];
        binding.target = obs_target;
        binding.control.msg_type = model::MidiMessageType::Note;
        binding.control_kind = model::BindingControlKind::Button;
        binding.action = model::BindingAction::ToggleMute;
        binding.button_light_mode = model::ButtonLightMode::MappedWhenAssigned;
        let key = BindingKey::from_binding(&binding);

        assert_eq!(
            state.button_light_feedback_value(&binding, Some(false), Some(true)),
            Some(1.0)
        );

        state.set_integration_connection_state("obs", false);
        state.sync_feedback_values(&profile_with_binding(binding.clone()));
        assert_eq!(
            state.button_light_feedback_value(&binding, Some(true), Some(true)),
            Some(0.0)
        );
        assert_eq!(
            state.feedback_values.lock().unwrap().get(&key).copied(),
            Some(0.0)
        );

        state.set_integration_connection_state("obs", true);
        assert_eq!(
            state.button_light_feedback_value(&binding, Some(false), Some(false)),
            Some(1.0)
        );
    }

    #[test]
    fn failed_settings_persistence_does_not_publish_candidate_state() {
        let state = test_app_state(TestAudioBackend::new(vec![]));
        state
            .app_settings_store
            .save(&app_settings::AppSettings::default())
            .expect("initial settings");
        state
            .app_settings_store
            .set_failure_point(crate::durable_json_store::FailurePoint::BeforePrimaryReplace);

        let result = crate::commands::settings::persist_app_settings_update(&state, |settings| {
            settings.language = "fr".to_string();
        });

        assert!(result.is_err());
        assert_eq!(state.app_settings.lock().expect("settings").language, "en");
    }

    #[test]
    fn failed_binding_add_does_not_change_profile_or_feedback() {
        let state = test_app_state(TestAudioBackend::new(vec![]));
        let original = model::Profile {
            name: "Default".to_string(),
            bindings: Vec::new(),
            osd_settings: Default::default(),
            plugin_settings: Default::default(),
            midi_device_preference: Default::default(),
            midi_device_preference_set: false,
        };
        state
            .profile_store
            .save_profile(original.clone())
            .expect("initial profile");
        *state.active_profile.lock().expect("active profile") =
            Some(AppState::profile_snapshot(original));
        state
            .profile_store
            .set_failure_point(crate::durable_json_store::FailurePoint::BeforePrimaryReplace);

        let result = crate::commands::bindings::add_binding_to_active_profile(
            &state,
            focus_volume_binding(model::MidiMode::Absolute),
        );

        assert!(result.is_err());
        assert!(state
            .active_profile
            .lock()
            .expect("active profile")
            .as_ref()
            .expect("profile")
            .bindings
            .is_empty());
        assert!(state.feedback_values.lock().expect("feedback").is_empty());
        assert!(state
            .binding_action_values
            .lock()
            .expect("binding values")
            .is_empty());
    }
}

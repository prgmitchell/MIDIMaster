#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
mod feedback;
mod midi;
mod midi_event_queue;
mod model;
mod monitors;
mod osd_window;
mod plugin_api;
mod profile_store;
mod run_logger;
mod runtime_helpers;
mod runtime_midi;
mod store_api;
mod windows_autostart;
mod windows_display;
mod ws_bridge;

use app_paths::app_data_root_dir;
use app_settings::AppSettingsStore;
pub(crate) use app_state::AppState;
use audio::AudioBackend;
use commands::*;
use midi::MidiManager;
use midi_event_queue::MidiEventQueue;
use model::OsdSettings;

use profile_store::ProfileStore;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) use monitors::collect_monitor_descriptors;
use plugin_api::{
    get_plugins_dir, hue_api_get, hue_api_put, hue_discover_bridges, hue_pair_bridge,
    install_plugin_package, list_plugins, plugin_http_post_json, read_plugin_base64,
    read_plugin_text, set_plugin_enabled, uninstall_plugin,
};
use store_api::{fetch_store_catalog, install_store_plugin};
use ws_bridge::{get_wavelink_ws_port, ws_close, ws_open, ws_send, WsHub};

#[cfg(target_os = "windows")]
use audio::windows::WindowsAudioBackend;

#[cfg(not(target_os = "windows"))]
use audio::unsupported::UnsupportedAudioBackend;

fn shutdown_lights(state: &AppState) {
    run_logger::info("app", "shutdown_lights_start", "");
    state.cancel_activity_button_light_holds();
    if let Ok(profile_guard) = state.active_profile.lock() {
        if let Some(profile) = profile_guard.as_ref() {
            run_logger::info(
                "app",
                "shutdown_lights_profile",
                &format!("binding_count={}", profile.bindings.len()),
            );
            if let Ok(mut midi) = state.midi.lock() {
                for binding in &profile.bindings {
                    let _ = midi.send_binding_feedback(binding, 0.0);
                }
            }
        }
    }
    run_logger::info("app", "shutdown_lights_done", "");
}

fn main() {
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
                        ^ tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .setup(|app| {
            let config_dir = app_data_root_dir(app.handle())
                .map_err(|_| "Unable to resolve config directory".to_string())?;
            if let Err(err) = run_logger::init(&config_dir) {
                eprintln!("[midimaster-log-init-failed] {}", err);
            }
            run_logger::info(
                "app",
                "startup",
                &format!("config_dir={}", config_dir.display()),
            );

            builtin_plugins::ensure_builtin_plugins(app.handle());
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
                midi_event_queue: Arc::new(Mutex::new(MidiEventQueue::default())),
                profile_store,
                app_settings_store,
                active_profile: Mutex::new(None),
                binding_state: Arc::new(Mutex::new(HashMap::new())),
                feedback_values: Arc::new(Mutex::new(HashMap::new())),
                binding_action_values: Arc::new(Mutex::new(HashMap::new())),
                activity_button_light_generations: Arc::new(Mutex::new(HashMap::new())),
                last_mute_input_active: Mutex::new(HashMap::new()),
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

            let update_window = WebviewWindowBuilder::new(
                app,
                "update",
                WebviewUrl::App("index.html?update=1".into()),
            )
            .title("MIDIMaster Update")
            .inner_size(420.0, 230.0)
            .min_inner_size(420.0, 230.0)
            .resizable(false)
            .maximizable(false)
            .always_on_top(true)
            .focused(false)
            .decorations(false)
            .visible(false)
            .build()?;
            let _ = update_window.hide();

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
                            let state = app.state::<AppState>();
                            run_logger::info("app", "tray_restart", "restart requested from tray");
                            shutdown_lights(&state);
                            run_logger::flush_pending_repeats();
                            app.restart();
                        }
                        "quit" => {
                            let state = app.state::<AppState>();
                            run_logger::info("app", "tray_quit", "shutdown requested from tray");
                            shutdown_lights(&state);
                            run_logger::flush_pending_repeats();
                            app.exit(0);
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
                        if let Some(osd_window) = app_handle.get_webview_window("osd") {
                            let _ = osd_window.close();
                        }
                        let state = app_handle.state::<AppState>();
                        run_logger::info("app", "window_close", "main window close requested");
                        shutdown_lights(&state);
                        run_logger::flush_pending_repeats();
                        app_handle.exit(0);
                    }
                    tauri::WindowEvent::Destroyed => {
                        let state = app_handle.state::<AppState>();
                        run_logger::info("app", "window_destroyed", "main window destroyed");
                        shutdown_lights(&state);
                        run_logger::flush_pending_repeats();
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

            background_tasks::spawn_midi_event_queue_loop(app.handle().clone());
            background_tasks::spawn_feedback_refresh_loop(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            frontend_log,
            list_midi_devices,
            list_midi_output_devices,
            start_midi_device,
            stop_midi_device,
            list_sessions,
            list_monitors,
            get_osd_settings,
            update_osd_settings,
            preview_osd,
            get_app_settings,
            get_app_version,
            update_app_settings,
            set_theme_preference,
            set_midi_device_preferences,
            clear_midi_device_preferences,
            set_active_profile_preference,
            reset_app_data,
            open_logs_folder,
            pick_executable_path,
            pick_autohotkey_script_path,
            focused_session,
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
            export_current_profile,
            import_profile_from_file,
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
            plugin_http_post_json,
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
            show_update_notification_window_if_main_hidden,
            close_update_notification_window,
            start_update_notification_window_drag,
            check_for_updates,
            download_and_install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
        AppState {
            audio: Box::new(audio),
            midi: Arc::new(Mutex::new(MidiManager::new())),
            midi_event_queue: Arc::new(Mutex::new(MidiEventQueue::default())),
            profile_store: ProfileStore::new(config_dir.clone()),
            app_settings_store: AppSettingsStore::new(config_dir),
            active_profile: Mutex::new(None),
            binding_state: Arc::new(Mutex::new(HashMap::new())),
            feedback_values: Arc::new(Mutex::new(HashMap::new())),
            binding_action_values: Arc::new(Mutex::new(HashMap::new())),
            activity_button_light_generations: Arc::new(Mutex::new(HashMap::new())),
            last_mute_input_active: Mutex::new(HashMap::new()),
            focus_volume_failure_logs: Mutex::new(HashMap::new()),
            mute_transition_until: Mutex::new(HashMap::new()),
            last_target_mute_state: Mutex::new(HashMap::new()),
            learn_pending: Mutex::new(false),
            learn_candidate: Mutex::new(None),
            learned_control: Mutex::new(None),
            osd_last_update: Mutex::new(None),
            osd_settings: Mutex::new(OsdSettings::default()),
            app_settings: Mutex::new(app_settings::AppSettings::default()),
        }
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
            mute_control: None,
            assign_control: None,
            assign_mode: model::AssignMode::Add,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
        }
    }

    fn focus_volume_binding(mode: model::MidiMode) -> model::Binding {
        model::Binding {
            id: "binding-focus".to_string(),
            name: "Focused App".to_string(),
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
            mute_control: None,
            assign_control: None,
            assign_mode: model::AssignMode::Add,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
        }
    }

    fn profile_with_binding(binding: model::Binding) -> model::Profile {
        model::Profile {
            name: "Default".to_string(),
            bindings: vec![binding],
            osd_settings: model::OsdSettings::default(),
            plugin_settings: HashMap::new(),
            midi_device_preference: model::MidiDevicePreference::default(),
        }
    }

    fn binding_state_with_update(last_value: f32, last_update: Instant) -> BindingState {
        BindingState {
            last_value,
            last_update,
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
}

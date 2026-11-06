#![cfg_attr(feature = "perf-audit", allow(dead_code))]

mod app_paths;
mod app_settings;
mod app_state;
mod application_launch;
mod audio;
mod audio_feedback;
mod background_tasks;
mod binding_actions;
mod binding_events;
mod binding_services;
mod bindings;
mod builtin_plugins;
mod commands;
mod device_target;
mod durable_json_store;
mod fader_curve;
mod feedback;
mod file_dialog;
mod fxsound;
mod midi;
mod midi_event_queue;
mod midi_learning;
mod midi_reconciliation;
pub mod model;
mod monitor_brightness;
mod monitors;
mod osd_window;
#[cfg(feature = "perf-audit")]
mod perf_audit;
mod plugin_api;
mod profile_snapshot;
mod profile_store;
mod profile_target_state;
mod run_logger;
mod runtime_helpers;
mod runtime_midi;
mod settings_services;
mod shutdown;
mod solo;
mod soundboard;
mod store_api;
mod telemetry;
mod virtual_audio;
mod voicemeeter;
mod window_focus;
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
use fxsound::{fxsound_select_preset, fxsound_snapshot, fxsound_write, FxSoundState};
use profile_store::ProfileStore;
use shutdown::{ShutdownAction, ShutdownCoordinator};

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
    #[cfg(feature = "e2e")]
    assert!(
        perf_audit::synthetic_targets_enabled(),
        "E2E builds require an isolated synthetic fixture"
    );
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
                &format!(
                    "app_version={} config_dir={}",
                    app.package_info().version,
                    config_dir.display()
                ),
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
            app.manage(FxSoundState::default());
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
            #[cfg(any(debug_assertions, feature = "perf-audit"))]
            {
                let open_devtools = std::env::args().any(|a| a == "--devtools")
                    || std::env::var("MIDIMASTER_DEVTOOLS").is_ok_and(|v| v == "1");
                if open_devtools {
                    if let Some(w) = app.get_webview_window("main") {
                        w.open_devtools();
                    }
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
            shutdown.track_background_task(audio_feedback::spawn(
                app.handle().clone(),
                shutdown.subscribe(),
            ));
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

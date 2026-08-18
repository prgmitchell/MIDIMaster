pub mod audio;
pub mod bindings;
pub mod midi;
pub mod profiles;
pub mod settings;
pub mod soundboard;
pub mod telemetry;
pub mod updates;
pub mod virtual_audio;

pub use audio::*;
pub use bindings::*;
pub use midi::*;
pub use profiles::*;
pub use settings::*;
pub use soundboard::*;
pub use telemetry::*;
pub use updates::*;
pub use virtual_audio::*;

macro_rules! command_registry {
    () => {
        tauri::generate_handler![
            frontend_log,
            list_midi_devices,
            list_midi_output_devices,
            get_midi_connection_health,
            get_midi_route_health,
            start_midi_device,
            start_midi_device_routes,
            stop_midi_route,
            stop_midi_device,
            list_sessions,
            list_monitors,
            get_osd_settings,
            update_osd_settings,
            preview_osd,
            get_app_settings,
            take_storage_recovery_notices,
            set_compact_bindings,
            get_app_version,
            update_app_settings,
            update_midi_device_inventory_consent,
            update_appearance_settings,
            update_fader_curve_presets,
            export_appearance_theme,
            import_appearance_theme,
            set_theme_preference,
            set_midi_device_preferences,
            set_midi_device_routes,
            clear_midi_device_preferences,
            set_active_profile_preference,
            reset_app_data,
            open_logs_folder,
            pick_executable_path,
            pick_autohotkey_script_path,
            submit_midi_device_inventory,
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
            set_integration_connection_state,
            apply_binding_action,
            pick_soundboard_audio,
            analyze_soundboard_audio,
            preview_soundboard_audio,
            list_soundboard_output_devices,
            set_soundboard_preview_volume,
            set_soundboard_preview_paused,
            stop_soundboard_preview,
            get_virtual_audio_status,
            get_virtual_audio_settings,
            set_virtual_audio_settings,
            list_virtual_audio_input_devices,
            install_virtual_audio,
            repair_virtual_audio,
            remove_virtual_audio,
            restart_system,
            copy_virtual_audio_diagnostics,
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
            voicemeeter_connect,
            voicemeeter_disconnect,
            voicemeeter_status,
            voicemeeter_snapshot,
            voicemeeter_write_parameters,
            voicemeeter_list_devices,
            voicemeeter_device_state,
            voicemeeter_assign_device,
            voicemeeter_launch,
            voicemeeter_safe_command,
            fetch_store_catalog,
            install_store_plugin,
            install_store_plugins,
            show_update_notification_window_if_main_hidden,
            close_update_notification_window,
            start_update_notification_window_drag,
            check_for_updates,
            download_and_install_update,
            #[cfg(feature = "perf-audit")]
            perf_audit::perf_audit_snapshot,
            #[cfg(feature = "perf-audit")]
            perf_audit::perf_audit_reset,
            #[cfg(feature = "perf-audit")]
            perf_audit::perf_audit_inject_midi,
            #[cfg(feature = "perf-audit")]
            perf_audit::perf_audit_record_result,
        ]
    };
}

pub(crate) use command_registry;

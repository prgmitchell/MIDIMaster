use crate::{
    app_settings::{
        AppAppearanceSettings, AppSettings, AppearanceTheme, FaderCurvePreset,
        MidiDeviceInventoryConsent,
    },
    durable_json_store::StorageRecoveryNotice,
    model::{MidiDeviceRoute, OsdSettings},
    settings_services, AppState,
};
pub(crate) use settings_services::persist_app_settings_update;
pub use settings_services::{MonitorInfo, PickAutoHotkeyScriptResult, PickExecutableResult};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn frontend_log(level: String, component: String, event: String, details: String) {
    settings_services::frontend_log(level, component, event, details)
}

#[tauri::command]
pub fn list_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    settings_services::list_monitors(app)
}

#[tauri::command]
pub fn get_osd_settings(state: State<AppState>) -> Result<OsdSettings, String> {
    settings_services::get_osd_settings(state.inner())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_osd_settings(
    app: AppHandle,
    state: State<AppState>,
    enabled: bool,
    monitor_index: usize,
    monitor_name: Option<String>,
    monitor_id: Option<String>,
    anchor: String,
    show_binding_name: bool,
    style: Option<String>,
    opacity: Option<f64>,
    scale: Option<f64>,
) -> Result<(), String> {
    settings_services::update_osd_settings(
        app,
        state.inner(),
        enabled,
        monitor_index,
        monitor_name,
        monitor_id,
        anchor,
        show_binding_name,
        style,
        opacity,
        scale,
    )
}

#[tauri::command]
pub fn preview_osd(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    settings_services::preview_osd(app, state.inner())
}

#[tauri::command]
pub fn get_app_settings(state: State<AppState>) -> Result<AppSettings, String> {
    settings_services::get_app_settings(state.inner())
}

#[tauri::command]
pub fn take_storage_recovery_notices(
    state: State<AppState>,
) -> Result<Vec<StorageRecoveryNotice>, String> {
    settings_services::take_storage_recovery_notices(state.inner())
}

#[tauri::command]
pub fn set_compact_bindings(
    state: State<AppState>,
    compact_bindings: bool,
) -> Result<bool, String> {
    settings_services::set_compact_bindings(state.inner(), compact_bindings)
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    settings_services::get_app_version(app)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_app_settings(
    app: AppHandle,
    state: State<AppState>,
    start_with_windows: bool,
    start_in_tray: bool,
    minimize_to_tray: bool,
    exit_to_tray: bool,
    auto_check_updates: bool,
    language: Option<String>,
) -> Result<AppSettings, String> {
    settings_services::update_app_settings(
        app,
        state.inner(),
        start_with_windows,
        start_in_tray,
        minimize_to_tray,
        exit_to_tray,
        auto_check_updates,
        language,
    )
}

#[tauri::command]
pub fn update_midi_device_inventory_consent(
    state: State<AppState>,
    consent: MidiDeviceInventoryConsent,
    notice_version: Option<u32>,
) -> Result<AppSettings, String> {
    settings_services::update_midi_device_inventory_consent(state.inner(), consent, notice_version)
}

#[tauri::command]
pub fn update_appearance_settings(
    state: State<AppState>,
    appearance: AppAppearanceSettings,
) -> Result<AppAppearanceSettings, String> {
    settings_services::update_appearance_settings(state.inner(), appearance)
}

#[tauri::command]
pub fn update_fader_curve_presets(
    state: State<AppState>,
    presets: Vec<FaderCurvePreset>,
) -> Result<Vec<FaderCurvePreset>, String> {
    settings_services::update_fader_curve_presets(state.inner(), presets)
}

#[tauri::command]
pub fn export_appearance_theme(theme: AppearanceTheme) -> Result<Option<String>, String> {
    settings_services::export_appearance_theme(theme)
}

#[tauri::command]
pub fn import_appearance_theme(
    state: State<AppState>,
) -> Result<Option<AppAppearanceSettings>, String> {
    settings_services::import_appearance_theme(state.inner())
}

#[tauri::command]
pub fn set_theme_preference(state: State<AppState>, theme: String) -> Result<(), String> {
    settings_services::set_theme_preference(state.inner(), theme)
}

#[tauri::command]
pub fn set_midi_device_preferences(
    state: State<AppState>,
    input_device_id: String,
    output_device_id: String,
    input_device_name: Option<String>,
    output_device_name: Option<String>,
) -> Result<(), String> {
    settings_services::set_midi_device_preferences(
        state.inner(),
        input_device_id,
        output_device_id,
        input_device_name,
        output_device_name,
    )
}

#[tauri::command]
pub fn set_midi_device_routes(
    state: State<AppState>,
    routes: Vec<MidiDeviceRoute>,
) -> Result<(), String> {
    settings_services::set_midi_device_routes(state.inner(), routes)
}

#[tauri::command]
pub fn clear_midi_device_preferences(state: State<AppState>) -> Result<(), String> {
    settings_services::clear_midi_device_preferences(state.inner())
}

#[tauri::command]
pub fn set_active_profile_preference(
    state: State<AppState>,
    profile_name: String,
) -> Result<(), String> {
    settings_services::set_active_profile_preference(state.inner(), profile_name)
}

#[tauri::command]
pub fn reset_app_data(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    settings_services::reset_app_data(app, state.inner())
}

#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Result<String, String> {
    settings_services::open_logs_folder(app)
}

#[tauri::command]
pub fn pick_executable_path() -> Result<Option<PickExecutableResult>, String> {
    settings_services::pick_executable_path()
}

#[tauri::command]
pub fn pick_autohotkey_script_path() -> Result<Option<PickAutoHotkeyScriptResult>, String> {
    settings_services::pick_autohotkey_script_path()
}

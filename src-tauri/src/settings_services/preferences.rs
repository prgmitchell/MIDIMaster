use super::*;

pub(super) fn persist_midi_preference_update<F>(state: &AppState, update: F) -> Result<(), String>
where
    F: FnOnce(&mut AppSettings),
{
    let mut settings = state
        .app_settings
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let mut active_profile = state
        .active_profile
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let mut updated_settings = settings.clone();
    update(&mut updated_settings);
    let updated_profile = active_profile.as_ref().map(|profile| {
        let mut profile = profile.profile().clone();
        profile.midi_device_preference = MidiDevicePreference {
            input_device_id: updated_settings.midi_input_device_id.clone(),
            output_device_id: updated_settings.midi_output_device_id.clone(),
            input_device_name: updated_settings.midi_input_device_name.clone(),
            output_device_name: updated_settings.midi_output_device_name.clone(),
            routes: updated_settings.midi_device_routes.clone(),
        };
        profile.midi_device_preference_set = true;
        profile
    });

    state
        .app_settings_store
        .save(&updated_settings)
        .map_err(|err| err.to_string())?;
    if let Some(profile) = &updated_profile {
        if let Err(error) = state.profile_store.save_profile(profile.clone()) {
            if let Err(rollback_error) = state.app_settings_store.save(&settings) {
                run_logger::error(
                    "settings",
                    "midi_preference_rollback_failed",
                    &format!("save_error={} rollback_error={}", error, rollback_error),
                );
            }
            return Err(error.to_string());
        }
    }

    *settings = updated_settings;
    *active_profile = updated_profile.map(AppState::profile_snapshot);
    Ok(())
}

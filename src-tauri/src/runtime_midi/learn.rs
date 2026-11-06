use crate::{model::MidiEvent, AppState};

pub(super) fn handle_learn_event(state: &AppState, event: &MidiEvent) -> Result<bool, String> {
    Ok(state
        .midi_learning
        .lock()
        .map_err(|_| "Lock poisoned")?
        .receive(event))
}

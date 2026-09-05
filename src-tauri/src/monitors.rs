use crate::model::OsdSettings;
use crate::windows_display::{display_device_id, monitor_display_name};
use tauri::AppHandle;

#[derive(Clone)]
pub(crate) struct MonitorDescriptor {
    pub index: usize,
    pub friendly_name: String,
    pub stable_id: String,
    pub is_primary: bool,
    pub monitor: tauri::Monitor,
}

pub(crate) fn collect_monitor_descriptors(
    app: &AppHandle,
) -> Result<Vec<MonitorDescriptor>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|_| "Failed to load monitors".to_string())?;
    let primary = app.primary_monitor().ok().flatten();

    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let raw_name = monitor
                .name()
                .cloned()
                .unwrap_or_else(|| format!("Monitor {}", index + 1));
            let stable_id = display_device_id(&raw_name).unwrap_or_else(|| raw_name.clone());
            let friendly_name = monitor_display_name(&raw_name).unwrap_or_else(|| raw_name.clone());
            let is_primary = primary
                .as_ref()
                .map(|p| {
                    p.name() == monitor.name()
                        && p.size() == monitor.size()
                        && p.position() == monitor.position()
                })
                .unwrap_or(false);

            MonitorDescriptor {
                index,
                friendly_name,
                stable_id,
                is_primary,
                monitor: monitor.clone(),
            }
        })
        .collect())
}

pub(crate) fn resolve_monitor_for_osd(
    app: &AppHandle,
    settings: &OsdSettings,
) -> Option<tauri::Monitor> {
    // Never wait for a disconnected display on the MIDI/OSD path. Resolve a
    // fresh snapshot each time so the saved stable ID wins as soon as it returns.
    let descriptors = collect_monitor_descriptors(app).ok()?;
    let index = select_monitor_index(
        settings.monitor_id.as_deref(),
        descriptors
            .iter()
            .map(|monitor| (monitor.stable_id.as_str(), monitor.is_primary)),
    )?;
    descriptors
        .into_iter()
        .nth(index)
        .map(|entry| entry.monitor)
}

fn select_monitor_index<'a>(
    requested_id: Option<&str>,
    monitors: impl IntoIterator<Item = (&'a str, bool)>,
) -> Option<usize> {
    let requested_id = requested_id.map(str::trim).filter(|id| !id.is_empty());
    let mut first = None;
    let mut primary = None;
    for (index, (stable_id, is_primary)) in monitors.into_iter().enumerate() {
        if requested_id == Some(stable_id) {
            return Some(index);
        }
        first.get_or_insert(index);
        if is_primary {
            primary.get_or_insert(index);
        }
    }
    primary.or(first)
}

#[cfg(test)]
mod tests {
    use super::select_monitor_index;

    #[test]
    fn saved_monitor_wins_over_primary_and_enumeration_order() {
        let monitors = [("first", false), ("primary", true), ("saved", false)];
        assert_eq!(select_monitor_index(Some(" saved "), monitors), Some(2));
    }

    #[test]
    fn missing_or_empty_selection_uses_primary_then_first_available() {
        let monitors = [("secondary", false), ("primary", true)];
        for requested in [None, Some(""), Some("  "), Some("disconnected")] {
            assert_eq!(select_monitor_index(requested, monitors), Some(1));
        }
        assert_eq!(
            select_monitor_index(Some("missing"), [("only", false)]),
            Some(0)
        );
        assert_eq!(select_monitor_index(Some("missing"), []), None);
    }

    #[test]
    fn saved_monitor_returns_after_disconnection_without_changing_preference() {
        let requested = Some("saved");
        let disconnected = [("primary", true)];
        let reconnected = [("saved", false), ("primary", true)];
        assert_eq!(select_monitor_index(requested, disconnected), Some(0));
        assert_eq!(select_monitor_index(requested, reconnected), Some(0));
        assert_eq!(
            select_monitor_index(requested, [("primary", true), ("saved", false)]),
            Some(1)
        );
        assert_eq!(requested, Some("saved"));
    }
}

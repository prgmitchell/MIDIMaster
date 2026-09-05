use super::metrics::record_synthetic_target;
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;

pub(crate) fn synthetic_targets_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        let enabled = std::env::var("MIDIMASTER_PERF_SYNTHETIC_TARGETS").ok();
        let directory = std::env::var_os("MIDIMASTER_PERF_APP_DATA_DIR");
        enabled.as_deref() == Some("1")
            && directory.as_deref().is_some_and(|path| {
                let path = Path::new(path);
                if !path.is_absolute() {
                    return false;
                }
                let Some(root) = path.parent().and_then(Path::parent) else {
                    return false;
                };
                std::fs::read(root.join("fixture.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .is_some_and(|manifest| manifest["synthetic_only"] == true)
            })
    })
}

/// The fixture-only sink substitutes for its reserved integration. Real plugin
/// events still only count as dispatched because emitting is not acknowledgement.
pub(crate) fn apply_synthetic_integration(
    binding_id: &str,
    integration_id: &str,
    action: &str,
    value: f32,
    target_ids: impl Iterator<Item = String>,
) -> bool {
    if integration_id != "perf-plugin" || !synthetic_targets_enabled() {
        return false;
    }
    for target_id in target_ids {
        record_synthetic_target(binding_id, &target_id, action, value);
    }
    true
}

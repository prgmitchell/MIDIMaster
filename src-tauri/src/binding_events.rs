//! Shared binding identity in UI/OSD payloads. Callers retain emission and silence policy.
use crate::model::Binding;
use serde::Serialize;
use serde_json::Value;

pub fn binding_event_payload(
    binding: &Binding,
    primary_target: impl Serialize,
    mut payload: Value,
) -> Value {
    payload["binding_id"] = serde_json::json!(binding.id);
    payload["binding_name"] = serde_json::json!(binding.name);
    payload["binding_primary_target"] = serde_json::json!(primary_target);
    #[cfg(feature = "perf-audit")]
    crate::perf_audit::annotate_result_payload(&mut payload);
    payload
}

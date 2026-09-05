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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::BindingTarget;
    #[test]
    fn metadata_preserves_primary_target_and_caller_emission_fields() {
        let binding = crate::test_support::binding();
        let payload = binding_event_payload(
            &binding,
            Some(BindingTarget::Master),
            serde_json::json!({"volume":0.25,"silent":true,"target":"Focus"}),
        );
        assert_eq!(
            payload,
            serde_json::json!({"binding_id":binding.id,"binding_name":binding.name,"binding_primary_target":"Master","volume":0.25,"silent":true,"target":"Focus"})
        );
        let payload = binding_event_payload(
            &binding,
            None::<BindingTarget>,
            serde_json::json!({"muted":true,"action":"toggle_mute"}),
        );
        assert!(payload["binding_primary_target"].is_null());
        assert!(payload.get("silent").is_none());
    }
}

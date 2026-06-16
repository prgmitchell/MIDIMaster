use crate::{
    app_settings::{AppSettings, MidiDeviceInventoryConsent},
    model::{DeviceInfo, MidiDeviceRoute},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;

pub const MIDI_DEVICE_INVENTORY_ENDPOINT: &str =
    "https://telemetry.midimaster.app/v1/midi-device-inventory";
pub const MIDI_DEVICE_INVENTORY_SCHEMA_VERSION: u32 = 1;
pub const MIDI_DEVICE_INVENTORY_NOTICE_VERSION: u32 = 1;

const MAX_DEVICE_COUNT: usize = 64;
const MAX_ROUTE_COUNT: usize = 32;
const MAX_ID_CHARS: usize = 64;
const MAX_NAME_CHARS: usize = 160;
const TELEMETRY_TIMEOUT_SECS: u64 = 5;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiDeviceInventoryPayload {
    pub schema_version: u32,
    pub notice_version: u32,
    pub app_version: String,
    pub input_device_count: usize,
    pub output_device_count: usize,
    pub selected_route_count: usize,
    pub input_devices: Vec<MidiDeviceInventoryDevice>,
    pub output_devices: Vec<MidiDeviceInventoryDevice>,
    pub selected_routes: Vec<MidiDeviceInventoryRoute>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiDeviceInventoryDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiDeviceInventoryRoute {
    pub input_device_id: String,
    pub input_device_name: String,
    pub output_device_id: String,
    pub output_device_name: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiDeviceInventorySubmitResult {
    pub submitted: bool,
    pub skipped: bool,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MidiDeviceInventorySubmissionDecision {
    Send { hash: String },
    Skip { reason: &'static str },
}

pub fn build_midi_device_inventory_payload(
    app_version: String,
    inputs: &[DeviceInfo],
    outputs: &[DeviceInfo],
    routes: &[MidiDeviceRoute],
) -> MidiDeviceInventoryPayload {
    let input_devices = sanitize_devices(inputs);
    let output_devices = sanitize_devices(outputs);
    let selected_routes = sanitize_routes(routes);
    MidiDeviceInventoryPayload {
        schema_version: MIDI_DEVICE_INVENTORY_SCHEMA_VERSION,
        notice_version: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
        app_version: sanitize_text(&app_version, 32),
        input_device_count: input_devices.len(),
        output_device_count: output_devices.len(),
        selected_route_count: selected_routes.len(),
        input_devices,
        output_devices,
        selected_routes,
    }
}

pub fn midi_device_inventory_payload_hash(
    payload: &MidiDeviceInventoryPayload,
) -> Result<String, String> {
    let data = serde_json::to_vec(payload).map_err(|err| err.to_string())?;
    Ok(hex::encode(Sha256::digest(data)))
}

pub fn midi_device_inventory_submission_decision(
    settings: &AppSettings,
    payload: &MidiDeviceInventoryPayload,
) -> Result<MidiDeviceInventorySubmissionDecision, String> {
    if settings.midi_device_inventory_consent != MidiDeviceInventoryConsent::Enabled {
        return Ok(MidiDeviceInventorySubmissionDecision::Skip {
            reason: "consent_not_enabled",
        });
    }
    if settings.midi_device_inventory_notice_version != MIDI_DEVICE_INVENTORY_NOTICE_VERSION {
        return Ok(MidiDeviceInventorySubmissionDecision::Skip {
            reason: "notice_not_accepted",
        });
    }
    let hash = midi_device_inventory_payload_hash(payload)?;
    if settings
        .midi_device_inventory_last_sent_hash
        .as_deref()
        .is_some_and(|existing| existing == hash)
    {
        return Ok(MidiDeviceInventorySubmissionDecision::Skip {
            reason: "unchanged",
        });
    }
    Ok(MidiDeviceInventorySubmissionDecision::Send { hash })
}

pub fn post_midi_device_inventory_payload(
    payload: &MidiDeviceInventoryPayload,
) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(TELEMETRY_TIMEOUT_SECS))
        .build();
    let value = serde_json::to_value(payload).map_err(|err| err.to_string())?;
    let response = agent
        .post(MIDI_DEVICE_INVENTORY_ENDPOINT)
        .set("Content-Type", "application/json")
        .send_json(value);

    match response {
        Ok(response) if (200..300).contains(&response.status()) => Ok(()),
        Ok(response) => Err(format!(
            "MIDI device inventory endpoint returned HTTP {}",
            response.status()
        )),
        Err(err) => Err(err.to_string()),
    }
}

fn sanitize_devices(devices: &[DeviceInfo]) -> Vec<MidiDeviceInventoryDevice> {
    devices
        .iter()
        .take(MAX_DEVICE_COUNT)
        .map(|device| MidiDeviceInventoryDevice {
            id: sanitize_text(&device.id, MAX_ID_CHARS),
            name: sanitize_text(&device.name, MAX_NAME_CHARS),
        })
        .collect()
}

fn sanitize_routes(routes: &[MidiDeviceRoute]) -> Vec<MidiDeviceInventoryRoute> {
    routes
        .iter()
        .filter_map(|route| route.normalized())
        .take(MAX_ROUTE_COUNT)
        .map(|route| MidiDeviceInventoryRoute {
            input_device_id: sanitize_text(route.input_id().unwrap_or_default(), MAX_ID_CHARS),
            input_device_name: sanitize_text(
                route.input_device_name.as_deref().unwrap_or_default(),
                MAX_NAME_CHARS,
            ),
            output_device_id: sanitize_text(route.output_id().unwrap_or_default(), MAX_ID_CHARS),
            output_device_name: sanitize_text(
                route.output_device_name.as_deref().unwrap_or_default(),
                MAX_NAME_CHARS,
            ),
            enabled: route.enabled,
        })
        .collect()
}

fn sanitize_text(value: &str, max_chars: usize) -> String {
    value
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max_chars)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, name: &str) -> DeviceInfo {
        DeviceInfo {
            id: id.to_string(),
            name: name.to_string(),
        }
    }

    fn route(input: &str, output: &str, input_name: &str, output_name: &str) -> MidiDeviceRoute {
        MidiDeviceRoute {
            input_device_id: Some(input.to_string()),
            output_device_id: Some(output.to_string()),
            input_device_name: Some(input_name.to_string()),
            output_device_name: Some(output_name.to_string()),
            enabled: true,
        }
    }

    #[test]
    fn payload_includes_only_midi_inventory_fields() {
        let payload = build_midi_device_inventory_payload(
            "4.2.0".to_string(),
            &[device(" midi:0\n", " Platform X+1 V2.13\t")],
            &[device("midi:1", "Platform X+1 V2.13")],
            &[route(
                "midi:0",
                "midi:1",
                "Platform X+1 V2.13",
                "Platform X+1 V2.13",
            )],
        );
        let value = serde_json::to_value(&payload).expect("payload json");

        assert_eq!(payload.schema_version, 1);
        assert_eq!(payload.notice_version, 1);
        assert_eq!(payload.input_device_count, 1);
        assert_eq!(payload.output_device_count, 1);
        assert_eq!(payload.selected_route_count, 1);
        assert_eq!(payload.input_devices[0].id, "midi:0");
        assert_eq!(payload.input_devices[0].name, "Platform X+1 V2.13");

        let text = value.to_string();
        assert!(!text.contains("profile"));
        assert!(!text.contains("binding"));
        assert!(!text.contains("plugin"));
        assert!(!text.contains("session"));
    }

    #[test]
    fn payload_caps_device_and_route_counts() {
        let devices = (0..80)
            .map(|index| device(&format!("midi:{index}"), "Device"))
            .collect::<Vec<_>>();
        let routes = (0..40)
            .map(|index| route(&format!("midi:{index}"), "midi:1", "Input", "Output"))
            .collect::<Vec<_>>();

        let payload =
            build_midi_device_inventory_payload("4.2.0".to_string(), &devices, &devices, &routes);

        assert_eq!(payload.input_devices.len(), MAX_DEVICE_COUNT);
        assert_eq!(payload.output_devices.len(), MAX_DEVICE_COUNT);
        assert_eq!(payload.selected_routes.len(), MAX_ROUTE_COUNT);
    }

    #[test]
    fn disabled_consent_skips_submission() {
        let payload = build_midi_device_inventory_payload(
            "4.2.0".to_string(),
            &[device("midi:0", "Controller")],
            &[],
            &[],
        );
        let settings = AppSettings {
            midi_device_inventory_consent: MidiDeviceInventoryConsent::Disabled,
            midi_device_inventory_notice_version: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
            ..AppSettings::default()
        };

        let decision =
            midi_device_inventory_submission_decision(&settings, &payload).expect("decision");

        assert_eq!(
            decision,
            MidiDeviceInventorySubmissionDecision::Skip {
                reason: "consent_not_enabled"
            }
        );
    }

    #[test]
    fn unchanged_payload_skips_submission() {
        let payload = build_midi_device_inventory_payload(
            "4.2.0".to_string(),
            &[device("midi:0", "Controller")],
            &[],
            &[],
        );
        let hash = midi_device_inventory_payload_hash(&payload).expect("payload hash");
        let settings = AppSettings {
            midi_device_inventory_consent: MidiDeviceInventoryConsent::Enabled,
            midi_device_inventory_notice_version: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
            midi_device_inventory_last_sent_hash: Some(hash),
            ..AppSettings::default()
        };

        let decision =
            midi_device_inventory_submission_decision(&settings, &payload).expect("decision");

        assert_eq!(
            decision,
            MidiDeviceInventorySubmissionDecision::Skip {
                reason: "unchanged"
            }
        );
    }
}

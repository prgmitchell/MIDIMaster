mod diagnostics;
use diagnostics::*;
mod connections;
mod feedback_transport;
mod health;
mod output_connection;
mod ports;
mod protocol;

use self::ports::*;
use self::protocol::{
    binding_feedback_position_send, binding_feedback_send, binding_light_feedback_sends,
    build_feedback_message, parse_midi_message, send_feedback_messages, BindingLightFeedbackSend,
    FeedbackMessage,
};
use crate::model::{Binding, DeviceInfo, MidiDeviceRoute, MidiEvent, MidiMessageType};
use crate::run_logger;
use anyhow::{anyhow, Result};
use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const LOG_MIDI_MESSAGES: bool = false;
const MIDI_DIAGNOSTIC_MIN_INTERVAL_MS: u128 = 250;
const EMPTY_INPUT_ENUMERATION_LOG_INTERVAL: Duration = Duration::from_secs(60);
const OUTPUT_RECONNECT_COOLDOWN: Duration = Duration::from_secs(5);
const OUTPUT_RECONNECT_SKIPPED_LOG_INTERVAL: Duration = Duration::from_secs(30);
const MAX_OUTPUT_RECONNECT_FAILURES: u32 = 3;
static EMPTY_INPUT_ENUMERATION_LOG_STATE: OnceLock<Mutex<EmptyEnumerationLogState>> =
    OnceLock::new();
static INPUT_DIAGNOSTICS: OnceLock<Mutex<HashMap<MidiDiagnosticKey, MidiDiagnosticState>>> =
    OnceLock::new();
static FEEDBACK_DIAGNOSTICS: OnceLock<Mutex<HashMap<MidiDiagnosticKey, MidiDiagnosticState>>> =
    OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct MidiDiagnosticKey {
    route: String,
    channel: u8,
    controller: u8,
    msg_type: MidiMessageType,
}

#[derive(Debug, Clone, Copy)]
struct MidiDiagnosticState {
    last_seen_value: u16,
    last_logged_value: u16,
    last_logged_at: Instant,
}

#[derive(Debug, Default)]
struct EmptyEnumerationLogState {
    empty_since_last_non_empty: bool,
    last_logged_at: Option<Instant>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiConnectionHealth {
    pub input_device_id: String,
    pub output_device_id: String,
    pub connected: bool,
    pub suspect: bool,
    pub reason: String,
    pub input_suspect: bool,
    pub input_name_mismatch: bool,
    pub expected_input_name: Option<String>,
    pub actual_input_name: Option<String>,
    pub last_input_seen_at: Option<u64>,
    pub output_suspect: bool,
    pub output_name_mismatch: bool,
    pub expected_output_name: Option<String>,
    pub actual_output_name: Option<String>,
}

pub struct MidiManager {
    input_routes: HashMap<String, MidiInputRoute>,
    output_routes: HashMap<String, MidiOutputRoute>,
}

struct MidiInputRoute {
    input_connection: Option<MidiInputConnection<()>>,
    input_device_id: String,
    input_device_name: String,
    output_device_id: String,
    input_connection_suspect: bool,
    input_connection_suspect_reason: Option<String>,
    input_inventory_generation: u64,
    last_input_seen_at_ms: Arc<AtomicU64>,
}

struct MidiOutputRoute {
    output_connection: Option<MidiOutputConnection>,
    output_device_name: String,
    last_reconnect_attempt: Option<std::time::Instant>,
    last_reconnect_skipped_log: Option<std::time::Instant>,
    reconnect_failures: u32,
    connection_suspect: bool,
    connection_suspect_reason: Option<String>,
}

impl MidiManager {
    pub fn new() -> Self {
        Self {
            input_routes: HashMap::new(),
            output_routes: HashMap::new(),
        }
    }

    pub fn list_devices(&self) -> Result<Vec<DeviceInfo>> {
        let midi_in = MidiInput::new("MIDIMaster")?;
        let ports = midi_in.ports();
        let mut devices = Vec::new();
        for (index, port) in ports.iter().enumerate() {
            let name = midi_in
                .port_name(port)
                .unwrap_or_else(|_| format!("Device {}", index));
            devices.push(DeviceInfo {
                id: format!("{}{}", MIDI_PORT_PREFIX, index),
                name,
            });
        }
        if devices.is_empty() {
            log_empty_input_enumeration_if_needed();
            let midi_in_retry = MidiInput::new("MIDIMaster")?;
            let ports = midi_in_retry.ports();
            for (index, port) in ports.iter().enumerate() {
                let name = midi_in_retry
                    .port_name(port)
                    .unwrap_or_else(|_| format!("Device {}", index));
                devices.push(DeviceInfo {
                    id: format!("{}{}", MIDI_PORT_PREFIX, index),
                    name,
                });
            }
        }
        if !devices.is_empty() {
            note_non_empty_input_enumeration();
        }
        log_inventory_if_changed("input", &devices);
        Ok(devices)
    }

    pub fn list_output_devices(&self) -> Result<Vec<DeviceInfo>> {
        let midi_out = MidiOutput::new("MIDIMaster")?;
        let ports = midi_out.ports();
        let mut devices = Vec::new();
        for (index, port) in ports.iter().enumerate() {
            let name = midi_out
                .port_name(port)
                .unwrap_or_else(|_| format!("Output {}", index));
            devices.push(DeviceInfo {
                id: format!("{}{}", MIDI_PORT_PREFIX, index),
                name,
            });
        }
        log_inventory_if_changed("output", &devices);
        Ok(devices)
    }

    pub fn active_routes(&self) -> Vec<(String, String)> {
        let mut routes = self
            .input_routes
            .values()
            .map(|route| {
                (
                    route.input_device_id.clone(),
                    route.output_device_id.clone(),
                )
            })
            .collect::<Vec<_>>();
        routes.sort_by(|a, b| a.0.cmp(&b.0));
        routes
    }

    pub fn active_route_details(&self) -> Vec<MidiDeviceRoute> {
        let mut routes = self
            .input_routes
            .values()
            .map(|route| MidiDeviceRoute {
                input_device_id: Some(route.input_device_id.clone()),
                output_device_id: Some(route.output_device_id.clone()),
                input_device_name: Some(route.input_device_name.clone()),
                output_device_name: self
                    .output_routes
                    .get(&route.output_device_id)
                    .map(|output| output.output_device_name.clone()),
                enabled: true,
            })
            .collect::<Vec<_>>();
        routes.sort_by(|a, b| a.input_id().cmp(&b.input_id()));
        routes
    }

    pub fn active_route_count(&self) -> usize {
        self.input_routes.len()
    }
}

#[cfg(test)]
mod tests;

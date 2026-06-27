use crate::model::{
    AuxiliaryControl, Binding, BindingAction, DeviceInfo, MidiDeviceRoute, MidiEvent,
    MidiMessageType, MidiMode,
};
use crate::run_logger;
use anyhow::{anyhow, Result};
use midir::{
    Ignore, MidiInput, MidiInputConnection, MidiInputPort, MidiOutput, MidiOutputConnection,
    MidiOutputPort,
};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MIDI_PORT_PREFIX: &str = "midi:";
const LOG_MIDI_MESSAGES: bool = false;
const MIDI_DIAGNOSTIC_MIN_INTERVAL_MS: u128 = 250;
const EMPTY_INPUT_ENUMERATION_LOG_INTERVAL: Duration = Duration::from_secs(60);
const OUTPUT_RECONNECT_COOLDOWN: Duration = Duration::from_secs(5);
const OUTPUT_RECONNECT_SKIPPED_LOG_INTERVAL: Duration = Duration::from_secs(30);
const MAX_OUTPUT_RECONNECT_FAILURES: u32 = 3;
static INPUT_DEVICE_SIGNATURE: OnceLock<Mutex<String>> = OnceLock::new();
static OUTPUT_DEVICE_SIGNATURE: OnceLock<Mutex<String>> = OnceLock::new();
static INPUT_DEVICE_GENERATION: AtomicU64 = AtomicU64::new(0);
static OUTPUT_DEVICE_GENERATION: AtomicU64 = AtomicU64::new(0);
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

#[derive(Debug, Clone, PartialEq)]
struct FeedbackMessage {
    logical_bytes: Vec<u8>,
    logical_raw_midi_value: u16,
    physical_bytes: Vec<u8>,
    physical_channel: u8,
    physical_controller: u8,
    physical_msg_type: MidiMessageType,
    physical_raw_midi_value: u16,
    normalized_value: f32,
    protocol: &'static str,
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

struct BindingLightFeedbackSend {
    device_id: String,
    channel: u8,
    controller: u8,
    value: f32,
    msg_type: MidiMessageType,
    use_binding_protocol: bool,
}

fn primary_light_feedback_send(
    binding: &Binding,
    value: f32,
    use_binding_protocol: bool,
) -> BindingLightFeedbackSend {
    BindingLightFeedbackSend {
        device_id: binding.device_id.clone(),
        channel: binding.control.channel,
        controller: binding.control.controller,
        value,
        msg_type: binding.control.msg_type.clone(),
        use_binding_protocol,
    }
}

fn indicator_light_feedback_send(
    indicator: &AuxiliaryControl,
    value: f32,
) -> BindingLightFeedbackSend {
    BindingLightFeedbackSend {
        device_id: indicator.device_id.clone(),
        channel: indicator.channel,
        controller: indicator.controller,
        value,
        msg_type: indicator.msg_type.clone(),
        use_binding_protocol: false,
    }
}

fn light_feedback_send_matches_primary(send: &BindingLightFeedbackSend, binding: &Binding) -> bool {
    send.device_id == binding.device_id
        && send.channel == binding.control.channel
        && send.controller == binding.control.controller
        && send.msg_type == binding.control.msg_type
}

fn binding_light_feedback_sends(binding: &Binding, value: f32) -> Vec<BindingLightFeedbackSend> {
    let Some(indicator) = binding.indicator_feedback_control() else {
        return vec![primary_light_feedback_send(binding, value, true)];
    };

    let indicator_send = indicator_light_feedback_send(indicator, value);
    let should_suppress_primary = !light_feedback_send_matches_primary(&indicator_send, binding);
    let mut sends = vec![indicator_send];
    if should_suppress_primary {
        sends.push(primary_light_feedback_send(binding, 0.0, false));
    }
    sends
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

#[derive(Debug, Clone)]
struct PreparedMidiRoute {
    input_device_id: String,
    output_device_id: String,
    input_device_name: Option<String>,
    output_device_name: Option<String>,
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

    pub fn active_route_count(&self) -> usize {
        self.input_routes.len()
    }

    pub fn connection_health(&mut self) -> MidiConnectionHealth {
        self.route_health()
            .into_iter()
            .next()
            .unwrap_or_else(|| MidiConnectionHealth {
                input_device_id: String::new(),
                output_device_id: String::new(),
                connected: false,
                suspect: false,
                reason: String::new(),
                input_suspect: false,
                input_name_mismatch: false,
                expected_input_name: None,
                actual_input_name: None,
                last_input_seen_at: None,
                output_suspect: false,
                output_name_mismatch: false,
                expected_output_name: None,
                actual_output_name: None,
            })
    }

    pub fn route_health(&mut self) -> Vec<MidiConnectionHealth> {
        self.refresh_route_health_state();
        let mut health = self
            .input_routes
            .values()
            .map(|route| {
                let output = self.output_routes.get(&route.output_device_id);
                let expected_input_name =
                    clean_expected_device_name(Some(&route.input_device_name));
                let actual_input_name = expected_input_name
                    .as_ref()
                    .and_then(|_| current_input_port_name(&route.input_device_id).ok());
                let input_name_mismatch = device_name_mismatch(
                    expected_input_name.as_deref(),
                    actual_input_name.as_deref(),
                );
                let input_suspect = route.input_connection_suspect || input_name_mismatch;
                let input_reason = route.input_connection_suspect_reason.clone().or_else(|| {
                    if input_name_mismatch {
                        Some("input_name_mismatch".to_string())
                    } else {
                        None
                    }
                });

                let expected_output_name = output
                    .and_then(|route| clean_expected_device_name(Some(&route.output_device_name)));
                let actual_output_name = expected_output_name
                    .as_ref()
                    .and_then(|_| current_output_port_name(&route.output_device_id).ok());
                let output_name_mismatch = device_name_mismatch(
                    expected_output_name.as_deref(),
                    actual_output_name.as_deref(),
                );
                let output_suspect = output
                    .map(|output| output.connection_suspect)
                    .unwrap_or(true)
                    || output_name_mismatch;
                let output_reason = output
                    .and_then(|output| output.connection_suspect_reason.clone())
                    .or_else(|| {
                        if output_name_mismatch {
                            Some("output_name_mismatch".to_string())
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| {
                        if output.is_none() {
                            "output_not_connected".to_string()
                        } else {
                            String::new()
                        }
                    });
                let suspect = input_suspect || output_suspect;
                let reason = input_reason.unwrap_or(output_reason);
                MidiConnectionHealth {
                    input_device_id: route.input_device_id.clone(),
                    output_device_id: route.output_device_id.clone(),
                    connected: route.input_connection.is_some()
                        && !input_suspect
                        && output
                            .map(|output| output.output_connection.is_some() && !output_suspect)
                            .unwrap_or(false),
                    suspect,
                    reason,
                    input_suspect,
                    input_name_mismatch,
                    expected_input_name,
                    actual_input_name,
                    last_input_seen_at: atomic_millis_to_option(&route.last_input_seen_at_ms),
                    output_suspect,
                    output_name_mismatch,
                    expected_output_name,
                    actual_output_name,
                }
            })
            .collect::<Vec<_>>();
        health.sort_by(|a, b| a.input_device_id.cmp(&b.input_device_id));
        health
    }

    fn refresh_route_health_state(&mut self) {
        let input_generation = inventory_generation("input");
        let input_device_ids = self.input_routes.keys().cloned().collect::<Vec<_>>();
        for input_device_id in input_device_ids {
            let Some((expected_name, route_generation, has_connection)) =
                self.input_routes.get(&input_device_id).map(|route| {
                    (
                        clean_expected_device_name(Some(&route.input_device_name)),
                        route.input_inventory_generation,
                        route.input_connection.is_some(),
                    )
                })
            else {
                continue;
            };

            if let Some(expected_name) = expected_name.as_deref() {
                match current_input_port_name(&input_device_id) {
                    Ok(actual_name) if actual_name != expected_name => {
                        log_route_device_mismatch(
                            "input",
                            &input_device_id,
                            expected_name,
                            Some(&actual_name),
                        );
                        self.mark_input_suspect(
                            &input_device_id,
                            "input_name_mismatch",
                            Some(&actual_name),
                        );
                    }
                    Ok(_) => {}
                    Err(_) => {
                        log_route_device_mismatch("input", &input_device_id, expected_name, None);
                        self.mark_input_suspect(&input_device_id, "input_port_missing", None);
                    }
                }
            }

            if has_connection && input_generation != route_generation {
                self.mark_input_suspect(&input_device_id, "input_inventory_changed", None);
            }
        }

        let output_device_ids = self.output_routes.keys().cloned().collect::<Vec<_>>();
        for output_device_id in output_device_ids {
            let Some(expected_name) = self.output_expected_name(&output_device_id) else {
                continue;
            };
            match current_output_port_name(&output_device_id) {
                Ok(actual_name) if actual_name != expected_name => {
                    self.mark_output_name_mismatch(
                        &output_device_id,
                        &expected_name,
                        Some(&actual_name),
                    );
                }
                Ok(_) => {}
                Err(_) => {
                    self.mark_output_name_mismatch(&output_device_id, &expected_name, None);
                }
            }
        }
    }

    fn mark_output_suspect(&mut self, output_device_id: &str, reason: &str) {
        let Some(route) = self.output_routes.get_mut(output_device_id) else {
            return;
        };
        route.connection_suspect = true;
        route.connection_suspect_reason = Some(reason.to_string());
    }

    fn mark_input_suspect(
        &mut self,
        input_device_id: &str,
        reason: &str,
        actual_input_name: Option<&str>,
    ) {
        let Some(route) = self.input_routes.get_mut(input_device_id) else {
            return;
        };
        let should_log = !route.input_connection_suspect
            || route.input_connection_suspect_reason.as_deref() != Some(reason);
        route.input_connection_suspect = true;
        route.input_connection_suspect_reason = Some(reason.to_string());
        if should_log {
            run_logger::warn(
                "midi",
                "input_marked_suspect",
                &format!(
                    "input_device_id={} output_device_id={} expected_input_name={} actual_input_name={} reason={}",
                    route.input_device_id,
                    route.output_device_id,
                    route.input_device_name,
                    actual_input_name.unwrap_or("<unknown>"),
                    reason
                ),
            );
        }
    }

    fn clear_output_suspect(route: &mut MidiOutputRoute) {
        route.connection_suspect = false;
        route.connection_suspect_reason = None;
        route.last_reconnect_skipped_log = None;
    }

    fn open_output_connection(
        output_device_id: &str,
        expected_output_device_name: Option<&str>,
    ) -> Result<(MidiOutputConnection, String)> {
        let midi_out = MidiOutput::new("MIDIMaster")?;
        let (output_port, output_port_name) =
            resolve_output_port(&midi_out, output_device_id, expected_output_device_name)?;
        let output_connection = midi_out
            .connect(&output_port, "midimaster-output")
            .map_err(|e| anyhow!("Failed to connect to output: {}", e))?;
        Ok((output_connection, output_port_name))
    }

    fn ensure_output_connected(
        &mut self,
        output_device_id: &str,
        expected_output_device_name: Option<&str>,
    ) -> Result<()> {
        let expected_output_device_name = clean_expected_device_name(expected_output_device_name)
            .or_else(|| {
                self.output_routes
                    .get(output_device_id)
                    .and_then(|route| clean_expected_device_name(Some(&route.output_device_name)))
            });
        if let Some(route) = self.output_routes.get_mut(output_device_id) {
            if route.output_connection.is_some() {
                if let Some(expected_name) = expected_output_device_name.as_deref() {
                    match current_output_port_name(output_device_id) {
                        Ok(actual_name) => {
                            if actual_name != expected_name {
                                log_route_device_mismatch(
                                    "output",
                                    output_device_id,
                                    expected_name,
                                    Some(&actual_name),
                                );
                                route.connection_suspect = true;
                                route.connection_suspect_reason =
                                    Some("output_name_mismatch".to_string());
                                return Err(anyhow!(
                                    "MIDI output device id {} now resolves to '{}' instead of '{}'",
                                    output_device_id,
                                    actual_name,
                                    expected_name
                                ));
                            }
                            route.output_device_name = actual_name;
                        }
                        Err(err) => {
                            log_route_device_mismatch(
                                "output",
                                output_device_id,
                                expected_name,
                                None,
                            );
                            route.connection_suspect = true;
                            route.connection_suspect_reason =
                                Some("output_port_missing".to_string());
                            return Err(err);
                        }
                    }
                }
                Self::clear_output_suspect(route);
                route.reconnect_failures = 0;
                return Ok(());
            }
        }
        let (output_connection, output_port_name) =
            Self::open_output_connection(output_device_id, expected_output_device_name.as_deref())?;
        if let Some(expected_name) = expected_output_device_name.as_deref() {
            if output_port_name != expected_name {
                log_route_device_mismatch(
                    "output",
                    output_device_id,
                    expected_name,
                    Some(&output_port_name),
                );
                return Err(anyhow!(
                    "MIDI output device id {} now resolves to '{}' instead of '{}'",
                    output_device_id,
                    output_port_name,
                    expected_name
                ));
            }
        }
        match self.output_routes.get_mut(output_device_id) {
            Some(route) => {
                route.output_connection = Some(output_connection);
                route.output_device_name = output_port_name.clone();
                route.reconnect_failures = 0;
                Self::clear_output_suspect(route);
            }
            None => {
                self.output_routes.insert(
                    output_device_id.to_string(),
                    MidiOutputRoute {
                        output_connection: Some(output_connection),
                        output_device_name: output_port_name.clone(),
                        last_reconnect_attempt: None,
                        last_reconnect_skipped_log: None,
                        reconnect_failures: 0,
                        connection_suspect: false,
                        connection_suspect_reason: None,
                    },
                );
            }
        }
        run_logger::info(
            "midi",
            "output_connected",
            &format!(
                "output_device_id={} output_device_name={}",
                output_device_id, output_port_name
            ),
        );
        Ok(())
    }

    fn force_output_reconnect(&mut self, output_device_id: &str) {
        if let Some(route) = self.output_routes.get_mut(output_device_id) {
            route.output_connection = None;
            route.last_reconnect_skipped_log = None;
        }
    }

    fn output_expected_name(&self, output_device_id: &str) -> Option<String> {
        self.output_routes
            .get(output_device_id)
            .and_then(|route| clean_expected_device_name(Some(&route.output_device_name)))
    }

    fn mark_output_name_mismatch(
        &mut self,
        output_device_id: &str,
        expected_name: &str,
        actual_name: Option<&str>,
    ) {
        log_route_device_mismatch("output", output_device_id, expected_name, actual_name);
        if let Some(route) = self.output_routes.get_mut(output_device_id) {
            route.connection_suspect = true;
            route.connection_suspect_reason = Some(
                if actual_name.is_some() {
                    "output_name_mismatch"
                } else {
                    "output_port_missing"
                }
                .to_string(),
            );
        }
    }

    pub fn set_device_routes(
        &mut self,
        routes: &[MidiDeviceRoute],
        on_event: Arc<dyn Fn(MidiEvent) + Send + Sync + 'static>,
        force_reconnect: bool,
    ) -> Result<()> {
        let mut next_routes = Vec::new();
        let mut seen_inputs = std::collections::HashSet::new();
        for route in routes {
            let Some(route) = route.normalized() else {
                continue;
            };
            if !route.enabled {
                continue;
            }
            let input_device_id = route.input_id().unwrap_or_default().to_string();
            let output_device_id = route.output_id().unwrap_or_default().to_string();
            if !seen_inputs.insert(input_device_id.clone()) {
                return Err(anyhow!("Duplicate MIDI input route: {}", input_device_id));
            }
            next_routes.push(PreparedMidiRoute {
                input_device_id,
                output_device_id,
                input_device_name: clean_expected_device_name(route.input_device_name.as_deref()),
                output_device_name: clean_expected_device_name(route.output_device_name.as_deref()),
            });
        }

        let desired_inputs = next_routes
            .iter()
            .map(|route| route.input_device_id.clone())
            .collect::<std::collections::HashSet<_>>();
        let existing_inputs = self.input_routes.keys().cloned().collect::<Vec<_>>();
        for input_device_id in existing_inputs {
            if !desired_inputs.contains(&input_device_id) {
                self.input_routes.remove(&input_device_id);
                run_logger::info(
                    "midi",
                    "input_route_disconnected",
                    &format!("input_device_id={}", input_device_id),
                );
            }
        }

        for route in &next_routes {
            if force_reconnect {
                self.force_output_reconnect(&route.output_device_id);
            }
            self.ensure_output_connected(
                &route.output_device_id,
                route.output_device_name.as_deref(),
            )?;
        }

        let input_inventory_generation = inventory_generation("input");
        for route in next_routes {
            let expected_input_device_name = route.input_device_name.clone().or_else(|| {
                self.input_routes
                    .get(&route.input_device_id)
                    .and_then(|existing| {
                        clean_expected_device_name(Some(&existing.input_device_name))
                    })
            });
            let needs_reconnect = if let Some(existing) =
                self.input_routes.get_mut(&route.input_device_id)
            {
                if let Some(expected_name) = expected_input_device_name.as_deref() {
                    existing.input_device_name = expected_name.to_string();
                }
                if existing.output_device_id != route.output_device_id {
                    run_logger::info(
                        "midi",
                        "input_route_output_changed",
                        &format!(
                            "input_device_id={} previous_output={} next_output={}",
                            route.input_device_id,
                            existing.output_device_id,
                            route.output_device_id
                        ),
                    );
                    existing.output_device_id = route.output_device_id.clone();
                }
                if input_inventory_generation != existing.input_inventory_generation {
                    existing.input_connection_suspect = true;
                    existing.input_connection_suspect_reason =
                        Some("input_inventory_changed".to_string());
                    run_logger::warn(
                        "midi",
                        "input_marked_suspect",
                        &format!(
                            "input_device_id={} output_device_id={} expected_input_name={} actual_input_name=<unknown> reason=input_inventory_changed previous_generation={} current_generation={}",
                            existing.input_device_id,
                            existing.output_device_id,
                            existing.input_device_name,
                            existing.input_inventory_generation,
                            input_inventory_generation
                        ),
                    );
                }
                force_reconnect
                    || existing.input_connection.is_none()
                    || existing.input_connection_suspect
                    || input_inventory_generation != existing.input_inventory_generation
            } else {
                true
            };
            if !needs_reconnect {
                continue;
            }

            let reconnecting = self.input_routes.remove(&route.input_device_id).is_some();
            if reconnecting {
                run_logger::warn(
                    "midi",
                    "input_reconnect_attempt",
                    &format!(
                        "input_device_id={} output_device_id={} expected_input_name={}",
                        route.input_device_id,
                        route.output_device_id,
                        expected_input_device_name.as_deref().unwrap_or("")
                    ),
                );
            }
            let input_route = match self.connect_input_route(
                &route.input_device_id,
                &route.output_device_id,
                expected_input_device_name.as_deref(),
                on_event.clone(),
            ) {
                Ok(route) => route,
                Err(err) => {
                    run_logger::error(
                        "midi",
                        "input_reconnect_failed",
                        &format!(
                            "input_device_id={} output_device_id={} expected_input_name={} error={}",
                            route.input_device_id,
                            route.output_device_id,
                            expected_input_device_name.as_deref().unwrap_or(""),
                            err
                        ),
                    );
                    return Err(err);
                }
            };
            self.input_routes
                .insert(route.input_device_id.clone(), input_route);
            if reconnecting {
                run_logger::info(
                    "midi",
                    "input_reconnected",
                    &format!(
                        "input_device_id={} output_device_id={} expected_input_name={}",
                        route.input_device_id,
                        route.output_device_id,
                        expected_input_device_name.as_deref().unwrap_or("")
                    ),
                );
            }
        }

        let referenced_outputs = self
            .input_routes
            .values()
            .map(|route| route.output_device_id.clone())
            .collect::<std::collections::HashSet<_>>();
        let existing_outputs = self.output_routes.keys().cloned().collect::<Vec<_>>();
        for output_device_id in existing_outputs {
            if !referenced_outputs.contains(&output_device_id) {
                self.output_routes.remove(&output_device_id);
                run_logger::info(
                    "midi",
                    "output_route_disconnected",
                    &format!("output_device_id={}", output_device_id),
                );
            }
        }

        Ok(())
    }

    fn connect_input_route(
        &self,
        input_device_id: &str,
        output_device_id: &str,
        expected_input_device_name: Option<&str>,
        on_event: Arc<dyn Fn(MidiEvent) + Send + Sync + 'static>,
    ) -> Result<MidiInputRoute> {
        let mut midi_in = MidiInput::new("MIDIMaster")?;
        midi_in.ignore(Ignore::None);
        let (input_port, input_port_name) =
            resolve_input_port(&midi_in, input_device_id, expected_input_device_name)?;
        run_logger::info(
            "midi",
            "start_route_requested",
            &format!(
                "input_device_id={} output_device_id={}",
                input_device_id, output_device_id
            ),
        );

        let event_device_id = input_device_id.to_string();
        let last_input_seen_at_ms = Arc::new(AtomicU64::new(0));
        let callback_last_input_seen_at_ms = Arc::clone(&last_input_seen_at_ms);

        let connection = midi_in.connect(
            &input_port,
            "midimaster-input",
            move |_timestamp, message, _| {
                callback_last_input_seen_at_ms.store(now_epoch_millis(), Ordering::Relaxed);
                if LOG_MIDI_MESSAGES {
                    run_logger::debug("midi", "raw_message", &format!("bytes={:?}", message));
                }
                if let Some(event) = parse_midi_message(&event_device_id, message) {
                    log_midi_input_if_needed(&event, message);
                    on_event(event);
                }
            },
            (),
        )?;

        run_logger::info(
            "midi",
            "input_connected",
            &format!(
                "input_device_id={} input_device_name={} output_device_id={}",
                input_device_id, input_port_name, output_device_id
            ),
        );

        Ok(MidiInputRoute {
            input_connection: Some(connection),
            input_device_id: input_device_id.to_string(),
            input_device_name: input_port_name,
            output_device_id: output_device_id.to_string(),
            input_connection_suspect: false,
            input_connection_suspect_reason: None,
            input_inventory_generation: inventory_generation("input"),
            last_input_seen_at_ms,
        })
    }

    pub fn stop(&mut self) {
        run_logger::info(
            "midi",
            "stop_device",
            &format!(
                "input_route_count={} output_route_count={}",
                self.input_routes.len(),
                self.output_routes.len()
            ),
        );
        self.input_routes.clear();
        self.output_routes.clear();
    }

    pub fn stop_route(&mut self, input_device_id: &str) -> Option<String> {
        let route = self.input_routes.remove(input_device_id)?;
        let output_device_id = route.output_device_id.clone();
        let still_referenced = self
            .input_routes
            .values()
            .any(|other| other.output_device_id == output_device_id);
        if !still_referenced {
            self.output_routes.remove(&output_device_id);
        }
        run_logger::info(
            "midi",
            "route_stopped",
            &format!(
                "input_device_id={} output_device_id={}",
                input_device_id, output_device_id
            ),
        );
        Some(output_device_id)
    }

    pub fn send_binding_feedback(&mut self, binding: &Binding, value: f32) -> Result<()> {
        self.send_feedback_inner(
            &binding.device_id,
            binding.control.channel,
            binding.control.controller,
            value,
            binding.control.msg_type.clone(),
            Some(binding),
        )
    }

    pub fn send_binding_light_feedback(&mut self, binding: &Binding, value: f32) -> Result<()> {
        let mut result = Ok(());
        for send in binding_light_feedback_sends(binding, value) {
            let binding_context = if send.use_binding_protocol {
                Some(binding)
            } else {
                None
            };
            if let Err(err) = self.send_feedback_inner(
                &send.device_id,
                send.channel,
                send.controller,
                send.value,
                send.msg_type,
                binding_context,
            ) {
                if result.is_ok() {
                    result = Err(err);
                }
            }
        }
        result
    }

    pub fn send_feedback(
        &mut self,
        device_id: &str,
        channel: u8,
        controller: u8,
        value: f32, // volume or mute state (1.0 = on/muted, 0.0 = off/unmuted)
        msg_type: MidiMessageType,
    ) -> Result<()> {
        self.send_feedback_inner(device_id, channel, controller, value, msg_type, None)
    }

    fn send_feedback_inner(
        &mut self,
        device_id: &str,
        channel: u8,
        controller: u8,
        value: f32,
        msg_type: MidiMessageType,
        binding: Option<&Binding>,
    ) -> Result<()> {
        if matches!(msg_type, MidiMessageType::ProgramChange) {
            run_logger::debug(
                "midi",
                "feedback_skipped_program_change",
                &format!(
                    "input_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} normalized_value={:.4}",
                    device_id, channel, controller, msg_type, value
                ),
            );
            return Ok(());
        }

        let resolved_route = self
            .input_routes
            .get(device_id)
            .map(|route| {
                (
                    route.input_device_id.clone(),
                    route.output_device_id.clone(),
                    false,
                )
            })
            .or_else(|| {
                if self.input_routes.len() == 1 {
                    self.input_routes.values().next().map(|route| {
                        (
                            route.input_device_id.clone(),
                            route.output_device_id.clone(),
                            true,
                        )
                    })
                } else {
                    None
                }
            });

        let Some((route_input_device_id, output_device_id, used_single_route_fallback)) =
            resolved_route
        else {
            run_logger::debug(
                "midi",
                "feedback_skipped_no_route",
                &format!(
                    "input_device_id={} active_route_count={} logical_channel={} logical_controller={} logical_msg_type={:?} normalized_value={:.4}",
                    device_id,
                    self.input_routes.len(),
                    channel,
                    controller,
                    msg_type,
                    value
                ),
            );
            return Ok(());
        };
        if used_single_route_fallback {
            run_logger::debug(
                "midi",
                "feedback_route_fallback_single_active",
                &format!(
                    "requested_input_device_id={} route_input_device_id={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} normalized_value={:.4}",
                    device_id,
                    route_input_device_id,
                    output_device_id,
                    channel,
                    controller,
                    msg_type,
                    value
                ),
            );
        }

        let Some(output_device_name) = self
            .output_routes
            .get(&output_device_id)
            .map(|route| route.output_device_name.clone())
        else {
            run_logger::debug(
                "midi",
                "feedback_skipped_no_output",
                &format!(
                    "input_device_id={} requested_input_device_id={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} normalized_value={:.4}",
                    route_input_device_id,
                    device_id,
                    output_device_id,
                    channel,
                    controller,
                    msg_type,
                    value
                ),
            );
            return Ok(());
        };

        let feedback = build_feedback_message(
            channel,
            controller,
            value,
            &msg_type,
            binding,
            &output_device_name,
        );

        let mut send_success = false;
        if let Some(route) = self.output_routes.get_mut(&output_device_id) {
            if route
                .output_connection
                .as_mut()
                .map(|connection| connection.send(&feedback.physical_bytes).is_ok())
                .unwrap_or(false)
            {
                send_success = true;
                Self::clear_output_suspect(route);
            }
        }
        if send_success {
            log_feedback_sent_if_needed(
                &route_input_device_id,
                &output_device_id,
                channel,
                controller,
                &msg_type,
                &feedback,
            );
        }

        if !send_success {
            self.mark_output_suspect(&output_device_id, "output_send_failed");
            let (should_attempt, reconnect_failures) = if let Some(route) =
                self.output_routes.get_mut(&output_device_id)
            {
                let should_attempt = route
                    .last_reconnect_attempt
                    .map(|t| t.elapsed() >= OUTPUT_RECONNECT_COOLDOWN)
                    .unwrap_or(true);
                let reconnect_failures = route.reconnect_failures;

                if !should_attempt || reconnect_failures >= MAX_OUTPUT_RECONNECT_FAILURES {
                    if should_log_reconnect_skipped(
                        &mut route.last_reconnect_skipped_log,
                        Instant::now(),
                        OUTPUT_RECONNECT_SKIPPED_LOG_INTERVAL,
                    ) {
                        run_logger::warn(
                                "midi",
                                "output_reconnect_skipped",
                                &format!(
                                    "feedback_protocol={} output_device_id={} output_device_name={} cooldown_ready={} reconnect_failures={} max_failures={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={}",
                                    feedback.protocol,
                                    output_device_id,
                                    output_device_name,
                                    should_attempt,
                                    reconnect_failures,
                                    MAX_OUTPUT_RECONNECT_FAILURES,
                                    channel,
                                    controller,
                                    msg_type,
                                    feedback.physical_channel,
                                    feedback.physical_controller,
                                    feedback.physical_msg_type,
                                    feedback.normalized_value,
                                    feedback.logical_raw_midi_value,
                                    feedback.physical_raw_midi_value,
                                    format_midi_bytes(&feedback.logical_bytes),
                                    format_midi_bytes(&feedback.physical_bytes)
                                ),
                            );
                    }
                    return Ok(());
                }

                route.last_reconnect_attempt = Some(std::time::Instant::now());
                route.last_reconnect_skipped_log = None;
                (should_attempt, reconnect_failures)
            } else {
                return Ok(());
            };
            let _ = should_attempt;
            let _ = reconnect_failures;
            run_logger::warn(
                "midi",
                "output_send_failed",
                &format!(
                    "feedback_protocol={} output_device_id={} output_device_name={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={} action=attempting_reconnect",
                    feedback.protocol,
                    output_device_id,
                    output_device_name,
                    channel,
                    controller,
                    msg_type,
                    feedback.physical_channel,
                    feedback.physical_controller,
                    feedback.physical_msg_type,
                    feedback.normalized_value,
                    feedback.logical_raw_midi_value,
                    feedback.physical_raw_midi_value,
                    format_midi_bytes(&feedback.logical_bytes),
                    format_midi_bytes(&feedback.physical_bytes)
                ),
            );

            if let Some(route) = self.output_routes.get_mut(&output_device_id) {
                route.output_connection = None;
            }
            match self.ensure_output_connected(&output_device_id, Some(&output_device_name)) {
                Ok(_) => {
                    run_logger::info(
                        "midi",
                        "output_reconnected",
                        &format!("output_device_id={}", output_device_id),
                    );
                    if let Some(route) = self.output_routes.get_mut(&output_device_id) {
                        let retry_error = route
                            .output_connection
                            .as_mut()
                            .and_then(|connection| {
                                connection
                                    .send(&feedback.physical_bytes)
                                    .err()
                                    .map(|error| error.to_string())
                            })
                            .or_else(|| {
                                if route.output_connection.is_none() {
                                    Some("output not connected".to_string())
                                } else {
                                    None
                                }
                            });
                        if let Some(e) = retry_error {
                            route.connection_suspect = true;
                            route.connection_suspect_reason =
                                Some("output_retry_send_failed".to_string());
                            run_logger::error(
                                "midi",
                                "retry_send_failed",
                                &format!(
                                    "feedback_protocol={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={} error={}",
                                    feedback.protocol,
                                    output_device_id,
                                    channel,
                                    controller,
                                    msg_type,
                                    feedback.physical_channel,
                                    feedback.physical_controller,
                                    feedback.physical_msg_type,
                                    feedback.normalized_value,
                                    feedback.logical_raw_midi_value,
                                    feedback.physical_raw_midi_value,
                                    format_midi_bytes(&feedback.logical_bytes),
                                    format_midi_bytes(&feedback.physical_bytes),
                                    e
                                ),
                            );
                        } else {
                            Self::clear_output_suspect(route);
                            run_logger::info(
                                "midi",
                                "retry_send_successful",
                                &format!(
                                    "feedback_protocol={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={}",
                                    feedback.protocol,
                                    output_device_id,
                                    channel,
                                    controller,
                                    msg_type,
                                    feedback.physical_channel,
                                    feedback.physical_controller,
                                    feedback.physical_msg_type,
                                    feedback.normalized_value,
                                    feedback.logical_raw_midi_value,
                                    feedback.physical_raw_midi_value,
                                    format_midi_bytes(&feedback.logical_bytes),
                                    format_midi_bytes(&feedback.physical_bytes)
                                ),
                            );
                            log_feedback_sent_if_needed(
                                &route_input_device_id,
                                &output_device_id,
                                channel,
                                controller,
                                &msg_type,
                                &feedback,
                            );
                        }
                    }
                }
                Err(e) => {
                    let failures =
                        if let Some(route) = self.output_routes.get_mut(&output_device_id) {
                            route.connection_suspect = true;
                            route.connection_suspect_reason =
                                Some("output_reconnect_failed".to_string());
                            route.reconnect_failures += 1;
                            route.reconnect_failures
                        } else {
                            self.output_routes.insert(
                                output_device_id.clone(),
                                MidiOutputRoute {
                                    output_connection: None,
                                    output_device_name: output_device_name.clone(),
                                    last_reconnect_attempt: Some(std::time::Instant::now()),
                                    last_reconnect_skipped_log: None,
                                    reconnect_failures: 1,
                                    connection_suspect: true,
                                    connection_suspect_reason: Some(
                                        "output_reconnect_failed".to_string(),
                                    ),
                                },
                            );
                            1
                        };
                    if failures >= MAX_OUTPUT_RECONNECT_FAILURES {
                        run_logger::error(
                            "midi",
                            "output_reconnect_give_up",
                            &format!(
                                "feedback_protocol={} output_device_id={} attempts={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} physical_raw_midi_value={} physical_bytes_hex={} error={}",
                                feedback.protocol,
                                output_device_id,
                                failures,
                                channel,
                                controller,
                                msg_type,
                                feedback.physical_channel,
                                feedback.physical_controller,
                                feedback.physical_msg_type,
                                feedback.physical_raw_midi_value,
                                format_midi_bytes(&feedback.physical_bytes),
                                e
                            ),
                        );
                    } else {
                        run_logger::warn(
                            "midi",
                            "output_reconnect_failed",
                            &format!(
                                "feedback_protocol={} output_device_id={} attempt={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} physical_raw_midi_value={} physical_bytes_hex={} error={}",
                                feedback.protocol,
                                output_device_id,
                                failures,
                                channel,
                                controller,
                                msg_type,
                                feedback.physical_channel,
                                feedback.physical_controller,
                                feedback.physical_msg_type,
                                feedback.physical_raw_midi_value,
                                format_midi_bytes(&feedback.physical_bytes),
                                e
                            ),
                        );
                    }
                }
            }
        }
        Ok(())
    }
}

fn build_feedback_message(
    channel: u8,
    controller: u8,
    value: f32,
    msg_type: &MidiMessageType,
    binding: Option<&Binding>,
    output_device_name: &str,
) -> FeedbackMessage {
    let logical = build_direct_feedback_bytes(channel, controller, value, msg_type);
    if let Some(binding) = binding {
        if let Some(physical) = build_xtouch_mc_vpot_feedback(binding, value, output_device_name) {
            return FeedbackMessage {
                logical_bytes: logical.bytes,
                logical_raw_midi_value: logical.raw_midi_value,
                physical_bytes: physical.bytes,
                physical_channel: physical.channel,
                physical_controller: physical.controller,
                physical_msg_type: physical.msg_type,
                physical_raw_midi_value: physical.raw_midi_value,
                normalized_value: logical.normalized_value,
                protocol: "xtouch_mc_vpot_fan",
            };
        }
    }

    FeedbackMessage {
        logical_bytes: logical.bytes.clone(),
        logical_raw_midi_value: logical.raw_midi_value,
        physical_bytes: logical.bytes,
        physical_channel: logical.channel,
        physical_controller: logical.controller,
        physical_msg_type: logical.msg_type,
        physical_raw_midi_value: logical.raw_midi_value,
        normalized_value: logical.normalized_value,
        protocol: "direct",
    }
}

#[derive(Debug, Clone, PartialEq)]
struct FeedbackBytes {
    bytes: Vec<u8>,
    channel: u8,
    controller: u8,
    msg_type: MidiMessageType,
    normalized_value: f32,
    raw_midi_value: u16,
}

fn build_direct_feedback_bytes(
    channel: u8,
    controller: u8,
    value: f32,
    msg_type: &MidiMessageType,
) -> FeedbackBytes {
    let normalized_value = value.clamp(0.0, 1.0);

    match msg_type {
        MidiMessageType::Note => {
            let status = 0x90 | (channel & 0x0F);
            let velocity = (normalized_value * 127.0).round() as u8;
            FeedbackBytes {
                bytes: vec![status, controller, velocity],
                channel: channel & 0x0F,
                controller,
                msg_type: msg_type.clone(),
                normalized_value,
                raw_midi_value: velocity as u16,
            }
        }
        MidiMessageType::PitchBend => {
            let status = 0xE0 | (channel & 0x0F);
            let value14 = (normalized_value * 16383.0).round() as u16;
            let lsb = (value14 & 0x7F) as u8;
            let msb = ((value14 >> 7) & 0x7F) as u8;
            FeedbackBytes {
                bytes: vec![status, lsb, msb],
                channel: channel & 0x0F,
                controller: 0xE0,
                msg_type: msg_type.clone(),
                normalized_value,
                raw_midi_value: value14,
            }
        }
        MidiMessageType::ControlChange => {
            let status = 0xB0 | (channel & 0x0F);
            let value7 = (normalized_value * 127.0).round() as u8;
            FeedbackBytes {
                bytes: vec![status, controller, value7],
                channel: channel & 0x0F,
                controller,
                msg_type: msg_type.clone(),
                normalized_value,
                raw_midi_value: value7 as u16,
            }
        }
        MidiMessageType::ProgramChange => {
            let status = 0xC0 | (channel & 0x0F);
            FeedbackBytes {
                bytes: vec![status, controller & 0x7F],
                channel: channel & 0x0F,
                controller: controller & 0x7F,
                msg_type: msg_type.clone(),
                normalized_value,
                raw_midi_value: (controller & 0x7F) as u16,
            }
        }
    }
}

fn build_xtouch_mc_vpot_feedback(
    binding: &Binding,
    value: f32,
    output_device_name: &str,
) -> Option<FeedbackBytes> {
    if !is_xtouch_mc_vpot_output(output_device_name)
        || binding.action != BindingAction::Volume
        || binding.mode != MidiMode::Relative
        || binding.control.msg_type != MidiMessageType::ControlChange
        || binding.control.channel != 0
        || !(16..=23).contains(&binding.control.controller)
    {
        return None;
    }

    let normalized_value = value.clamp(0.0, 1.0);
    let knob_index = binding.control.controller - 16;
    let physical_controller = 48 + knob_index;
    let raw_midi_value = xtouch_mc_vpot_fan_value(normalized_value);
    Some(FeedbackBytes {
        bytes: vec![0xB0, physical_controller, raw_midi_value as u8],
        channel: 0,
        controller: physical_controller,
        msg_type: MidiMessageType::ControlChange,
        normalized_value,
        raw_midi_value,
    })
}

fn is_xtouch_mc_vpot_output(output_device_name: &str) -> bool {
    let normalized_name = output_device_name.to_ascii_uppercase();
    normalized_name.contains("X-TOUCH MINI")
        || normalized_name.contains("X-TOUCH-EXT")
        || normalized_name.contains("X-TOUCH EXTENDER")
}

fn xtouch_mc_vpot_fan_value(normalized_value: f32) -> u16 {
    let value = normalized_value.clamp(0.0, 1.0);
    if value <= 0.0 {
        return 0;
    }
    let led_value = (value * 11.0).ceil().clamp(1.0, 11.0) as u16;
    0x20 | led_value
}

fn log_midi_input_if_needed(event: &MidiEvent, raw_message: &[u8]) {
    let raw_value = event.value_14.unwrap_or(event.value as u16);
    let max_value = diagnostic_max_value(&event.msg_type);
    let key = MidiDiagnosticKey {
        route: event.device_id.clone(),
        channel: event.channel,
        controller: event.controller,
        msg_type: event.msg_type.clone(),
    };
    let Some(reason) = diagnostic_log_reason(&INPUT_DIAGNOSTICS, key, raw_value, max_value) else {
        return;
    };

    let value_14 = event
        .value_14
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_string());
    run_logger::debug(
        "midi",
        "input_observed",
        &format!(
            "reason={} device_id={} channel={} controller={} value={} value_14={} msg_type={:?} bytes_hex={}",
            reason,
            event.device_id,
            event.channel,
            event.controller,
            event.value,
            value_14,
            event.msg_type,
            format_midi_bytes(raw_message)
        ),
    );
}

fn log_feedback_sent_if_needed(
    input_device_id: &str,
    output_device_id: &str,
    channel: u8,
    controller: u8,
    msg_type: &MidiMessageType,
    feedback: &FeedbackMessage,
) {
    let key = MidiDiagnosticKey {
        route: format!("{}->{}", input_device_id, output_device_id),
        channel: feedback.physical_channel,
        controller: feedback.physical_controller,
        msg_type: feedback.physical_msg_type.clone(),
    };
    let Some(reason) = diagnostic_log_reason(
        &FEEDBACK_DIAGNOSTICS,
        key,
        feedback.physical_raw_midi_value,
        diagnostic_max_value(&feedback.physical_msg_type),
    ) else {
        return;
    };

    run_logger::debug(
        "midi",
        "feedback_sent_bytes",
        &format!(
            "reason={} feedback_protocol={} input_device_id={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={}",
            reason,
            feedback.protocol,
            input_device_id,
            output_device_id,
            channel,
            controller,
            msg_type,
            feedback.physical_channel,
            feedback.physical_controller,
            feedback.physical_msg_type,
            feedback.normalized_value,
            feedback.logical_raw_midi_value,
            feedback.physical_raw_midi_value,
            format_midi_bytes(&feedback.logical_bytes),
            format_midi_bytes(&feedback.physical_bytes)
        ),
    );
}

fn diagnostic_log_reason(
    diagnostics: &OnceLock<Mutex<HashMap<MidiDiagnosticKey, MidiDiagnosticState>>>,
    key: MidiDiagnosticKey,
    raw_value: u16,
    max_value: u16,
) -> Option<&'static str> {
    let now = Instant::now();
    let mut map = diagnostics
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    let Some(state) = map.get_mut(&key) else {
        map.insert(
            key,
            MidiDiagnosticState {
                last_seen_value: raw_value,
                last_logged_value: raw_value,
                last_logged_at: now,
            },
        );
        return Some("first");
    };

    if state.last_seen_value == raw_value {
        return None;
    }
    state.last_seen_value = raw_value;

    let endpoint = raw_value == 0 || raw_value == max_value;
    let significant_change =
        raw_value.abs_diff(state.last_logged_value) >= diagnostic_significant_delta(max_value);
    let interval_elapsed =
        state.last_logged_at.elapsed().as_millis() >= MIDI_DIAGNOSTIC_MIN_INTERVAL_MS;
    let reason = if endpoint {
        Some("endpoint")
    } else if significant_change || interval_elapsed {
        Some("change")
    } else {
        None
    };

    if reason.is_some() {
        state.last_logged_value = raw_value;
        state.last_logged_at = now;
    }
    reason
}

fn diagnostic_max_value(msg_type: &MidiMessageType) -> u16 {
    match msg_type {
        MidiMessageType::PitchBend => 16383,
        MidiMessageType::ControlChange | MidiMessageType::Note | MidiMessageType::ProgramChange => {
            127
        }
    }
}

fn diagnostic_significant_delta(max_value: u16) -> u16 {
    if max_value > 127 {
        1024
    } else {
        8
    }
}

fn format_midi_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{:02X}", byte))
        .collect::<Vec<_>>()
        .join("-")
}

fn should_log_empty_enumeration(
    state: &mut EmptyEnumerationLogState,
    now: Instant,
    interval: Duration,
) -> bool {
    if !state.empty_since_last_non_empty {
        state.empty_since_last_non_empty = true;
        state.last_logged_at = Some(now);
        return true;
    }

    let elapsed = state
        .last_logged_at
        .map(|last| now.duration_since(last))
        .unwrap_or(interval);
    if elapsed >= interval {
        state.last_logged_at = Some(now);
        return true;
    }

    false
}

fn should_log_reconnect_skipped(
    last_logged_at: &mut Option<Instant>,
    now: Instant,
    interval: Duration,
) -> bool {
    let elapsed = last_logged_at
        .map(|last| now.duration_since(last))
        .unwrap_or(interval);
    if elapsed >= interval {
        *last_logged_at = Some(now);
        return true;
    }

    false
}

fn note_non_empty_enumeration(state: &mut EmptyEnumerationLogState) {
    state.empty_since_last_non_empty = false;
    state.last_logged_at = None;
}

fn log_empty_input_enumeration_if_needed() {
    let slot = EMPTY_INPUT_ENUMERATION_LOG_STATE
        .get_or_init(|| Mutex::new(EmptyEnumerationLogState::default()));
    let Ok(mut state) = slot.lock() else {
        return;
    };
    if should_log_empty_enumeration(
        &mut state,
        Instant::now(),
        EMPTY_INPUT_ENUMERATION_LOG_INTERVAL,
    ) {
        run_logger::warn(
            "midi",
            "input_enumeration_empty",
            "retrying input enumeration",
        );
    }
}

fn note_non_empty_input_enumeration() {
    let slot = EMPTY_INPUT_ENUMERATION_LOG_STATE
        .get_or_init(|| Mutex::new(EmptyEnumerationLogState::default()));
    if let Ok(mut state) = slot.lock() {
        note_non_empty_enumeration(&mut state);
    }
}

fn log_inventory_if_changed(kind: &str, devices: &[DeviceInfo]) {
    let signature = devices
        .iter()
        .map(|device| format!("{}:{}", device.id, device.name))
        .collect::<Vec<_>>()
        .join("|");

    let slot = if kind == "input" {
        INPUT_DEVICE_SIGNATURE.get_or_init(|| Mutex::new(String::new()))
    } else {
        OUTPUT_DEVICE_SIGNATURE.get_or_init(|| Mutex::new(String::new()))
    };

    if let Ok(mut last) = slot.lock() {
        if *last == signature {
            return;
        }
        *last = signature;
    }
    if kind == "input" {
        INPUT_DEVICE_GENERATION.fetch_add(1, Ordering::Relaxed);
    } else {
        OUTPUT_DEVICE_GENERATION.fetch_add(1, Ordering::Relaxed);
    }

    run_logger::info(
        "midi",
        &format!("{}_inventory_changed", kind),
        &format!("port_count={}", devices.len()),
    );

    for (index, device) in devices.iter().enumerate() {
        run_logger::debug(
            "midi",
            &format!("{}_port", kind),
            &format!("index={} id={} name={}", index, device.id, device.name),
        );
    }
}

fn clean_expected_device_name(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_midi_port_index(device_id: &str, kind: &str) -> Result<usize> {
    device_id
        .strip_prefix(MIDI_PORT_PREFIX)
        .ok_or_else(|| anyhow!("Invalid MIDI {} device id: {}", kind, device_id))?
        .parse::<usize>()
        .map_err(|err| anyhow!("Invalid MIDI {} device id {}: {}", kind, device_id, err))
}

fn validate_expected_device_name(
    kind: &str,
    device_id: &str,
    expected_name: Option<&str>,
    actual_name: &str,
) -> Result<()> {
    let Some(expected_name) = clean_expected_device_name(expected_name) else {
        return Ok(());
    };
    if expected_name == actual_name {
        return Ok(());
    }

    log_route_device_mismatch(kind, device_id, &expected_name, Some(actual_name));
    Err(anyhow!(
        "MIDI {} device id {} now resolves to '{}' instead of '{}'",
        kind,
        device_id,
        actual_name,
        expected_name
    ))
}

fn device_name_mismatch(expected_name: Option<&str>, actual_name: Option<&str>) -> bool {
    match (
        clean_expected_device_name(expected_name),
        actual_name.and_then(|name| clean_expected_device_name(Some(name))),
    ) {
        (Some(expected), Some(actual)) => expected != actual,
        (Some(_), None) => true,
        _ => false,
    }
}

fn log_route_device_mismatch(
    kind: &str,
    device_id: &str,
    expected_name: &str,
    actual_name: Option<&str>,
) {
    run_logger::warn(
        "midi",
        "route_device_mismatch",
        &format!(
            "kind={} device_id={} expected_name={} actual_name={}",
            kind,
            device_id,
            expected_name,
            actual_name.unwrap_or("<missing>")
        ),
    );
}

fn resolve_input_port(
    midi_in: &MidiInput,
    input_device_id: &str,
    expected_input_device_name: Option<&str>,
) -> Result<(MidiInputPort, String)> {
    let input_port_index = parse_midi_port_index(input_device_id, "input")?;
    let input_port = find_input_port(midi_in, input_port_index)?;
    let input_port_name = midi_in
        .port_name(&input_port)
        .unwrap_or_else(|_| format!("Input {}", input_port_index));
    validate_expected_device_name(
        "input",
        input_device_id,
        expected_input_device_name,
        &input_port_name,
    )?;
    Ok((input_port, input_port_name))
}

fn resolve_output_port(
    midi_out: &MidiOutput,
    output_device_id: &str,
    expected_output_device_name: Option<&str>,
) -> Result<(MidiOutputPort, String)> {
    let output_port_index = parse_midi_port_index(output_device_id, "output")?;
    let output_port = find_output_port(midi_out, output_port_index)?;
    let output_port_name = midi_out
        .port_name(&output_port)
        .unwrap_or_else(|_| format!("Output {}", output_port_index));
    validate_expected_device_name(
        "output",
        output_device_id,
        expected_output_device_name,
        &output_port_name,
    )?;
    Ok((output_port, output_port_name))
}

fn current_input_port_name(input_device_id: &str) -> Result<String> {
    let input_port_index = parse_midi_port_index(input_device_id, "input")?;
    let midi_in = MidiInput::new("MIDIMaster")?;
    let input_port = find_input_port(&midi_in, input_port_index)?;
    Ok(midi_in
        .port_name(&input_port)
        .unwrap_or_else(|_| format!("Input {}", input_port_index)))
}

fn current_output_port_name(output_device_id: &str) -> Result<String> {
    let output_port_index = parse_midi_port_index(output_device_id, "output")?;
    let midi_out = MidiOutput::new("MIDIMaster")?;
    let output_port = find_output_port(&midi_out, output_port_index)?;
    Ok(midi_out
        .port_name(&output_port)
        .unwrap_or_else(|_| format!("Output {}", output_port_index)))
}

fn inventory_generation(kind: &str) -> u64 {
    if kind == "input" {
        INPUT_DEVICE_GENERATION.load(Ordering::Relaxed)
    } else {
        OUTPUT_DEVICE_GENERATION.load(Ordering::Relaxed)
    }
}

fn now_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn atomic_millis_to_option(value: &AtomicU64) -> Option<u64> {
    match value.load(Ordering::Relaxed) {
        0 => None,
        millis => Some(millis),
    }
}

fn find_input_port(midi_in: &MidiInput, index: usize) -> Result<MidiInputPort> {
    midi_in
        .ports()
        .get(index)
        .cloned()
        .ok_or_else(|| anyhow!("MIDI input port not found"))
}

fn find_output_port(midi_out: &MidiOutput, index: usize) -> Result<MidiOutputPort> {
    midi_out
        .ports()
        .get(index)
        .cloned()
        .ok_or_else(|| anyhow!("MIDI output port not found"))
}

fn parse_midi_message(device_id: &str, message: &[u8]) -> Option<MidiEvent> {
    if message.is_empty() {
        return None;
    }
    let status = message[0];
    let command = status & 0xF0;
    let channel = status & 0x0F;

    match command {
        0xB0 if message.len() >= 3 => Some(MidiEvent {
            device_id: device_id.to_string(),
            channel,
            controller: message[1],
            value: message[2],
            value_14: None,
            msg_type: MidiMessageType::ControlChange,
        }),
        0x90 | 0x80 if message.len() >= 3 => Some(MidiEvent {
            device_id: device_id.to_string(),
            channel,
            controller: message[1],                              // Note number
            value: if command == 0x80 { 0 } else { message[2] }, // Note Off = velocity 0
            value_14: None,
            msg_type: MidiMessageType::Note,
        }),
        0xC0 if message.len() >= 2 => Some(MidiEvent {
            device_id: device_id.to_string(),
            channel,
            controller: message[1],
            value: 127,
            value_14: None,
            msg_type: MidiMessageType::ProgramChange,
        }),
        0xE0 if message.len() >= 3 => {
            let lsb = message[1] as u16;
            let msb = message[2] as u16;
            let value_14 = (msb << 7) | lsb;
            Some(MidiEvent {
                device_id: device_id.to_string(),
                channel,
                controller: 0xE0,
                value: message[2],
                value_14: Some(value_14),
                msg_type: MidiMessageType::PitchBend,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        AssignMode, AuxiliaryControl, BindingControlKind, BindingTarget, ButtonLightBehavior,
        ButtonLightMode, FaderCurve, MidiControl, MuteBehavior, RelativeFormat,
    };

    fn direct_feedback(
        channel: u8,
        controller: u8,
        value: f32,
        msg_type: MidiMessageType,
    ) -> FeedbackMessage {
        build_feedback_message(channel, controller, value, &msg_type, None, "")
    }

    fn expected_direct_feedback(
        bytes: Vec<u8>,
        channel: u8,
        controller: u8,
        msg_type: MidiMessageType,
        normalized_value: f32,
        raw_midi_value: u16,
    ) -> FeedbackMessage {
        FeedbackMessage {
            logical_bytes: bytes.clone(),
            logical_raw_midi_value: raw_midi_value,
            physical_bytes: bytes,
            physical_channel: channel,
            physical_controller: controller,
            physical_msg_type: msg_type,
            physical_raw_midi_value: raw_midi_value,
            normalized_value,
            protocol: "direct",
        }
    }

    #[test]
    fn parses_program_change_zero_as_button_press() {
        let event = parse_midi_message("midi:0", &[0xC0, 0x00]).expect("program change event");

        assert_eq!(event.device_id, "midi:0");
        assert_eq!(event.channel, 0);
        assert_eq!(event.controller, 0);
        assert_eq!(event.value, 127);
        assert_eq!(event.value_14, None);
        assert_eq!(event.msg_type, MidiMessageType::ProgramChange);
    }

    #[test]
    fn parses_program_change_program_number_and_channel() {
        let event = parse_midi_message("midi:1", &[0xC3, 0x7C]).expect("program change event");

        assert_eq!(event.device_id, "midi:1");
        assert_eq!(event.channel, 3);
        assert_eq!(event.controller, 0x7C);
        assert_eq!(event.value, 127);
        assert_eq!(event.value_14, None);
        assert_eq!(event.msg_type, MidiMessageType::ProgramChange);
    }

    #[test]
    fn ignores_truncated_three_byte_messages_without_dropping_program_change() {
        assert!(parse_midi_message("midi:0", &[0xB0, 0x07]).is_none());
        assert!(parse_midi_message("midi:0", &[0xC0, 0x05]).is_some());
    }

    fn manager_with_test_route(input_device_id: &str, output_device_id: &str) -> MidiManager {
        let mut manager = MidiManager::new();
        insert_test_route(&mut manager, input_device_id, output_device_id);
        manager
    }

    fn insert_test_route(manager: &mut MidiManager, input_device_id: &str, output_device_id: &str) {
        manager.input_routes.insert(
            input_device_id.to_string(),
            MidiInputRoute {
                input_connection: None,
                input_device_id: input_device_id.to_string(),
                input_device_name: String::new(),
                output_device_id: output_device_id.to_string(),
                input_connection_suspect: false,
                input_connection_suspect_reason: None,
                input_inventory_generation: inventory_generation("input"),
                last_input_seen_at_ms: Arc::new(AtomicU64::new(0)),
            },
        );
        manager.output_routes.insert(
            output_device_id.to_string(),
            MidiOutputRoute {
                output_connection: None,
                output_device_name: String::new(),
                last_reconnect_attempt: None,
                last_reconnect_skipped_log: None,
                reconnect_failures: 0,
                connection_suspect: false,
                connection_suspect_reason: None,
            },
        );
    }

    fn xtouch_mini_mc_volume_binding(controller: u8) -> Binding {
        Binding {
            id: "binding-1".to_string(),
            name: "Binding 1".to_string(),
            macro_name: String::new(),
            device_id: "midi:0".to_string(),
            control: MidiControl {
                channel: 0,
                controller,
                msg_type: MidiMessageType::ControlChange,
            },
            control_kind: BindingControlKind::Continuous,
            targets: vec![BindingTarget::Master],
            target: BindingTarget::Master,
            action: BindingAction::Volume,
            mode: MidiMode::Relative,
            relative_format: RelativeFormat::Auto,
            fader_curve: FaderCurve::Linear,
            custom_curve: Vec::new(),
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: MuteBehavior::ToggleOnPress,
            button_light_mode: ButtonLightMode::Activity,
            button_light_behavior: ButtonLightBehavior::FollowState,
            indicator_control: None,
            mute_control: None,
            assign_control: None,
            assign_mode: AssignMode::Add,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
            macro_steps: Vec::new(),
        }
    }

    #[test]
    fn empty_enumeration_logging_is_rate_limited() {
        let mut state = EmptyEnumerationLogState::default();
        let start = Instant::now();
        let interval = Duration::from_secs(60);

        assert!(should_log_empty_enumeration(&mut state, start, interval));
        assert!(!should_log_empty_enumeration(
            &mut state,
            start + Duration::from_secs(3),
            interval
        ));
        assert!(should_log_empty_enumeration(
            &mut state,
            start + Duration::from_secs(61),
            interval
        ));
    }

    #[test]
    fn empty_enumeration_logging_resets_after_devices_return() {
        let mut state = EmptyEnumerationLogState::default();
        let start = Instant::now();
        let interval = Duration::from_secs(60);

        assert!(should_log_empty_enumeration(&mut state, start, interval));
        note_non_empty_enumeration(&mut state);
        assert!(should_log_empty_enumeration(
            &mut state,
            start + Duration::from_secs(3),
            interval
        ));
    }

    #[test]
    fn reconnect_skipped_logging_is_rate_limited() {
        let mut last_logged_at = None;
        let start = Instant::now();
        let interval = Duration::from_secs(30);

        assert!(should_log_reconnect_skipped(
            &mut last_logged_at,
            start,
            interval
        ));
        assert!(!should_log_reconnect_skipped(
            &mut last_logged_at,
            start + Duration::from_secs(3),
            interval
        ));
        assert!(should_log_reconnect_skipped(
            &mut last_logged_at,
            start + Duration::from_secs(31),
            interval
        ));
    }

    #[test]
    fn expected_device_name_validation_rejects_reused_output_id() {
        validate_expected_device_name(
            "output",
            "midi:1",
            Some("Platform X+1 V2.13"),
            "Platform X+1 V2.13",
        )
        .expect("matching output name should pass");

        let err = validate_expected_device_name(
            "output",
            "midi:1",
            Some("Platform X+1 V2.13"),
            "Focusrite USB MIDI",
        )
        .expect_err("reused id with a different output name should be rejected");

        let message = err.to_string();
        assert!(message.contains("midi:1"));
        assert!(message.contains("Focusrite USB MIDI"));
        assert!(message.contains("Platform X+1 V2.13"));
    }

    #[test]
    fn device_name_mismatch_requires_known_expected_name() {
        assert!(!device_name_mismatch(None, Some("Focusrite USB MIDI")));
        assert!(!device_name_mismatch(
            Some("Platform X+1 V2.13"),
            Some("Platform X+1 V2.13")
        ));
        assert!(device_name_mismatch(
            Some("Platform X+1 V2.13"),
            Some("Focusrite USB MIDI")
        ));
        assert!(device_name_mismatch(Some("Platform X+1 V2.13"), None));
    }

    #[test]
    fn route_health_reports_input_suspect_fields() {
        let mut manager = manager_with_test_route("midi:998", "midi:999");
        let route = manager
            .input_routes
            .get_mut("midi:998")
            .expect("test input route");
        route.input_device_name = "Platform X+1 V2.13".to_string();
        route.input_connection_suspect = true;
        route.input_connection_suspect_reason = Some("input_inventory_changed".to_string());
        route.last_input_seen_at_ms.store(1234, Ordering::Relaxed);

        let health = manager.connection_health();

        assert_eq!(health.input_device_id, "midi:998");
        assert!(health.suspect);
        assert!(health.input_suspect);
        assert_eq!(health.reason, "input_port_missing");
        assert_eq!(
            health.expected_input_name.as_deref(),
            Some("Platform X+1 V2.13")
        );
        assert_eq!(health.last_input_seen_at, Some(1234));
    }

    #[test]
    fn connection_health_marks_suspect_pair() {
        let mut manager = manager_with_test_route("midi:0", "midi:1");

        manager.mark_output_suspect("midi:1", "output_send_failed");

        let health = manager.connection_health();
        assert_eq!(health.input_device_id, "midi:0");
        assert_eq!(health.output_device_id, "midi:1");
        assert!(health.suspect);
        assert!(!health.connected);
        assert_eq!(health.reason, "output_send_failed");
    }

    #[test]
    fn route_health_isolated_by_output_route() {
        let mut manager = manager_with_test_route("midi:0", "midi:10");
        insert_test_route(&mut manager, "midi:1", "midi:11");

        manager.mark_output_suspect("midi:10", "output_send_failed");

        let health = manager.route_health();

        assert_eq!(health.len(), 2);
        assert_eq!(health[0].input_device_id, "midi:0");
        assert!(health[0].suspect);
        assert_eq!(health[0].reason, "output_send_failed");
        assert_eq!(health[1].input_device_id, "midi:1");
        assert!(!health[1].suspect);
        assert_eq!(health[1].reason, "");
    }

    #[test]
    fn feedback_failure_marks_only_binding_route_output_suspect() {
        let mut manager = manager_with_test_route("midi:0", "midi:998");
        insert_test_route(&mut manager, "midi:1", "midi:999");

        manager
            .send_feedback("midi:0", 0, 7, 0.5, MidiMessageType::ControlChange)
            .expect("feedback send should degrade health instead of failing");

        let health = manager.route_health();
        let first = health
            .iter()
            .find(|route| route.input_device_id == "midi:0")
            .expect("first route health");
        let second = health
            .iter()
            .find(|route| route.input_device_id == "midi:1")
            .expect("second route health");

        assert!(first.suspect);
        assert_eq!(first.output_device_id, "midi:998");
        assert!(!second.suspect);
        assert_eq!(second.output_device_id, "midi:999");
    }

    #[test]
    fn feedback_with_stale_device_id_uses_single_active_route() {
        let mut manager = manager_with_test_route("midi:1", "midi:998");

        manager
            .send_feedback("midi:0", 0, 7, 0.5, MidiMessageType::ControlChange)
            .expect("single active route feedback fallback should not fail");

        let health = manager.route_health();
        assert_eq!(health.len(), 1);
        assert_eq!(health[0].input_device_id, "midi:1");
        assert_eq!(health[0].output_device_id, "midi:998");
        assert!(health[0].suspect);
    }

    #[test]
    fn feedback_with_stale_device_id_does_not_fallback_when_routes_are_ambiguous() {
        let mut manager = manager_with_test_route("midi:1", "midi:998");
        insert_test_route(&mut manager, "midi:2", "midi:999");

        manager
            .send_feedback("midi:0", 0, 7, 0.5, MidiMessageType::ControlChange)
            .expect("ambiguous stale feedback should be skipped without failing");

        let health = manager.route_health();
        assert_eq!(health.len(), 2);
        assert!(health.iter().all(|route| !route.suspect));
    }

    #[test]
    fn setting_empty_routes_clears_suspect_health() {
        let mut manager = manager_with_test_route("midi:0", "midi:1");
        manager.mark_output_suspect("midi:1", "output_send_failed");

        manager
            .set_device_routes(&[], std::sync::Arc::new(|_| {}), false)
            .expect("empty route sync");

        let health = manager.connection_health();
        assert_eq!(health.input_device_id, "");
        assert_eq!(health.output_device_id, "");
        assert!(!health.suspect);
        assert_eq!(health.reason, "");
    }

    #[test]
    fn stop_clears_suspect_health() {
        let mut manager = manager_with_test_route("midi:0", "midi:1");
        manager.mark_output_suspect("midi:1", "output_reconnect_failed");

        manager.stop();

        let health = manager.connection_health();
        assert!(!health.suspect);
        assert_eq!(health.reason, "");
    }

    #[test]
    fn control_change_feedback_maps_normalized_values_to_7_bit_bytes() {
        assert_eq!(
            direct_feedback(0, 9, 0.0, MidiMessageType::ControlChange),
            expected_direct_feedback(
                vec![0xB0, 9, 0],
                0,
                9,
                MidiMessageType::ControlChange,
                0.0,
                0
            )
        );
        assert_eq!(
            direct_feedback(0, 9, 0.5, MidiMessageType::ControlChange),
            expected_direct_feedback(
                vec![0xB0, 9, 64],
                0,
                9,
                MidiMessageType::ControlChange,
                0.5,
                64
            )
        );
        assert_eq!(
            direct_feedback(0, 9, 1.0, MidiMessageType::ControlChange),
            expected_direct_feedback(
                vec![0xB0, 9, 127],
                0,
                9,
                MidiMessageType::ControlChange,
                1.0,
                127
            )
        );
    }

    #[test]
    fn note_feedback_maps_normalized_value_to_velocity() {
        assert_eq!(
            direct_feedback(2, 15, 1.0, MidiMessageType::Note),
            expected_direct_feedback(vec![0x92, 15, 127], 2, 15, MidiMessageType::Note, 1.0, 127)
        );
    }

    #[test]
    fn program_change_button_can_emit_note_indicator_feedback() {
        let mut binding = xtouch_mini_mc_volume_binding(16);
        binding.control_kind = BindingControlKind::Button;
        binding.control.msg_type = MidiMessageType::ProgramChange;
        binding.indicator_control = Some(AuxiliaryControl {
            device_id: "midi:0".to_string(),
            channel: 4,
            controller: 25,
            msg_type: MidiMessageType::Note,
            control_kind: BindingControlKind::Button,
            mode: MidiMode::Absolute,
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: MuteBehavior::ToggleOnPress,
        });

        let indicator = binding
            .indicator_feedback_control()
            .expect("custom indicator should be used");
        let feedback = build_feedback_message(
            indicator.channel,
            indicator.controller,
            1.0,
            &indicator.msg_type,
            None,
            "Generic MIDI Output",
        );

        assert_eq!(feedback.protocol, "direct");
        assert_eq!(feedback.physical_bytes, vec![0x94, 25, 127]);
    }

    #[test]
    fn custom_indicator_light_feedback_includes_primary_off_send() {
        let mut binding = xtouch_mini_mc_volume_binding(21);
        binding.control_kind = BindingControlKind::Button;
        binding.control.msg_type = MidiMessageType::Note;
        binding.mode = MidiMode::Absolute;
        binding.indicator_control = Some(AuxiliaryControl {
            device_id: "midi:0".to_string(),
            channel: 0,
            controller: 22,
            msg_type: MidiMessageType::Note,
            control_kind: BindingControlKind::Button,
            mode: MidiMode::Absolute,
            deadzone: 0.0,
            debounce_ms: 0,
            mute_behavior: MuteBehavior::ToggleOnPress,
        });

        let sends = binding_light_feedback_sends(&binding, 1.0);

        assert_eq!(sends.len(), 2);
        assert_eq!(sends[0].device_id, "midi:0");
        assert_eq!(sends[0].channel, 0);
        assert_eq!(sends[0].controller, 22);
        assert_eq!(sends[0].msg_type, MidiMessageType::Note);
        assert_eq!(sends[0].value, 1.0);
        assert!(!sends[0].use_binding_protocol);
        assert_eq!(sends[1].device_id, "midi:0");
        assert_eq!(sends[1].channel, 0);
        assert_eq!(sends[1].controller, 21);
        assert_eq!(sends[1].msg_type, MidiMessageType::Note);
        assert_eq!(sends[1].value, 0.0);
        assert!(!sends[1].use_binding_protocol);
    }

    #[test]
    fn default_button_light_feedback_uses_primary_send_only() {
        let mut binding = xtouch_mini_mc_volume_binding(21);
        binding.control_kind = BindingControlKind::Button;
        binding.control.msg_type = MidiMessageType::Note;
        binding.mode = MidiMode::Absolute;

        let sends = binding_light_feedback_sends(&binding, 1.0);

        assert_eq!(sends.len(), 1);
        assert_eq!(sends[0].device_id, "midi:0");
        assert_eq!(sends[0].channel, 0);
        assert_eq!(sends[0].controller, 21);
        assert_eq!(sends[0].msg_type, MidiMessageType::Note);
        assert_eq!(sends[0].value, 1.0);
        assert!(sends[0].use_binding_protocol);
    }

    #[test]
    fn pitch_bend_feedback_maps_normalized_value_to_14_bit_bytes() {
        assert_eq!(
            direct_feedback(1, 0xE0, 0.0, MidiMessageType::PitchBend),
            expected_direct_feedback(
                vec![0xE1, 0, 0],
                1,
                0xE0,
                MidiMessageType::PitchBend,
                0.0,
                0
            )
        );
        assert_eq!(
            direct_feedback(1, 0xE0, 0.5, MidiMessageType::PitchBend),
            expected_direct_feedback(
                vec![0xE1, 0, 64],
                1,
                0xE0,
                MidiMessageType::PitchBend,
                0.5,
                8192
            )
        );
        assert_eq!(
            direct_feedback(1, 0xE0, 1.0, MidiMessageType::PitchBend),
            expected_direct_feedback(
                vec![0xE1, 0x7F, 0x7F],
                1,
                0xE0,
                MidiMessageType::PitchBend,
                1.0,
                16383
            )
        );
    }

    #[test]
    fn feedback_values_are_clamped_before_byte_construction() {
        assert_eq!(
            direct_feedback(0, 9, -1.0, MidiMessageType::ControlChange),
            expected_direct_feedback(
                vec![0xB0, 9, 0],
                0,
                9,
                MidiMessageType::ControlChange,
                0.0,
                0
            )
        );
        assert_eq!(
            direct_feedback(0, 9, 2.0, MidiMessageType::ControlChange),
            expected_direct_feedback(
                vec![0xB0, 9, 127],
                0,
                9,
                MidiMessageType::ControlChange,
                1.0,
                127
            )
        );
    }

    #[test]
    fn xtouch_mini_mc_knob_one_relative_volume_maps_to_vpot_fan_feedback() {
        let binding = xtouch_mini_mc_volume_binding(16);

        let off = build_feedback_message(
            0,
            16,
            0.0,
            &MidiMessageType::ControlChange,
            Some(&binding),
            "X-TOUCH MINI",
        );
        assert_eq!(off.protocol, "xtouch_mc_vpot_fan");
        assert_eq!(off.logical_bytes, vec![0xB0, 0x10, 0x00]);
        assert_eq!(off.physical_bytes, vec![0xB0, 0x30, 0x00]);

        let halfway = build_feedback_message(
            0,
            16,
            0.5,
            &MidiMessageType::ControlChange,
            Some(&binding),
            "X-TOUCH MINI",
        );
        assert_eq!(halfway.logical_bytes, vec![0xB0, 0x10, 0x40]);
        assert_eq!(halfway.physical_bytes, vec![0xB0, 0x30, 0x26]);

        let full = build_feedback_message(
            0,
            16,
            1.0,
            &MidiMessageType::ControlChange,
            Some(&binding),
            "X-TOUCH MINI",
        );
        assert_eq!(full.logical_bytes, vec![0xB0, 0x10, 0x7F]);
        assert_eq!(full.physical_bytes, vec![0xB0, 0x30, 0x2B]);
    }

    #[test]
    fn xtouch_mini_mc_knob_eight_relative_volume_maps_to_vpot_eight() {
        let binding = xtouch_mini_mc_volume_binding(23);
        let feedback = build_feedback_message(
            0,
            23,
            1.0,
            &MidiMessageType::ControlChange,
            Some(&binding),
            "X-TOUCH MINI",
        );

        assert_eq!(feedback.protocol, "xtouch_mc_vpot_fan");
        assert_eq!(feedback.physical_bytes, vec![0xB0, 0x37, 0x2B]);
    }

    #[test]
    fn xtouch_ext_knob_one_relative_volume_maps_to_vpot_fan_feedback() {
        let binding = xtouch_mini_mc_volume_binding(16);
        let feedback = build_feedback_message(
            0,
            16,
            0.5,
            &MidiMessageType::ControlChange,
            Some(&binding),
            "X-Touch-Ext",
        );

        assert_eq!(feedback.protocol, "xtouch_mc_vpot_fan");
        assert_eq!(feedback.physical_bytes, vec![0xB0, 0x30, 0x26]);
    }

    #[test]
    fn xtouch_ext_knob_eight_relative_volume_maps_to_vpot_eight() {
        let binding = xtouch_mini_mc_volume_binding(23);
        let feedback = build_feedback_message(
            0,
            23,
            1.0,
            &MidiMessageType::ControlChange,
            Some(&binding),
            "X-Touch-Ext",
        );

        assert_eq!(feedback.protocol, "xtouch_mc_vpot_fan");
        assert_eq!(feedback.physical_bytes, vec![0xB0, 0x37, 0x2B]);
    }

    #[test]
    fn non_xtouch_output_keeps_direct_relative_encoder_feedback() {
        let binding = xtouch_mini_mc_volume_binding(16);
        let feedback = build_feedback_message(
            0,
            16,
            0.5,
            &MidiMessageType::ControlChange,
            Some(&binding),
            "Generic MIDI Output",
        );

        assert_eq!(feedback.protocol, "direct");
        assert_eq!(feedback.physical_bytes, vec![0xB0, 0x10, 0x40]);
    }

    #[test]
    fn xtouch_mini_note_feedback_stays_direct() {
        let mut binding = xtouch_mini_mc_volume_binding(16);
        binding.control.msg_type = MidiMessageType::Note;
        binding.control.controller = 40;
        let feedback = build_feedback_message(
            0,
            40,
            1.0,
            &MidiMessageType::Note,
            Some(&binding),
            "X-TOUCH MINI",
        );

        assert_eq!(feedback.protocol, "direct");
        assert_eq!(feedback.physical_bytes, vec![0x90, 40, 127]);
    }

    #[test]
    fn xtouch_mini_absolute_cc_feedback_stays_direct() {
        let mut binding = xtouch_mini_mc_volume_binding(16);
        binding.mode = MidiMode::Absolute;
        let feedback = build_feedback_message(
            0,
            16,
            0.5,
            &MidiMessageType::ControlChange,
            Some(&binding),
            "X-TOUCH MINI",
        );

        assert_eq!(feedback.protocol, "direct");
        assert_eq!(feedback.physical_bytes, vec![0xB0, 0x10, 0x40]);
    }
}

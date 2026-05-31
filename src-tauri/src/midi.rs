use crate::model::{Binding, BindingAction, DeviceInfo, MidiEvent, MidiMessageType, MidiMode};
use crate::run_logger;
use anyhow::{anyhow, Result};
use midir::{
    Ignore, MidiInput, MidiInputConnection, MidiInputPort, MidiOutput, MidiOutputConnection,
    MidiOutputPort,
};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const MIDI_PORT_PREFIX: &str = "midi:";
const LOG_MIDI_MESSAGES: bool = false;
const MIDI_DIAGNOSTIC_MIN_INTERVAL_MS: u128 = 250;
static INPUT_DEVICE_SIGNATURE: OnceLock<Mutex<String>> = OnceLock::new();
static OUTPUT_DEVICE_SIGNATURE: OnceLock<Mutex<String>> = OnceLock::new();
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

pub struct MidiManager {
    input_connection: Option<MidiInputConnection<()>>,
    output_connections: Vec<MidiOutputConnection>,
    active_device: Option<String>,
    active_output_device: Option<String>,
    active_output_device_name: Option<String>,
    last_reconnect_attempt: Option<std::time::Instant>,
    reconnect_failures: u32,
}

impl MidiManager {
    pub fn new() -> Self {
        Self {
            input_connection: None,
            output_connections: Vec::new(),
            active_device: None,
            active_output_device: None,
            active_output_device_name: None,
            last_reconnect_attempt: None,
            reconnect_failures: 0,
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
            run_logger::warn(
                "midi",
                "input_enumeration_empty",
                "retrying input enumeration",
            );
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

    pub fn active_pair(&self) -> Option<(String, String)> {
        Some((
            self.active_device.clone()?,
            self.active_output_device.clone()?,
        ))
        .filter(|_| self.input_connection.is_some() && !self.output_connections.is_empty())
    }

    fn connect_output(&mut self, output_device_id: &str) -> Result<()> {
        // Clear existing output connections first
        self.output_connections.clear();

        let output_port_index = output_device_id
            .strip_prefix(MIDI_PORT_PREFIX)
            .ok_or_else(|| anyhow!("Invalid output device id"))?
            .parse::<usize>()?;
        let midi_out = MidiOutput::new("MIDIMaster")?;
        let output_port = find_output_port(&midi_out, output_port_index)?;
        let output_port_name = midi_out
            .port_name(&output_port)
            .unwrap_or_else(|_| format!("Output {}", output_port_index));
        let output_connection = midi_out
            .connect(&output_port, "midimaster-output")
            .map_err(|e| anyhow!("Failed to connect to output: {}", e))?;

        self.output_connections = vec![output_connection];
        self.active_output_device = Some(output_device_id.to_string());
        self.active_output_device_name = Some(output_port_name.clone());
        self.reconnect_failures = 0; // Reset failure count on successful connect
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

    pub fn start_device<F>(
        &mut self,
        input_device_id: &str,
        output_device_id: &str,
        on_event: F,
    ) -> Result<()>
    where
        F: Fn(MidiEvent) + Send + 'static,
    {
        if self.active_device.as_deref() == Some(input_device_id)
            && self.active_output_device.as_deref() == Some(output_device_id)
            && self.input_connection.is_some()
            && !self.output_connections.is_empty()
        {
            run_logger::info(
                "midi",
                "start_device_noop",
                &format!(
                    "input_device_id={} output_device_id={}",
                    input_device_id, output_device_id
                ),
            );
            return Ok(());
        }

        run_logger::info(
            "midi",
            "switch_device_begin",
            &format!(
                "previous_input={} previous_output={} next_input={} next_output={}",
                self.active_device.as_deref().unwrap_or(""),
                self.active_output_device.as_deref().unwrap_or(""),
                input_device_id,
                output_device_id
            ),
        );

        // Clear existing input connection first
        self.input_connection = None;
        self.output_connections.clear();
        self.active_device = None;
        self.active_output_device = None;
        self.active_output_device_name = None;

        // Input setup
        let input_port_index = input_device_id
            .strip_prefix(MIDI_PORT_PREFIX)
            .ok_or_else(|| anyhow!("Invalid input device id"))?
            .parse::<usize>()?;
        let mut midi_in = MidiInput::new("MIDIMaster")?;
        midi_in.ignore(Ignore::None);
        let input_port = find_input_port(&midi_in, input_port_index)?;

        // Output setup
        self.connect_output(output_device_id)?;
        run_logger::info(
            "midi",
            "start_device_requested",
            &format!(
                "input_device_id={} output_device_id={}",
                input_device_id, output_device_id
            ),
        );

        let event_device_id = input_device_id.to_string();
        let active_device = input_device_id.to_string(); // we use input device ID as the primary ID for the session

        let connection = midi_in.connect(
            &input_port,
            "midimaster-input",
            move |_timestamp, message, _| {
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

        self.input_connection = Some(connection);
        self.active_device = Some(active_device);
        run_logger::info(
            "midi",
            "input_connected",
            &format!("input_device_id={}", input_device_id),
        );

        Ok(())
    }

    pub fn stop(&mut self) {
        run_logger::info(
            "midi",
            "stop_device",
            &format!(
                "had_input={} had_output={} active_input={} active_output={}",
                self.input_connection.is_some(),
                !self.output_connections.is_empty(),
                self.active_device.as_deref().unwrap_or(""),
                self.active_output_device.as_deref().unwrap_or("")
            ),
        );
        self.input_connection.take();
        self.output_connections.clear();
        self.active_device = None;
        self.active_output_device = None;
        self.active_output_device_name = None;
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
        let output_device_name = self.active_output_device_name.clone().unwrap_or_default();
        let feedback = build_feedback_message(
            channel,
            controller,
            value,
            &msg_type,
            binding,
            &output_device_name,
        );

        // We only send feedback if the requested device matches our active ONE
        if self.active_device.as_deref() != Some(device_id) {
            run_logger::debug(
                "midi",
                "feedback_skipped_device_mismatch",
                &format!(
                    "feedback_protocol={} requested_input_device={} active_input_device={} active_output_device={} active_output_device_name={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={}",
                    feedback.protocol,
                    device_id,
                    self.active_device.as_deref().unwrap_or(""),
                    self.active_output_device.as_deref().unwrap_or(""),
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
            return Ok(());
        }

        // Early exit if no output is connected yet (prevents spam on startup)
        if self.active_output_device.is_none() {
            run_logger::debug(
                "midi",
                "feedback_skipped_no_output",
                &format!(
                    "feedback_protocol={} input_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={}",
                    feedback.protocol,
                    device_id,
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
            return Ok(());
        }

        let output_device_id = self
            .active_output_device
            .as_deref()
            .unwrap_or("")
            .to_string();
        let mut send_success = false;
        if let Some(conn) = self.output_connections.get_mut(0) {
            if conn.send(&feedback.physical_bytes).is_ok() {
                send_success = true;
            }
        }
        if send_success {
            log_feedback_sent_if_needed(
                device_id,
                &output_device_id,
                channel,
                controller,
                &msg_type,
                &feedback,
            );
        }

        if !send_success {
            // Rate limit reconnection attempts: wait at least 5 seconds between attempts
            // and give up after 3 consecutive failures
            const RECONNECT_COOLDOWN_SECS: u64 = 5;
            const MAX_RECONNECT_FAILURES: u32 = 3;

            let should_attempt = self
                .last_reconnect_attempt
                .map(|t| t.elapsed().as_secs() >= RECONNECT_COOLDOWN_SECS)
                .unwrap_or(true);

            if !should_attempt || self.reconnect_failures >= MAX_RECONNECT_FAILURES {
                // Silently skip reconnection - either too soon or too many failures
                run_logger::warn(
                    "midi",
                    "output_reconnect_skipped",
                    &format!(
                        "feedback_protocol={} output_device_id={} output_device_name={} cooldown_ready={} reconnect_failures={} max_failures={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={}",
                        feedback.protocol,
                        output_device_id,
                        output_device_name,
                        should_attempt,
                        self.reconnect_failures,
                        MAX_RECONNECT_FAILURES,
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
                return Ok(());
            }

            self.last_reconnect_attempt = Some(std::time::Instant::now());
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

            if let Some(output_id) = self.active_output_device.clone() {
                // Clear old connections first to release the port
                self.output_connections.clear();

                match self.connect_output(&output_id) {
                    Ok(_) => {
                        run_logger::info(
                            "midi",
                            "output_reconnected",
                            &format!("output_device_id={}", output_id),
                        );
                        if let Some(conn) = self.output_connections.get_mut(0) {
                            if let Err(e) = conn.send(&feedback.physical_bytes) {
                                run_logger::error(
                                    "midi",
                                    "retry_send_failed",
                                    &format!(
                                        "feedback_protocol={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={} error={}",
                                        feedback.protocol,
                                        output_id,
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
                                run_logger::info(
                                    "midi",
                                    "retry_send_successful",
                                    &format!(
                                        "feedback_protocol={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={}",
                                        feedback.protocol,
                                        output_id,
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
                                    device_id, &output_id, channel, controller, &msg_type,
                                    &feedback,
                                );
                            }
                        }
                    }
                    Err(e) => {
                        self.reconnect_failures += 1;
                        if self.reconnect_failures >= MAX_RECONNECT_FAILURES {
                            run_logger::error(
                                "midi",
                                "output_reconnect_give_up",
                                &format!(
                                    "feedback_protocol={} output_device_id={} attempts={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} physical_raw_midi_value={} physical_bytes_hex={} error={}",
                                    feedback.protocol,
                                    output_id,
                                    self.reconnect_failures,
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
                                    output_id,
                                    self.reconnect_failures,
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
        MidiMessageType::ControlChange | MidiMessageType::Note => 127,
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
    if message.len() < 3 {
        return None;
    }
    let status = message[0];
    let command = status & 0xF0;
    let channel = status & 0x0F;

    match command {
        0xB0 => Some(MidiEvent {
            device_id: device_id.to_string(),
            channel,
            controller: message[1],
            value: message[2],
            value_14: None,
            msg_type: MidiMessageType::ControlChange,
        }),
        0x90 | 0x80 => Some(MidiEvent {
            device_id: device_id.to_string(),
            channel,
            controller: message[1],                              // Note number
            value: if command == 0x80 { 0 } else { message[2] }, // Note Off = velocity 0
            value_14: None,
            msg_type: MidiMessageType::Note,
        }),
        0xE0 => {
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
        AssignMode, BindingControlKind, BindingTarget, ButtonLightMode, FaderCurve, MidiControl,
        MuteBehavior, RelativeFormat,
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

    fn xtouch_mini_mc_volume_binding(controller: u8) -> Binding {
        Binding {
            id: "binding-1".to_string(),
            name: "Binding 1".to_string(),
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
            mute_control: None,
            assign_control: None,
            assign_mode: AssignMode::Add,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
        }
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

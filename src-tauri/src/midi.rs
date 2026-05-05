use crate::model::{DeviceInfo, MidiEvent};
use crate::run_logger;
use anyhow::{anyhow, Result};
use midir::{
    Ignore, MidiInput, MidiInputConnection, MidiInputPort, MidiOutput, MidiOutputConnection,
    MidiOutputPort,
};
use std::sync::{Mutex, OnceLock};

const MIDI_PORT_PREFIX: &str = "midi:";
const LOG_MIDI_MESSAGES: bool = false;
static INPUT_DEVICE_SIGNATURE: OnceLock<Mutex<String>> = OnceLock::new();
static OUTPUT_DEVICE_SIGNATURE: OnceLock<Mutex<String>> = OnceLock::new();

pub struct MidiManager {
    input_connection: Option<MidiInputConnection<()>>,
    output_connections: Vec<MidiOutputConnection>,
    active_device: Option<String>,
    active_output_device: Option<String>,
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
        let output_connection = midi_out
            .connect(&output_port, "midimaster-output")
            .map_err(|e| anyhow!("Failed to connect to output: {}", e))?;

        self.output_connections = vec![output_connection];
        self.active_output_device = Some(output_device_id.to_string());
        self.reconnect_failures = 0; // Reset failure count on successful connect
        run_logger::info(
            "midi",
            "output_connected",
            &format!("output_device_id={}", output_device_id),
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
    }

    pub fn send_feedback(
        &mut self,
        device_id: &str,
        channel: u8,
        controller: u8,
        value: f32, // volume or mute state (1.0 = on/muted, 0.0 = off/unmuted)
        msg_type: crate::model::MidiMessageType,
    ) -> Result<()> {
        // We only send feedback if the requested device matches our active ONE
        if self.active_device.as_deref() != Some(device_id) {
            run_logger::debug(
                "midi",
                "feedback_skipped_device_mismatch",
                &format!(
                    "requested_device={} active_device={}",
                    device_id,
                    self.active_device.as_deref().unwrap_or("")
                ),
            );
            return Ok(());
        }

        let clamped = value.clamp(0.0, 1.0);

        let message = match msg_type {
            crate::model::MidiMessageType::Note => {
                let status = 0x90 | (channel & 0x0F);
                let velocity = (clamped * 127.0).round() as u8;
                vec![status, controller, velocity]
            }
            crate::model::MidiMessageType::PitchBend => {
                let status = 0xE0 | (channel & 0x0F);
                let value14 = (clamped * 16383.0).round() as u16;
                let lsb = (value14 & 0x7F) as u8;
                let msb = ((value14 >> 7) & 0x7F) as u8;
                vec![status, lsb, msb]
            }
            crate::model::MidiMessageType::ControlChange => {
                let status = 0xB0 | (channel & 0x0F);
                let value7 = (clamped * 127.0).round() as u8;
                vec![status, controller, value7]
            }
        };

        // Early exit if no output is connected yet (prevents spam on startup)
        if self.active_output_device.is_none() {
            run_logger::debug(
                "midi",
                "feedback_skipped_no_output",
                &format!("device_id={} controller={}", device_id, controller),
            );
            return Ok(());
        }

        let mut send_success = false;
        if let Some(conn) = self.output_connections.get_mut(0) {
            if conn.send(&message).is_ok() {
                send_success = true;
            }
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
                        "cooldown_ready={} reconnect_failures={} max_failures={}",
                        should_attempt, self.reconnect_failures, MAX_RECONNECT_FAILURES
                    ),
                );
                return Ok(());
            }

            self.last_reconnect_attempt = Some(std::time::Instant::now());
            run_logger::warn("midi", "output_send_failed", "attempting reconnect");

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
                            if let Err(e) = conn.send(&message) {
                                run_logger::error(
                                    "midi",
                                    "retry_send_failed",
                                    &format!("output_device_id={} error={}", output_id, e),
                                );
                            } else {
                                run_logger::info(
                                    "midi",
                                    "retry_send_successful",
                                    &format!("output_device_id={}", output_id),
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
                                &format!("attempts={} error={}", self.reconnect_failures, e),
                            );
                        } else {
                            run_logger::warn(
                                "midi",
                                "output_reconnect_failed",
                                &format!("attempt={} error={}", self.reconnect_failures, e),
                            );
                        }
                    }
                }
            }
        }
        Ok(())
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
            msg_type: crate::model::MidiMessageType::ControlChange,
        }),
        0x90 | 0x80 => Some(MidiEvent {
            device_id: device_id.to_string(),
            channel,
            controller: message[1],                              // Note number
            value: if command == 0x80 { 0 } else { message[2] }, // Note Off = velocity 0
            value_14: None,
            msg_type: crate::model::MidiMessageType::Note,
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
                msg_type: crate::model::MidiMessageType::PitchBend,
            })
        }
        _ => None,
    }
}

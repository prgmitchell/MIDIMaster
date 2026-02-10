use crate::model::{DeviceInfo, MidiEvent};
use anyhow::{anyhow, Result};
use midir::{
    Ignore, MidiInput, MidiInputConnection, MidiInputPort, MidiOutput, MidiOutputConnection,
    MidiOutputPort,
};

const MIDI_PORT_PREFIX: &str = "midi:";
const LOG_MIDI_MESSAGES: bool = false;

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
        println!("Found {} MIDI input ports", ports.len());
        let mut devices = Vec::new();
        for (index, port) in ports.iter().enumerate() {
            let name = midi_in
                .port_name(port)
                .unwrap_or_else(|_| format!("Device {}", index));
            println!("MIDI port {}: {}", index, name);
            devices.push(DeviceInfo {
                id: format!("{}{}", MIDI_PORT_PREFIX, index),
                name,
            });
        }
        if devices.is_empty() {
            println!("MIDI: retrying device enumeration");
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
        Ok(devices)
    }

    pub fn list_output_devices(&self) -> Result<Vec<DeviceInfo>> {
        let midi_out = MidiOutput::new("MIDIMaster")?;
        let ports = midi_out.ports();
        println!("Found {} MIDI output ports", ports.len());
        let mut devices = Vec::new();
        for (index, port) in ports.iter().enumerate() {
            let name = midi_out
                .port_name(port)
                .unwrap_or_else(|_| format!("Output {}", index));
            println!("MIDI output port {}: {}", index, name);
            devices.push(DeviceInfo {
                id: format!("{}{}", MIDI_PORT_PREFIX, index),
                name,
            });
        }
        Ok(devices)
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
        println!("MIDI Output connected: {}", output_device_id);
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
        // Clear existing input connection first
        self.input_connection = None;

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

        let event_device_id = input_device_id.to_string();
        let active_device = input_device_id.to_string(); // we use input device ID as the primary ID for the session

        let connection = midi_in.connect(
            &input_port,
            "midimaster-input",
            move |_timestamp, message, _| {
                if LOG_MIDI_MESSAGES {
                    println!("MIDI message: {:?}", message);
                }
                if let Some(event) = parse_midi_message(&event_device_id, message) {
                    on_event(event);
                }
            },
            (),
        )?;

        self.input_connection = Some(connection);
        self.active_device = Some(active_device);

        Ok(())
    }

    pub fn stop(&mut self) {
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
                return Ok(());
            }

            self.last_reconnect_attempt = Some(std::time::Instant::now());
            println!("MIDI: Output failed, attempting reconnect...");

            if let Some(output_id) = self.active_output_device.clone() {
                // Clear old connections first to release the port
                self.output_connections.clear();

                match self.connect_output(&output_id) {
                    Ok(_) => {
                        println!("MIDI: Reconnected to output {}", output_id);
                        if let Some(conn) = self.output_connections.get_mut(0) {
                            if let Err(e) = conn.send(&message) {
                                println!("MIDI: Retry send failed: {}", e);
                            } else {
                                println!("MIDI: Retry send successful");
                            }
                        }
                    }
                    Err(e) => {
                        self.reconnect_failures += 1;
                        if self.reconnect_failures >= MAX_RECONNECT_FAILURES {
                            println!(
                                "MIDI: Reconnection failed after {} attempts, giving up: {}",
                                self.reconnect_failures, e
                            );
                        } else {
                            println!(
                                "MIDI: Reconnection failed (attempt {}): {}",
                                self.reconnect_failures, e
                            );
                        }
                    }
                }
            }
        }
        Ok(())
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

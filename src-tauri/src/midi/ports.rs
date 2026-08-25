use crate::{model::DeviceInfo, run_logger};
use anyhow::{anyhow, Result};
use midir::{MidiInput, MidiInputPort, MidiOutput, MidiOutputPort};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};

pub(super) const MIDI_PORT_PREFIX: &str = "midi:";
static INPUT_DEVICE_SIGNATURE: OnceLock<Mutex<String>> = OnceLock::new();
static OUTPUT_DEVICE_SIGNATURE: OnceLock<Mutex<String>> = OnceLock::new();
static INPUT_DEVICE_GENERATION: AtomicU64 = AtomicU64::new(0);
static OUTPUT_DEVICE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub(super) struct PreparedMidiRoute {
    pub(super) input_device_id: String,
    pub(super) output_device_id: String,
    pub(super) input_device_name: Option<String>,
    pub(super) output_device_name: Option<String>,
}

pub(super) fn log_inventory_if_changed(kind: &str, devices: &[DeviceInfo]) {
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

pub(super) fn clean_expected_device_name(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn inventory_device_name<'a>(
    devices: &'a [DeviceInfo],
    device_id: &str,
) -> Option<&'a str> {
    devices
        .iter()
        .find(|device| device.id == device_id)
        .map(|device| device.name.as_str())
}

fn parse_midi_port_index(device_id: &str, kind: &str) -> Result<usize> {
    device_id
        .strip_prefix(MIDI_PORT_PREFIX)
        .ok_or_else(|| anyhow!("Invalid MIDI {} device id: {}", kind, device_id))?
        .parse::<usize>()
        .map_err(|err| anyhow!("Invalid MIDI {} device id {}: {}", kind, device_id, err))
}

pub(super) fn validate_expected_device_name(
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

pub(super) fn device_name_mismatch(expected_name: Option<&str>, actual_name: Option<&str>) -> bool {
    match (
        clean_expected_device_name(expected_name),
        actual_name.and_then(|name| clean_expected_device_name(Some(name))),
    ) {
        (Some(expected), Some(actual)) => expected != actual,
        (Some(_), None) => true,
        _ => false,
    }
}

pub(super) fn preflight_midi_routes(routes: &[PreparedMidiRoute]) -> Result<()> {
    if routes.is_empty() {
        return Ok(());
    }
    let midi_in = MidiInput::new("MIDIMaster preflight")?;
    let midi_out = MidiOutput::new("MIDIMaster preflight")?;
    for route in routes {
        resolve_input_port(
            &midi_in,
            &route.input_device_id,
            route.input_device_name.as_deref(),
        )?;
        resolve_output_port(
            &midi_out,
            &route.output_device_id,
            route.output_device_name.as_deref(),
        )?;
    }
    Ok(())
}

pub(super) fn log_route_device_mismatch(
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

pub(super) fn resolve_input_port(
    midi_in: &MidiInput,
    input_device_id: &str,
    expected_input_device_name: Option<&str>,
) -> Result<(MidiInputPort, String)> {
    let index = parse_midi_port_index(input_device_id, "input")?;
    let port = find_input_port(midi_in, index)?;
    let name = midi_in
        .port_name(&port)
        .unwrap_or_else(|_| format!("Input {}", index));
    validate_expected_device_name("input", input_device_id, expected_input_device_name, &name)?;
    Ok((port, name))
}

pub(super) fn resolve_output_port(
    midi_out: &MidiOutput,
    output_device_id: &str,
    expected_output_device_name: Option<&str>,
) -> Result<(MidiOutputPort, String)> {
    let index = parse_midi_port_index(output_device_id, "output")?;
    let port = find_output_port(midi_out, index)?;
    let name = midi_out
        .port_name(&port)
        .unwrap_or_else(|_| format!("Output {}", index));
    validate_expected_device_name(
        "output",
        output_device_id,
        expected_output_device_name,
        &name,
    )?;
    Ok((port, name))
}

pub(super) fn current_input_port_name(input_device_id: &str) -> Result<String> {
    let index = parse_midi_port_index(input_device_id, "input")?;
    let midi_in = MidiInput::new("MIDIMaster")?;
    let port = find_input_port(&midi_in, index)?;
    Ok(midi_in
        .port_name(&port)
        .unwrap_or_else(|_| format!("Input {}", index)))
}

pub(super) fn current_output_port_name(output_device_id: &str) -> Result<String> {
    let index = parse_midi_port_index(output_device_id, "output")?;
    let midi_out = MidiOutput::new("MIDIMaster")?;
    let port = find_output_port(&midi_out, index)?;
    Ok(midi_out
        .port_name(&port)
        .unwrap_or_else(|_| format!("Output {}", index)))
}

pub(super) fn inventory_generation(kind: &str) -> u64 {
    if kind == "input" {
        INPUT_DEVICE_GENERATION.load(Ordering::Relaxed)
    } else {
        OUTPUT_DEVICE_GENERATION.load(Ordering::Relaxed)
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

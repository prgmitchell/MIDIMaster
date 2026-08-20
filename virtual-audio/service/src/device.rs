use crate::limiter::SafetyLimiter;
use crate::ring::AudioRing;
use crate::status::ServiceStatus;
use crate::uac1::{Descriptors, SetupPacket};
use crate::{BYTES_PER_SAMPLE, CHANNELS, SAMPLE_RATE};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const STATUS_OK: i32 = 0;
pub const STATUS_PIPE: i32 = -32;

#[derive(Debug)]
struct ControlState {
    configuration: u8,
    alternate: HashMap<u8, u8>,
    sample_rate: u32,
    mute: bool,
    volume: i16,
}

#[derive(Debug)]
pub struct Device {
    pub descriptors: Descriptors,
    pub bus_id: &'static str,
    ring: AudioRing,
    limiter: Mutex<SafetyLimiter>,
    control: Mutex<ControlState>,
    status: Arc<ServiceStatus>,
}

impl Device {
    pub fn new(vid: u16, pid: u16, status: Arc<ServiceStatus>) -> Self {
        Self {
            descriptors: Descriptors::new(vid, pid),
            bus_id: crate::BUS_ID,
            ring: AudioRing::new(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE / 4), // 250 ms
            limiter: Mutex::new(SafetyLimiter::default()),
            control: Mutex::new(ControlState {
                configuration: 0,
                alternate: HashMap::from([(0, 0), (1, 0)]),
                sample_rate: SAMPLE_RATE as u32,
                mute: false,
                volume: 0,
            }),
            status,
        }
    }

    pub fn capture_active(&self) -> bool {
        let state = self.control.lock().expect("control state poisoned");
        state.configuration == 1 && state.alternate.get(&1) == Some(&1)
    }

    pub fn write_router_audio(&self, input: &[u8]) -> usize {
        let mut limiter = self.limiter.lock().expect("limiter poisoned");
        let limited = limiter.process(input);
        self.ring.write_latest(&limited);
        self.publish_stats(&limiter);
        input.len()
    }

    pub fn read_capture(&self, output: &mut [u8]) -> usize {
        if !self.capture_active() {
            output.fill(0);
            return 0;
        }
        let read = self.ring.read_or_silence(output);
        let limiter = self.limiter.lock().expect("limiter poisoned");
        self.publish_stats(&limiter);
        read
    }

    fn publish_stats(&self, limiter: &SafetyLimiter) {
        let ring = self.ring.stats();
        let limited = limiter.stats();
        self.status.update_audio(
            ring.dropped_bytes,
            ring.underrun_bytes,
            limited.limited_frames,
            limited.gain_reduction_db,
        );
    }

    pub fn handle_control(&self, setup: SetupPacket, output: &[u8]) -> (Vec<u8>, i32) {
        let mut state = self.control.lock().expect("control state poisoned");
        let truncate = |mut bytes: Vec<u8>| {
            bytes.truncate(setup.length as usize);
            bytes
        };
        if setup.request_type & 0x60 == 0 {
            return match setup.request {
                0x00 => (truncate(vec![0, 0]), STATUS_OK),
                0x01 | 0x03 | 0x05 => (vec![], STATUS_OK),
                0x06 => {
                    let kind = (setup.value >> 8) as u8;
                    let index = setup.value as u8;
                    match self.descriptors.get(kind, index) {
                        Some(bytes) => (truncate(bytes), STATUS_OK),
                        None => (vec![], STATUS_PIPE),
                    }
                }
                0x08 => (truncate(vec![state.configuration]), STATUS_OK),
                0x09 if setup.value <= 1 => {
                    state.configuration = setup.value as u8;
                    state.alternate.insert(0, 0);
                    state.alternate.insert(1, 0);
                    drop(state);
                    self.reset_audio();
                    (vec![], STATUS_OK)
                }
                0x0a => match state.alternate.get(&(setup.index as u8)) {
                    Some(value) => (truncate(vec![*value]), STATUS_OK),
                    None => (vec![], STATUS_PIPE),
                },
                0x0b => {
                    let interface = setup.index as u8;
                    let alternate = setup.value as u8;
                    if state.configuration != 1
                        || interface > 1
                        || alternate > 1
                        || (interface == 0 && alternate != 0)
                    {
                        (vec![], STATUS_PIPE)
                    } else {
                        state.alternate.insert(interface, alternate);
                        if alternate == 0 && interface == 1 {
                            drop(state);
                            self.reset_audio();
                        }
                        (vec![], STATUS_OK)
                    }
                }
                0x0c => (truncate(vec![0, 0]), STATUS_OK),
                _ => (vec![], STATUS_PIPE),
            };
        }

        let recipient = setup.request_type & 0x1f;
        let selector = (setup.value >> 8) as u8;
        let endpoint = setup.index as u8;
        if recipient == 2 && selector == 1 && endpoint == 0x82 {
            return match setup.request {
                0x01 if output.len() >= 3 => {
                    let rate =
                        output[0] as u32 | (output[1] as u32) << 8 | (output[2] as u32) << 16;
                    if rate != SAMPLE_RATE as u32 {
                        (vec![], STATUS_PIPE)
                    } else {
                        state.sample_rate = rate;
                        (vec![], STATUS_OK)
                    }
                }
                0x81 => (truncate(rate24(state.sample_rate)), STATUS_OK),
                0x82 | 0x83 => (truncate(rate24(SAMPLE_RATE as u32)), STATUS_OK),
                0x84 => (truncate(rate24(1)), STATUS_OK),
                _ => (vec![], STATUS_PIPE),
            };
        }

        let entity = (setup.index >> 8) as u8;
        let interface = setup.index as u8;
        if recipient == 1 && interface == 0 && (entity == 2 || entity == 5) {
            let control = (setup.value >> 8) as u8;
            return match (control, setup.request) {
                (1, 0x01) if !output.is_empty() => {
                    state.mute = output[0] != 0;
                    (vec![], STATUS_OK)
                }
                (1, 0x81) => (truncate(vec![u8::from(state.mute)]), STATUS_OK),
                (2, 0x01) if output.len() >= 2 => {
                    state.volume = i16::from_le_bytes([output[0], output[1]]);
                    (vec![], STATUS_OK)
                }
                (2, 0x81) => (truncate(state.volume.to_le_bytes().to_vec()), STATUS_OK),
                (2, 0x82) => (truncate((-60i16 * 256).to_le_bytes().to_vec()), STATUS_OK),
                (2, 0x83) => (truncate(0i16.to_le_bytes().to_vec()), STATUS_OK),
                (2, 0x84) => (truncate(256i16.to_le_bytes().to_vec()), STATUS_OK),
                _ => (vec![], STATUS_PIPE),
            };
        }
        (vec![], STATUS_PIPE)
    }

    fn reset_audio(&self) {
        self.ring.reset();
        self.limiter.lock().expect("limiter poisoned").reset();
    }
}

fn rate24(rate: u32) -> Vec<u8> {
    vec![rate as u8, (rate >> 8) as u8, (rate >> 16) as u8]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(request_type: u8, request: u8, value: u16, index: u16, length: u16) -> SetupPacket {
        SetupPacket {
            request_type,
            request,
            value,
            index,
            length,
        }
    }

    #[test]
    fn enumerates_and_captures_pipe_pcm_after_interface_activates() {
        let device = Device::new(0xffff, 0xca01, Arc::new(ServiceStatus::default()));
        let (descriptor, status) = device.handle_control(setup(0x80, 0x06, 0x0100, 0, 18), &[]);
        assert_eq!(status, STATUS_OK);
        assert_eq!(descriptor.len(), 18);
        assert_eq!(
            device.handle_control(setup(0, 0x09, 1, 0, 0), &[]).1,
            STATUS_OK
        );
        assert_eq!(
            device.handle_control(setup(1, 0x0b, 1, 1, 0), &[]).1,
            STATUS_OK
        );
        assert!(device.capture_active());
        let silence = vec![0u8; (240 + 1) * 4];
        assert_eq!(device.write_router_audio(&silence), silence.len());
        let mut output = [1u8; 4];
        device.read_capture(&mut output);
        assert_eq!(output, [0; 4]);
    }

    #[test]
    fn rejects_non_48khz_endpoint_rate() {
        let device = Device::new(0xffff, 0xca01, Arc::new(ServiceStatus::default()));
        let request = setup(0x22, 0x01, 0x0100, 0x82, 3);
        assert_eq!(
            device.handle_control(request, &[0x44, 0xac, 0]).1,
            STATUS_PIPE
        );
    }
}

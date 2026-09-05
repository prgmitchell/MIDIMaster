use crate::support;
use midimaster_virtual_audio_service::{
    device::Device, limiter::SafetyLimiter, ring::AudioRing, status::ServiceStatus,
    uac1::SetupPacket,
};
use std::sync::Arc;

pub fn configure_capture(device: &Device) {
    assert_eq!(
        device
            .handle_control(
                SetupPacket {
                    request_type: 0,
                    request: 9,
                    value: 1,
                    index: 0,
                    length: 0
                },
                &[]
            )
            .1,
        0
    );
    assert_eq!(
        device
            .handle_control(
                SetupPacket {
                    request_type: 1,
                    request: 11,
                    value: 1,
                    index: 1,
                    length: 0
                },
                &[]
            )
            .1,
        0
    );
    assert!(device.capture_active());
}

pub fn run() {
    // 1, 8 and 20 ms at 48 kHz stereo PCM16.
    for frames in [48_usize, 384, 960] {
        let input = (0..frames * 2)
            .flat_map(|sample| {
                let value = if sample % 97 == 0 { i16::MAX } else { 10_000 };
                value.to_le_bytes()
            })
            .collect::<Vec<_>>();
        let ring = AudioRing::new(48_000);
        let mut output = vec![0; input.len()];
        let mut result =
            support::measure("virtual_audio.ring_write_read", 10_000, input.len(), || {
                ring.write_latest(std::hint::black_box(&input));
                assert_eq!(ring.read_or_silence(&mut output), input.len());
                assert_eq!(output, input);
            });
        result["frames_per_operation"] = serde_json::json!(frames);
        println!("{result}");

        let mut limiter = SafetyLimiter::default();
        // Fill all lookahead frames before timing so each call yields a full block.
        limiter.process(&vec![0; 240 * 4]);
        let mut result =
            support::measure("virtual_audio.limiter_process", 10_000, input.len(), || {
                let output = limiter.process(std::hint::black_box(&input));
                assert_eq!(output.len(), input.len());
                std::hint::black_box(output);
            });
        result["frames_per_operation"] = serde_json::json!(frames);
        println!("{result}");

        let status = Arc::new(ServiceStatus::default());
        let device = Device::new(0xffff, 0xca01, status);
        configure_capture(&device);
        device.write_router_audio(&vec![0; 240 * 4]);
        let mut result = support::measure(
            "virtual_audio.device_write_capture",
            10_000,
            input.len(),
            || {
                assert_eq!(
                    device.write_router_audio(std::hint::black_box(&input)),
                    input.len()
                );
                assert_eq!(device.read_capture(&mut output), input.len());
                std::hint::black_box(&output);
            },
        );
        result["frames_per_operation"] = serde_json::json!(frames);
        result["scope"] = serde_json::json!("actual limiter,ring,control locks,status publication; single caller,no IPC/audio driver");
        println!("{result}");
    }
}

use midimaster_virtual_audio_service::{
    device::Device, perf_audit, status::ServiceStatus, usbip::Server,
};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

fn submit(sequence: u32, packets: u32) -> Vec<u8> {
    let mut frame = Vec::with_capacity(48 + packets as usize * 16);
    // CMD_SUBMIT, sequence, device, IN, endpoint2, flags, bytes, start, packets, interval.
    for value in [1, sequence, 0, 1, 2, 0, packets * 192, 0, packets, 1] {
        frame.extend_from_slice(&value.to_be_bytes());
    }
    frame.extend_from_slice(&[0; 8]);
    for packet in 0..packets {
        for value in [packet * 192, 192, 0, 0] {
            frame.extend_from_slice(&value.to_be_bytes());
        }
    }
    frame
}

fn distribution(mut samples: Vec<u64>) -> serde_json::Value {
    samples.sort_unstable();
    let percentile =
        |fraction: f64| samples[((samples.len() - 1) as f64 * fraction).ceil() as usize];
    serde_json::json!({ "samples": samples.len(), "p50_us": percentile(0.50),
        "p95_us": percentile(0.95), "p99_us": percentile(0.99), "max_us": samples.last() })
}

fn run_fixture(packets: u32) {
    const REQUESTS: u32 = 500;
    const WINDOW: u32 = 16;
    perf_audit::reset_scheduler_metrics();
    let status = Arc::new(ServiceStatus::default());
    let device = Arc::new(Device::new(0xffff, 0xca01, status.clone()));
    super::pcm::configure_capture(&device);
    let stop = Arc::new(AtomicBool::new(false));
    // Never attach a driver or contact the installed service's fixed port.
    let server = Server::bind("127.0.0.1:0", device, status, stop.clone()).unwrap();
    let address = server.local_addr().unwrap();
    let server_thread = thread::spawn(move || server.serve());
    let mut client = TcpStream::connect(address).unwrap();
    client.set_nodelay(true).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut import = vec![0x01, 0x11, 0x80, 0x03, 0, 0, 0, 0];
    import.extend_from_slice(b"1-1");
    import.resize(40, 0);
    client.write_all(&import).unwrap();
    let mut reply = vec![0; 320];
    client.read_exact(&mut reply).unwrap();
    assert_eq!(&reply[..8], &[0x01, 0x11, 0, 3, 0, 0, 0, 0]);

    let started = Instant::now();
    for sequence in 0..WINDOW {
        client.write_all(&submit(sequence, packets)).unwrap();
    }
    let mut received = HashSet::new();
    for completed in 0..REQUESTS {
        let mut header = [0; 48];
        client.read_exact(&mut header).unwrap();
        assert_eq!(u32::from_be_bytes(header[..4].try_into().unwrap()), 3);
        assert_eq!(i32::from_be_bytes(header[20..24].try_into().unwrap()), 0);
        let sequence = u32::from_be_bytes(header[4..8].try_into().unwrap());
        assert!(sequence < REQUESTS && received.insert(sequence));
        let actual = u32::from_be_bytes(header[24..28].try_into().unwrap());
        let returned_packets = u32::from_be_bytes(header[32..36].try_into().unwrap());
        assert_eq!(actual, packets * 192);
        assert_eq!(returned_packets, packets);
        let mut payload = vec![0; (actual + packets * 16) as usize];
        client.read_exact(&mut payload).unwrap();
        assert!(payload[..actual as usize].iter().all(|byte| *byte == 0));
        let next = completed + WINDOW;
        if next < REQUESTS {
            client.write_all(&submit(next, packets)).unwrap();
        }
    }
    let elapsed = started.elapsed();
    drop(client);
    stop.store(true, Ordering::Release);
    server_thread.join().unwrap().unwrap();
    let settle = Instant::now();
    while perf_audit::scheduler_snapshot().active_workers > 0 {
        assert!(
            settle.elapsed() < Duration::from_secs(1),
            "worker cleanup timed out"
        );
        thread::sleep(Duration::from_millis(1));
    }
    let snapshot = perf_audit::scheduler_snapshot();
    assert_eq!(snapshot.worker_threads_created, u64::from(REQUESTS));
    assert_eq!(snapshot.wake_deadline_lateness_us.len(), REQUESTS as usize);
    println!(
        "{}",
        serde_json::json!({
            "benchmark": "virtual_audio.usbip_iso_scheduler", "requests": REQUESTS,
            "iso_packets_per_request": packets, "outstanding_window": WINDOW,
            "elapsed_ms": elapsed.as_secs_f64() * 1000.0,
            "worker_threads_created": snapshot.worker_threads_created,
            "worker_threads_per_second": snapshot.worker_threads_created as f64 / elapsed.as_secs_f64(),
            "peak_active_workers": snapshot.peak_active_workers,
            "worker_start_delay": distribution(snapshot.worker_start_delay_us),
            "wake_deadline_lateness": distribution(snapshot.wake_deadline_lateness_us),
            "scope": "real Server/request parsing/reserve_iso/thread-per-URB/wait_until/capture/serialization; ephemeral loopback; silent in-memory device; no driver/attachment; audit counters enabled"
        })
    );
}

pub fn run() {
    for packets in [1, 8] {
        run_fixture(packets);
    }
}

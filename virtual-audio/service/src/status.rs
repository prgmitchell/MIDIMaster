pub use midimaster_virtual_audio_protocol::StatusSnapshot;
use midimaster_virtual_audio_protocol::STATUS_PIPE_PATH;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Default)]
pub struct ServiceStatus {
    running: AtomicBool,
    attached_port_count: AtomicU32,
    sessions: AtomicU32,
    dropped_bytes: AtomicU64,
    underrun_bytes: AtomicU64,
    limited_frames: AtomicU64,
    limiter_reduction_millidb: AtomicU32,
    last_error: Mutex<Option<String>>,
}

impl ServiceStatus {
    pub fn set_running(&self, value: bool) {
        self.running.store(value, Ordering::Relaxed);
    }
    pub fn set_attached_port_count(&self, port_count: u32) {
        self.attached_port_count
            .store(port_count, Ordering::Relaxed);
    }
    pub fn session_opened(&self) {
        self.sessions.fetch_add(1, Ordering::Relaxed);
    }
    pub fn session_closed(&self) {
        self.sessions.fetch_sub(1, Ordering::Relaxed);
    }
    pub fn update_audio(&self, dropped: u64, underruns: u64, limited: u64, reduction_db: f32) {
        self.dropped_bytes.store(dropped, Ordering::Relaxed);
        self.underrun_bytes.store(underruns, Ordering::Relaxed);
        self.limited_frames.store(limited, Ordering::Relaxed);
        self.limiter_reduction_millidb
            .store((reduction_db.max(0.0) * 1000.0) as u32, Ordering::Relaxed);
    }
    pub fn set_error(&self, error: impl Into<String>) {
        *self.last_error.lock().expect("status error poisoned") = Some(error.into());
    }
    pub fn clear_error(&self) {
        *self.last_error.lock().expect("status error poisoned") = None;
    }
    pub fn snapshot(&self) -> StatusSnapshot {
        let attached_port_count = self.attached_port_count.load(Ordering::Relaxed);
        StatusSnapshot {
            schema_version: 1,
            service_running: self.running.load(Ordering::Relaxed),
            // Keep the original boolean for older MIDIMaster clients, but derive
            // it from the same atomic value so a snapshot can never report the
            // contradictory `false` + `1 port` state.
            usbip_attached: attached_port_count == 1,
            attached_port_count: Some(attached_port_count),
            active_sessions: self.sessions.load(Ordering::Relaxed),
            dropped_bytes: self.dropped_bytes.load(Ordering::Relaxed),
            underrun_bytes: self.underrun_bytes.load(Ordering::Relaxed),
            limited_frames: self.limited_frames.load(Ordering::Relaxed),
            limiter_reduction_db: self.limiter_reduction_millidb.load(Ordering::Relaxed) as f32
                / 1000.0,
            last_error: self
                .last_error
                .lock()
                .expect("status error poisoned")
                .clone(),
            timestamp_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        }
    }
}

#[cfg(windows)]
pub fn serve_named_pipe(status: std::sync::Arc<ServiceStatus>, stop: std::sync::Arc<AtomicBool>) {
    serve_named_pipe_at(status, stop, STATUS_PIPE_PATH);
}

#[cfg(windows)]
fn serve_named_pipe_at(
    status: std::sync::Arc<ServiceStatus>,
    stop: std::sync::Arc<AtomicBool>,
    pipe_name: &str,
) {
    use std::thread;
    use std::time::Duration;
    use windows::core::{HRESULT, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::{WriteFile, PIPE_ACCESS_OUTBOUND};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_NOWAIT, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_MESSAGE,
    };

    let pipe_name: Vec<u16> = pipe_name.encode_utf16().chain(Some(0)).collect();
    while !stop.load(Ordering::Acquire) {
        let pipe = unsafe {
            CreateNamedPipeW(
                PCWSTR(pipe_name.as_ptr()),
                PIPE_ACCESS_OUTBOUND,
                PIPE_TYPE_MESSAGE | PIPE_REJECT_REMOTE_CLIENTS | PIPE_NOWAIT,
                4,
                16 * 1024,
                0,
                0,
                None,
            )
        };
        if pipe == INVALID_HANDLE_VALUE {
            status.set_error("could not create Virtual Audio status pipe");
            thread::sleep(Duration::from_secs(1));
            continue;
        }
        loop {
            if stop.load(Ordering::Acquire) {
                break;
            }
            let connected = match unsafe { ConnectNamedPipe(pipe, None) } {
                Ok(()) => true,
                Err(error) => error.code() == HRESULT::from_win32(ERROR_PIPE_CONNECTED.0),
            };
            if connected {
                let mut payload = serde_json::to_vec(&status.snapshot())
                    .unwrap_or_else(|_| b"{\"schema_version\":1}".to_vec());
                payload.push(b'\n');
                let mut written = 0u32;
                let _ = unsafe { WriteFile(pipe, Some(&payload), Some(&mut written), None) };
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            let _ = CloseHandle(pipe);
        }
    }
}

#[cfg(all(test, windows))]
mod pipe_tests {
    use super::*;
    use std::io::Read;
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn named_pipe_returns_one_bounded_json_snapshot() {
        let status = Arc::new(ServiceStatus::default());
        status.set_running(true);
        status.set_attached_port_count(1);
        let stop = Arc::new(AtomicBool::new(false));
        let worker_status = status.clone();
        let worker_stop = stop.clone();
        let pipe_name = format!(
            r"\\.\pipe\MIDIMaster.VirtualAudio.Status.test.{}",
            std::process::id()
        );
        let worker_pipe_name = pipe_name.clone();
        let worker = thread::spawn(move || {
            serve_named_pipe_at(worker_status, worker_stop, &worker_pipe_name)
        });

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut pipe = loop {
            match std::fs::OpenOptions::new().read(true).open(&pipe_name) {
                Ok(pipe) => break pipe,
                Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                Err(error) => panic!("status pipe did not become available: {error}"),
            }
        };
        let mut payload = String::new();
        pipe.read_to_string(&mut payload).unwrap();
        stop.store(true, Ordering::Release);
        worker.join().unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(payload.trim()).unwrap();
        assert_eq!(snapshot["schema_version"], 1);
        assert_eq!(snapshot["service_running"], true);
        assert_eq!(snapshot["usbip_attached"], true);
        assert_eq!(snapshot["attached_port_count"], 1);
        assert!(payload.len() < 16 * 1024);
    }
}

#[cfg(test)]
mod status_tests {
    use super::*;

    #[test]
    fn attachment_boolean_is_derived_from_the_port_count() {
        let status = ServiceStatus::default();
        let empty = status.snapshot();
        assert!(!empty.usbip_attached);
        assert_eq!(empty.attached_port_count, Some(0));

        status.set_attached_port_count(2);
        let duplicate = status.snapshot();
        assert!(!duplicate.usbip_attached);
        assert_eq!(duplicate.attached_port_count, Some(2));

        status.set_attached_port_count(1);
        let healthy = status.snapshot();
        assert!(healthy.usbip_attached);
        assert_eq!(healthy.attached_port_count, Some(1));
    }
}

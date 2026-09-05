//! Opt-in counters for the isolated USB/IP benchmark; no scheduler changes.
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

static CREATED: AtomicU64 = AtomicU64::new(0);
static ACTIVE: AtomicU64 = AtomicU64::new(0);
static PEAK: AtomicU64 = AtomicU64::new(0);
static START_DELAYS: OnceLock<Mutex<Vec<u64>>> = OnceLock::new();
static DEADLINE_LATENESS: OnceLock<Mutex<Vec<u64>>> = OnceLock::new();

fn sample(target: &OnceLock<Mutex<Vec<u64>>>, duration: Duration) {
    if let Ok(mut samples) = target.get_or_init(|| Mutex::new(Vec::new())).lock() {
        if samples.len() < 10_000 {
            samples.push(duration.as_micros() as u64);
        }
    }
}

pub(crate) struct UrbWorker;

impl UrbWorker {
    pub(crate) fn started(requested: Instant) -> Self {
        CREATED.fetch_add(1, Ordering::Relaxed);
        let active = ACTIVE.fetch_add(1, Ordering::Relaxed) + 1;
        PEAK.fetch_max(active, Ordering::Relaxed);
        sample(&START_DELAYS, requested.elapsed());
        Self
    }
}

impl Drop for UrbWorker {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::Relaxed);
    }
}

pub(crate) fn completed_wait(deadline: Instant, at: Instant) {
    sample(&DEADLINE_LATENESS, at.saturating_duration_since(deadline));
}

#[derive(Debug, Serialize)]
pub struct SchedulerSnapshot {
    pub worker_threads_created: u64,
    pub active_workers: u64,
    pub peak_active_workers: u64,
    pub worker_start_delay_us: Vec<u64>,
    pub wake_deadline_lateness_us: Vec<u64>,
}

fn samples(target: &OnceLock<Mutex<Vec<u64>>>) -> Vec<u64> {
    target
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap()
        .clone()
}

pub fn scheduler_snapshot() -> SchedulerSnapshot {
    SchedulerSnapshot {
        worker_threads_created: CREATED.load(Ordering::Relaxed),
        active_workers: ACTIVE.load(Ordering::Relaxed),
        peak_active_workers: PEAK.load(Ordering::Relaxed),
        worker_start_delay_us: samples(&START_DELAYS),
        wake_deadline_lateness_us: samples(&DEADLINE_LATENESS),
    }
}

/// Call only between isolated fixtures after their workers have finished.
pub fn reset_scheduler_metrics() {
    assert_eq!(ACTIVE.load(Ordering::Relaxed), 0);
    CREATED.store(0, Ordering::Relaxed);
    PEAK.store(0, Ordering::Relaxed);
    START_DELAYS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap()
        .clear();
    DEADLINE_LATENESS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap()
        .clear();
}

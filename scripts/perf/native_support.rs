//! Shared standalone native benchmark measurement, never linked into the app.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

struct AllocationCounter;
static COUNTING: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static ALLOCATED_BYTES: AtomicU64 = AtomicU64::new(0);

fn allocation(size: usize, pointer: *mut u8) {
    if !pointer.is_null() && COUNTING.load(Ordering::Relaxed) {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        ALLOCATED_BYTES.fetch_add(size as u64, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for AllocationCounter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        allocation(layout.size(), pointer);
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        allocation(layout.size(), pointer);
        pointer
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let pointer = unsafe { System.realloc(pointer, layout, new_size) };
        allocation(new_size, pointer);
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
    }
}

#[global_allocator]
static ALLOCATOR: AllocationCounter = AllocationCounter;

/// Warm state first. Allocation counting uses a separate pass so atomic counter
/// updates do not inflate the reported timing samples. Bytes are allocation
/// requests (including realloc), not retained memory or peak working set.
pub fn measure(
    name: &str,
    iterations: usize,
    operation_bytes: usize,
    mut operation: impl FnMut(),
) -> serde_json::Value {
    for _ in 0..3 {
        operation();
    }
    let mut durations = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        operation();
        durations.push(started.elapsed().as_nanos() as u64);
    }
    durations.sort_unstable();
    ALLOCATIONS.store(0, Ordering::Relaxed);
    ALLOCATED_BYTES.store(0, Ordering::Relaxed);
    COUNTING.store(true, Ordering::Relaxed);
    for _ in 0..iterations.min(100) {
        operation();
    }
    COUNTING.store(false, Ordering::Relaxed);
    let allocation_iterations = iterations.min(100) as f64;
    let elapsed_ns = durations.iter().sum::<u64>();
    let percentile = |fraction: f64| {
        durations[((durations.len() - 1) as f64 * fraction).ceil() as usize] as f64 / 1000.0
    };
    serde_json::json!({
        "benchmark": name, "samples": iterations, "warmup_operations": 3,
        "p50_us": percentile(0.50), "p95_us": percentile(0.95), "p99_us": percentile(0.99),
        "mean_us": elapsed_ns as f64 / iterations as f64 / 1000.0,
        "operation_bytes": operation_bytes,
        "input_bytes_per_second": (operation_bytes > 0).then(|| operation_bytes as f64 * iterations as f64 * 1e9 / elapsed_ns as f64),
        "allocation_calls_per_operation": ALLOCATIONS.load(Ordering::Relaxed) as f64 / allocation_iterations,
        "allocation_requested_bytes_per_operation": ALLOCATED_BYTES.load(Ordering::Relaxed) as f64 / allocation_iterations,
        "allocation_measurement": "separate pass; alloc/alloc_zeroed/realloc requests, not retained bytes"
    })
}

//! Narrow library surface used by local performance-audit builds.
//!
//! The shipping application remains the `midimaster` binary. Internal
//! benchmark helpers are feature-gated so they cannot become production Tauri
//! or plugin APIs.

#![cfg_attr(feature = "perf-audit", allow(dead_code))]

#[cfg(feature = "perf-audit")]
mod bindings;
#[cfg(feature = "perf-audit")]
mod durable_json_store;
#[cfg(feature = "perf-audit")]
mod midi_event_queue;
#[cfg(feature = "perf-audit")]
pub mod model;
#[cfg(feature = "perf-audit")]
mod profile_snapshot;
#[cfg(feature = "perf-audit")]
mod profile_store;
#[cfg(feature = "perf-audit")]
mod run_logger;

#[cfg(feature = "perf-audit")]
#[path = "audio/target_match.rs"]
pub mod target_match;

#[cfg(feature = "perf-audit")]
pub mod perf_bench;

//! Meter samples never enter the logical value/OSD feedback cache.
use crate::model::{Binding, BindingTarget};
use crate::{feedback, AppState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

#[cfg(test)]
mod tests;

pub const INTERVAL: Duration = Duration::from_millis(40);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioSample {
    pub target: BindingTarget,
    /// None means unavailable, distinct from a valid silent meter.
    pub level: Option<f32>,
}

pub trait AudioMeter {
    fn sample(&mut self, targets: &[BindingTarget]) -> Vec<AudioSample>;
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct MeterDemand {
    pub generation: u64,
    pub targets: Vec<BindingTarget>,
}

#[derive(Default)]
pub struct AudioFeedbackState {
    pub demand: MeterDemand,
    plugins: HashMap<String, Vec<AudioSample>>,
}

impl AudioFeedbackState {
    pub fn replace(&mut self, provider: String, generation: u64, samples: Vec<AudioSample>) {
        if generation != self.demand.generation {
            return;
        }
        let samples = samples
            .into_iter()
            .filter(|s| {
                matches!(&s.target, BindingTarget::Integration { .. })
                    && self.demand.targets.contains(&s.target)
            })
            .map(|s| AudioSample {
                target: s.target,
                level: s.level.filter(|v| v.is_finite()).map(clamp_level),
            })
            .collect();
        self.plugins.insert(provider, samples);
    }

    fn reset(&mut self, targets: Vec<BindingTarget>) {
        self.demand.generation += 1;
        self.demand.targets = targets;
        self.plugins.clear();
    }
}

pub fn clamp_level(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

pub fn binding_level(binding: &Binding, samples: &[AudioSample]) -> Option<f32> {
    samples
        .iter()
        .filter(|s| binding.normalized_targets_ref().contains(&s.target))
        .filter_map(|s| s.level)
        .map(clamp_level)
        .reduce(f32::max)
}

// Linear release reaches silence in 160 ms; no adaptive gain or beat detection.
pub fn release(previous: f32, next: f32, elapsed: Duration) -> f32 {
    clamp_level(next).max((previous - elapsed.as_secs_f32() / 0.16).max(0.0))
}

fn led_key(
    binding: &Binding,
    midi: &crate::midi::MidiManager,
) -> Option<feedback::FeedbackControlKey> {
    if !binding.has_led_feedback() {
        return None;
    }
    if !binding.led_enabled {
        return Some(feedback::binding_feedback_control_key(binding));
    }
    if let Some(control) = binding.led_feedback_control() {
        return Some(feedback::FeedbackControlKey::from_aux(control));
    }
    let control = midi.automatic_led_output(binding)?;
    Some(feedback::FeedbackControlKey {
        device_id: binding.device_id.clone(),
        channel: control.channel,
        controller: control.controller,
        msg_type: control.msg_type,
    })
}

fn refresh_held_meter(messages: &[Vec<u8>], elapsed: Duration) -> bool {
    // Mackie meters decay on the controller. Refresh nonzero held segments
    // before their 300 ms decay; Note/CC outputs still suppress duplicates.
    elapsed >= Duration::from_millis(120)
        && messages
            .iter()
            .any(|m| m.len() == 2 && m[0] == 0xD0 && m[1] & 0x0F != 0)
}

pub(crate) fn spawn(
    app: tauri::AppHandle,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut meter: Option<Box<dyn AudioMeter>> = None;
        let mut previous_profile = None;
        let mut previous_routes = Vec::new();
        let mut bindings: Vec<Binding> = Vec::new();
        let mut levels: HashMap<String, f32> = HashMap::new();
        let mut sent = HashMap::new();
        let mut last_tick = Instant::now();
        let mut last_resend = Instant::now();
        while !*shutdown.borrow() {
            let started = Instant::now();
            let elapsed = started.duration_since(last_tick);
            last_tick = started;
            let state = app.state::<AppState>();
            let profile = state.active_profile.lock().ok().and_then(|p| p.clone());
            let routes = state
                .midi
                .lock()
                .map(|m| m.active_routes())
                .unwrap_or_default();
            let changed = match (&previous_profile, &profile) {
                (Some(a), Some(b)) => !Arc::ptr_eq(a, b),
                (None, None) => false,
                _ => true,
            } || routes != previous_routes;
            if changed {
                let next: Vec<Binding> = profile
                    .as_ref()
                    .map(|p| {
                        p.bindings
                            .iter()
                            .flat_map(Binding::led_output_bindings)
                            .filter(|b| {
                                state
                                    .midi
                                    .lock()
                                    .is_ok_and(|m| m.meter_feedback_key(b, 0.0).is_some())
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let values = state
                    .feedback_values
                    .lock()
                    .map(|v| v.clone())
                    .unwrap_or_default();
                if let Ok(mut midi) = state.midi.lock() {
                    for old in &bindings {
                        let Some(key) = led_key(old, &midi) else {
                            continue;
                        };
                        if next
                            .iter()
                            .any(|b| led_key(b, &midi).as_ref() == Some(&key))
                        {
                            continue;
                        }
                        let replacement = profile.as_ref().and_then(|p| {
                            p.bindings.iter().find(|b| {
                                b.feedback_enabled
                                    && feedback::binding_feedback_control_key(b) == key
                            })
                        });
                        if let Some(current) = replacement {
                            let value = values
                                .get(&crate::bindings::BindingKey::from_binding(current))
                                .copied()
                                .unwrap_or(0.0);
                            let _ = midi.send_binding_feedback(current, value);
                        } else {
                            let _ = midi.send_binding_led_feedback(old, 0.0);
                            if let Some(current) = profile
                                .as_ref()
                                .and_then(|p| p.bindings.iter().find(|b| b.id == old.id))
                            {
                                let value = values
                                    .get(&crate::bindings::BindingKey::from_binding(current))
                                    .copied()
                                    .unwrap_or(0.0);
                                let _ = midi.send_binding_feedback(current, value);
                            }
                        }
                    }
                }
                bindings = next;
                let mut targets = Vec::new();
                for binding in bindings.iter().filter(|b| b.uses_audio_feedback()) {
                    for target in binding.normalized_targets_ref() {
                        if !targets.contains(target) {
                            targets.push(target.clone());
                        }
                    }
                }
                if let Ok(mut audio) = state.audio_feedback.lock() {
                    audio.reset(targets);
                    let _ = app.emit("audio_meter_demand", &audio.demand);
                }
                levels.clear();
                sent.clear();
                meter = None;
                previous_profile = profile;
                previous_routes = routes;
            }
            if bindings.is_empty() {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            let (targets, mut samples) = state
                .audio_feedback
                .lock()
                .map(|audio| {
                    (
                        audio.demand.targets.clone(),
                        audio
                            .plugins
                            .values()
                            .flatten()
                            .cloned()
                            .collect::<Vec<_>>(),
                    )
                })
                .unwrap_or_default();
            if targets.iter().any(|t| {
                matches!(
                    t,
                    BindingTarget::Master
                        | BindingTarget::Focus
                        | BindingTarget::Session { .. }
                        | BindingTarget::Application { .. }
                        | BindingTarget::Device { .. }
                )
            }) {
                if meter.is_none() {
                    meter = state.audio.create_meter();
                }
                if let Some(meter) = meter.as_mut() {
                    samples.extend(meter.sample(&targets));
                }
            }
            // Periodic resend also recovers a controller that reconnected silently.
            if last_resend.elapsed() >= Duration::from_secs(10) {
                sent.clear();
                last_resend = Instant::now();
            }
            let values: Vec<_> = state
                .feedback_values
                .lock()
                .map(|cache| {
                    bindings
                        .iter()
                        .map(|b| {
                            cache
                                .get(&crate::bindings::BindingKey::from_binding(b))
                                .copied()
                                .unwrap_or(0.0)
                        })
                        .collect()
                })
                .unwrap_or_default();
            if let Ok(mut midi) = state.midi.lock() {
                for (binding, value) in bindings.iter().zip(values) {
                    let level = if binding.uses_audio_feedback() {
                        let previous = levels.get(&binding.id).copied().unwrap_or(0.0);
                        binding_level(binding, &samples)
                            .map(|v| release(previous, v, elapsed))
                            .unwrap_or(0.0)
                    } else {
                        clamp_level(value)
                    };
                    levels.insert(binding.id.clone(), level);
                    let Some(bytes) = midi.meter_feedback_key(binding, level) else {
                        continue;
                    };
                    let send_due = sent.get(&binding.id).is_none_or(|(previous, at)| {
                        previous != &bytes
                            || refresh_held_meter(&bytes.1, started.duration_since(*at))
                    });
                    if send_due && midi.send_binding_led_feedback(binding, level).is_ok() {
                        sent.insert(binding.id.clone(), (bytes, started));
                    }
                }
            }
            std::thread::sleep(INTERVAL.saturating_sub(started.elapsed()));
        }
        if let Ok(mut midi) = app.state::<AppState>().midi.lock() {
            for binding in &bindings {
                let _ = midi.send_binding_led_feedback(binding, 0.0);
            }
        }
        // Dropping meter here releases every COM interface on its owning thread.
    })
}

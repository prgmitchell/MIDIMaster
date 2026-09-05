//! Local-only adapters that let Criterion exercise private production code.

use crate::bindings::BindingKey;
use crate::durable_json_store::{new_recovery_notices, DurableJsonStore};
use crate::midi_event_queue::MidiEventQueue;
use crate::model::{BindingTarget, MidiEvent, Profile};
use crate::profile_snapshot::ProfileSnapshot;
use crate::profile_store::ProfileStore;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

pub fn prepare_soundboard_source(
    mapping: &crate::model::SoundboardMapping,
) -> Result<Option<f32>, String> {
    crate::soundboard::prepare_playback_source(mapping).map(|mut source| source.next())
}

pub struct DurableProfileBench {
    store: DurableJsonStore,
}

pub struct IndexedProfileBench {
    snapshot: Arc<ProfileSnapshot>,
}

pub struct ProfileStoreBench {
    store: ProfileStore,
}

impl ProfileStoreBench {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            store: ProfileStore::with_recovery_notices(config_dir, new_recovery_notices()),
        }
    }

    pub fn save(&self, profile: Profile) -> anyhow::Result<()> {
        self.store.save_profile(profile)
    }
}

impl IndexedProfileBench {
    pub fn new(profile: Profile) -> Self {
        Self {
            snapshot: Arc::new(ProfileSnapshot::new(profile)),
        }
    }

    pub fn clone_handle(&self) {
        std::hint::black_box(self.snapshot.clone());
    }

    pub fn lookup_events(&self, events: &[MidiEvent]) -> usize {
        events
            .iter()
            .filter(|event| {
                self.snapshot
                    .find_binding(&BindingKey::from_event(event), true)
                    .is_some()
            })
            .count()
    }
}

impl DurableProfileBench {
    pub fn new(path: PathBuf) -> Self {
        Self {
            store: DurableJsonStore::new(path, "performance_profiles", new_recovery_notices()),
        }
    }

    pub fn save(&self, profiles: &[Profile]) -> anyhow::Result<()> {
        self.store.save(&profiles.to_vec())
    }
}

pub fn deserialize_profile(bytes: &[u8]) -> serde_json::Result<Profile> {
    serde_json::from_slice(bytes)
}

pub fn clone_profile(profile: &Profile) -> Profile {
    profile.clone()
}

pub fn count_integration_targets(profile: &Profile) -> usize {
    profile
        .bindings
        .iter()
        .flat_map(|binding| binding.normalized_targets_ref().iter())
        .filter(|target| matches!(target, BindingTarget::Integration { .. }))
        .count()
}

pub fn enqueue_and_drain(events: &[MidiEvent]) -> usize {
    let mut queue = MidiEventQueue::new(256, 512);
    for event in events {
        queue.enqueue(event.clone());
    }
    queue.drain().len()
}

pub fn prepare_feedback_state(profile: &Profile) -> usize {
    let mut binding_indexes = HashMap::with_capacity(profile.bindings.len());
    let mut target_count = 0usize;
    for (index, binding) in profile.bindings.iter().enumerate() {
        binding_indexes.insert(binding.id.as_str(), index);
        target_count += binding.normalized_targets_ref().len();
    }
    binding_indexes.len() + target_count
}

pub fn enqueue_log_records(record_count: usize) {
    static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
    let log_dir = LOG_DIR.get_or_init(|| {
        let path = std::env::temp_dir().join(format!(
            "midimaster-criterion-log-{}",
            uuid::Uuid::new_v4().simple()
        ));
        crate::run_logger::init(&path).expect("initialize benchmark logger");
        path
    });
    std::hint::black_box(log_dir);
    for index in 0..record_count {
        crate::run_logger::info(
            "perf_bench",
            "queue_record",
            &format!("sequence={index} value={}", index % 128),
        );
    }
}

use criterion::{
    black_box, criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion, Throughput,
};
use midimaster::model::{MidiEvent, MidiMessageType, Profile};
use midimaster::perf_bench::{
    clone_profile, count_integration_targets, deserialize_profile, enqueue_and_drain,
    enqueue_log_records, prepare_feedback_state, DurableProfileBench, IndexedProfileBench,
    ProfileStoreBench,
};
use midimaster::target_match::{application_name_matches, ApplicationMatchInfo};
use serde_json::json;

fn fixture_profile(binding_count: usize, icon_bytes: usize) -> Profile {
    let icon_data = format!("data:image/png;base64,{}", "A".repeat(icon_bytes));
    let bindings = (0..binding_count)
        .map(|index| {
            json!({
                "id": format!("binding-{index}"),
                "name": format!("Binding {index}"),
                "device_id": "perf-midi",
                "control": {
                    "channel": (index % 16),
                    "controller": (index % 120),
                    "msg_type": "ControlChange"
                },
                "control_kind": "Continuous",
                "targets": [{
                    "Integration": {
                        "integration_id": "perf-plugin",
                        "kind": "channel",
                        "data": {
                            "identifier": format!("channel-{index}"),
                            "label": format!("Channel {index}"),
                            "icon_data": icon_data
                        }
                    }
                }],
                "action": "Volume",
                "mode": "Absolute",
                "deadzone": 0.0,
                "debounce_ms": 0
            })
        })
        .collect::<Vec<_>>();

    serde_json::from_value(json!({
        "name": "Performance fixture",
        "bindings": bindings
    }))
    .expect("valid profile fixture")
}

fn profile_benchmarks(c: &mut Criterion) {
    let mut group = c.benchmark_group("profile");
    group.sample_size(20);
    for (bindings, icon_bytes) in [(50, 0), (50, 12_000), (250, 0)] {
        let profile = fixture_profile(bindings, icon_bytes);
        let encoded = serde_json::to_vec(&profile).expect("serialize fixture");
        group.throughput(Throughput::Bytes(encoded.len() as u64));
        let id = format!("bindings-{bindings}-icon-{icon_bytes}");
        group.bench_with_input(
            BenchmarkId::new("deserialize", &id),
            &encoded,
            |b, bytes| {
                b.iter(|| deserialize_profile(black_box(bytes)).expect("profile"));
            },
        );
        group.bench_with_input(BenchmarkId::new("clone", &id), &profile, |b, value| {
            b.iter(|| clone_profile(black_box(value)));
        });
        group.bench_with_input(
            BenchmarkId::new("target_traversal", &id),
            &profile,
            |b, value| {
                b.iter(|| black_box(count_integration_targets(black_box(value))));
            },
        );
        let lookup_events = (0..bindings)
            .map(|index| cc((index % 120) as u8, (index % 126 + 1) as u8))
            .collect::<Vec<_>>();
        let lookup_index = IndexedProfileBench::new(profile.clone());
        group.bench_with_input(
            BenchmarkId::new("indexed_binding_lookup", &id),
            &lookup_index,
            |b, index| {
                b.iter(|| black_box(index.lookup_events(black_box(&lookup_events))));
            },
        );
        group.bench_with_input(
            BenchmarkId::new("active_snapshot_clone", &id),
            &lookup_index,
            |b, index| b.iter(|| index.clone_handle()),
        );
        group.bench_with_input(
            BenchmarkId::new("feedback_state_snapshot", &id),
            &profile,
            |b, value| {
                b.iter(|| black_box(prepare_feedback_state(black_box(value))));
            },
        );
    }
    group.finish();
}

fn cc(controller: u8, value: u8) -> MidiEvent {
    MidiEvent {
        device_id: "perf-midi".to_string(),
        channel: 0,
        controller,
        value,
        value_14: None,
        msg_type: MidiMessageType::ControlChange,
    }
}

fn queue_benchmarks(c: &mut Criterion) {
    let mut group = c.benchmark_group("midi_queue");
    group.sample_size(20);
    for event_count in [125usize, 500, 1_000] {
        group.throughput(Throughput::Elements(event_count as u64));
        group.bench_with_input(
            BenchmarkId::new("enqueue_and_drain", event_count),
            &event_count,
            |b, &count| {
                let events = (0..count)
                    .map(|index| cc((index % 16) as u8, (index % 126 + 1) as u8))
                    .collect::<Vec<_>>();
                b.iter(|| black_box(enqueue_and_drain(black_box(&events))));
            },
        );
    }
    group.finish();
}

fn storage_benchmarks(c: &mut Criterion) {
    let mut group = c.benchmark_group("durable_profile_store");
    group.sample_size(10);
    for (bindings, icon_bytes) in [(50, 0), (50, 12_000)] {
        let profile = fixture_profile(bindings, icon_bytes);
        let payload_bytes = serde_json::to_vec(&vec![profile.clone()])
            .expect("serialize fixture")
            .len();
        let benchmark_dir = std::env::temp_dir().join(format!(
            "midimaster-criterion-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&benchmark_dir).expect("create benchmark directory");
        let store = DurableProfileBench::new(benchmark_dir.join("profiles.json"));
        let compacted_store = ProfileStoreBench::new(benchmark_dir.join("compacted"));
        group.throughput(Throughput::Bytes(payload_bytes as u64));
        let id = format!("bindings-{bindings}-icon-{icon_bytes}");
        group.bench_function(BenchmarkId::new("durable_save", id), |b| {
            b.iter_batched(
                || vec![profile.clone()],
                |profiles| store.save(black_box(&profiles)).expect("durable save"),
                BatchSize::SmallInput,
            );
        });
        let compacted_id = format!("bindings-{bindings}-icon-{icon_bytes}");
        group.bench_function(
            BenchmarkId::new("compacted_profile_save", compacted_id),
            |b| {
                b.iter_batched(
                    || profile.clone(),
                    |profile| {
                        compacted_store
                            .save(black_box(profile))
                            .expect("compacted save")
                    },
                    BatchSize::SmallInput,
                );
            },
        );
        std::fs::remove_dir_all(&benchmark_dir).expect("remove benchmark directory");
    }
    group.finish();
}

fn audio_target_benchmarks(c: &mut Criterion) {
    let candidates = (0..64)
        .map(|index| {
            (
                format!("C:\\Apps\\Application{index}.exe"),
                format!("Application{index}.exe"),
                format!("Application {index}"),
            )
        })
        .collect::<Vec<_>>();
    c.bench_function("audio_target_match/64_sessions", |b| {
        b.iter(|| {
            let matches = candidates
                .iter()
                .filter(|(path, process_name, display_name)| {
                    application_name_matches(
                        black_box("Application 63"),
                        ApplicationMatchInfo {
                            process_path: Some(path),
                            process_name: Some(process_name),
                            display_name: Some(display_name),
                            ..Default::default()
                        },
                    )
                })
                .count();
            black_box(matches)
        });
    });
}

fn logging_benchmarks(c: &mut Criterion) {
    let mut group = c.benchmark_group("logging");
    group.sample_size(20);
    for records in [1usize, 100, 1_000] {
        group.throughput(Throughput::Elements(records as u64));
        group.bench_with_input(
            BenchmarkId::new("bounded_async_enqueue", records),
            &records,
            |b, &count| b.iter(|| enqueue_log_records(black_box(count))),
        );
    }
    group.finish();
}

criterion_group!(
    benches,
    profile_benchmarks,
    queue_benchmarks,
    storage_benchmarks,
    audio_target_benchmarks,
    logging_benchmarks
);
criterion_main!(benches);

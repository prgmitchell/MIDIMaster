use super::*;

fn event(value: u8, value_14: Option<u16>) -> MidiEvent {
    MidiEvent {
        device_id: "perf-midi-input".into(),
        channel: 0,
        controller: 1,
        value,
        value_14,
        msg_type: if value_14.is_some() {
            MidiMessageType::PitchBend
        } else {
            MidiMessageType::ControlChange
        },
    }
}

fn applied(at: Instant) -> ActionTrace {
    ActionTrace {
        requested: 1,
        applied: 1,
        last_applied: Some(at),
        ..Default::default()
    }
}

#[test]
fn empty_timings_are_unavailable_not_successful_zero_measurements() {
    let snapshot = NativeActionMetrics::default().snapshot();
    assert_eq!(snapshot.native_action.samples, 0);
    assert_eq!(snapshot.native_action.p95_us, None);
    assert!(!snapshot.latest_value.converged);
    assert_eq!(percentile(&[10, 20, 30, 40], 0.50), Some(30));
}

#[test]
fn dequeued_unmatched_ignored_and_failed_events_cannot_certify_applied_output() {
    for (trace, failed, expected_noops, expected_errors) in [
        (ActionTrace::default(), false, 1, 0), // Unmatched or ignored by a binding.
        (ActionTrace::default(), true, 0, 1),  // Handler returns an error.
        (
            ActionTrace {
                requested: 1,
                errors: 1,
                ..Default::default()
            },
            false,
            0,
            1,
        ), // Native target failure is swallowed by routing.
    ] {
        let mut metrics = NativeActionMetrics::default();
        let at = Instant::now();
        let token = metrics.enqueue(&event(42, None), at);
        metrics.dispatch(&token, at + Duration::from_micros(10));
        metrics.finish(&token, trace, Duration::from_micros(20), failed);
        let snapshot = metrics.snapshot();
        assert!(snapshot.dispatched_value.converged);
        assert!(!snapshot.latest_value.converged);
        assert_eq!(snapshot.native_action.samples, 0);
        assert_eq!(snapshot.native_processing.samples, 1);
        assert_eq!(snapshot.action_outcomes.noop, expected_noops);
        assert_eq!(snapshot.action_outcomes.errors, expected_errors);
    }
}

#[test]
fn plugin_dispatch_and_partial_execution_are_not_local_applied_samples() {
    for trace in [
        ActionTrace {
            requested: 1,
            dispatched: 1,
            ..Default::default()
        },
        ActionTrace {
            requested: 2,
            dispatched: 1,
            ..applied(Instant::now())
        },
        ActionTrace {
            requested: 2,
            ..applied(Instant::now())
        },
        ActionTrace {
            unverified: true,
            ..applied(Instant::now())
        },
    ] {
        let mut metrics = NativeActionMetrics::default();
        let token = metrics.enqueue(&event(42, None), Instant::now());
        metrics.dispatch(&token, Instant::now());
        metrics.finish(&token, trace, Duration::from_micros(5), false);
        assert!(!metrics.snapshot().latest_value.converged);
        assert_eq!(metrics.snapshot().native_action.samples, 0);
    }
}

#[test]
fn profile_mutation_outcomes_do_not_claim_target_application() {
    for (scenario, published, failed, expected) in [
        ("published assignment", true, false, (1, 0, 0)),
        ("unchanged assignment", false, false, (0, 1, 0)),
        ("assignment release", false, false, (0, 1, 0)),
        ("failed persistence", false, true, (0, 0, 1)),
    ] {
        let mut metrics = NativeActionMetrics::default();
        let token = metrics.enqueue(&event(127, None), Instant::now());
        ACTIVE_ACTION.with(|active| *active.borrow_mut() = Some(ActionTrace::default()));
        if published {
            record_unverified_action();
        }
        let trace = ACTIVE_ACTION
            .with(|active| active.borrow_mut().take())
            .unwrap();
        metrics.finish(&token, trace, Duration::from_micros(20), failed);
        let snapshot = metrics.snapshot();
        let outcomes = snapshot.action_outcomes;
        assert_eq!(
            (outcomes.unverified, outcomes.noop, outcomes.errors),
            expected,
            "{scenario}"
        );
        assert_eq!(outcomes.applied_targets, 0, "{scenario}");
        assert_eq!(outcomes.applied, 0, "{scenario}");
        assert_eq!(snapshot.native_action.samples, 0, "{scenario}");
        assert_eq!(snapshot.native_action.p95_us, None, "{scenario}");
        assert!(!snapshot.latest_value.converged, "{scenario}");
        assert_eq!(snapshot.native_processing.samples, 1, "{scenario}");
    }
}

#[test]
fn applied_latency_stops_at_target_success_while_processing_includes_later_work() {
    let mut metrics = NativeActionMetrics::default();
    let at = Instant::now();
    let token = metrics.enqueue(&event(42, None), at);
    metrics.dispatch(&token, at + Duration::from_micros(10));
    metrics.finish(
        &token,
        applied(at + Duration::from_micros(30)),
        Duration::from_micros(200),
        false,
    );
    let snapshot = metrics.snapshot();
    assert!(snapshot.latest_value.converged);
    assert_eq!(snapshot.native_action.p95_us, Some(30));
    assert_eq!(snapshot.queue_dispatch.p95_us, Some(10));
    assert_eq!(snapshot.native_processing.p95_us, Some(200));
    assert_eq!(snapshot.action_outcomes.applied, 1);
}

#[test]
fn value_convergence_retains_fourteen_bits_and_allows_legitimate_same_value_noops() {
    let mut metrics = NativeActionMetrics::default();
    let first = metrics.enqueue(&event(1, Some(128)), Instant::now());
    let second = metrics.enqueue(&event(1, Some(129)), Instant::now());
    metrics.finish(&first, applied(Instant::now()), Duration::ZERO, false);
    assert_eq!(metrics.snapshot().latest_value.mismatches, 1);
    metrics.finish(&second, applied(Instant::now()), Duration::ZERO, false);
    assert!(metrics.snapshot().latest_value.converged);
    let third = metrics.enqueue(&event(1, Some(129)), Instant::now());
    // A repeated identical input can be ignored by normal runtime filtering;
    // the requested output is already present, but queue dispatch stays separate.
    assert!(metrics.snapshot().latest_value.converged);
    assert!(!metrics.snapshot().dispatched_value.converged);
    metrics.finish(&third, applied(Instant::now()), Duration::ZERO, false);
    assert!(metrics.snapshot().latest_value.converged);
}

#[test]
fn prior_run_completion_does_not_pollute_a_reset_run() {
    let mut metrics = NativeActionMetrics::default();
    let old = metrics.enqueue(&event(42, None), Instant::now());
    metrics = NativeActionMetrics {
        generation: 1,
        ..Default::default()
    };
    metrics.dispatch(&old, Instant::now());
    metrics.finish(&old, applied(Instant::now()), Duration::ZERO, false);
    assert_eq!(metrics.snapshot().action_outcomes.processed, 0);
    assert_eq!(metrics.snapshot().queue_dispatch.samples, 0);
}

#[test]
fn queue_entries_keep_tokens_through_coalescing_overflow_and_newer_enqueues() {
    let mut queue = crate::midi_event_queue::MidiEventQueue::new(1, 1);
    queue.enqueue(event(1, Some(128)));
    queue.enqueue(event(1, Some(129)));
    let mut first_batch = queue.drain_audited();
    queue.enqueue(event(1, Some(130)));
    let (first_event, first_token) = first_batch.remove(0);
    let (second_event, second_token) = queue.drain_audited().remove(0);
    assert_eq!(first_event.value_14, Some(129));
    assert_eq!(first_token.input.value_14, first_event.value_14);
    assert_eq!(second_token.input.value_14, second_event.value_14);
    assert!(first_token.input.sequence < second_token.input.sequence);
    let note = MidiEvent {
        msg_type: MidiMessageType::Note,
        ..event(127, None)
    };
    queue.enqueue(note.clone());
    queue.enqueue(MidiEvent { value: 0, ..note });
    assert_eq!(queue.audit_snapshot().dropped, 1);
    let (kept, token) = queue.drain_audited().remove(0);
    assert_eq!(kept.value, 127);
    assert_eq!(token.input.value, 127);
}

#[test]
fn synthetic_sink_exposes_applied_values_with_input_identity_and_tags_real_result_payloads() {
    let mut metrics = NativeActionMetrics::default();
    let token = metrics.enqueue(&event(64, None), Instant::now());
    ACTIVE_ACTION.with(|active| {
        *active.borrow_mut() = Some(ActionTrace {
            requested: 1,
            identity: Some(token.identity()),
            enqueued_at: Some(token.at),
            ..Default::default()
        })
    });
    record_synthetic_target("binding", "channel", "Volume", 64.0 / 127.0);
    let mut payload = serde_json::json!({"volume": 64.0 / 127.0});
    annotate_result_payload(&mut payload);
    assert_eq!(payload["perf_audit"]["sequence"], token.input.sequence);
    assert_eq!(payload["perf_audit"]["applied"], true);
    let trace = ACTIVE_ACTION
        .with(|active| active.borrow_mut().take())
        .unwrap();
    metrics.finish(&token, trace, Duration::ZERO, false);
    let snapshot = metrics.snapshot();
    assert!(snapshot.latest_value.converged);
    assert_eq!(snapshot.synthetic_targets.len(), 1);
    assert_eq!(
        snapshot.synthetic_targets[0].input.as_ref().unwrap().value,
        64
    );
    assert_eq!(snapshot.synthetic_targets[0].value, 64.0 / 127.0);
    let mut outside_scope = serde_json::json!({"volume":0.5});
    annotate_result_payload(&mut outside_scope);
    assert!(outside_scope.get("perf_audit").is_none());
}

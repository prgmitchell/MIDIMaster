import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizedRecords, midiCollectionExpression, validateMidiResult, runMidiJourney } from "../run-midi-cdp.mjs";
import { collectMidiInRenderer, midiQueueSettled } from "../lib/midi-collection.mjs";
import { expectedSyntheticTargets } from "../lib/midi-validation.mjs";

const durations = samples => ({ samples, p50_us: samples ? 100 : null, p95_us: samples ? 200 : null,
  p99_us: samples ? 300 : null, max_us: samples ? 400 : null });
const convergence = (controls, mismatches = 0) => ({ controls, mismatches, converged: controls > 0 && mismatches === 0 });
const target = (controller, value, sequence, inputValue, action = "Volume") => ({
  binding_id: `perf-binding-${controller}`, target_id: `channel-${controller}`, action, value,
  input: { sequence, value: inputValue, value_14: null },
});

function fixtureResult({ kind = "continuous", messages = 4, controls = 1, applied = 4, noop = 0,
  targets = [target(1, 4 / 127, 3, 4)] } = {}) {
  return {
    injection: { message_count: messages, control_count: controls, rate_per_second: 125,
      message_kind: kind, scheduled_duration_us: 32000 },
    snapshot: {
      schema_version: 2, run_id: "native-run", scenario_id: "fixture-scenario", variant: "current",
      queue: { enqueued: messages, drained: messages, coalesced: 0, dropped: 0, pending_continuous: 0, pending_preserved: 0 },
      native_action: durations(applied), native_processing: durations(messages), queue_dispatch: durations(messages),
      latest_value: convergence(controls, kind === "button" ? controls : 0), dispatched_value: convergence(controls),
      action_outcomes: { processed: messages, applied, dispatched: 0, noop, errors: 0, unverified: 0,
        applied_targets: applied, dispatched_targets: 0, failed_targets: 0 },
      synthetic_targets_enabled: true, synthetic_targets: targets,
    },
    frontend: { entries: [], renderedValues: targets.map(item => ({ bindingId: item.binding_id, value: Math.round(item.value * 100) / 100, sequence: item.input.sequence })) },
    renderer_frames_completed: true,
  };
}

test("renderer verification rejects an adjacent stale slider step with a newer sequence", () => {
  const result = fixtureResult({ messages: 6, applied: 6, targets: [target(1, 6 / 127, 5, 6)] });
  result.frontend.renderedValues[0].value = 0.04;
  assert.throws(() => validateMidiResult(result, { requireRenderer: true }), /Renderer final value did not complete/);
  result.frontend.renderedValues[0].value = 0.05;
  assert.equal(validateMidiResult(result, { requireRenderer: true }).renderer_controls_checked, 1);
});

test("normalization preserves measured zero but never manufactures missing values", () => {
  const result = fixtureResult();
  result.snapshot.native_action = { samples: 0, p50_us: null, p95_us: null, p99_us: null };
  result.snapshot.queue.pending_preserved = null;
  result.snapshot.queue.dropped = null;
  result.injection.scheduled_duration_us = null;
  result.snapshot.native_processing.p50_us = 0;
  result.snapshot.native_processing.p95_us = null;
  const records = normalizedRecords(result.snapshot, result.injection, result.frontend);
  const byMetric = new Map(records.map(record => [record.metric, record.value]));
  assert.equal(byMetric.get("midi.native_action_samples"), 0);
  assert.equal(byMetric.get("midi.native_processing_p50"), 0);
  assert.equal(byMetric.get("midi.native_processing_max"), 0.4, "rare stalls remain visible alongside percentiles");
  for (const metric of ["native_action_p50", "native_processing_p95", "queue_depth", "events_dropped", "injection_duration"]) {
    assert.equal(byMetric.has(`midi.${metric}`), false, metric);
  }
  assert.ok(records.every(record => typeof record.value === "number" && Number.isFinite(record.value)));
});

test("legacy dispatch timing cannot be presented as verified applied timing", () => {
  const result = fixtureResult();
  result.snapshot.schema_version = 1;
  result.frontend.entries.push({ kind: "operation", name: "midi-visible-update", durationMs: 12 });
  const records = normalizedRecords(result.snapshot, result.injection, result.frontend);
  assert.ok(records.some(record => record.metric === "legacy.midi.native_action_samples"));
  assert.ok(records.some(record => record.metric === "legacy.midi.native_action_p95"));
  assert.ok(!records.some(record => ["midi.native_action_samples", "midi.native_action_p95", "midi.visible_update"].includes(record.metric)));
  assert.throws(() => validateMidiResult(result), /schema 2/);
});

test("dispatch-only results retain zero application counts and do not pass synthetic gates", () => {
  const result = fixtureResult();
  result.snapshot.synthetic_targets_enabled = false;
  result.snapshot.synthetic_targets = [];
  result.snapshot.native_action = durations(0);
  result.snapshot.latest_value = convergence(1, 1);
  Object.assign(result.snapshot.action_outcomes, { applied: 0, applied_targets: 0, dispatched: 4, dispatched_targets: 4 });
  const validation = validateMidiResult(result);
  assert.equal(validation.applied, 0);
  assert.equal(validation.dispatched, 4);
  assert.equal(validation.synthetic_targets_checked, 0);
  const records = normalizedRecords(result.snapshot, result.injection, result.frontend);
  assert.equal(records.find(record => record.metric === "midi.latest_applied_controls").value, 0);
  assert.ok(!records.some(record => record.metric === "midi.applied_controls" || record.metric === "midi.native_action_p95"));
  assert.throws(() => validateMidiResult(result, { requireSynthetic: true }), /sink was not enabled/);
});

test("expected synthetic values distinguish button toggle parity from raw input", () => {
  const button = expectedSyntheticTargets({ message_count: 34, control_count: 16, message_kind: "button" });
  assert.deepEqual(button.slice(0, 3).map(({ binding_id, value, sequence, applied, noop }) => ({ binding_id, value, sequence, applied, noop })), [
    { binding_id: "perf-binding-4", value: 0, sequence: 32, applied: 2, noop: 1 },
    { binding_id: "perf-binding-12", value: 0, sequence: 33, applied: 2, noop: 1 },
    { binding_id: "perf-binding-20", value: 1, sequence: 2, applied: 1, noop: 1 },
  ]);
  assert.deepEqual(expectedSyntheticTargets({ message_count: 4, control_count: 1, message_kind: "action" })
    .map(({ value, sequence, action }) => ({ value, sequence, action })), [{ value: 0, sequence: 3, action: "ToggleEffect" }]);
  assert.equal(expectedSyntheticTargets({ message_count: 2, control_count: 16, message_kind: "continuous" }).length, 2);
});

test("correct button releases are noops while every press and final toggle is verified", () => {
  const result = fixtureResult({ kind: "button", applied: 2, noop: 2, targets: [target(4, 0, 2, 127, "ToggleEffect")] });
  assert.equal(result.snapshot.latest_value.converged, false);
  assert.equal(validateMidiResult(result).synthetic_targets_checked, 1);
  result.snapshot.synthetic_targets[0].value = 1;
  assert.throws(() => validateMidiResult(result), /target value mismatch/);
  result.snapshot.synthetic_targets[0].value = 0;
  result.snapshot.synthetic_targets[0].input.sequence = 3;
  assert.throws(() => validateMidiResult(result), /input identity mismatch/);
});

test("isolated button samples reject delayed profile saves even when final toggle parity is correct", () => {
  const result = fixtureResult({ kind: "button", applied: 2, noop: 2, targets: [target(4, 0, 2, 127, "ToggleEffect")] });
  // A request started before the collector reset can still complete inside the
  // new sample; filtering only by IPC start time would miss the original race.
  result.frontend.entries.push({ kind: "ipc", name: "save_profile", startTimeMs: 1, durationMs: 900, ok: true });
  assert.equal(validateMidiResult(result).synthetic_targets_checked, 1);
  assert.throws(() => validateMidiResult(result, { requireStableProfile: true }), /overlapped.*save_profile/);
});

test("isolated MIDI samples reject successful and failed profile or connection mutations", () => {
  for (const name of ["save_profile", "load_profile", "delete_profile", "add_binding", "remove_binding",
    "stop_midi_device", "stop_midi_route", "start_midi_device", "start_midi_device_routes"]) {
    for (const ok of [true, false]) {
      const result = fixtureResult();
      result.frontend.entries.push({ kind: "ipc", name, ok, startTimeMs: 100, durationMs: 12 });
      assert.throws(() => validateMidiResult(result, { requireStableProfile: true }),
        new RegExp(`overlapped.*${name}`));
    }
  }
});

test("profile stability requires capture but permits read-only IPC and normal MIDI observations", () => {
  const result = fixtureResult();
  result.frontend.entries.push(
    ...["list_profiles", "get_active_profile", "list_midi_devices", "get_midi_route_health", "perf_audit_snapshot"]
      .map(name => ({ kind: "ipc", name, ok: true, startTimeMs: 100, durationMs: 2 })),
    { kind: "operation", name: "midi-visible-update", durationMs: 10 },
  );
  assert.equal(validateMidiResult(result, { requireStableProfile: true }).profile_stability_checked, true);
  assert.equal(validateMidiResult(result).profile_stability_checked, undefined);
  for (const frontend of [null, {}, { entries: null }, { entries: {} }]) {
    result.frontend = frontend;
    assert.throws(() => validateMidiResult(result, { requireStableProfile: true }), /requires captured frontend entries/);
  }
});

test("concurrent-save validation remains opt-in and preserves raw IPC evidence", () => {
  const result = fixtureResult();
  const entry = { kind: "ipc", name: "save_profile", ok: true, startTimeMs: 100, durationMs: 25 };
  result.frontend.entries.push(entry);
  const before = structuredClone(result);
  assert.equal(validateMidiResult(result, { requireSynthetic: true, requireRenderer: false }).applied, 4);
  assert.equal(validateMidiResult(result, { requireStableProfile: false }).applied, 4);
  assert.deepEqual(result, before);
});

test("all sixteen preserved controls have independent press/release accounting", () => {
  const targets = Array.from({ length: 16 }, (_, control) => target(control * 8 + 4,
    control < 2 ? 0 : 1, control < 2 ? control + 32 : control, 127, "ToggleEffect"));
  const result = fixtureResult({ kind: "button", messages: 34, controls: 16, applied: 18, noop: 16, targets });
  result.snapshot.latest_value = convergence(16, 14);
  assert.equal(validateMidiResult(result).synthetic_targets_checked, 16);
  result.snapshot.synthetic_targets[5].input.sequence += 16;
  assert.throws(() => validateMidiResult(result), /input identity mismatch/);
});

test("repeated ProgramChange pulses are all applied even when the final toggle is off", () => {
  const result = fixtureResult({ kind: "action", targets: [target(0, 0, 3, 127, "ToggleEffect")] });
  assert.equal(validateMidiResult(result).applied, 4);
  Object.assign(result.snapshot.action_outcomes, { applied: 3, applied_targets: 3, noop: 1 });
  result.snapshot.native_action = durations(3);
  assert.throws(() => validateMidiResult(result), /press\/release action counts/);
});

test("continuous sink values and identities are checked independently from convergence flags", () => {
  const changes = [
    [result => { result.snapshot.synthetic_targets[0].value = 0.5; }, /value mismatch/],
    [result => { result.snapshot.synthetic_targets[0].target_id = "channel-9"; }, /identity\/action mismatch/],
    [result => { result.snapshot.synthetic_targets[0].input.value_14 = 256; }, /input identity mismatch/],
    [result => { result.snapshot.synthetic_targets[0].input.value = 5; }, /applied input mismatch/],
    [result => { result.snapshot.synthetic_targets = []; }, /coverage/],
  ];
  for (const [change, error] of changes) {
    const result = fixtureResult();
    change(result);
    assert.throws(() => validateMidiResult(result), error);
  }
});

test("correct synthetic output does not hide inconsistent continuous applied-input accounting", () => {
  const result = fixtureResult();
  result.snapshot.latest_value = convergence(1, 1);
  assert.throws(() => validateMidiResult(result), /continuous applied-input values did not converge/);
});

test("coalescing a complete continuous cycle may finish at an already applied value", () => {
  const result = fixtureResult({ messages: 127, applied: 1, noop: 1, targets: [target(1, 1 / 127, 0, 1)] });
  Object.assign(result.snapshot.queue, { drained: 2, coalesced: 125 });
  result.snapshot.action_outcomes.processed = 2;
  result.snapshot.native_processing = durations(2);
  result.snapshot.queue_dispatch = durations(2);
  assert.equal(validateMidiResult(result, { requireRenderer: true }).renderer_controls_checked, 1);
});

test("missing, unprocessed, dropped, or misclassified work cannot pass correctness gates", () => {
  const changes = [
    [result => { result.snapshot.queue.pending_preserved = null; }, /queue pending_preserved/],
    [result => { result.snapshot.action_outcomes.processed = 3; }, /not settled/],
    [result => { result.snapshot.queue.coalesced = 1; }, /accounting/],
    [result => { result.snapshot.action_outcomes.noop = 1; }, /outcome counts/],
    [result => { result.snapshot.action_outcomes.failed_targets = 1; }, /failed or could not/],
    [result => { result.snapshot.dispatched_value = convergence(1, 1); }, /reach the dispatcher/],
    [result => { result.snapshot.latest_value = convergence(2); }, /control coverage/],
    [result => { result.snapshot.native_action.p50_us = null; }, /native_action.p50_us/],
    [result => { result.snapshot.native_action.samples = 0; }, /zero samples/],
    [result => { result.snapshot.native_processing = durations(0); }, /samples do not match/],
  ];
  for (const [change, error] of changes) {
    const result = fixtureResult();
    change(result);
    assert.throws(() => validateMidiResult(result), error);
  }
});

test("visible continuous collection requires final rendered values for every affected control", () => {
  assert.equal(validateMidiResult(fixtureResult(), { requireRenderer: true }).renderer_controls_checked, 1);
  for (const change of [
    result => { delete result.renderer_frames_completed; },
    result => { result.frontend.renderedValues = []; },
    result => { result.frontend.renderedValues[0].sequence = 2; },
    result => { result.frontend.renderedValues[0].value = 0.5; },
  ]) {
    const result = fixtureResult();
    change(result);
    assert.throws(() => validateMidiResult(result, { requireRenderer: true }), /Renderer/);
  }
});

function collectionHarness({ stuckFrames = false, stuckAfterInjection = false, stuckQueue = false, dirtyReset = false, missingQueueField = false } = {}) {
  const log = [];
  const timers = new Map();
  let clock = 0;
  let nextTimer = 0;
  let phase = "previous";
  let pending = true;
  let passes = 0;
  const result = fixtureResult();
  const empty = () => ({ schema_version: 2,
    queue: { enqueued: 0, drained: 0, coalesced: 0, dropped: 0, pending_continuous: 0, pending_preserved: 0 },
    action_outcomes: { processed: 0 } });
  const environment = {
    performance: { now: () => clock },
    setTimeout(callback, ms) {
      const id = ++nextTimer;
      timers.set(id, callback);
      // Queue polling advances the clock; renderer watchdogs remain cancellable.
      if (ms === 50 || stuckFrames || (stuckAfterInjection && phase === "injected")) queueMicrotask(() => {
        if (timers.delete(id)) { clock += ms; callback(); }
      });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) {
      const id = ++nextTimer;
      if (!stuckFrames && !(stuckAfterInjection && phase === "injected")) queueMicrotask(() => { clock += 16; log.push("frame"); callback(clock); });
      return id;
    },
    cancelAnimationFrame() { log.push("cancel-frame"); },
    __MIDIMASTER_PERF__: {
      reset() { log.push("frontend-reset"); },
      snapshot() { log.push("frontend-snapshot"); return { ...result.frontend, sample: passes }; },
    },
    __TAURI__: { core: { async invoke(command, options) {
      log.push(command);
      if (command === "perf_audit_reset") { phase = "reset"; return; }
      if (command === "perf_audit_inject_midi") {
        assert.deepEqual({ ...options }, { messageCount: 4, ratePerSecond: 125, controlCount: 1, messageKind: "continuous" });
        phase = "injected"; pending = true; passes++;
        return result.injection;
      }
      if (phase === "previous" || phase === "injected") {
        const snapshot = phase === "previous" ? empty() : structuredClone(result.snapshot);
        if (pending || stuckQueue) { snapshot.queue.pending_continuous = 1; pending = false; }
        if (missingQueueField) delete snapshot.queue.pending_preserved;
        return snapshot;
      }
      const reset = empty();
      if (dirtyReset) reset.queue.enqueued = 1;
      return reset;
    } } },
  };
  return { environment, log, timers };
}

const collectionOptions = { messageCount: 4, ratePerSecond: 125, controlCount: 1, messageKind: "continuous", timeoutMs: 500 };

test("serialized collector waits for previous and current work and isolates repeated samples", async () => {
  const { environment, log, timers } = collectionHarness();
  const first = await vm.runInNewContext(midiCollectionExpression(collectionOptions), environment);
  assert.equal(first.renderer_frames_completed, true);
  assert.deepEqual(log.slice(0, 8), ["perf_audit_snapshot", "perf_audit_snapshot", "frame", "frame",
    "perf_audit_reset", "frontend-reset", "perf_audit_snapshot", "perf_audit_inject_midi"]);
  assert.equal(log.filter(value => value === "frame").length, 4);
  assert.equal(log.at(-1), "frontend-snapshot");
  assert.equal(timers.size, 0);
  const second = await collectMidiInRenderer(collectionOptions, environment);
  assert.equal(first.frontend.sample, 1);
  assert.equal(second.frontend.sample, 2);
  assert.equal(log.filter(value => value === "perf_audit_reset").length, 2);
  assert.equal(log.filter(value => value === "frontend-reset").length, 2);
});

test("collector rejects renderer timeouts instead of silently returning an incomplete sample", async () => {
  const { environment, log } = collectionHarness({ stuckFrames: true });
  await assert.rejects(collectMidiInRenderer(collectionOptions, environment), /Renderer completion frames/);
  assert.ok(log.includes("cancel-frame"));
  assert.ok(!log.includes("perf_audit_inject_midi"));
});

test("renderer completion is required after injection as well as before reset", async () => {
  const { environment, log } = collectionHarness({ stuckAfterInjection: true });
  await assert.rejects(collectMidiInRenderer(collectionOptions, environment), /Renderer completion frames/);
  assert.ok(log.includes("perf_audit_inject_midi"));
  assert.ok(!log.includes("frontend-snapshot"));
});

test("a queue that never finishes fails without resetting or discarding its work", async () => {
  const { environment, log } = collectionHarness({ stuckQueue: true });
  await assert.rejects(collectMidiInRenderer(collectionOptions, environment), /did not settle before timeout/);
  assert.ok(!log.includes("perf_audit_reset"));
});

test("collector rejects dirty resets and malformed queues before injecting a new sample", async () => {
  for (const [options, error] of [[{ dirtyReset: true }, /reset retained work/], [{ missingQueueField: true }, /queue pending_preserved/]]) {
    const { environment, log } = collectionHarness(options);
    await assert.rejects(collectMidiInRenderer(collectionOptions, environment), error);
    assert.ok(!log.includes("perf_audit_inject_midi"));
  }
});

test("draining the queue is insufficient until all dispatched actions finish", () => {
  const snapshot = fixtureResult().snapshot;
  snapshot.action_outcomes.processed = 3;
  assert.equal(midiQueueSettled(snapshot, 4), false);
  snapshot.action_outcomes.processed = 4;
  assert.equal(midiQueueSettled(snapshot, 4), true);
  assert.equal(midiQueueSettled(snapshot, 5), false);
});

test("standalone runner retains rejected raw results without publishing or retaining accepted records", async () => {
  const output = await mkdtemp(join(tmpdir(), "midimaster-midi-collector-"));
  const result = fixtureResult();
  let closed = 0;
  const connector = {
    locateTarget: async () => ({ webSocketDebuggerUrl: "fixture" }),
    Session: class {
      async open() {}
      async send() { return { result: { value: structuredClone(result) } }; }
      close() { closed++; }
    },
  };
  const options = { ...collectionOptions, output, runId: "standalone", scenarioId: "one-control", variant: "current" };
  try {
    const success = await runMidiJourney(options, connector);
    assert.ok(success.records.length > 0);
    assert.equal(success.validation.status, "success");
    assert.ok((await readFile(join(output, "midi.ndjson"), "utf8")).length > 0);
    result.snapshot.synthetic_targets[0].value = 0.75;
    await assert.rejects(runMidiJourney(options, connector), /Synthetic target value mismatch/);
    assert.equal(await readFile(join(output, "midi.ndjson"), "utf8"), "");
    const raw = JSON.parse(await readFile(join(output, "native-snapshot.json"), "utf8"));
    assert.equal(raw.synthetic_targets[0].value, 0.75);
    const status = JSON.parse(await readFile(join(output, "midi-validation.json"), "utf8"));
    assert.equal(status.valid, false);
    assert.equal(status.status, "failed");
    assert.ok(status.elapsed_ms >= 0);
    assert.match(status.error, /target value mismatch/);
    assert.equal(closed, 2);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("connection failure clears stale acceptance and records a failed run", async () => {
  const output = await mkdtemp(join(tmpdir(), "midimaster-midi-connection-"));
  try {
    await writeFile(join(output, "midi.ndjson"), "previous accepted result\n");
    await assert.rejects(runMidiJourney({ ...collectionOptions, output, runId: "failed-connection", scenarioId: "connection", variant: "current" }, {
      locateTarget: async () => { throw new Error("No audit window"); },
    }), /No audit window/);
    assert.equal(await readFile(join(output, "midi.ndjson"), "utf8"), "");
    const status = JSON.parse(await readFile(join(output, "midi-validation.json"), "utf8"));
    assert.equal(status.valid, false);
    assert.equal(status.status, "failed");
    assert.equal(status.run_id, "failed-connection");
    assert.ok(status.elapsed_ms >= 0);
  } finally { await rm(output, { recursive: true, force: true }); }
});

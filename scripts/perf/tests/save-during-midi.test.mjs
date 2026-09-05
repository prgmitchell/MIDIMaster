import assert from "node:assert/strict";
import test from "node:test";
import { saveDuringMidi } from "../lib/save-during-midi.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function nativeSnapshot(count) {
  return {
    schema_version: 2,
    queue: { enqueued: count, drained: count, coalesced: 0, dropped: 0, pending_continuous: 0, pending_preserved: 0 },
    action_outcomes: { processed: count },
  };
}

/** The collector stays pending until the test releases it. Snapshot reads expose
 * native counter progression independently from the save interaction. */
function scenario({ counts = [0, 0, 10, 25, 100], finishOnRead = 3, save, collectorResult } = {}) {
  const collection = deferred();
  const saveReached = deferred();
  const collectorStarted = deferred();
  const calls = { collect: [], save: [], snapshots: [], waits: [] };
  const session = { id: "isolated-session" };
  const midiOptions = { messageCount: 100, ratePerSecond: 100, controlCount: 16, messageKind: "continuous" };
  const raw = collectorResult ?? {
    injection: { message_count: 100, message_kind: "continuous" },
    snapshot: nativeSnapshot(100),
    frontend: { raw_samples: [12, 18] },
    renderer_frames_completed: true,
  };
  const saveResult = { id: "edit-save", metric: "storage.profile_save", durationMs: 8 };
  let clock = 0;
  const options = {
    session, sample: 7, midiOptions,
    now: () => clock,
    wait: async (milliseconds) => { calls.waits.push(milliseconds); clock += milliseconds; },
    collectMidi: async (...args) => {
      calls.collect.push(args);
      collectorStarted.resolve();
      return collection.promise;
    },
    readSnapshot: async (readSession) => {
      assert.equal(readSession, session);
      const index = calls.snapshots.length;
      calls.snapshots.push(index);
      clock++;
      if (index === finishOnRead) collection.resolve(raw);
      const value = counts[Math.min(index, counts.length - 1)];
      if (value instanceof Error) throw value;
      return typeof value === "number" ? nativeSnapshot(value) : value;
    },
    runInteraction: async (...args) => {
      calls.save.push(args);
      saveReached.resolve();
      clock += 8;
      return save ? save() : saveResult;
    },
  };
  return { options, session, midiOptions, raw, saveResult, calls, collection, saveReached, collectorStarted };
}

test("save waits for fresh partial counters and retains raw collector and save evidence", async () => {
  const fixture = scenario({ counts: [50, 50, 50, 0, 10, 20, 100], finishOnRead: 5 });
  const result = await saveDuringMidi(fixture.options);
  assert.equal(result.status, "success");
  assert.equal(result.overlap.verified, true);
  assert.equal(result.midi, fixture.raw);
  assert.equal(result.save.result, fixture.saveResult);
  assert.deepEqual(fixture.calls.collect, [[fixture.session, fixture.midiOptions]]);
  assert.deepEqual(fixture.calls.save, [[fixture.session, "edit-save", 7]]);
  assert.equal(fixture.calls.waits.length, 3, "old partial counts and reset zero cannot trigger the save");
  assert.equal(result.overlap.beforeCollection.snapshot.queue.enqueued, 50);
  assert.equal(result.overlap.beforeSave.snapshot.queue.enqueued, 10);
  assert.equal(result.overlap.afterSave.snapshot.queue.enqueued, 20);
  assert.equal(result.finalSnapshot.queue.enqueued, 100);
  assert.ok(result.overlap.beforeSave.receivedAtMs <= result.save.startedAtMs);
  assert.ok(result.save.completedAtMs <= result.overlap.afterSave.requestedAtMs);
  assert.deepEqual(result.errors, []);
});

test("unchanged partial counts after a short save still show injection has not finished", async () => {
  const fixture = scenario({ counts: [0, 0, 10, 10, 100] });
  const result = await saveDuringMidi(fixture.options);
  assert.equal(result.overlap.verified, true);
  assert.equal(result.status, "success");
});

test("completed injection before observation never invokes save", async () => {
  const fixture = scenario({ counts: [0, 0, 100, 100], finishOnRead: 2 });
  const result = await saveDuringMidi(fixture.options);
  assert.equal(result.status, "failed");
  assert.equal(result.overlap.verified, false);
  assert.equal(result.save, null);
  assert.equal(fixture.calls.save.length, 0);
  assert.equal(result.midi, fixture.raw);
  assert.equal(result.errors[0].stage, "observe-injection");
});

test("injection completing during editor setup or save cannot claim overlap", async () => {
  const fixture = scenario({ counts: [0, 0, 10, 100, 100] });
  const result = await saveDuringMidi(fixture.options);
  assert.equal(result.status, "failed");
  assert.equal(result.overlap.verified, false);
  assert.equal(result.overlap.beforeSave.snapshot.queue.enqueued, 10);
  assert.equal(result.overlap.afterSave.snapshot.queue.enqueued, 100);
  assert.equal(result.save.result, fixture.saveResult);
  assert.equal(result.midi, fixture.raw);
  assert.match(result.errors[0].message, /overlap is unverified/);
});

test("save failure retains its error and waits for collection instead of abandoning injection", async () => {
  const fixture = scenario({ counts: [0, 0, 10, 100], finishOnRead: -1,
    save: () => { throw new Error("profile save rejected"); } });
  let returned = false;
  const pending = saveDuringMidi(fixture.options).then(result => { returned = true; return result; });
  await fixture.saveReached.promise;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(returned, false);
  fixture.collection.resolve(fixture.raw);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.overlap.verified, false);
  assert.equal(result.midi, fixture.raw);
  assert.equal(result.finalSnapshot.queue.enqueued, 100);
  assert.ok(result.save.completedAtMs >= result.save.startedAtMs);
  assert.equal(result.errors[0].stage, "save");
  assert.match(result.errors[0].message, /profile save rejected/);
  assert.match(result.errors[0].stack, /profile save rejected/);
});

test("collector rejection during an in-flight save is retained and invalidates overlap", async () => {
  const saveFinished = deferred();
  const fixture = scenario({ finishOnRead: -1, save: () => saveFinished.promise });
  const pending = saveDuringMidi(fixture.options);
  await fixture.saveReached.promise;
  fixture.collection.reject(new Error("native injection failed"));
  saveFinished.resolve(fixture.saveResult);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.overlap.verified, false);
  assert.equal(result.midi, null);
  assert.equal(result.save.result, fixture.saveResult);
  assert.equal(result.finalSnapshot.queue.enqueued, 100);
  assert.ok(result.errors.some(error => error.stage === "collection" && /native injection failed/.test(error.message)));
});

test("counter observation timeout preserves evidence and still awaits the collector", async () => {
  const fixture = scenario({ counts: [50, 50, 50, 100], finishOnRead: -1 });
  const deadlineObserved = deferred();
  let returned = false;
  const pending = saveDuringMidi({ ...fixture.options, overlapTimeoutMs: 5, pollIntervalMs: 5,
    readSnapshot: async session => {
      const snapshot = await fixture.options.readSnapshot(session);
      if (fixture.calls.snapshots.length === 3) deadlineObserved.resolve();
      return snapshot;
    },
  }).then(result => { returned = true; return result; });
  await deadlineObserved.promise;
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  assert.equal(returned, false);
  fixture.collection.resolve(fixture.raw);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.overlap.verified, false);
  assert.equal(result.save, null);
  assert.equal(result.overlap.lastObserved.snapshot.queue.enqueued, 50);
  assert.equal(result.midi, fixture.raw);
  assert.equal(result.errors[0].stage, "observe-injection");
  assert.match(result.errors[0].message, /before timeout/);
});

test("failed final native snapshot retains successful raw collection and save output", async () => {
  const fixture = scenario({ counts: [0, 0, 10, 25, new Error("final snapshot unavailable")] });
  const result = await saveDuringMidi(fixture.options);
  assert.equal(result.status, "failed");
  assert.equal(result.overlap.verified, false);
  assert.equal(result.midi, fixture.raw);
  assert.equal(result.save.result, fixture.saveResult);
  assert.equal(result.finalSnapshot, null);
  assert.equal(result.errors[0].stage, "final-snapshot");
  assert.match(result.errors[0].message, /final snapshot unavailable/);
});

test("failed observation cannot bypass settling or discard final native evidence", async () => {
  const fixture = scenario({ counts: [0, new Error("snapshot unavailable"), 100], finishOnRead: -1 });
  const pending = saveDuringMidi(fixture.options);
  await fixture.collectorStarted.promise;
  fixture.collection.resolve(fixture.raw);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.midi, fixture.raw);
  assert.equal(result.finalSnapshot.queue.enqueued, 100);
  assert.equal(fixture.calls.save.length, 0);
  assert.match(result.errors[0].message, /snapshot unavailable/);
});

test("counter rollback, collector count mismatch, or missing save measurement invalidates results", async () => {
  for (const configuration of [
    { counts: [0, 0, 10, 5, 100] },
    { collectorResult: { injection: { message_count: 99 }, snapshot: nativeSnapshot(99) } },
    { finishOnRead: -1, save: () => ({ id: "edit-save", durationMs: 8 }) },
  ]) {
    const fixture = scenario(configuration);
    const pending = saveDuringMidi(fixture.options);
    if (configuration.finishOnRead === -1) {
      await fixture.saveReached.promise;
      fixture.collection.resolve(fixture.raw);
    }
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.equal(result.overlap.verified, false);
    assert.equal(result.midi, fixture.raw);
    assert.ok(result.errors.length > 0);
  }
});

test("invalid or unsettled initial native snapshots do not start a collector", async () => {
  const unsettled = nativeSnapshot(50);
  unsettled.queue.pending_continuous = 1;
  for (const snapshot of [{ schema_version: 1 }, unsettled]) {
    const fixture = scenario({ counts: [snapshot] });
    const result = await saveDuringMidi(fixture.options);
    assert.equal(result.status, "failed");
    assert.equal(result.overlap.verified, false);
    assert.equal(fixture.calls.collect.length, 0);
    assert.equal(result.errors[0].stage, "before-collection");
  }
});

test("invalid request options fail before collection begins", async () => {
  const fixture = scenario();
  for (const options of [
    { midiOptions: { messageCount: 1 } }, { overlapTimeoutMs: 0 }, { readSnapshot: null },
  ]) {
    await assert.rejects(saveDuringMidi({ ...fixture.options, ...options }));
  }
  assert.equal(fixture.calls.collect.length, 0);
});

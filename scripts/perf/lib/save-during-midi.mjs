import { midiQueueSettled } from "./midi-collection.mjs";

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function enqueued(snapshot) {
  const value = snapshot?.queue?.enqueued;
  if (snapshot?.schema_version !== 2 || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Save-during-MIDI evidence requires a schema 2 native queue snapshot");
  }
  return value;
}

/** Run one save alongside the existing collector. The caller owns the isolated
 * session exclusively and supplies collectMidi(session, options), readSnapshot(session),
 * and the existing runInteraction(session, id, sample). No renderer latency is inferred.
 */
export async function saveDuringMidi({
  session,
  sample = 0,
  midiOptions,
  collectMidi,
  readSnapshot,
  runInteraction,
  overlapTimeoutMs = 5000,
  pollIntervalMs = 20,
  now = () => performance.now(),
  wait = pause,
}) {
  if (!Number.isSafeInteger(midiOptions?.messageCount) || midiOptions.messageCount < 2) {
    throw new Error("Save-during-MIDI requires at least two messages to observe a partial injection");
  }
  if (![collectMidi, readSnapshot, runInteraction].every((callback) => typeof callback === "function")) {
    throw new Error("Save-during-MIDI requires collector, snapshot and interaction callbacks");
  }
  if (![overlapTimeoutMs, pollIntervalMs].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Save-during-MIDI wait limits must be positive");
  }
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const result = {
    status: "failed",
    sample,
    midiOptions: { ...midiOptions },
    midi: null,
    save: null,
    overlap: {
      verified: false,
      criterion: "injection remains partial before and after the completed save interaction",
      beforeCollection: null,
      beforeSave: null,
      afterSave: null,
      lastObserved: null,
    },
    finalSnapshot: null,
    errors: [],
  };
  const recordError = (stage, error) => result.errors.push({
    stage,
    name: String(error?.name || "Error"),
    message: String(error?.message || error),
    ...(error?.stack ? { stack: String(error.stack) } : {}),
  });
  const capture = async () => {
    const requestedAtMs = elapsed();
    const snapshot = await readSnapshot(session);
    return { requestedAtMs, receivedAtMs: elapsed(), snapshot };
  };
  let collection = null;
  let collectionState = "not-started";
  let stage = "before-collection";
  try {
    result.overlap.beforeCollection = await capture();
    const previousEnqueued = enqueued(result.overlap.beforeCollection.snapshot);
    if (!midiQueueSettled(result.overlap.beforeCollection.snapshot)) {
      throw new Error("The preceding MIDI sample must be settled before observing fresh injection counters");
    }
    collectionState = "pending";
    // Attach rejection handling immediately, including when save/setup later fails.
    collection = Promise.resolve().then(() => collectMidi(session, midiOptions)).then(
      (raw) => { result.midi = raw; collectionState = "fulfilled"; },
      (error) => { collectionState = "rejected"; recordError("collection", error); },
    );
    stage = "observe-injection";
    const deadline = now() + overlapTimeoutMs;
    let observedNewCounters = false;
    while (true) {
      const observation = await capture();
      result.overlap.lastObserved = observation;
      const count = enqueued(observation.snapshot);
      // The collector drains/reset previous work. Unchanged old counters cannot
      // establish that this sample has started, even when they look partial.
      if (count !== previousEnqueued) observedNewCounters = true;
      if (collectionState !== "pending") throw new Error("Collection ended before a partial injection was observed");
      if (observedNewCounters && count > 0 && count < midiOptions.messageCount) {
        result.overlap.beforeSave = observation;
        break;
      }
      if (observedNewCounters && count >= midiOptions.messageCount) {
        throw new Error("Injection completed before the save could start");
      }
      if (now() >= deadline) throw new Error("A partial injection was not observed before timeout");
      await wait(pollIntervalMs);
    }
    stage = "save";
    result.save = { startedAtMs: elapsed(), completedAtMs: null, result: null };
    try {
      result.save.result = await runInteraction(session, "edit-save", sample);
    } finally {
      result.save.completedAtMs = elapsed();
    }
    if (result.save.result?.id !== "edit-save" || result.save.result?.metric !== "storage.profile_save" ||
        !Number.isFinite(result.save.result?.durationMs) || result.save.result.durationMs < 0) {
      throw new Error("The save interaction returned no valid renderer-measured save duration");
    }
    stage = "verify-overlap";
    result.overlap.afterSave = await capture();
    const afterCount = enqueued(result.overlap.afterSave.snapshot);
    const beforeCount = enqueued(result.overlap.beforeSave.snapshot);
    // runInteraction also opens/fills the editor. If injection finishes during
    // setup, a pre-interaction snapshot alone would make a false overlap claim.
    if (afterCount < beforeCount || afterCount >= midiOptions.messageCount) {
      throw new Error("Injection was not demonstrably active after save completion; overlap is unverified");
    }
    result.overlap.verified = true;
  } catch (error) {
    recordError(stage, error);
  } finally {
    // The collector retains its own queue/frame deadlines. Never abandon it or
    // reset its counters merely because observing overlap or saving failed.
    if (collection) await collection;
    if (collection) {
      try { result.finalSnapshot = await readSnapshot(session); }
      catch (error) { recordError("final-snapshot", error); }
    }
  }
  if (collectionState === "fulfilled" && result.midi?.injection?.message_count !== midiOptions.messageCount) {
    recordError("collection", new Error("Collected injection does not match the requested message count"));
  }
  if (collectionState !== "fulfilled" || result.errors.length) result.overlap.verified = false;
  if (result.overlap.verified) result.status = "success";
  return result;
}

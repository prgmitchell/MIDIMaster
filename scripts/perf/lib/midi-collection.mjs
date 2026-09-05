/** Serializable queue predicate shared by the browser collector and result gates. */
export function midiQueueSettled(snapshot, messageCount) {
  if (snapshot?.schema_version !== 2) throw new Error("MIDI result verification requires audit schema 2");
  const queue = snapshot.queue;
  for (const field of ["pending_continuous", "pending_preserved", "enqueued", "drained", "coalesced", "dropped"]) {
    if (!Number.isSafeInteger(queue?.[field]) || queue[field] < 0) throw new Error(`Missing or invalid MIDI queue ${field}`);
  }
  const processed = snapshot.action_outcomes?.processed;
  if (!Number.isSafeInteger(processed) || processed < 0) throw new Error("Missing or invalid MIDI processed count");
  return queue.pending_continuous === 0 && queue.pending_preserved === 0
    && processed === queue.drained && (messageCount == null || queue.enqueued === messageCount);
}

/** Runs in the renderer. Each sample drains old work before clearing either clock's records. */
export async function collectMidiInRenderer(options, environment = globalThis, isSettled = midiQueueSettled) {
  const { messageCount, ratePerSecond, controlCount, messageKind, timeoutMs = 30000 } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("MIDI collection timeout must be positive");
  const invoke = environment.__TAURI__?.core?.invoke;
  const frontendAudit = environment.__MIDIMASTER_PERF__;
  if (!invoke) throw new Error("Tauri invoke bridge unavailable");
  if (!frontendAudit?.reset || !frontendAudit?.snapshot) throw new Error("Frontend performance audit unavailable");
  const pause = ms => new Promise(resolve => environment.setTimeout(resolve, ms));

  async function settle(expectedMessages) {
    const deadline = environment.performance.now() + timeoutMs;
    do {
      const snapshot = await invoke("perf_audit_snapshot");
      if (isSettled(snapshot, expectedMessages)) return snapshot;
      if (environment.performance.now() >= deadline) throw new Error("MIDI queue/action processing did not settle before timeout");
      await pause(50);
    } while (true);
  }

  async function frames() {
    if (typeof environment.requestAnimationFrame !== "function") throw new Error("Renderer frame scheduling unavailable");
    await new Promise((resolve, reject) => {
      let frame;
      const timer = environment.setTimeout(() => {
        environment.cancelAnimationFrame?.(frame);
        reject(new Error("Renderer completion frames did not run before timeout"));
      }, Math.min(timeoutMs, 2000));
      frame = environment.requestAnimationFrame(() => {
        frame = environment.requestAnimationFrame(() => {
          environment.clearTimeout(timer);
          resolve();
        });
      });
    });
  }

  await settle();
  await frames();
  await invoke("perf_audit_reset");
  frontendAudit.reset();
  const reset = await invoke("perf_audit_snapshot");
  if (!isSettled(reset, 0) || reset.queue.drained !== 0 || reset.queue.coalesced !== 0 || reset.queue.dropped !== 0) {
    throw new Error("MIDI audit reset retained work from a preceding sample");
  }
  const injection = await invoke("perf_audit_inject_midi", { messageCount, ratePerSecond, controlCount, messageKind });
  const snapshot = await settle(messageCount);
  await frames();
  return { injection, snapshot, frontend: frontendAudit.snapshot(), renderer_frames_completed: true };
}

export function midiCollectionExpression(options) {
  return `(${collectMidiInRenderer})(${JSON.stringify(options)}, globalThis, ${midiQueueSettled})`;
}

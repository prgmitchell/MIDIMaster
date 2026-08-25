import { createFrameBatcher, midiPayloadControlKey } from "./render_batching.js";

export function createMidiEventDispatch({
  shouldPreserve,
  applyEvent,
  maxPendingPerfEvents = 2_048,
}) {
  const batcher = createFrameBatcher({
    keyFor: midiPayloadControlKey,
    shouldPreserve,
    onFlush: (events) => events.forEach(applyEvent),
  });
  const pendingPerformanceEvents = new Map();

  function queue(payload) {
    batcher.queue(payload);
  }

  function queuePerformance(payload) {
    const key = midiPayloadControlKey(payload);
    if (!key) return;
    const pending = pendingPerformanceEvents.get(key) || [];
    pending.push(payload);
    if (pending.length > maxPendingPerfEvents) {
      pending.splice(0, pending.length - maxPendingPerfEvents);
    }
    pendingPerformanceEvents.set(key, pending);
  }

  function takePerformance(payload) {
    const key = midiPayloadControlKey(payload);
    const pending = key ? pendingPerformanceEvents.get(key) : null;
    if (!pending?.length) return null;
    const next = pending.shift();
    if (pending.length === 0) pendingPerformanceEvents.delete(key);
    return next;
  }

  function clearPerformance() {
    pendingPerformanceEvents.clear();
  }

  return { queue, queuePerformance, takePerformance, clearPerformance };
}

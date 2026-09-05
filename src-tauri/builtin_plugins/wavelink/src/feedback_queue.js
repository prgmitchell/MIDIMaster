import { STATE_REFRESH_DEBOUNCE_MS } from "./protocol.js";

const DOMAINS = ["mixes", "channels", "outputs"];

/** Serialize state reconciliation while folding responses received during a pass.
 * Command/button feedback bypasses this queue. An unchanged state is suppressed
 * only within one refresh burst: native feedback may have deferred hardware I/O
 * while a control was active, so later refreshes must still reconcile it.
 */
export function createFeedbackQueue({ ctx, state, reconcile }) {
  const dirty = new Set();
  const interrupted = new Set();
  const sent = new Map();
  let generation = 0;
  let running = null;
  let activeDomains = null;

  function invalidate({ retryInterrupted = false } = {}) {
    generation += 1;
    sent.clear();
    if (retryInterrupted) {
      for (const domain of activeDomains || []) interrupted.add(domain);
      for (const domain of dirty) interrupted.add(domain);
    } else {
      interrupted.clear();
    }
    dirty.clear();
  }

  async function flush() {
    while (dirty.size && !state.disposed) {
      const domains = new Set(dirty);
      dirty.clear();
      activeDomains = domains;
      const currentGeneration = generation;
      const isCurrent = () => !state.disposed && generation === currentGeneration;
      const forget = (bindingId, action) => sent.delete(JSON.stringify([bindingId, action]));
      const send = async (bindingId, value, action) => {
        if (!isCurrent()) return;
        const key = JSON.stringify([bindingId, action]);
        const previous = sent.get(key);
        const age = previous ? Date.now() - previous.at : Infinity;
        if (
          previous?.value === value &&
          age >= 0 && age < STATE_REFRESH_DEBOUNCE_MS
        ) return;
        await ctx.feedback.set(bindingId, value, action, { silent: true });
        if (isCurrent()) sent.set(key, { value, at: Date.now() });
      };
      try {
        await reconcile(domains, { send, forget, isCurrent });
      } finally {
        activeDomains = null;
      }
    }
    dirty.clear();
  }

  function sync(domain = null) {
    if (state.disposed) return Promise.resolve();
    // Resume local-action interruptions only when a state response arrives;
    // replaying immediately could overwrite the command with stale cached data.
    for (const item of interrupted) dirty.add(item);
    interrupted.clear();
    for (const item of domain ? [domain] : DOMAINS) dirty.add(item);
    if (!running) {
      running = Promise.resolve().then(flush).finally(() => {
        running = null;
        // A new native event may arrive after flush resolves but before finally.
        if (dirty.size && !state.disposed) return sync();
      });
    }
    return running;
  }

  return { sync, invalidate };
}

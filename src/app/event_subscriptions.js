/**
 * Owns Tauri event unlisteners so startup wiring has an explicit lifecycle.
 */
export function createEventSubscriptions({ listen } = {}) {
  if (typeof listen !== "function") {
    throw new Error("createEventSubscriptions: listen is required");
  }

  const unlisteners = new Set();
  let disposed = false;

  async function subscribe(eventName, handler) {
    if (disposed) throw new Error("Event subscriptions have been disposed");
    const unlisten = await listen(eventName, handler);
    if (typeof unlisten === "function") unlisteners.add(unlisten);
    return unlisten;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    const pending = Array.from(unlisteners, (unlisten) => Promise.resolve().then(unlisten));
    unlisteners.clear();
    await Promise.allSettled(pending);
  }

  return {
    subscribe,
    dispose,
    size: () => unlisteners.size,
  };
}

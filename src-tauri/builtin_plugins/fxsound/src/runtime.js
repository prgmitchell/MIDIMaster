import {
  ID,
  WRITE_INTERVAL_MS,
  innerTarget,
  targetKey,
  targetValue,
  writesForTarget,
  applyWrites,
} from "./protocol.js";

export function createRuntime({ ctx, state, updateUi }) {
  let writeTimer = null;
  let writePromise = null;
  let pollPromise = null;
  let lastPollAt = 0;
  let failures = 0;
  const pending = new Map();
  const intents = new Map();
  const feedbackCache = new Map();
  let uiSignature = "";

  function notify() {
    if (state.disposed) return;
    const status = state.snapshot.status;
    const signature = JSON.stringify([
      state.snapshot.connected,
      status?.equalizer.bands.map((b) => [b.index, b.frequency]),
      status?.presets,
    ]);
    if (signature !== uiSignature) {
      uiSignature = signature;
      ctx.app.invalidateBindingsUI();
    }
    updateUi();
  }

  async function feedback(silent = true) {
    if (!state.snapshot.connected || state.disposed) return;
    for (const binding of ctx.bindings.getAll()) {
      for (const raw of binding.targets ||
        (binding.target ? [binding.target] : [])) {
        const target = innerTarget(raw);
        if (target?.integration_id !== ID) continue;
        const value = targetValue(target, state.snapshot.status);
        if (value === null) continue;
        const key = `${binding.id}:${targetKey(target)}`;
        if (feedbackCache.get(key) === value) continue;
        await ctx.feedback.set(
          binding.id,
          value,
          binding.action ||
            (target.kind === "power" ? "ToggleEffect" : "Volume"),
          { silent },
        );
        feedbackCache.set(key, value);
      }
    }
  }

  async function flush() {
    if (writeTimer !== null) clearTimeout(writeTimer);
    writeTimer = null;
    if (writePromise) {
      await writePromise;
      return flush();
    }
    if (state.disposed || !state.snapshot.connected || !pending.size) return;
    const writes = [...pending.values()];
    pending.clear();
    writePromise = ctx.tauri
      .invoke("fxsound_write", { writes })
      .catch((error) => {
        intents.clear();
        state.snapshot = {
          ...state.snapshot,
          connected: false,
          detail: String(error),
        };
        pending.clear();
        notify();
        throw error;
      })
      .finally(() => {
        writePromise = null;
      });
    await writePromise;
    if (pending.size && !state.disposed) scheduleFlush();
  }

  function scheduleFlush() {
    if (writeTimer !== null || state.disposed || writePromise) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flush().catch(() => {});
    }, WRITE_INTERVAL_MS);
  }

  async function write(writes) {
    if (!state.snapshot.connected || state.disposed || !writes.length) return;
    for (const entry of writes) {
      const key = `${entry.kind}:${entry.index ?? entry.key ?? ""}`;
      pending.set(key, entry);
      intents.set(key, { entry, at: Date.now() });
    }
    applyWrites(state.snapshot.status, writes);
    scheduleFlush();
    notify();
    await feedback(false);
  }

  async function poll(force = false) {
    if (state.disposed || state.disconnectedByUser) return;
    if (pollPromise) return pollPromise;
    if (!force && !state.snapshot.connected && !state.settings.auto_connect)
      return;
    if (
      !force &&
      Date.now() - lastPollAt < (state.snapshot.connected ? 1000 : 4000)
    )
      return;
    if (writePromise || pending.size) return;
    lastPollAt = Date.now();
    pollPromise = (async () => {
      try {
        const snapshot = await ctx.tauri.invoke("fxsound_snapshot", { force });
        if (state.disposed || state.disconnectedByUser) return;
        if (!snapshot.connected && state.snapshot.connected && ++failures < 3)
          return;
        if (snapshot.connected) failures = 0;
        state.snapshot = snapshot;
        if (snapshot.connected) {
          for (const [key, intent] of intents) {
            if (Date.now() - intent.at > 1500) intents.delete(key);
            else applyWrites(snapshot.status, [intent.entry]);
          }
          await feedback(true);
        }
        notify();
      } catch (error) {
        if (state.disposed) return;
        if (++failures >= 3 || force) {
          state.snapshot = {
            connected: false,
            installed: false,
            status: null,
            detail: String(error),
          };
          notify();
        }
      } finally {
        pollPromise = null;
      }
    })();
    return pollPromise;
  }

  async function connect() {
    if (state.connecting || state.disposed) return;
    state.connecting = true;
    state.disconnectedByUser = false;
    feedbackCache.clear();
    notify();
    try {
      await poll(true);
    } finally {
      state.connecting = false;
      notify();
    }
  }

  function disconnect() {
    state.disconnectedByUser = true;
    pending.clear();
    intents.clear();
    if (writeTimer !== null) clearTimeout(writeTimer);
    writeTimer = null;
    state.snapshot = {
      ...state.snapshot,
      connected: false,
      status: null,
      detail: "Not connected",
    };
    notify();
  }

  async function trigger({ binding_id, action, value, target }) {
    if (!state.snapshot.connected || state.disposed) return;
    if (target.kind === "preset" || target.kind === "reset") {
      if (Number(value) < 0.5) return;
      await flush();
      intents.clear();
      if (target.kind === "preset")
        await ctx.tauri.invoke("fxsound_select_preset", {
          name: target.data.name,
        });
      else
        await ctx.tauri.invoke("fxsound_write", {
          writes: state.snapshot.status.equalizer.bands.map((band) => ({
            kind: "band",
            index: band.index,
            value: 0,
          })),
        });
      if (binding_id)
        await ctx.feedback.set(binding_id, 0, action, {
          silent: true,
          forceHardwareFeedback: true,
        });
      feedbackCache.clear();
      await poll(true);
      return;
    }
    const writes = writesForTarget(target, value, state.snapshot.status);
    await write(writes);
    if (writes.length)
      await ctx.feedback.set(
        binding_id,
        targetValue(target, state.snapshot.status),
        action,
      );
  }

  function dispose() {
    state.disposed = true;
    pending.clear();
    intents.clear();
    if (writeTimer !== null) clearTimeout(writeTimer);
    writeTimer = null;
  }

  return {
    poll,
    connect,
    disconnect,
    write,
    flush,
    trigger,
    feedback,
    notify,
    dispose,
    clearFeedback: () => feedbackCache.clear(),
  };
}

import assert from "node:assert/strict";
import { createFeedback } from "../src-tauri/builtin_plugins/wavelink/src/feedback.js";
import { createConnection } from "../src-tauri/builtin_plugins/wavelink/src/connection.js";
import { createIntegration } from "../src-tauri/builtin_plugins/wavelink/src/integration.js";
import { STATE_REFRESH_DEBOUNCE_MS } from "../src-tauri/builtin_plugins/wavelink/src/protocol.js";

const target = (kind, data) => ({ Integration: { integration_id: "wavelink", kind, data } });
const binding = (id, kind, data, action = "Volume") => ({ id, action, target: target(kind, data) });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const originalNow = Date.now;
let now = 1000;
Date.now = () => now;

function fixture(bindings, options = {}) {
  const calls = [];
  const state = {
    wsId: 1,
    bindings,
    mixes: [{ id: "stream", level: 0.7, isMuted: true }],
    channels: Array.from({ length: 8 }, (_, index) => ({
      id: `c${index}`,
      level: 0.5,
      isMuted: false,
      mixes: [{ id: "stream", level: 0.3, isMuted: true }],
      effects: [{ id: "compressor", isEnabled: true }],
    })),
    outputDevicesState: { mainOutput: { outputDeviceId: "speakers", outputId: "out" } },
  };
  const ctx = {
    feedback: {
      set: async (...args) => {
        calls.push(args);
        await options.send?.(...args);
      },
    },
  };
  const primaryFeedbackIntentByBinding = new Map();
  const feedback = createFeedback({
    ctx, state, primaryFeedbackIntentByBinding,
    shouldIgnoreStaleLocalVolume: options.ignoreLocal || (() => false),
    shouldIgnoreStaleFeedbackIntent: options.ignorePrimary || (() => false),
  });
  return { calls, state, ctx, feedback, primaryFeedbackIntentByBinding };
}

try {
  for (const count of [25, 100, 500]) {
    const f = fixture(Array.from({ length: count }, (_, index) =>
      binding(`b${index}`, "channel", { identifier: `c${index % 8}` })));
    await Promise.all([
      f.feedback.syncAllFeedback("mixes"),
      f.feedback.syncAllFeedback("channels"),
      f.feedback.syncAllFeedback("outputs"),
    ]);
    assert.equal(f.calls.length, count * 2, "one volume and one mute update per bound channel");
    await f.feedback.syncAllFeedback();
    await f.feedback.syncAllFeedback();
    assert.equal(f.calls.length, count * 2, "unchanged replies within a burst do not repeat IPC");
    assert.ok(f.calls.every((call) => call[3].silent === true));
    f.calls.length = 0;
    f.state.outputDevicesState = { mainOutput: null };
    await f.feedback.syncAllFeedback("outputs");
    assert.equal(f.calls.length, 0, "an output-device reply does not rescan/send channel bindings");
    f.state.channels = f.state.channels.map((channel, index) =>
      index === 0 ? { ...channel, level: 0.8 } : channel);
    await f.feedback.syncAllFeedback("channels");
    assert.equal(f.calls.length, Math.ceil(count / 8), "only changed channel volumes cross IPC");
    assert.ok(f.calls.every((call) => call[1] === 0.8 && call[2] === "Volume"));

    now += STATE_REFRESH_DEBOUNCE_MS;
    f.calls.length = 0;
    await f.feedback.syncAllFeedback("channels");
    assert.equal(f.calls.length, count * 2,
      "later refreshes retry hardware feedback that native user-activity guards may have skipped");
  }

  // Current and legacy endpoint schemas retain the same values and mute semantics.
  {
    const f = fixture([
      binding("mix", "mix", { mixer_id: "stream" }),
      binding("channel", "channel", { identifier: "c0" }),
      binding("channel-mix", "channel_mix", { identifier: "c0", mixer_id: "stream" }),
      binding("legacy-mix", "endpoint", { mixer_id: "stream" }),
      binding("legacy-channel", "endpoint", { identifier: "c0" }),
      binding("legacy-both", "endpoint", { identifier: "c0", mixer_id: "stream" }),
      binding("mute", "channel", { identifier: "c0" }, "ToggleMute"),
      binding("effect", "channel_effect", { identifier: "c0", effect_id: "compressor" }, "ToggleEffect"),
      binding("output", "main_output_device", { output_device_id: "speakers", output_id: "out" }, "SetMainOutputDevice"),
      binding("cycle", "main_output_cycle", {}, "SetMainOutputDevice"),
      binding("missing", "channel", { identifier: "absent" }),
      { id: "other", target: { Master: null }, action: "Volume" },
    ]);
    await f.feedback.syncAllFeedback();
    const values = Object.fromEntries(f.calls.map(([id, value, action]) => [`${id}:${action}`, value]));
    assert.deepEqual(values, {
      "mix:Volume": 0.7, "mix:ToggleMute": 1,
      "channel:Volume": 0.5, "channel:ToggleMute": 0,
      "channel-mix:Volume": 0.3, "channel-mix:ToggleMute": 1,
      "legacy-mix:Volume": 0.7, "legacy-mix:ToggleMute": 1,
      "legacy-channel:Volume": 0.5, "legacy-channel:ToggleMute": 0,
      "legacy-both:Volume": 0.3, "legacy-both:ToggleMute": 1,
      "mute:ToggleMute": 0, "effect:ToggleEffect": 1,
      "output:SetMainOutputDevice": 1, "cycle:SetMainOutputDevice": 0,
    });
    assert.deepEqual([...new Set(f.calls.map(([id]) => id))],
      f.state.bindings.slice(0, -2).map((binding) => binding.id),
      "a combined refresh preserves profile binding order across domains");
  }

  {
    const f = fixture([binding("first-match", "channel", { identifier: "c0" })]);
    f.state.channels.push({ id: "c0", level: 0.9, isMuted: true });
    await f.feedback.syncAllFeedback();
    assert.deepEqual(f.calls, [["first-match", 0.5, "Volume", { silent: true }],
      ["first-match", 0, "ToggleMute", { silent: true }]],
      "channel indexing retains the original first-match behavior for duplicate IDs");
  }

  // Binding changes, offline transitions and reconnects must invalidate snapshots.
  {
    const f = fixture([binding("same-id", "channel", { identifier: "c0" })]);
    await f.feedback.syncAllFeedback();
    f.calls.length = 0;
    f.feedback.setBindings([binding("same-id", "channel", { identifier: "c1" })]);
    await f.feedback.syncAllFeedback();
    assert.equal(f.calls.length, 2, "a new profile/mapping resends even identical values and IDs");
    f.calls.length = 0;
    await f.feedback.syncOfflineFeedback();
    await f.feedback.syncOfflineFeedback();
    assert.deepEqual(f.calls, [["same-id", 0, "Volume", { silent: true }]], "offline feedback remains once per transition");
    f.feedback.invalidateFeedback();
    f.calls.length = 0;
    await f.feedback.syncAllFeedback();
    assert.equal(f.calls.length, 2, "reconnect restores hardware feedback even within a burst");
  }

  // Suppressed local intent must not leave a stale last-sent value in the cache.
  {
    let ignore = false;
    const f = fixture([binding("fader", "channel", { identifier: "c0" })], { ignoreLocal: () => ignore });
    await f.feedback.syncAllFeedback();
    f.calls.length = 0;
    ignore = true;
    await f.feedback.syncAllFeedback();
    assert.equal(f.calls.length, 0);
    ignore = false;
    await f.feedback.syncAllFeedback();
    assert.deepEqual(f.calls, [["fader", 0.5, "Volume", { silent: true }]]);
    f.primaryFeedbackIntentByBinding.set("fader", { value: 0.5 });
    await f.feedback.syncAllFeedback();
    assert.equal(f.primaryFeedbackIntentByBinding.size, 0, "matching primary intent is cleared");
  }

  {
    let fail = true;
    const f = fixture([binding("retry", "channel", { identifier: "c0" })], {
      send: () => { if (fail) throw new Error("native unavailable"); },
    });
    await f.feedback.syncAllFeedback();
    fail = false;
    f.calls.length = 0;
    await f.feedback.syncAllFeedback();
    assert.equal(f.calls.length, 2, "failed native feedback is retried, never cached as delivered");
  }

  // An in-flight old-profile pass must stop before its next native call.
  {
    let release;
    let block = true;
    const f = fixture([binding("old", "channel", { identifier: "c0" })], {
      send: async () => { if (block) { block = false; await new Promise((resolve) => { release = resolve; }); } },
    });
    const previous = f.feedback.syncAllFeedback();
    await tick();
    f.feedback.setBindings([binding("new", "channel", { identifier: "c1" })]);
    const next = f.feedback.syncAllFeedback();
    release();
    await Promise.all([previous, next]);
    assert.deepEqual(f.calls.map((call) => [call[0], call[2]]), [
      ["old", "Volume"], ["new", "Volume"], ["new", "ToggleMute"],
    ]);
  }

  // Local commands cancel stale in-flight work without losing the other domains
  // from a full profile/reconnect refresh. Retry waits for a real state response.
  {
    let releaseFeedback;
    let releaseWrite;
    let block = true;
    const f = fixture([
      binding("mix-a", "mix", { mixer_id: "stream" }),
      binding("mix-b", "mix", { mixer_id: "stream" }),
      binding("channel", "channel", { identifier: "c0" }),
      binding("effect", "channel_effect", { identifier: "c0", effect_id: "compressor" }, "ToggleEffect"),
    ], {
      send: async () => { if (block) { block = false; await new Promise(resolve => { releaseFeedback = resolve; }); } },
    });
    let integration;
    createIntegration({
      ctx: { ...f.ctx, registerIntegration: value => { integration = value; } },
      state: f.state,
      invalidateFeedback: f.feedback.invalidateFeedback,
      setChannelEffectEnabled: () => new Promise(resolve => { releaseWrite = () => resolve(true); }),
    }).registerPluginIntegration();
    const refresh = f.feedback.syncAllFeedback();
    await tick();
    const command = integration.onBindingTriggered({ binding_id: "effect", action: "ToggleEffect", value: 0,
      target: { kind: "channel_effect", data: { identifier: "c0", effect_id: "compressor" } } });
    releaseFeedback();
    await refresh;
    assert.deepEqual(f.calls, [["mix-a", 0.7, "Volume", { silent: true }]],
      "interrupted work does not replay cached state while the local command is pending");
    releaseWrite();
    await command;
    f.state.channels[0].effects[0].isEnabled = false;
    await f.feedback.syncAllFeedback("channels");
    assert.deepEqual(f.calls.filter(([id]) => id === "mix-b"), [
      ["mix-b", 0.7, "Volume", { silent: true }], ["mix-b", 1, "ToggleMute", { silent: true }],
    ], "a channels response completes interrupted mix feedback too");
    assert.deepEqual(f.calls.filter(([id]) => id === "effect"), [
      ["effect", 0, "ToggleEffect"], ["effect", 0, "ToggleEffect", { silent: true }],
    ], "only the confirmed effect value is reconciled");
    const sent = f.calls.length;
    await f.feedback.syncAllFeedback();
    assert.equal(f.calls.length, sent, "resumed reconciliation keeps burst deduplication");
  }

  {
    const f = fixture([
      binding("old-mix", "mix", { mixer_id: "stream" }),
      binding("channel", "channel", { identifier: "c0" }),
    ]);
    const pending = f.feedback.syncAllFeedback();
    f.feedback.invalidateFeedback({ retryInterrupted: true });
    await pending;
    assert.equal(f.calls.length, 0, "local invalidation also retains work not yet started");
    await f.feedback.syncOfflineFeedback();
    f.calls.length = 0;
    await f.feedback.syncAllFeedback("channels");
    assert.deepEqual(f.calls.map(([id]) => id), ["channel", "channel"],
      "offline invalidation discards deferred domains from the previous connection");
  }

  {
    const f = fixture([binding("old", "mix", { mixer_id: "stream" })]);
    const pending = f.feedback.syncAllFeedback();
    f.feedback.invalidateFeedback({ retryInterrupted: true });
    f.feedback.setBindings([binding("new", "channel", { identifier: "c1" })]);
    await pending;
    await f.feedback.syncAllFeedback("channels");
    assert.deepEqual(f.calls.map(([id]) => id), ["new", "new"],
      "profile reset discards deferred old bindings");
  }

  {
    let release;
    const f = fixture([binding("dispose", "channel", { identifier: "c0" })], {
      send: () => new Promise((resolve) => { release = resolve; }),
    });
    const pending = f.feedback.syncAllFeedback();
    await tick();
    f.feedback.invalidateFeedback({ retryInterrupted: true });
    f.state.disposed = true;
    release();
    await pending;
    await f.feedback.syncAllFeedback();
    assert.equal(f.calls.length, 1, "unload stops queued feedback");
  }

  {
    const f = fixture([binding("cancel-before-start", "channel", { identifier: "c0" })]);
    const pending = f.feedback.syncAllFeedback();
    f.feedback.invalidateFeedback({ retryInterrupted: true });
    f.state.disposed = true;
    await pending;
    assert.equal(f.calls.length, 0, "unload before the scheduled pass prevents every native call");
  }

  // Local actions bypass silent reconciliation and invalidate its duplicate cache.
  {
    const f = fixture([binding("effect", "channel_effect", { identifier: "c0", effect_id: "compressor" }, "ToggleEffect")]);
    let integration;
    createIntegration({
      ctx: { ...f.ctx, registerIntegration: (value) => { integration = value; } },
      state: f.state,
      invalidateFeedback: f.feedback.invalidateFeedback,
      setChannelEffectEnabled: async () => true,
    }).registerPluginIntegration();
    await f.feedback.syncAllFeedback();
    f.calls.length = 0;
    const payload = { binding_id: "effect", action: "ToggleEffect", value: 0, target: { kind: "channel_effect", data: {} } };
    await integration.onBindingTriggered({ ...payload, button_event: "press" });
    await integration.onBindingTriggered({ ...payload, button_event: "release" });
    assert.deepEqual(f.calls, [["effect", 0, "ToggleEffect"], ["effect", 0, "ToggleEffect"]],
      "press/release feedback remains immediate and never passes through duplicate suppression");
    await f.feedback.syncAllFeedback();
    assert.deepEqual(f.calls.at(-1), ["effect", 1, "ToggleEffect", { silent: true }],
      "remote reconciliation is not suppressed by the preceding local action");
  }

  // Exercise the real connection callback: domain routing and reconnect reset.
  {
    const f = fixture([binding("connected", "channel", { identifier: "c0" })]);
    let onMessage;
    const pendingAppInfoByWsId = new Map();
    let resets = 0;
    const domains = [];
    const connection = createConnection({
      ctx: {
        tauri: { invoke: async () => 12345 },
        ws: {
          open: async () => 1,
          close: async () => {},
          onMessage: (_, callback) => { onMessage = callback; },
          send: async (_, text) => {
            const request = JSON.parse(text);
            if (request.id === 1) onMessage({ type: "text", data: JSON.stringify({ id: 1, result: { name: "Wave Link" } }) });
          },
        },
      },
      state: f.state, pendingAppInfoByWsId, pendingRpcById: new Map(),
      invalidateFeedback: () => { resets++; f.feedback.invalidateFeedback(); },
      updateAppInfoUi: () => {},
      syncAllFeedback: (domain) => { domains.push(domain); return f.feedback.syncAllFeedback(domain); },
    });
    assert.equal(await connection.connectOnce(), true);
    assert.equal(resets, 1);
    for (const [id, result] of [[2, f.state.mixes], [3, f.state.channels], [4, f.state.outputDevicesState]]) {
      onMessage({ type: "text", data: JSON.stringify({ id, result }) });
    }
    await tick();
    assert.deepEqual(domains, ["mixes", "channels", "outputs"]);
    assert.equal(f.calls.length, 2);
  }
} finally {
  Date.now = originalNow;
}

console.log("Wave Link feedback scaling, coalescing, lifecycle and compatibility tests passed");

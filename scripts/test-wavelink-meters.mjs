import assert from "node:assert/strict";
import {
  createMeters,
  meterAddress,
  stereoMeterLevel,
  targetMeterLevel,
} from "../src-tauri/builtin_plugins/wavelink/src/meters.js";

const target = (kind, data) => ({
  Integration: { integration_id: "wavelink", kind, data },
});
const channel = target("channel", { identifier: "game" });
const mix = target("mix", { mixer_id: "monitor" });
const route = target("channel_mix", {
  identifier: "game",
  mixer_id: "monitor",
});
assert.deepEqual(meterAddress(channel), {
  type: "channel",
  id: "game",
  subId: "",
});
assert.deepEqual(meterAddress(mix), { type: "mix", id: "monitor", subId: "" });
assert.deepEqual(meterAddress(route), {
  type: "channel",
  id: "game",
  subId: "monitor",
});
assert.deepEqual(
  meterAddress(target("endpoint", route.Integration.data)),
  meterAddress(route),
);
assert.equal(meterAddress("Master"), null);
assert.equal(meterAddress(target("effect", { identifier: "game" })), null);
assert.equal(
  stereoMeterLevel({ levelLeftPercentage: 0.2, levelRightPercentage: 0.7 }),
  0.7,
);
assert.equal(
  stereoMeterLevel({
    levelLeftPercentage: NaN,
    levelRightPercentage: Infinity,
  }),
  null,
);
assert.equal(
  stereoMeterLevel({ levelLeftPercentage: 2, levelRightPercentage: -1 }),
  1,
);

const state = {
  wsId: 1,
  channels: [
    { id: "game", isMuted: false, mixes: [{ id: "monitor", isMuted: false }] },
  ],
  mixes: [{ id: "monitor", isMuted: false }],
};
const address = meterAddress(route);
assert.equal(targetMeterLevel(address, 0.7, state), 0.7);
for (const muted of [
  state.channels[0],
  state.channels[0].mixes[0],
  state.mixes[0],
]) {
  muted.isMuted = true;
  assert.equal(targetMeterLevel(address, 0.7, state), 0);
  muted.isMuted = false;
}
assert.equal(
  targetMeterLevel({ ...address, subId: "missing" }, 0.7, state),
  null,
);

const requests = [],
  snapshots = [];
let demand;
const ctx = {
  feedback: {
    onAudioTargetsChanged: async (handler) => {
      demand = handler;
    },
    setAudioLevels: async (samples, generation) => {
      snapshots.push({ samples, generation });
    },
  },
};
const meters = createMeters({
  ctx,
  state,
  requestJsonRpc: async (method, params) => {
    requests.push({ method, params });
    return { ok: true };
  },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 55));
demand({ generation: 1, targets: [channel, mix, route, route, "Master"] });
await settle();
assert.equal(
  requests.filter((r) => r.params.levelMeterChanged.isEnabled).length,
  3,
  "one subscription per source",
);
meters.receive({
  channels: [
    { id: "game", levelLeftPercentage: 0.4, levelRightPercentage: 0.3 },
    {
      id: "game",
      subId: "monitor",
      levelLeftPercentage: 0.6,
      levelRightPercentage: 0.7,
    },
  ],
  mixes: [
    { id: "monitor", levelLeftPercentage: 0.8, levelRightPercentage: 0.5 },
  ],
});
await settle();
assert.deepEqual(
  snapshots.at(-1).samples.map((s) => s.level),
  [0.4, 0.8, 0.7, 0.7],
);
meters.refresh();
await settle();
assert.equal(
  snapshots.at(-1).samples[2].level,
  0.7,
  "unchanged meters remain valid without notifications",
);
state.channels[0].mixes[0].isMuted = true;
meters.refresh();
await settle();
assert.equal(
  snapshots.at(-1).samples[2].level,
  0,
  "mute-only changes clear the output",
);
state.channels[0].mixes[0].isMuted = false;

demand({ generation: 2, targets: [route] });
await settle();
assert.equal(snapshots.at(-1).generation, 2);
assert.equal(
  snapshots.at(-1).samples[0].level,
  null,
  "profile changes discard old meters",
);
assert.ok(requests.some((r) => !r.params.levelMeterChanged.isEnabled));
assert.equal(
  requests.filter((r) => r.params.levelMeterChanged.isEnabled).length,
  4,
  "same target is resubscribed for a fresh sample",
);
meters.receive({
  channels: [{ id: "game", subId: "monitor", levelLeftPercentage: 0.5 }],
});
await settle();
const savedChannels = state.channels;
state.channels = [];
meters.refresh("channels");
await settle();
assert.equal(
  snapshots.at(-1).samples[0].level,
  null,
  "removed targets become unavailable",
);
state.channels = savedChannels;
meters.refresh("channels");
await settle();
assert.equal(
  snapshots.at(-1).samples[0].level,
  null,
  "returning targets cannot reuse a removed sample",
);
state.wsId = null;
meters.disconnected();
await settle();
assert.equal(snapshots.at(-1).samples[0].level, null);
state.wsId = 2;
await meters.reconcile();
assert.equal(
  requests.filter((r) => r.params.levelMeterChanged.isEnabled).length,
  5,
);
await meters.dispose();
assert.deepEqual(snapshots.at(-1).samples, []);
const count = snapshots.length;
meters.receive({
  channels: [{ id: "game", subId: "monitor", levelLeftPercentage: 1 }],
});
await settle();
assert.equal(snapshots.length, count, "disposal cancels meter publishing");
// Reconnecting while an old socket's subscription is still awaiting a reply.
let delayedDemand, acknowledge;
let calls = 0;
const raceState = { ...state, wsId: 10 };
const raceRequests = [];
const race = createMeters({
  state: raceState,
  ctx: {
    feedback: {
      onAudioTargetsChanged: async (handler) => {
        delayedDemand = handler;
      },
      setAudioLevels: async () => {},
    },
  },
  requestJsonRpc: async (method, params) => {
    raceRequests.push(params.levelMeterChanged);
    if (++calls === 1)
      await new Promise((resolve) => {
        acknowledge = resolve;
      });
    return { ok: true };
  },
});
delayedDemand({ generation: 3, targets: [route] });
raceState.wsId = null;
race.disconnected();
raceState.wsId = 11;
void race.reconcile();
acknowledge();
await settle();
assert.equal(
  raceRequests.filter((r) => r.isEnabled).length,
  2,
  "new socket is subscribed even when old acknowledgement arrives late",
);
await race.dispose();
assert.equal(raceRequests.at(-1).isEnabled, false);

// Disposal waits for a subscription acknowledgement and then unsubscribes it.
let disposeDemand, finishSubscription;
const disposeRequests = [];
const disposingMeters = createMeters({
  state: { ...state, wsId: 12 },
  ctx: {
    feedback: {
      onAudioTargetsChanged: async (handler) => {
        disposeDemand = handler;
      },
      setAudioLevels: async () => {},
    },
  },
  requestJsonRpc: async (method, params) => {
    disposeRequests.push(params.levelMeterChanged);
    if (params.levelMeterChanged.isEnabled)
      await new Promise((resolve) => {
        finishSubscription = resolve;
      });
    return { ok: true };
  },
});
disposeDemand({ generation: 4, targets: [route] });
const disposing = disposingMeters.dispose();
finishSubscription();
await disposing;
assert.deepEqual(
  disposeRequests.map((r) => r.isEnabled),
  [true, false],
);
console.log("Wave Link meter tests passed");

import assert from "node:assert/strict";
import { createProfileTargetState } from "../src/features/profiles/controllers/target_state.js";
import { createProfileState as waveState } from "../src-tauri/builtin_plugins/wavelink/src/profile_state.js";
import { createProfileState as obsState } from "../src-tauri/builtin_plugins/obs/src/profile_state.js";
import { createActions as hueActions } from "../src-tauri/builtin_plugins/hue/src/actions.js";
import { createTargetState as hueTargetState } from "../src-tauri/builtin_plugins/hue/src/target_state.js";
import { createIntegration as vmIntegration } from "../src-tauri/builtin_plugins/voicemeeter/src/integration.js";

const raw = (integration_id, kind, data) => ({
  Integration: { integration_id, kind, data },
});
const a = raw("fixture", "channel", { id: "a", label: "A" });
const b = raw("fixture", "channel", { id: "b" });
let name = "Work",
  connected = false,
  allowed = true;
let bindings = [
  { action: "Volume", targets: [a, b] },
  { action: "OpenApplication", target: "OpenApplication" },
];
const values = new Map([
  ["a", { volume: 0.9, muted: false }],
  ["b", { volume: 0.8, muted: true }],
]);
const calls = [],
  restores = [],
  prepares = [];
const integration = {
  prepareStateCapture: ({ refresh }) => prepares.push(refresh),
  captureTargetState: (target) =>
    connected ? { ...values.get(target.data.id) } : null,
  restoreTargetState: (target, saved) => {
    if (!connected) return false;
    values.set(target.data.id, { ...saved });
    restores.push(target.data.id);
    return true;
  },
};
const controller = createProfileTargetState({
  invoke: async (command, args) => {
    assert.equal(command, "checkpoint_profile_state");
    calls.push(structuredClone(args));
    return allowed;
  },
  getActiveProfileName: () => name,
  getBindings: () => bindings,
  getPluginHost: () => ({
    getIntegration: (id) => (id === "fixture" ? integration : null),
  }),
});
const saved = [
  { target: a, state: { volume: 0.25, muted: true } },
  { target: b, state: { volume: 0.65, muted: false } },
];
await controller.loaded({ target_states: saved });
assert.deepEqual(restores, []);
assert.deepEqual(
  calls.at(-1).targetStates,
  [],
  "offline feedback never replaces saved states",
);
connected = true;
allowed = false;
await controller.tick();
assert.deepEqual(
  restores,
  [],
  "Solo also suspends pending integration restoration",
);
allowed = true;
bindings[0].targets[0] = raw("fixture", "channel", {
  id: "a",
  label: "Renamed",
  icon_data: "derived",
});
await controller.tick();
assert.deepEqual(restores, ["a", "b"]);
assert.deepEqual(
  calls.at(-1).targetStates.map((entry) => entry.state),
  saved.map((entry) => entry.state),
);
values.set("a", { volume: 0.42, muted: false });
await controller.beforeSwitch();
assert.equal(
  calls.at(-2).leaveProfile,
  true,
  "Solo is restored before fresh mixer capture",
);
assert.equal(prepares.at(-1), true);
assert.equal(calls.at(-1).profileName, "Work");
name = "Play";
await controller.loaded({
  target_states: [{ target: a, state: { volume: 0.7, muted: false } }],
});
assert.equal(values.get("a").volume, 0.7);
await controller.beforeSwitch();
name = "Work";
await controller.loaded({ target_states: saved });
assert.equal(values.get("a").volume, 0.25);
await controller.dispose();

const ws = {
  wsId: 1,
  channels: [
    {
      id: "game",
      level: 0.4,
      isMuted: false,
      mixes: [{ id: "monitor", level: 0.3, isMuted: true }],
      effects: [{ id: "fx", enabled: true }],
    },
  ],
  mixes: [{ id: "monitor", level: 0.8, isMuted: false }],
};
const rpc = [];
const wave = waveState({
  state: ws,
  flushVolumeWrites: async () => {},
  getChannelEffects: (channel) => channel?.effects || [],
  setChannelEffectEnabled: async (_data, enabled) => {
    ws.channels[0].effects[0].enabled = enabled;
    return true;
  },
  requestJsonRpc: async (method, params) => {
    rpc.push({ method, params });
    return {
      ok: true,
      result:
        method === "getChannels"
          ? { channels: ws.channels }
          : { mixes: ws.mixes },
    };
  },
});
const route = raw("wavelink", "channel_mix", {
  identifier: "game",
  mixer_id: "monitor",
}).Integration;
assert.deepEqual(wave.captureTargetState(route), { volume: 0.3, muted: true });
await wave.restoreTargetState(route, { volume: 0.6, muted: false });
assert.deepEqual(rpc.at(-1), {
  method: "setChannel",
  params: {
    id: "game",
    mixes: [{ id: "monitor", level: 0.6, isMuted: false }],
  },
});
assert.deepEqual(wave.captureTargetState(route), { volume: 0.6, muted: false });
await wave.prepareStateCapture({ refresh: true });
assert.deepEqual(
  rpc.slice(-2).map((call) => call.method),
  ["getChannels", "getMixes"],
);
assert.equal(
  wave.captureTargetState(raw("wavelink", "main_output_cycle", {}).Integration),
  null,
);
ws.wsId = null;
assert.equal(
  await wave.restoreTargetState(route, { volume: 0, muted: false }),
  false,
);

const obsCalls = [];
const obs = obsState({
  state: { connected: true },
  request: async (method, data) => {
    obsCalls.push({ method, data });
    if (method === "GetInputVolume") return { inputVolumeMul: 0.2 };
    if (method === "GetInputMute") return { inputMuted: true };
    if (method === "GetSceneItemList")
      return {
        sceneItems: [
          { sourceName: "Camera", sceneItemId: 5, sceneItemEnabled: false },
        ],
      };
    if (method === "GetSourceFilterList")
      return { filters: [{ filterName: "Color", filterEnabled: false }] };
    if (method === "GetReplayBufferStatus") return { outputActive: false };
    return {};
  },
});
const input = { kind: "input", data: { input_name: "Mic" } };
assert.deepEqual(await obs.captureTargetState(input), {
  volume: 0.2,
  muted: true,
});
await obs.restoreTargetState(input, { volume: 0.4, muted: false });
assert.deepEqual(obsCalls.slice(-2), [
  { method: "SetInputVolume", data: { inputName: "Mic", inputVolumeMul: 0.4 } },
  { method: "SetInputMute", data: { inputName: "Mic", inputMuted: false } },
]);
await obs.restoreTargetState(
  { kind: "source", data: { scene_name: "Main", source_name: "Camera" } },
  { enabled: true },
);
assert.equal(obsCalls.at(-1).data.sceneItemEnabled, true);
await obs.restoreTargetState(
  {
    kind: "source_filter",
    data: { source_name: "Camera", filter_name: "Color" },
  },
  { enabled: true },
);
assert.equal(obsCalls.at(-1).data.filterEnabled, true);
await obs.restoreTargetState(
  { kind: "action", data: { action: "ToggleReplayBuffer" } },
  { enabled: true },
);
assert.equal(
  obsCalls.at(-1).method,
  "StartReplayBuffer",
  "restoration sets state instead of toggling",
);
assert.equal(await obs.captureTargetState({ kind: "scene", data: {} }), null);
assert.equal(
  await obs.captureTargetState({
    kind: "action",
    data: { action: "StartRecord" },
  }),
  null,
);

const stateByKey = new Map([["light::1", { on: false, bri: 127 }]]),
  hueWrites = [];
const targetTools = hueTargetState({
  stateByKey,
  lastLocalWriteAt: new Map(),
  lastNonzeroBriByKey: new Map(),
  localIntentByKey: new Map(),
});
const hue = hueActions({
  ...targetTools,
  stateByKey,
  state: { connected: true },
  groupLightIdsByKey: new Map(),
  lastQueuedVolumeByKey: new Map(),
  ctx: { feedback: { set: async () => {} } },
  syncFeedbackForKey: async () => {},
  queueHueWrite: (...args) => hueWrites.push(args),
});
const light = raw("hue", "light", { id: "1" }).Integration;
assert.deepEqual(hue.captureTargetState(light), { on: false, bri: 127 });
await hue.restoreTargetState(light, { on: false, bri: 200 });
assert.deepEqual(hueWrites[0].slice(0, 3), [
  "light",
  "1",
  { on: false, bri: 200, transitiontime: 0 },
]);
assert.deepEqual(
  hue.captureTargetState(light),
  { on: false, bri: 200 },
  "off retains the remembered brightness",
);

let vm;
const vmCalls = [];
vmIntegration({
  ctx: {
    registerIntegration: (value) => {
      vm = value;
    },
    tauri: {
      invoke: async (command, args) => {
        vmCalls.push({ command, args });
        return { status: { connected: true }, values: [{ value: -12 }] };
      },
    },
  },
  state: { status: { connected: true } },
}).registerPluginIntegration();
const parameter = {
  kind: "parameter",
  data: { scope: "strip", index: 0, property: "Gain" },
};
assert.deepEqual(await vm.captureTargetState(parameter), { value: -12 });
await vm.restoreTargetState(parameter, { value: -9 });
assert.deepEqual(vmCalls.at(-1).args.writes, [
  { scope: "strip", index: 0, property: "Gain", value: -9 },
]);
assert.equal(await vm.captureTargetState({ kind: "command", data: {} }), null);
console.log(
  "Profile target capture, Solo exclusion, switching, reconnects, and built-in integration restoration passed",
);

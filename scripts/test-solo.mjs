import assert from "node:assert/strict";
import {
  buildWaveLinkSoloPlan,
  createWaveLinkSolo,
} from "../src-tauri/builtin_plugins/wavelink/src/solo.js";
import { createSoloController } from "../src/app/controllers/solo.js";

const target = (kind, data) => ({
  Integration: { integration_id: "wavelink", kind, data },
});
const fixture = () => ({
  wsId: 12,
  mixes: [
    { id: "monitor", isMuted: false },
    { id: "stream", isMuted: true },
  ],
  channels: [
    {
      id: "game",
      isMuted: false,
      mixes: [
        { id: "monitor", isMuted: false },
        { id: "stream", isMuted: true },
      ],
    },
    {
      id: "music",
      isMuted: true,
      mixes: [
        { id: "monitor", isMuted: false },
        { id: "stream", isMuted: false },
      ],
    },
    {
      id: "mic",
      isMuted: false,
      mixes: [
        { id: "monitor", isMuted: false },
        { id: "stream", isMuted: true },
      ],
    },
  ],
});
function apply(state, operations) {
  for (const { method, params } of operations) {
    if (method === "setMix")
      state.mixes.find((m) => m.id === params.id).isMuted = params.isMuted;
    else {
      const ch = state.channels.find((c) => c.id === params.id);
      if (params.mixes)
        for (const route of params.mixes)
          ch.mixes.find((r) => r.id === route.id).isMuted = route.isMuted;
      else ch.isMuted = params.isMuted;
    }
  }
}
for (const targets of [
  [target("channel_mix", { identifier: "game", mixer_id: "monitor" })],
  [target("channel", { identifier: "game" })],
  [target("mix", { mixer_id: "monitor" })],
  [
    target("channel_mix", { identifier: "game", mixer_id: "stream" }),
    target("channel", { identifier: "mic" }),
  ],
]) {
  const state = fixture(),
    original = structuredClone(state);
  const plan = buildWaveLinkSoloPlan({ ...state, targets });
  apply(state, plan.apply);
  if (targets[0].Integration.kind !== "mix")
    assert.equal(state.channels[1].isMuted, true);
  if (targets[0].Integration.kind === "channel_mix" && targets.length === 1) {
    assert.equal(state.channels[2].isMuted, true);
    assert.equal(state.mixes[1].isMuted, true);
    assert.equal(state.channels[0].mixes[0].isMuted, false);
  }
  state.channels[1].isMuted = false;
  state.channels[0].mixes[0].isMuted = true;
  apply(state, plan.restore);
  assert.deepEqual(
    state,
    original,
    "every pre-Solo mixer flag must be restored exactly",
  );
}
const nativePlan = buildWaveLinkSoloPlan({
  ...fixture(),
  targets: [],
  nativeChannelIds: ["GAME"],
});
assert.equal(nativePlan.allow_virtual_inputs, false);
assert.equal(
  buildWaveLinkSoloPlan({
    ...fixture(),
    targets: [],
    nativeChannelIds: ["hardware-direct"],
  }),
  null,
);
assert.deepEqual(nativePlan.virtual_channel_ids, ["game", "music", "mic"]);
assert(
  nativePlan.apply.some(
    (rpc) => rpc.params.id === "mic" && rpc.params.isMuted === true,
  ),
);
assert.throws(
  () =>
    buildWaveLinkSoloPlan({
      ...fixture(),
      targets: [target("channel", { identifier: "missing" })],
    }),
  /unavailable/,
);
const requests = [];
const createPlan = createWaveLinkSolo({
  state: { wsId: 12 },
  requestJsonRpc: async (method) => {
    requests.push(method);
    return { ok: true, result: fixture() };
  },
});
assert(
  (
    await createPlan({
      targets: [target("channel", { identifier: "game" })],
      nativeChannelIds: [],
    })
  ).restore.length,
);
assert.deepEqual(requests.sort(), ["getChannels", "getMixes"]);
await assert.rejects(
  createWaveLinkSolo({ state: {}, requestJsonRpc: () => {} })({}),
  /Connect Wave Link/,
);

let owner = null;
const calls = [],
  errors = [];
const controller = createSoloController({
  invoke: async (command, args) => {
    calls.push([command, args]);
    if (command === "get_binding_solo_context")
      return {
        active_binding_id: owner,
        targets: [{ Application: { name: "game" } }],
        wave_link_channel_ids: [],
      };
    owner = args.active ? args.bindingId : null;
  },
  getPluginHost: () => null,
  diagnosticError: (_, error) => errors.push(error),
  showAlert: (_, error) => errors.push(error),
});
const press = (binding = "a", behavior = "ToggleOnPress", value = 127) =>
  controller.enqueue({
    binding_id: binding,
    behavior,
    value,
    control_key: binding,
  });
await Promise.all([press(), press()]);
assert.equal(owner, null, "rapid presses should turn Solo on and then off");
assert.equal(
  calls.filter(
    ([command, args]) => command === "set_binding_solo" && args.active,
  ).length,
  1,
);
await press("a", "SetFromValue");
const count = calls.length;
await press("a", "SetFromValue");
assert.equal(
  calls.length,
  count,
  "repeated Match-on inputs must not resnapshot mute states",
);
await press("b");
assert.equal(owner, "b", "pressing another Solo switches the active binding");
await press("a", "SetFromValue", 0);
assert.equal(
  owner,
  "b",
  "releasing an older Match modifier must not cancel a different Solo",
);
await press("b", "ToggleOnPress", 0);
assert.equal(owner, "b", "Toggle ignores release");
await controller.dispose();
assert.equal(owner, null);
assert.deepEqual(errors, []);
console.log(
  "Solo session isolation, Wave Link planning, exact restoration, and Toggle/Match tests passed",
);

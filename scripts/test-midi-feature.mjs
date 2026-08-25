import assert from "node:assert/strict";
import * as midiPreferences from "../src/features/midi/device_preferences.js";
import {
  createMidiFeature,
  resolveMidiDeviceStatusPresentation,
} from "../src/features/midi/midi.js";
globalThis.document = { hidden: false, addEventListener() {} };
globalThis.window = { addEventListener() {} };

const route = (inputId, outputId, inputName, outputName = inputName) => ({
  inputDeviceId: inputId,
  outputDeviceId: outputId,
  inputDeviceName: inputName,
  outputDeviceName: outputName,
  enabled: true,
});

const initialSnapshot = {
  inputs: [
    { id: "midi:0", name: "Focusrite USB MIDI" },
    { id: "midi:1", name: "MIDI Mix" },
  ],
  outputs: [
    { id: "midi:0", name: "Microsoft GS Wavetable Synth" },
    { id: "midi:1", name: "Focusrite USB MIDI" },
    { id: "midi:2", name: "MIDI Mix" },
  ],
};
const recoveredSnapshot = {
  inputs: [...initialSnapshot.inputs, { id: "midi:2", name: "Platform X+1 V2.13" }],
  outputs: [...initialSnapshot.outputs, { id: "midi:3", name: "Platform X+1 V2.13" }],
};
const savedPreference = {
  configured: true,
  routes: [
    route("midi:0", "midi:1", "Platform X+1 V2.13"),
    route("midi:1", "midi:2", "MIDI Mix"),
  ],
};

let snapshot = initialSnapshot;
let connectedBackendRoutes = [];
let health = [];
const startCalls = [];
const startForces = [];
const profileUpdates = [];
const connectedUpdates = [];

const invoke = async (command, args = {}) => {
  if (command === "list_midi_devices") return snapshot.inputs;
  if (command === "list_midi_output_devices") return snapshot.outputs;
  if (command === "get_midi_route_health") return health;
  if (command === "get_midi_connection_health") return health[0] || null;
  if (command === "start_midi_device_routes") {
    const requested = structuredClone(args.routes || []);
    startCalls.push(requested);
    startForces.push(Boolean(args.force));
    connectedBackendRoutes = requested.toSorted((left, right) => (
      String(left.input_device_id).localeCompare(String(right.input_device_id))
    ));
    return { connectedRoutes: structuredClone(connectedBackendRoutes), failedRoutes: [], complete: true };
  }
  if (command === "stop_midi_route") {
    connectedBackendRoutes = connectedBackendRoutes.filter(
      (candidate) => candidate.input_device_id !== args.inputDeviceId,
    );
    return null;
  }
  if (command === "stop_midi_device") {
    connectedBackendRoutes = [];
    return null;
  }
  return null;
};

const translations = {
  "common.cancel": "Cancel",
  "midi.applyChanges": "Apply Changes",
  "midi.applyFailed": "Could not apply MIDI route changes: {message}",
  "midi.partialRetrying": "Some MIDI routes are unavailable; retrying automatically.",
};
const t = (key, params = {}) => Object.entries(params).reduce(
  (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
  translations[key] || key,
);

assert.deepEqual(
  resolveMidiDeviceStatusPresentation({
    routes: [],
    kind: "input",
    loading: true,
    translate: (key) => key === "midi.loadingDevices" ? "Loading devices…" : key,
  }),
  {
    activeRoutes: [],
    isLoading: true,
    label: "Loading devices…",
    additionalDevices: [],
    title: "Loading devices…",
  },
  "the top-bar device boxes should not claim that nothing is active before startup finishes",
);

const feature = createMidiFeature({
  invoke,
  dom: {},
  getSavedMidiDeviceIds: () => ({}),
  clearSavedMidiDeviceIds: async () => {},
  onProfileDeviceSelected: async (preference) => profileUpdates.push(structuredClone(preference)),
  onConnected: (connection) => connectedUpdates.push(structuredClone(connection)),
  i18n: { t },
});

const startup = await feature.syncToProfileDevice(savedPreference);
feature.stopSessionRefresh();
assert.equal(startup.partial, true);
assert.equal(startCalls.length, 1);
assert.deepEqual(
  startCalls[0].map((item) => item.input_device_name),
  ["MIDI Mix"],
  "startup should keep the healthy route active",
);
assert.equal(profileUpdates.at(-1).routes.length, 2, "the missing desired route must remain persisted");

snapshot = recoveredSnapshot;
health = [{
  inputDeviceId: "midi:1",
  outputDeviceId: "midi:2",
  suspect: true,
  inputSuspect: true,
  reason: "input_inventory_changed",
}];
await feature.checkAvailabilityNow();
feature.stopSessionRefresh();
assert.equal(startCalls.length, 2);
assert.equal(startForces[1], false, "suspect recovery must not force healthy routes to reconnect");
assert.deepEqual(
  startCalls[1].map((item) => [item.input_device_id, item.output_device_id, item.input_device_name]),
  [
    ["midi:2", "midi:3", "Platform X+1 V2.13"],
    ["midi:1", "midi:2", "MIDI Mix"],
  ],
  "recovery must canonicalize every desired route before reconnecting",
);
assert.deepEqual(
  connectedUpdates.at(-1).routes.map((item) => item.inputDeviceName),
  ["Platform X+1 V2.13", "MIDI Mix"],
  "backend map ordering must not change the first displayed profile route",
);

const routeEditor = midiPreferences.createMidiRouteDraftController();
const originalRoutes = [route("midi:0", "midi:1", "Focusrite USB MIDI")];
routeEditor.begin(originalRoutes);
routeEditor.replace([route("midi:2", "midi:1", "Platform X+1 V2.13", "Focusrite USB MIDI")]);
routeEditor.replace([route("midi:2", "midi:3", "Platform X+1 V2.13")]);
let editorApplyCalls = 0;
assert.equal(editorApplyCalls, 0, "draft edits must not apply routes");
await routeEditor.commit(async (routes) => {
  editorApplyCalls += 1;
  assert.deepEqual(
    [routes[0].inputDeviceId, routes[0].outputDeviceId],
    ["midi:2", "midi:3"],
  );
});
assert.equal(editorApplyCalls, 1, "committing two dropdown edits should apply once");
assert.equal(routeEditor.isDirty(), false, "a successful Apply should disable Apply Changes again");

routeEditor.begin(originalRoutes);
routeEditor.replace([route("midi:2", "midi:3", "Platform X+1 V2.13")]);
routeEditor.discard();
assert.deepEqual(routeEditor.current(originalRoutes), originalRoutes, "Cancel must restore desired routes");

routeEditor.begin(originalRoutes);
routeEditor.replace([route("midi:2", "midi:3", "Platform X+1 V2.13")]);
routeEditor.replace(originalRoutes);
assert.equal(routeEditor.isDirty(), false, "reverting every edit must disable Apply Changes");

routeEditor.begin(originalRoutes);
routeEditor.replace([route("midi:2", "midi:3", "Platform X+1 V2.13")]);
await assert.rejects(
  routeEditor.commit(async () => {
    throw new Error("simulated apply failure");
  }),
  /simulated apply failure/,
);
assert.equal(routeEditor.isDirty(), true, "a failed Apply must keep the draft dirty");
assert.equal(routeEditor.draft()[0].inputDeviceName, "Platform X+1 V2.13");

const oneSidedProfileUpdates = [];
const oneSidedFeature = createMidiFeature({
  invoke: async (command) => {
    if (command === "list_midi_devices") {
      return [{ id: "midi:2", name: "Platform X+1 V2.13" }];
    }
    if (command === "list_midi_output_devices") return [];
    return null;
  },
  dom: {},
  onProfileDeviceSelected: async (preference) => {
    oneSidedProfileUpdates.push(structuredClone(preference));
  },
  i18n: { t },
});
await oneSidedFeature.syncToProfileDevice({
  configured: true,
  routes: [route("midi:0", "midi:1", "Platform X+1 V2.13")],
});
assert.equal(
  oneSidedProfileUpdates.at(-1).routes[0].inputDeviceId,
  "midi:0",
  "a one-sided match must not migrate route IDs before a successful connection",
);

const retrySnapshots = [
  { inputs: [], outputs: [] },
  recoveredSnapshot,
];
let inputEnumerations = 0;
let outputEnumerations = 0;
const retryFeature = createMidiFeature({
  invoke: async (command) => {
    if (command === "list_midi_devices") {
      const current = retrySnapshots[Math.min(inputEnumerations, retrySnapshots.length - 1)];
      inputEnumerations += 1;
      return current.inputs;
    }
    if (command === "list_midi_output_devices") {
      const current = retrySnapshots[Math.min(outputEnumerations, retrySnapshots.length - 1)];
      outputEnumerations += 1;
      return current.outputs;
    }
    return null;
  },
  dom: {},
  i18n: { t },
});
const retried = await retryFeature.loadMidiDevicesWithRetry();
assert.ok(inputEnumerations >= 2, "startup retries must perform fresh input enumeration");
assert.ok(outputEnumerations >= 2, "startup retries must perform fresh output enumeration");
assert.equal(retried.inputs.length, recoveredSnapshot.inputs.length);

console.log("MIDI feature lifecycle tests passed");
process.exit(0);

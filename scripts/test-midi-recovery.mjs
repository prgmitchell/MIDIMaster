import assert from "node:assert/strict";
import { createMidiFeature } from "../src/features/midi/midi.js";

globalThis.document = { hidden: false, addEventListener() {} };
globalThis.window = { addEventListener() {} };

const platform = {
  input_device_id: "midi:0",
  output_device_id: "midi:1",
  input_device_name: "Platform X+1 V2.13",
  output_device_name: "Platform X+1 V2.13",
  enabled: true,
};
const mixer = {
  input_device_id: "midi:1",
  output_device_id: "midi:2",
  input_device_name: "MIDI Mix",
  output_device_name: "MIDI Mix",
  enabled: true,
};
let devices = [platform, mixer];
let health = [];
let failInputs = new Set();
const starts = [];
const connected = [];
let disconnected = 0;
const midiStatus = { textContent: "" };
const feature = createMidiFeature({
  dom: { midiStatus },
  i18n: { t: (key) => key },
  onConnected: (state) => connected.push(state),
  onDisconnected: () => { disconnected += 1; },
  invoke: async (command, args = {}) => {
    if (command === "list_midi_devices") {
      return devices.map((r) => ({ id: r.input_device_id, name: r.input_device_name }));
    }
    if (command === "list_midi_output_devices") {
      return devices.map((r) => ({ id: r.output_device_id, name: r.output_device_name }));
    }
    if (command === "get_midi_route_health") return health;
    if (command === "start_midi_device_routes") {
      starts.push(structuredClone(args));
      const failedRoutes = args.routes.filter((r) => failInputs.has(r.input_device_id))
        .map((route) => ({ route, reason: "could not create Windows MM MIDI output port" }));
      return {
        connectedRoutes: args.routes.filter((r) => !failInputs.has(r.input_device_id)),
        failedRoutes,
        complete: failedRoutes.length === 0,
      };
    }
    return null;
  },
});

try {
  await feature.syncToProfileDevice({ configured: true, routes: devices });
  feature.stopSessionRefresh();
  assert.equal(starts.length, 1);

  // The inventory is unchanged, but the existing output handle has failed.
  health = [{ inputDeviceId: "midi:0", outputDeviceId: "midi:1", connected: false,
    suspect: true, outputSuspect: true, reason: "output_reconnect_failed" }];
  failInputs.add("midi:0");
  await feature.checkAvailabilityNow();
  feature.stopSessionRefresh();
  assert.equal(starts.length, 2, "same-ID recovery must reach the backend");
  assert.equal(starts.at(-1).force, false, "healthy routes must not be forcibly reopened");
  assert.deepEqual(connected.at(-1).routes.map((r) => r.inputDeviceName), ["MIDI Mix"]);
  assert.equal(midiStatus.textContent, "midi.partialRetrying");

  // Present in inventory does not mean a failed open succeeded on the next poll.
  await feature.checkAvailabilityNow();
  feature.stopSessionRefresh();
  assert.equal(starts.length, 3);
  assert.equal(midiStatus.textContent, "midi.partialRetrying", "failed retries cannot claim reconnection");

  failInputs.clear();
  await feature.checkAvailabilityNow();
  feature.stopSessionRefresh();
  assert.equal(starts.length, 4, "the saved failed route must keep retrying");
  assert.equal(connected.at(-1).routes.length, 2);
  assert.equal(midiStatus.textContent, "midi.reconnectedProfile");

  // A backend reporting disconnected without suspect flags also needs recovery.
  health = [{ inputDeviceId: "midi:0", outputDeviceId: "midi:1", connected: false }];
  failInputs = new Set(["midi:0", "midi:1"]);
  const connectedCount = connected.length;
  await feature.checkAvailabilityNow();
  feature.stopSessionRefresh();
  assert.equal(starts.length, 5);
  assert.equal(connected.length, connectedCount, "zero active routes must not call onConnected");
  assert.equal(disconnected, 1);
  assert.equal(midiStatus.textContent, "midi.partialRetrying");

  // Power cycling reorders port IDs; reconnect using the saved device names.
  devices = [
    { ...platform, input_device_id: "midi:4", output_device_id: "midi:5" },
    mixer,
  ];
  failInputs.clear();
  health = [];
  await feature.checkAvailabilityNow();
  feature.stopSessionRefresh();
  assert.equal(starts.at(-1).routes[0].input_device_id, "midi:4");
  assert.equal(starts.at(-1).routes[0].output_device_id, "midi:5");
  assert.equal(connected.at(-1).routes.length, 2);

  const recoveredStarts = starts.length;
  await feature.checkAvailabilityNow();
  assert.equal(starts.length, recoveredStarts, "healthy unchanged routes must stay open");
  console.log("MIDI same-ID failure and power-cycle recovery tests passed");
} finally {
  feature.dispose();
}

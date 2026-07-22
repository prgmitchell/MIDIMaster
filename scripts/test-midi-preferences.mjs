import assert from "node:assert/strict";
import {
  buildPersistedMidiPreference,
  hasMidiPreference,
  normalizeMidiPreference,
  normalizeMidiRoutes,
} from "../src/core/midi_preferences.js";

const normalized = normalizeMidiPreference({
  midi_device_preference_set: true,
  midi_device_routes: [{
    input_device_id: " input-1 ",
    output_device_id: " output-1 ",
    input_device_name: " Controller ",
    output_device_name: " Controller ",
  }],
});

assert.equal(normalized.configured, true);
assert.deepEqual(normalized.routes, [{
  inputDeviceId: "input-1",
  outputDeviceId: "output-1",
  inputDeviceName: "Controller",
  outputDeviceName: "Controller",
  enabled: true,
}]);
assert.equal(hasMidiPreference(normalized), true);

assert.deepEqual(normalizeMidiRoutes({
  input_device_id: "legacy-in",
  output_device_id: "legacy-out",
}), [{
  inputDeviceId: "legacy-in",
  outputDeviceId: "legacy-out",
  inputDeviceName: "",
  outputDeviceName: "",
  enabled: true,
}]);

assert.equal(normalizeMidiRoutes({ routes: [
  {
    inputDeviceId: "same-id",
    outputDeviceId: "out-1",
    inputDeviceName: "Controller",
  },
  {
    inputDeviceId: "same-id",
    outputDeviceId: "out-2",
    inputDeviceName: "Controller (Unavailable)",
  },
] }).length, 1);

assert.deepEqual(buildPersistedMidiPreference(normalized), {
  input_device_id: "input-1",
  output_device_id: "output-1",
  input_device_name: "Controller",
  output_device_name: "Controller",
  routes: [{
    input_device_id: "input-1",
    output_device_id: "output-1",
    input_device_name: "Controller",
    output_device_name: "Controller",
    enabled: true,
  }],
});

console.log("MIDI preference tests passed");

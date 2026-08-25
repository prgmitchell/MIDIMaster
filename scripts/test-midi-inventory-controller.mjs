import assert from "node:assert/strict";
import { createMidiInventoryController } from "../src/app/midi_inventory_controller.js";

let state = { midiDeviceInventoryConsent: "enabled", midiDeviceInventoryNoticeVersion: 1 };
const calls = [];
const timers = [];
const controller = createMidiInventoryController({
  invoke: async (command, args = {}) => {
    calls.push([command, args]);
    if (command === "update_midi_device_inventory_consent") return args;
    return null;
  },
  settingsStore: {
    get: () => state,
    update: (patch) => { state = { ...state, ...patch }; },
  },
  syncSettingsUi: () => {},
  showChoices: async () => "disabled",
  translate: (key) => key,
  setTimer: (callback) => { timers.push(callback); return timers.length; },
  clearTimer: () => {},
});

controller.queueSubmit("test");
assert.equal(timers.length, 1);
await timers.shift()();
assert.deepEqual(calls[0], ["submit_midi_device_inventory", {}]);

state = { midiDeviceInventoryConsent: "unknown", midiDeviceInventoryNoticeVersion: 0 };
await controller.maybePromptConsent();
assert.deepEqual(calls[1], [
  "update_midi_device_inventory_consent",
  { consent: "disabled", noticeVersion: 1 },
]);
assert.equal(state.midiDeviceInventoryConsent, "disabled");

console.log("MIDI inventory controller tests passed");

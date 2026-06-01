import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/features/midi/device_preferences.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const midiPreferences = await import(moduleUrl);

const platformPreference = {
  inputDeviceId: "midi:0",
  outputDeviceId: "midi:0",
  inputDeviceName: "Platform X+1 V2.13",
  outputDeviceName: "Platform X+1 V2.13",
};

function testDropdownStateRequiresActiveConnection() {
  const connected = midiPreferences.resolveMidiDeviceDropdownState({
    selectedValue: "midi:0",
    connectedDeviceId: "midi:0",
  });
  assert.equal(connected.connected, true);
  assert.equal(connected.unavailable, false);
  assert.equal(connected.empty, false);

  const unavailable = midiPreferences.resolveMidiDeviceDropdownState({
    selectedValue: "midi:0",
    selectedUnavailable: true,
    connectedDeviceId: "midi:0",
  });
  assert.equal(unavailable.connected, false);
  assert.equal(unavailable.unavailable, true);

  const availableButDisconnected = midiPreferences.resolveMidiDeviceDropdownState({
    selectedValue: "midi:0",
    selectedUnavailable: false,
    connectedDeviceId: "",
  });
  assert.equal(availableButDisconnected.connected, false);
  assert.equal(availableButDisconnected.unavailable, false);
  assert.equal(availableButDisconnected.available, true);

  const empty = midiPreferences.resolveMidiDeviceDropdownState();
  assert.equal(empty.empty, true);
  assert.equal(empty.connected, false);
  assert.equal(empty.unavailable, false);
}

function testPreferredPairDisappearsAndReturnsByName() {
  const missing = midiPreferences.resolvePreferredMidiDevicePair(
    { inputs: [], outputs: [] },
    platformPreference,
  );
  assert.equal(missing.available, false);
  assert.equal(missing.inputMatch, null);
  assert.equal(missing.outputMatch, null);

  const reappearedWithShiftedIds = midiPreferences.resolvePreferredMidiDevicePair(
    {
      inputs: [{ id: "midi:2", name: "Platform X+1 V2.13" }],
      outputs: [{ id: "midi:3", name: "Platform X+1 V2.13" }],
    },
    platformPreference,
  );
  assert.equal(reappearedWithShiftedIds.available, true);
  assert.equal(reappearedWithShiftedIds.inputMatch.id, "midi:2");
  assert.equal(reappearedWithShiftedIds.outputMatch.id, "midi:3");
}

function testHotplugStatusFlow() {
  const initiallyConnected = midiPreferences.resolveMidiDeviceDropdownState({
    selectedValue: "midi:0",
    connectedDeviceId: "midi:0",
  });
  assert.equal(initiallyConnected.connected, true);

  const missingPair = midiPreferences.resolvePreferredMidiDevicePair(
    { inputs: [], outputs: [] },
    platformPreference,
  );
  const unplugged = midiPreferences.resolveMidiDeviceDropdownState({
    selectedValue: platformPreference.inputDeviceId,
    selectedUnavailable: !missingPair.inputMatch,
    connectedDeviceId: "",
  });
  assert.equal(unplugged.connected, false);
  assert.equal(unplugged.unavailable, true);

  const repluggedPair = midiPreferences.resolvePreferredMidiDevicePair(
    {
      inputs: [{ id: "midi:0", name: "Platform X+1 V2.13" }],
      outputs: [{ id: "midi:0", name: "Platform X+1 V2.13" }],
    },
    platformPreference,
  );
  assert.equal(repluggedPair.available, true);

  const availableBeforeStart = midiPreferences.resolveMidiDeviceDropdownState({
    selectedValue: repluggedPair.inputMatch.id,
    selectedUnavailable: false,
    connectedDeviceId: "",
  });
  assert.equal(availableBeforeStart.connected, false);
  assert.equal(availableBeforeStart.unavailable, false);

  const connectedAfterStart = midiPreferences.resolveMidiDeviceDropdownState({
    selectedValue: repluggedPair.inputMatch.id,
    selectedUnavailable: false,
    connectedDeviceId: repluggedPair.inputMatch.id,
  });
  assert.equal(connectedAfterStart.connected, true);
}

testDropdownStateRequiresActiveConnection();
testPreferredPairDisappearsAndReturnsByName();
testHotplugStatusFlow();

console.log("MIDI hotplug tests passed");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/features/midi/device_preferences.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const midiPreferences = await import(moduleUrl);
const appPreferencesSource = await readFile(new URL("../src/app/preferences.js", import.meta.url), "utf8");
const appPreferencesModuleUrl = `data:text/javascript;base64,${Buffer.from(appPreferencesSource).toString("base64")}`;
const appPreferences = await import(appPreferencesModuleUrl);

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

function testLegacyPreferenceNormalizesToSingleRoute() {
  const pref = midiPreferences.normalizeMidiPreference(platformPreference);

  assert.equal(pref.routes.length, 1);
  assert.equal(pref.routes[0].inputDeviceId, "midi:0");
  assert.equal(pref.routes[0].outputDeviceId, "midi:0");
  assert.equal(pref.routes[0].enabled, true);

  const persisted = midiPreferences.buildPersistedMidiRoutes(pref.routes);
  assert.deepEqual(persisted, [{
    input_device_id: "midi:0",
    output_device_id: "midi:0",
    input_device_name: "Platform X+1 V2.13",
    output_device_name: "Platform X+1 V2.13",
    enabled: true,
  }]);
}

function testPreferredRoutesReturnByNameWithShiftedIds() {
  const preference = {
    routes: [
      {
        inputDeviceId: "midi:0",
        outputDeviceId: "midi:10",
        inputDeviceName: "Deck A",
        outputDeviceName: "Deck A Out",
      },
      {
        inputDeviceId: "midi:1",
        outputDeviceId: "midi:11",
        inputDeviceName: "Deck B",
        outputDeviceName: "Deck B Out",
      },
    ],
  };

  const resolved = midiPreferences.resolvePreferredMidiDeviceRoutes({
    inputs: [
      { id: "midi:4", name: "Deck B" },
      { id: "midi:3", name: "Deck A" },
    ],
    outputs: [
      { id: "midi:14", name: "Deck B Out" },
      { id: "midi:13", name: "Deck A Out" },
    ],
  }, preference);

  assert.equal(resolved.available, true);
  assert.equal(resolved.routes[0].inputMatch.id, "midi:3");
  assert.equal(resolved.routes[0].outputMatch.id, "midi:13");
  assert.equal(resolved.routes[1].inputMatch.id, "midi:4");
  assert.equal(resolved.routes[1].outputMatch.id, "midi:14");
}

function testDuplicateInputsAndSharedOutputs() {
  const duplicateRoutes = [
    { inputDeviceId: "midi:0", outputDeviceId: "midi:10", inputDeviceName: "Deck A" },
    { inputDeviceId: "midi:1", outputDeviceId: "midi:10", inputDeviceName: "Deck B" },
    { inputDeviceId: "midi:0", outputDeviceId: "midi:11", inputDeviceName: "Deck A" },
  ];

  assert.equal(midiPreferences.hasDuplicateInputRoute(duplicateRoutes, "midi:0", 0), true);
  assert.equal(midiPreferences.hasDuplicateInputRoute(duplicateRoutes, "midi:1", 1), false);
  assert.equal(midiPreferences.hasDuplicateInputRoute([
    { inputDeviceId: "midi:0", outputDeviceId: "midi:10", inputDeviceName: "Platform X+1 V2.13" },
    { inputDeviceId: "midi:0", outputDeviceId: "midi:11", inputDeviceName: "MIDI Mix" },
  ], "midi:0", 0), false);

  const counts = midiPreferences.sharedOutputCounts([
    { inputDeviceId: "midi:0", outputDeviceId: "midi:10" },
    { inputDeviceId: "midi:1", outputDeviceId: "midi:10" },
    { inputDeviceId: "midi:2", outputDeviceId: "midi:11" },
  ]);
  assert.equal(counts.get("midi:10"), 2);
  assert.equal(counts.get("midi:11"), 1);
}

function testTwoRoutesOneDisappearsOtherRemainsResolvable() {
  const preference = {
    routes: [
      {
        inputDeviceId: "midi:0",
        outputDeviceId: "midi:10",
        inputDeviceName: "Deck A",
        outputDeviceName: "Deck A Out",
      },
      {
        inputDeviceId: "midi:1",
        outputDeviceId: "midi:11",
        inputDeviceName: "Deck B",
        outputDeviceName: "Deck B Out",
      },
    ],
  };

  const resolved = midiPreferences.resolvePreferredMidiDeviceRoutes({
    inputs: [{ id: "midi:1", name: "Deck B" }],
    outputs: [{ id: "midi:11", name: "Deck B Out" }],
  }, preference);

  assert.equal(resolved.available, false);
  assert.equal(resolved.routes[0].available, false);
  assert.equal(resolved.routes[1].available, true);
  assert.equal(resolved.routes[1].inputMatch.id, "midi:1");
  assert.equal(resolved.routes[1].outputMatch.id, "midi:11");
}

function testSavedRouteDoesNotMatchReusedIdWithDifferentName() {
  const resolved = midiPreferences.resolvePreferredMidiDeviceRoutes({
    inputs: [{ id: "midi:0", name: "Focusrite USB MIDI" }],
    outputs: [{ id: "midi:10", name: "Focusrite USB MIDI" }],
  }, {
    routes: [{
      inputDeviceId: "midi:0",
      outputDeviceId: "midi:10",
      inputDeviceName: "Platform X+1 V2.13",
      outputDeviceName: "Platform X+1 V2.13",
    }],
  });

  assert.equal(resolved.available, false);
  assert.equal(resolved.routes[0].available, false);
  assert.equal(resolved.routes[0].inputMatch, null);
  assert.equal(resolved.routes[0].outputMatch, null);
}

function testSavedRoutesKeepUnavailableRowsWhenIdsAreReused() {
  const normalized = midiPreferences.normalizeMidiRoutes({
    routes: [
      {
        inputDeviceId: "midi:0",
        outputDeviceId: "midi:10",
        inputDeviceName: "Platform X+1 V2.13",
        outputDeviceName: "Platform X+1 V2.13",
      },
      {
        inputDeviceId: "midi:0",
        outputDeviceId: "midi:10",
        inputDeviceName: "MIDI Mix",
        outputDeviceName: "MIDI Mix",
      },
    ],
  });

  assert.equal(normalized.length, 2);

  const resolved = midiPreferences.resolvePreferredMidiDeviceRoutes({
    inputs: [{ id: "midi:0", name: "MIDI Mix" }],
    outputs: [{ id: "midi:10", name: "MIDI Mix" }],
  }, { routes: normalized });

  assert.equal(resolved.available, false);
  assert.equal(resolved.routes.length, 2);
  assert.equal(resolved.routes[0].available, false);
  assert.equal(resolved.routes[0].inputMatch, null);
  assert.equal(resolved.routes[1].available, true);
  assert.equal(resolved.routes[1].inputMatch.id, "midi:0");
  assert.equal(resolved.routes[1].outputMatch.id, "midi:10");
}

function testStartupPreferencesKeepUnavailableRowsWhenIdsAreReused() {
  const normalized = appPreferences.normalizeProfileMidiRoutes({
    routes: [
      {
        inputDeviceId: "midi:0",
        outputDeviceId: "midi:10",
        inputDeviceName: "Platform X+1 V2.13",
        outputDeviceName: "Platform X+1 V2.13",
      },
      {
        inputDeviceId: "midi:0",
        outputDeviceId: "midi:10",
        inputDeviceName: "MIDI Mix",
        outputDeviceName: "MIDI Mix",
      },
    ],
  });

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].inputDeviceName, "Platform X+1 V2.13");
  assert.equal(normalized[1].inputDeviceName, "MIDI Mix");
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

function testSuspectBackendHealthTriggersSamePairRecovery() {
  const connectedPreference = {
    inputDeviceId: "midi:0",
    outputDeviceId: "midi:1",
    inputDeviceName: "nanoKONTROL2 1 SLIDER/KNOB",
    outputDeviceName: "nanoKONTROL2 1 CTRL",
  };
  const stillVisibleSnapshot = {
    inputs: [{ id: "midi:0", name: "nanoKONTROL2 1 SLIDER/KNOB" }],
    outputs: [{ id: "midi:1", name: "nanoKONTROL2 1 CTRL" }],
  };

  const visiblePair = midiPreferences.resolvePreferredMidiDevicePair(
    stillVisibleSnapshot,
    connectedPreference,
  );
  assert.equal(visiblePair.available, true);
  assert.equal(midiPreferences.shouldRecoverSuspectMidiPair({
    inputDeviceId: "midi:0",
    outputDeviceId: "midi:1",
    connected: false,
    suspect: true,
    reason: "output_send_failed",
  }, connectedPreference), true);

  const recovering = midiPreferences.resolveMidiDeviceDropdownState({
    selectedValue: connectedPreference.inputDeviceId,
    selectedUnavailable: true,
    connectedDeviceId: "",
  });
  assert.equal(recovering.connected, false);
  assert.equal(recovering.unavailable, true);

  const afterRestart = midiPreferences.resolveMidiDeviceDropdownState({
    selectedValue: visiblePair.inputMatch.id,
    selectedUnavailable: false,
    connectedDeviceId: visiblePair.inputMatch.id,
  });
  assert.equal(afterRestart.connected, true);

  assert.equal(midiPreferences.shouldRecoverSuspectMidiPair({
    inputDeviceId: "midi:2",
    outputDeviceId: "midi:1",
    suspect: true,
  }, connectedPreference), false);
  assert.equal(midiPreferences.shouldRecoverSuspectMidiPair({
    inputDeviceId: "midi:0",
    outputDeviceId: "midi:1",
    suspect: false,
  }, connectedPreference), false);
}

testDropdownStateRequiresActiveConnection();
testPreferredPairDisappearsAndReturnsByName();
testLegacyPreferenceNormalizesToSingleRoute();
testPreferredRoutesReturnByNameWithShiftedIds();
testDuplicateInputsAndSharedOutputs();
testTwoRoutesOneDisappearsOtherRemainsResolvable();
testSavedRouteDoesNotMatchReusedIdWithDifferentName();
testSavedRoutesKeepUnavailableRowsWhenIdsAreReused();
testStartupPreferencesKeepUnavailableRowsWhenIdsAreReused();
testHotplugStatusFlow();
testSuspectBackendHealthTriggersSamePairRecovery();

console.log("MIDI hotplug tests passed");

import assert from "node:assert/strict";
import { obsTestUtils } from "../src-tauri/builtin_plugins/obs/plugin.mjs";
import { readFile } from "node:fs/promises";

const obsPluginSource = await readFile(
  new URL("../src-tauri/builtin_plugins/obs/plugin.mjs", import.meta.url),
  "utf8",
);

function testMatchingLocalMuteEchoIsIgnored() {
  const intents = new Map();
  obsTestUtils.rememberLocalMuteIntent(intents, "Mic/Aux", true, 1000);

  assert.equal(obsTestUtils.shouldIgnoreLocalMuteEcho(intents, "Mic/Aux", true, 1100), true);
}

function testOppositeMuteEventPassesImmediately() {
  const intents = new Map();
  obsTestUtils.rememberLocalMuteIntent(intents, "Mic/Aux", true, 1000);

  assert.equal(obsTestUtils.shouldIgnoreLocalMuteEcho(intents, "Mic/Aux", false, 1100), false);
  assert.equal(intents.has("Mic/Aux"), false);

  assert.equal(obsTestUtils.shouldIgnoreLocalMuteEcho(intents, "Mic/Aux", true, 1110), false);
}

function testExpiredMuteIntentPasses() {
  const intents = new Map();
  obsTestUtils.rememberLocalMuteIntent(intents, "Mic/Aux", true, 1000);

  assert.equal(
    obsTestUtils.shouldIgnoreLocalMuteEcho(
      intents,
      "Mic/Aux",
      true,
      1000 + obsTestUtils.LOCAL_WRITE_QUIET_MS,
    ),
    false,
  );
  assert.equal(intents.has("Mic/Aux"), false);
}

function testMuteIntentsAreScopedByInput() {
  const intents = new Map();
  obsTestUtils.rememberLocalMuteIntent(intents, "Mic/Aux", true, 1000);

  assert.equal(obsTestUtils.shouldIgnoreLocalMuteEcho(intents, "Desktop Audio", true, 1100), false);
  assert.equal(intents.has("Mic/Aux"), true);
}

function testInputMuteFeedbackIncludesVolumeAndMuteBindings() {
  const volumeBindings = new Map([["Mic/Aux", new Set(["fader-1", "shared-binding"])]]);
  const muteBindings = new Map([["Mic/Aux", new Set(["mute-button-1", "shared-binding"])]]);

  assert.deepEqual(
    [...obsTestUtils.inputMuteFeedbackBindingIds(volumeBindings, muteBindings, "Mic/Aux")],
    ["fader-1", "shared-binding", "mute-button-1"],
  );
  assert.deepEqual(
    [...obsTestUtils.inputMuteFeedbackBindingIds(volumeBindings, muteBindings, "Desktop Audio")],
    [],
  );
}

function testSourceFiltersNormalizeToStableEntries() {
  assert.deepEqual(
    obsTestUtils.normalizeSourceFilters([
      { filterName: "Chroma Key", filterKind: "chroma_key_filter_v2", filterEnabled: true },
      { filterName: "  ", filterKind: "ignored", filterEnabled: true },
      { filterName: "Sharpen", filterEnabled: false },
    ]),
    [
      { filterName: "Chroma Key", filterKind: "chroma_key_filter_v2", filterEnabled: true },
      { filterName: "Sharpen", filterKind: "", filterEnabled: false },
    ],
  );
}

function testSourceFilterActionTargetsFilterInsteadOfVisibility() {
  const action = obsTestUtils.makeSourceFilterButtonAction("Video Capture Device", "Chroma Key");

  assert.equal(action.label, "Toggle Chroma Key");
  assert.equal(action.value, "ToggleEffect");
  assert.equal(action.behavior, "stateful");
  assert.equal(action.targetOption.label, "Video Capture Device - Chroma Key");
  assert.deepEqual(action.targetOption.target, {
    Integration: {
      integration_id: "obs",
      kind: "source_filter",
      data: {
        source_name: "Video Capture Device",
        filter_name: "Chroma Key",
        action_kind: "stateful",
      },
    },
  });
}

function testSourceFilterKeysUseSourceAndFilterNames() {
  assert.equal(
    obsTestUtils.sourceFilterKey("Video Capture Device", "Chroma Key"),
    "Video Capture Device\u0000Chroma Key",
  );
}

function testDisconnectFeedbackClearsObsMuteAndStatefulLights() {
  const bindings = [
    {
      id: "obs-fader",
      action: "Volume",
      targets: [{ Integration: { integration_id: "obs", kind: "input", data: { input_name: "Mic/Aux" } } }],
    },
    {
      id: "obs-mute",
      action: "ToggleMute",
      target: {
        Integration: { integration_id: "obs", kind: "input", data: { input_name: "Desktop Audio" } },
      },
    },
    {
      id: "obs-source",
      action: "ToggleMute",
      target: { Integration: { integration_id: "obs", kind: "source", data: { source_name: "Camera" } } },
    },
    {
      id: "obs-filter",
      action: "ToggleEffect",
      target: {
        Integration: { integration_id: "obs", kind: "source_filter", data: { filter_name: "Chroma Key" } },
      },
    },
  ];

  assert.deepEqual(obsTestUtils.obsDisconnectedFeedbackUpdates(bindings), [
    { bindingId: "obs-fader", action: "ToggleMute" },
    { bindingId: "obs-mute", action: "ToggleMute" },
    { bindingId: "obs-source", action: "ToggleMute" },
    { bindingId: "obs-filter", action: "ToggleEffect" },
  ]);
}

function testDisconnectFeedbackIgnoresUnrelatedAndMomentaryBindings() {
  const bindings = [
    {
      id: "wavelink-mute",
      action: "ToggleMute",
      target: { Integration: { integration_id: "wavelink", kind: "input", data: {} } },
    },
    {
      id: "obs-scene",
      action: "Volume",
      target: { Integration: { integration_id: "obs", kind: "scene", data: { scene_name: "Main" } } },
    },
  ];

  assert.deepEqual(obsTestUtils.obsDisconnectedFeedbackUpdates(bindings), []);
}

// The emitted-package runtime test verifies silent disconnect feedback.

testMatchingLocalMuteEchoIsIgnored();
testOppositeMuteEventPassesImmediately();
testExpiredMuteIntentPasses();
testMuteIntentsAreScopedByInput();
testInputMuteFeedbackIncludesVolumeAndMuteBindings();
testSourceFiltersNormalizeToStableEntries();
testSourceFilterActionTargetsFilterInsteadOfVisibility();
testSourceFilterKeysUseSourceAndFilterNames();
testDisconnectFeedbackClearsObsMuteAndStatefulLights();
testDisconnectFeedbackIgnoresUnrelatedAndMomentaryBindings();

console.log("OBS plugin tests passed");

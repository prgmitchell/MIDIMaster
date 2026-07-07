import assert from "node:assert/strict";
import { obsTestUtils } from "../src-tauri/builtin_plugins/obs/plugin.mjs";

function testMatchingLocalMuteEchoIsIgnored() {
  const intents = new Map();
  obsTestUtils.rememberLocalMuteIntent(intents, "Mic/Aux", true, 1000);

  assert.equal(
    obsTestUtils.shouldIgnoreLocalMuteEcho(intents, "Mic/Aux", true, 1100),
    true,
  );
}

function testOppositeMuteEventPassesImmediately() {
  const intents = new Map();
  obsTestUtils.rememberLocalMuteIntent(intents, "Mic/Aux", true, 1000);

  assert.equal(
    obsTestUtils.shouldIgnoreLocalMuteEcho(intents, "Mic/Aux", false, 1100),
    false,
  );
  assert.equal(intents.has("Mic/Aux"), false);

  assert.equal(
    obsTestUtils.shouldIgnoreLocalMuteEcho(intents, "Mic/Aux", true, 1110),
    false,
  );
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

  assert.equal(
    obsTestUtils.shouldIgnoreLocalMuteEcho(intents, "Desktop Audio", true, 1100),
    false,
  );
  assert.equal(intents.has("Mic/Aux"), true);
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
  assert.deepEqual(
    action.targetOption.target,
    {
      Integration: {
        integration_id: "obs",
        kind: "source_filter",
        data: {
          source_name: "Video Capture Device",
          filter_name: "Chroma Key",
          action_kind: "stateful",
        },
      },
    },
  );
}

function testSourceFilterKeysUseSourceAndFilterNames() {
  assert.equal(
    obsTestUtils.sourceFilterKey("Video Capture Device", "Chroma Key"),
    "Video Capture Device\u0000Chroma Key",
  );
}

testMatchingLocalMuteEchoIsIgnored();
testOppositeMuteEventPassesImmediately();
testExpiredMuteIntentPasses();
testMuteIntentsAreScopedByInput();
testSourceFiltersNormalizeToStableEntries();
testSourceFilterActionTargetsFilterInsteadOfVisibility();
testSourceFilterKeysUseSourceAndFilterNames();

console.log("OBS plugin tests passed");

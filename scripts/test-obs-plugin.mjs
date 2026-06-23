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

testMatchingLocalMuteEchoIsIgnored();
testOppositeMuteEventPassesImmediately();
testExpiredMuteIntentPasses();
testMuteIntentsAreScopedByInput();

console.log("OBS plugin tests passed");

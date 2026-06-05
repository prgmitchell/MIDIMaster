import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const targetCoreSource = await readFile(new URL("../src/core/target_core.js", import.meta.url), "utf8");
const targetCoreModuleUrl = `data:text/javascript;base64,${Buffer.from(targetCoreSource).toString("base64")}`;
const { createTargetCore } = await import(targetCoreModuleUrl);

const sessionRefreshSource = await readFile(new URL("../src/app/session_refresh.js", import.meta.url), "utf8");
const sessionRefreshModuleUrl = `data:text/javascript;base64,${Buffer.from(sessionRefreshSource).toString("base64")}`;
const { createSessionRefresher } = await import(sessionRefreshModuleUrl);

let focusedSession = null;

const targetCore = createTargetCore({
  masterIconData: "master",
  focusIconData: "focus",
  mediaPlayPauseIconData: "media",
  getSessions: () => [],
  getPlaybackDevices: () => [],
  getRecordingDevices: () => [],
  getFocusedSession: () => focusedSession,
  getPluginHost: () => null,
  getIntegrationTargetState: () => null,
});

function testFocusVolumeAndMuteResolveFromFocusedSession() {
  focusedSession = {
    id: "session-firefox",
    display_name: "Firefox",
    volume: 0.73,
    is_muted: true,
    icon_data: "firefox-icon",
  };

  assert.equal(targetCore.getVolumeForTarget("Focus"), 0.73);
  assert.equal(targetCore.resolveTargetVolume("Focus"), 0.73);
  assert.equal(targetCore.getMuteForTarget("Focus"), true);
  assert.deepEqual(targetCore.resolveOsdTarget("Focus"), {
    label: "Focused: Firefox",
    icon_data: "firefox-icon",
  });
}

function testFocusValueTracksFocusChangesWithoutSessionListChanges() {
  focusedSession = null;
  assert.equal(targetCore.getVolumeForTarget("Focus"), null);
  assert.equal(targetCore.getMuteForTarget("Focus"), false);

  focusedSession = {
    id: "session-teams",
    display_name: "Microsoft Teams",
    volume: 0.18,
    is_muted: false,
    icon_data: null,
  };

  assert.equal(targetCore.getVolumeForTarget("Focus"), 0.18);
  assert.equal(targetCore.getMuteForTarget("Focus"), false);
}

function testNormalizeSessionKeyPrefersApplicationKey() {
  assert.equal(
    targetCore.normalizeSessionKey({
      application_key: "package:5319275A.WhatsAppDesktop_cv1g1gvanyjgm",
      process_name: "ApplicationFrameHost.exe",
      display_name: "WhatsApp",
    }),
    "package:5319275a.whatsappdesktop_cv1g1gvanyjgm",
  );
}

function testNormalizeSessionKeyAvoidsPidOnlyFallback() {
  assert.equal(
    targetCore.normalizeSessionKey({
      process_name: "PID 1234",
      display_name: "PID 1234",
    }),
    "",
  );
}

function testNormalizeSessionKeyAvoidsWebView2Fallback() {
  assert.equal(
    targetCore.normalizeSessionKey({
      process_path: "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe",
      process_name: "msedgewebview2.exe",
      display_name: "WhatsApp",
    }),
    "whatsapp",
  );
  assert.equal(
    targetCore.normalizeSessionKey({
      process_path: "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe",
      process_name: "msedgewebview2.exe",
      application_key: "package:5319275A.WhatsAppDesktop_cv1g1gvanyjgm",
      display_name: "WhatsApp",
    }),
    "package:5319275a.whatsappdesktop_cv1g1gvanyjgm",
  );
}

function testPackageProductNameMatchesLegacyApplicationTarget() {
  const sessions = [{
    id: "session-whatsapp",
    display_name: "WhatsApp",
    application_key: "package:5319275A.WhatsAppDesktop_cv1g1gvanyjgm",
    process_name: "WhatsApp.Root.exe",
    volume: 0.42,
    muted: true,
    icon_data: "whatsapp-icon",
  }];
  const core = createTargetCore({
    masterIconData: "master",
    focusIconData: "focus",
    mediaPlayPauseIconData: "media",
    getSessions: () => sessions,
    getPlaybackDevices: () => [],
    getRecordingDevices: () => [],
    getFocusedSession: () => null,
    getPluginHost: () => null,
    getIntegrationTargetState: () => null,
  });
  const legacyTarget = { Application: { name: "whatsappdesktop" } };

  assert.equal(core.getVolumeForTarget(legacyTarget), 0.42);
  assert.equal(core.resolveTargetVolume(legacyTarget), 0.42);
  assert.equal(core.getMuteForTarget(legacyTarget), true);
  assert.deepEqual(core.resolveOsdTarget(legacyTarget), {
    label: "WhatsApp",
    icon_data: "whatsapp-icon",
  });
}

async function testFocusRefreshUpdatesTargetDisplaysWithoutSessionListChanges() {
  let state = {
    sessions: [],
    focusedSession: null,
    playbackDevices: [],
    recordingDevices: [],
    sessionsContainer: null,
  };
  const nextFocusedSession = {
    id: "session-spotify",
    display_name: "Spotify",
    volume: 0.64,
    is_muted: false,
    icon_data: "spotify-icon",
  };
  let renderCount = 0;
  let valueRefreshCount = 0;
  let targetDisplayRefreshCount = 0;

  const refresher = createSessionRefresher({
    invoke: async (command) => {
      if (command === "focused_session") return nextFocusedSession;
      return [];
    },
    getState: () => state,
    setState: (next) => {
      state = { ...state, ...next };
    },
    actions: {
      isBindingInteractionActive: () => false,
      renderBindings: () => {
        renderCount += 1;
      },
      updateBindingValues: () => {
        valueRefreshCount += 1;
      },
      updateBindingTargetDisplays: () => {
        targetDisplayRefreshCount += 1;
      },
    },
  });

  await refresher.refreshSessions();

  assert.deepEqual(state.focusedSession, nextFocusedSession);
  assert.equal(targetDisplayRefreshCount, 1);
  assert.equal(valueRefreshCount, 1);
  assert.equal(renderCount, 0);
}

testFocusVolumeAndMuteResolveFromFocusedSession();
testFocusValueTracksFocusChangesWithoutSessionListChanges();
testNormalizeSessionKeyPrefersApplicationKey();
testNormalizeSessionKeyAvoidsPidOnlyFallback();
testNormalizeSessionKeyAvoidsWebView2Fallback();
testPackageProductNameMatchesLegacyApplicationTarget();
await testFocusRefreshUpdatesTargetDisplaysWithoutSessionListChanges();

console.log("Target core focus tests passed");

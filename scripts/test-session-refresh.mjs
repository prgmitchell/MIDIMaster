import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app/session_refresh.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { createSessionRefresher } = await import(moduleUrl);

function createHarness({
  state,
  responses,
  getLastVolumeUpdateAt = () => 0,
  deviceRefreshIntervalMs = 60_000,
} = {}) {
  const calls = [];
  const actions = {
    renderBindings: 0,
    updateBindingValues: 0,
    updateBindingTargetDisplays: 0,
  };
  const refresher = createSessionRefresher({
    invoke: async (command) => {
      calls.push(command);
      return responses[command];
    },
    getState: () => state,
    setState: (next) => {
      Object.assign(state, next);
    },
    actions: {
      isBindingInteractionActive: () => false,
      renderBindings: () => { actions.renderBindings += 1; },
      updateBindingValues: () => { actions.updateBindingValues += 1; },
      updateBindingTargetDisplays: () => { actions.updateBindingTargetDisplays += 1; },
    },
    getLastVolumeUpdateAt,
    deviceRefreshIntervalMs,
  });
  return { refresher, calls, actions, state };
}

const baseSession = {
  id: "session-1",
  display_name: "Music",
  application_key: "music.exe",
  process_name: "music.exe",
  process_path: "C:/Music/music.exe",
  icon_data: "data:image/png;base64,old",
  volume: 0.25,
  is_muted: false,
  is_master: false,
};

async function testVolumeOnlyChangeUpdatesValuesNotFullRender() {
  const harness = createHarness({
    state: {
      sessions: [{ ...baseSession }],
      focusedSession: null,
      playbackDevices: [],
      recordingDevices: [],
      sessionsContainer: null,
    },
    responses: {
      list_sessions: [{ ...baseSession, volume: 0.7 }],
      focused_session: null,
      list_playback_devices: [],
      list_recording_devices: [],
    },
  });

  await harness.refresher.refreshSessions({ force: true });

  assert.equal(harness.actions.renderBindings, 0);
  assert.equal(harness.actions.updateBindingValues, 1);
  assert.equal(harness.state.sessions[0].volume, 0.7);
}

async function testStructureChangeRerendersBindings() {
  const harness = createHarness({
    state: {
      sessions: [{ ...baseSession }],
      focusedSession: null,
      playbackDevices: [],
      recordingDevices: [],
      sessionsContainer: null,
    },
    responses: {
      list_sessions: [{ ...baseSession, id: "session-2" }],
      focused_session: null,
      list_playback_devices: [],
      list_recording_devices: [],
    },
  });

  await harness.refresher.refreshSessions({ force: true });

  assert.equal(harness.actions.renderBindings, 1);
  assert.equal(harness.actions.updateBindingValues, 0);
}

async function testIconOnlyChangeDoesNotForceWork() {
  const harness = createHarness({
    state: {
      sessions: [{ ...baseSession }],
      focusedSession: null,
      playbackDevices: [],
      recordingDevices: [],
      sessionsContainer: null,
    },
    responses: {
      list_sessions: [{ ...baseSession, icon_data: "data:image/png;base64,new" }],
      focused_session: null,
      list_playback_devices: [],
      list_recording_devices: [],
    },
  });

  await harness.refresher.refreshSessions({ force: true });

  assert.equal(harness.actions.renderBindings, 0);
  assert.equal(harness.actions.updateBindingValues, 0);
  assert.equal(harness.state.sessions[0].icon_data, "data:image/png;base64,old");
}

async function testRecentFaderInputDefersNonUrgentRefresh() {
  const harness = createHarness({
    state: {
      sessions: [{ ...baseSession }],
      focusedSession: null,
      playbackDevices: [],
      recordingDevices: [],
      sessionsContainer: null,
    },
    responses: {},
    getLastVolumeUpdateAt: () => Date.now(),
  });

  const result = await harness.refresher.refreshSessions();

  assert.equal(result.deferred, true);
  assert.deepEqual(harness.calls, []);
}

async function testOverlappingRefreshesShareInFlightWork() {
  let releaseSessions;
  const sessionGate = new Promise((resolve) => {
    releaseSessions = resolve;
  });
  let listSessionCalls = 0;
  const state = {
    sessions: [{ ...baseSession }],
    focusedSession: null,
    playbackDevices: [],
    recordingDevices: [],
    sessionsContainer: null,
  };
  const refresher = createSessionRefresher({
    invoke: async (command) => {
      if (command === "list_sessions") {
        listSessionCalls += 1;
        await sessionGate;
        return [{ ...baseSession, volume: 0.6 }];
      }
      if (command === "focused_session") return null;
      return [];
    },
    getState: () => state,
    setState: (next) => Object.assign(state, next),
    actions: {
      isBindingInteractionActive: () => false,
      renderBindings: () => {},
      updateBindingValues: () => {},
      updateBindingTargetDisplays: () => {},
    },
  });

  const first = refresher.refreshSessions({ force: true });
  const second = refresher.refreshSessions({ force: true });
  releaseSessions();
  await Promise.all([first, second]);

  assert.equal(listSessionCalls, 1);
}

await testVolumeOnlyChangeUpdatesValuesNotFullRender();
await testStructureChangeRerendersBindings();
await testIconOnlyChangeDoesNotForceWork();
await testRecentFaderInputDefersNonUrgentRefresh();
await testOverlappingRefreshesShareInFlightWork();

console.log("Session refresh tests passed");

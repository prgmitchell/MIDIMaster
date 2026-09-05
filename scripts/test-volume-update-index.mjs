import assert from "node:assert/strict";
import { createBindingDomIndex } from "../src/app/binding_dom_index.js";
import { createBindingLookupIndex } from "../src/app/binding_lookup_index.js";
import { createMidiDisplay } from "../src/app/controllers/midi_display.js";
import { createVolumeEvents } from "../src/app/controllers/volume_events.js";
import { createTargetCore } from "../src/core/target_core.js";

const integration = (id, data = {}, kind = "input") => ({
  Integration: { integration_id: id, kind, data },
});
const slider = (bindingId) => ({ dataset: { bindingId, lastMidiUpdate: "0" } });
let sessions = [
  { id: "music-session", application_key: "music", display_name: "Music Player" },
  { id: "browser-session", application_key: "browser", display_name: "Browser" },
];
let playbackDevices = [{ id: "speakers", display_name: "Desk Speakers" }];
let recordingDevices = [{ id: "mic", display_name: "Microphone" }];
let focusedSession = sessions[0];
const core = createTargetCore({
  getSessions: () => sessions,
  getPlaybackDevices: () => playbackDevices,
  getRecordingDevices: () => recordingDevices,
  getFocusedSession: () => focusedSession,
});
const metadata = () => [sessions, playbackDevices, recordingDevices, focusedSession];

// Match the actual target-core predicate, including fallback labels, not a
// second hand-written definition of target equivalence.
const targets = [
  "Master", { type: "Master" }, { Master: null }, "Focus", { type: "Focus" },
  { Application: { name: "music" } }, { application: "music" },
  { type: "Application", appName: "music" }, { name: "music" },
  { Application: { name: "player", label: "Music Player" } },
  { Session: "music-session" }, { session: { sessionId: "music-session" } },
  { session_id: "music-session" }, { Session: "missing" },
  { Device: "playback:speakers" }, { Device: { device_id: "speakers" } },
  { deviceId: "speakers" }, { device: "recording:mic" },
  { Application: { name: "desk", label: "Desk" } },
  { Profile: { name: "Music" } }, { profile: "Music" },
  integration("obs", { input_name: "Browser", label: "Browser" }),
  integration("obs", { label: "Renamed", icon_data: "icon", input_name: "Browser" }),
  { integration: { integration_id: "obs", kind: "input", data: { input_name: "Browser" } } },
  integration("wavelink", { input_name: "Browser", label: "Browser" }),
  integration("obs", { input_name: "Browser" }, "other-kind"),
  // Malformed/legacy target shapes still obey exact JSON/key checks before
  // integration fallback is rejected by target_core.
  { Integration: {} }, { Integration: {}, name: "music" },
  { Integration: { integration_id: "obs" }, type: "Master" },
  { Application: { name: 'integration:obs:input:{"input_name":"Browser"}' } },
  null,
];
const index = createBindingDomIndex();
targets.forEach((target, indexNumber) => index.register(String(indexNumber), {
  slider: slider(String(indexNumber)), target,
}));
let comparisons = 0;
const targetsMatch = (...args) => { comparisons++; return core.targetsMatch(...args); };
const find = (target) => index.matchVolumeTargets(target, {
  targetsMatch, resolveTargetKey: core.resolveTargetKey, metadata: metadata(),
});
for (const query of targets) {
  const expected = index.volumeEntries().filter((entry) => entry.target && core.targetsMatch(entry.target, query));
  assert.deepEqual(find(query), expected, `indexed matches for ${JSON.stringify(query)}`);
  assert.deepEqual(find(query), expected, "cached matches retain identical row order");
}

for (const update of [
  () => { sessions = [{ id: "music-session", application_key: "other", display_name: "Other App" }]; },
  () => { focusedSession = { id: "focus", display_name: "Desk Speakers" }; },
  () => { playbackDevices = [{ id: "speakers", display_name: "New Output" }]; },
  () => { recordingDevices = [{ id: "mic", display_name: "New Input" }]; },
]) {
  update();
  for (const query of targets) {
    const expected = index.volumeEntries().filter((entry) => entry.target && core.targetsMatch(entry.target, query));
    assert.deepEqual(find(query), expected, "observed metadata changes invalidate fuzzy/derived identities");
  }
}

{
  const oldEntries = index.volumeEntries();
  index.register("0", { target: integration("obs", { input_name: "Changed" }) });
  assert.notEqual(index.volumeEntries(), oldEntries, "retargeting invalidates derived row snapshots");
  assert.equal(find(integration("obs", { input_name: "Changed" }))[0].bindingId, "0");
  index.clear();
  assert.equal(find("Master").length, 0, "removed rows are not retained by target caches");
}

{
  index.register("bounded", { slider: slider("bounded"), target: "Master" });
  const first = { Application: { name: "first" } };
  find(first);
  for (let value = 0; value < 256; value++) find({ Application: { name: `query-${value}` } });
  const previous = comparisons;
  find(first);
  assert.equal(comparisons, previous + 1, "the target query cache evicts instead of growing indefinitely");
}

function workflow(bindings, { onWrite = () => {}, onFocus = () => {} } = {}) {
  const domIndex = createBindingDomIndex();
  const writes = [];
  const buttonUpdates = [];
  bindings.forEach((binding) => domIndex.register(binding.id, {
    slider: slider(binding.id), target: binding.target,
  }));
  const profileState = { bindings, bindingLookupIndex: createBindingLookupIndex(bindings) };
  const liveState = { bindingInteractionTimes: {}, bindingLastValues: {} };
  const events = createVolumeEvents({
    profileState, liveState,
    setBindingSliderVolume: (slider, value, options) => {
      writes.push([slider.dataset.bindingId, value, options]);
      onWrite(slider, value);
    },
    syncButtonValueVisual: (...args) => buttonUpdates.push(args),
    targetsMatch,
    updateFocusedSessionState: onFocus,
    updateIntegrationStateFromEventPayload: () => {},
  });
  const display = createMidiDisplay({
    profileState, liveState,
    features: { bindings: { getRenderedBindingIndex: () => domIndex } },
    BACKEND_ECHO_SUPPRESSION_MS: 300,
    INTEGRATION_ACTIVE_ECHO_SUPPRESSION_MS: 500,
    applyVolumeUpdatePayload: events.applyVolumeUpdatePayload,
    targetsMatch, resolveTargetKey: core.resolveTargetKey, getTargetMetadata: metadata,
  });
  return { domIndex, writes, buttonUpdates, profileState, liveState, display };
}

{
  const bindings = Array.from({ length: 500 }, (_, number) => ({
    id: `b${number}`, action: "Volume", control_kind: "Continuous",
    target: integration("obs", { input_name: `Input ${number}` }),
  }));
  const w = workflow(bindings);
  const payloads = bindings.slice(0, 16).map((binding) => ({ binding_id: binding.id, target: binding.target, volume: 0.6 }));
  comparisons = 0;
  w.display.flushVolumeUpdatePayloads(payloads);
  assert.equal(w.writes.length, 16);
  assert.equal(comparisons, 16, "500 rows / 16 events only compare the 16 indexed candidates");
  w.display.flushVolumeUpdatePayloads(payloads);
  assert.equal(comparisons, 16, "unchanged target lookups reuse their bounded cached results");
  assert.equal(w.writes.length, 32, "target match caching does not suppress live volume writes");
}

// Read lastMidiUpdate and interaction state at application time, including
// changes made after an entry was indexed or during the same event batch.
{
  const originalNow = Date.now;
  Date.now = () => 10000;
  try {
    let w;
    const bindings = [0, 1].map((number) => ({
      id: `b${number}`, action: "Volume", control_kind: "Continuous",
      target: integration("obs", { input_name: `Input ${number}` }),
    }));
    w = workflow(bindings, { onWrite: () => { w.domIndex.volumeEntry("b1").slider.dataset.lastMidiUpdate = "10000"; } });
    w.domIndex.volumeEntries();
    w.display.flushVolumeUpdatePayloads(bindings.map((binding) => ({ binding_id: binding.id, target: binding.target, volume: 0.2 })));
    assert.deepEqual(w.writes.map((write) => write[0]), ["b0"], "later updates see the current MIDI timestamp");
    w.writes.length = 0;
    w.liveState.bindingInteractionTimes.b0 = 9900;
    w.display.flushVolumeUpdatePayloads([{ binding_id: "b0", target: bindings[0].target, volume: 0.1 }]);
    assert.equal(w.writes.length, 0, "integration echo suppression remains active");
  } finally { Date.now = originalNow; }
}

{
  const button = {
    id: "button", action: "Volume", control_kind: "Button", mute_behavior: "Momentary",
    control: { msg_type: "Note", channel: 0, controller: 1 },
    target: integration("obs", { input_name: "Input" }),
  };
  // Use an established momentary action so button behavior comes from the real model.
  button.action = "MediaPlayPause";
  const w = workflow([button]);
  w.display.flushVolumeUpdatePayloads([
    { binding_id: "button", target: button.target, volume: 0.5, input_value: 1 },
    { binding_id: "button", target: button.target, volume: 0.5, input_value: 0 },
  ]);
  assert.deepEqual(w.buttonUpdates, [["button", { inputValue: 1 }], ["button", { inputValue: 0 }]],
    "direct button press/release visuals are not combined by target caching");
}

{
  const first = { id: "duplicate", action: "Volume" };
  const last = { id: "duplicate", action: "ToggleMute" };
  const lookup = createBindingLookupIndex([first, last]);
  assert.equal(lookup.findById("duplicate"), first);
  assert.equal(lookup.findLastById("duplicate"), last);
}

console.log("Volume update target indexes, fuzzy-match compatibility, live echo guards and scaling tests passed");

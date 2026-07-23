import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { wavelinkTestUtils } from "../src-tauri/builtin_plugins/wavelink/plugin.mjs";

const {
  createMuteWriteCoordinator,
  createMainOutputCycleOption,
  disconnectedFeedbackUpdates,
  mergeEntityPatch,
  nextMainOutputDevice,
  outputDeviceId,
  outputDeviceName,
  outputId,
  validOutputDevices,
} = wavelinkTestUtils;

const wavelinkPluginSource = await readFile(
  new URL("../src-tauri/builtin_plugins/wavelink/plugin.mjs", import.meta.url),
  "utf8",
);

const outputDevices = [
  { outputDeviceId: "speakers", outputId: "out-speakers", name: "Speakers" },
  { outputDeviceId: "headphones", outputId: "out-headphones", name: "Headphones" },
  { outputDeviceId: "wave-xlr", outputId: "out-wave-xlr", name: "Wave:XLR" },
];

function testFirstDeviceCyclesToSecond() {
  const next = nextMainOutputDevice({
    mainOutput: { outputDeviceId: "speakers", outputId: "out-speakers" },
    outputDevices,
  });

  assert.equal(outputDeviceId(next), "headphones");
  assert.equal(outputId(next), "out-headphones");
}

function testLastDeviceWrapsToFirst() {
  const next = nextMainOutputDevice({
    mainOutput: { outputDeviceId: "wave-xlr", outputId: "out-wave-xlr" },
    outputDevices,
  });

  assert.equal(outputDeviceId(next), "speakers");
  assert.equal(outputId(next), "out-speakers");
}

function testUnknownCurrentDeviceFallsBackToFirst() {
  const next = nextMainOutputDevice({
    mainOutput: { outputDeviceId: "missing", outputId: "out-missing" },
    outputDevices,
  });

  assert.equal(outputDeviceId(next), "speakers");
}

function testFewerThanTwoDevicesDoesNotExposeOrCycle() {
  const oneDevice = [{ outputDeviceId: "speakers", outputId: "out-speakers", name: "Speakers" }];

  assert.equal(nextMainOutputDevice({
    mainOutput: { outputDeviceId: "speakers", outputId: "out-speakers" },
    outputDevices: oneDevice,
  }), null);
  assert.equal(createMainOutputCycleOption(oneDevice), null);
}

function testSnakeCaseAndCamelCaseFieldsResolve() {
  const mixedDevices = [
    { output_device_id: "speakers", output_id: "out-speakers", display_name: "Speakers" },
    { outputDeviceId: "headphones", outputId: "out-headphones", displayName: "Headphones" },
  ];
  const valid = validOutputDevices(mixedDevices);

  assert.equal(valid.length, 2);
  assert.equal(valid[0].output_device_id, "speakers");
  assert.equal(valid[0].output_id, "out-speakers");
  assert.equal(valid[0].output_device_name, "Speakers");
  assert.equal(outputDeviceName(valid[0]), "Speakers");
  assert.equal(valid[1].output_device_id, "headphones");
  assert.equal(valid[1].output_id, "out-headphones");
  assert.equal(valid[1].output_device_name, "Headphones");
  assert.equal(outputDeviceName(valid[1]), "Headphones");

  const next = nextMainOutputDevice({
    mainOutput: { output_device_id: "speakers", output_id: "out-speakers" },
    outputDevices: mixedDevices,
  });
  assert.equal(outputDeviceId(next), "headphones");
  assert.equal(outputId(next), "out-headphones");
}

function testCycleOptionUsesSetMainOutputMomentaryAction() {
  const option = createMainOutputCycleOption(outputDevices, "data:image/png;base64,test");

  assert.equal(option.label, "Cycle Main Output");
  assert.equal(option.target.Integration.kind, "main_output_cycle");
  assert.equal(option.target.Integration.data.action_label, "Cycle Main Output");
  assert.equal(option.target.Integration.data.action_kind, "momentary");
  assert.deepEqual(option.buttonActions, [{
    label: "Cycle Main Output",
    value: "SetMainOutputDevice",
    behavior: "momentary",
  }]);
}

function testChannelMuteNotificationMergesImmediately() {
  const channels = [{
    id: "music",
    isMuted: false,
    level: 0.75,
    mixes: [
      { id: "monitor", level: 0.8, isMuted: false },
      { id: "stream", level: 0.6, isMuted: false },
    ],
  }];

  const next = mergeEntityPatch(channels, { id: "music", isMuted: true }, ["mixes"]);

  assert.equal(next[0].isMuted, true);
  assert.equal(next[0].level, 0.75);
  assert.equal(channels[0].isMuted, false);
}

function testChannelMixMutePatchPreservesSiblingMixes() {
  const channels = [{
    id: "music",
    mixes: [
      { id: "monitor", level: 0.8, isMuted: false },
      { id: "stream", level: 0.6, isMuted: false },
    ],
  }];

  const next = mergeEntityPatch(channels, {
    id: "music",
    mixes: [{ id: "stream", isMuted: true }],
  }, ["mixes"]);

  assert.deepEqual(next[0].mixes, [
    { id: "monitor", level: 0.8, isMuted: false },
    { id: "stream", level: 0.6, isMuted: true },
  ]);
}

function testMixMuteNotificationMergesImmediately() {
  const mixes = [{ id: "stream", name: "Stream Mix", level: 0.9, isMuted: false }];
  const next = mergeEntityPatch(mixes, { id: "stream", isMuted: true });

  assert.deepEqual(next, [{ id: "stream", name: "Stream Mix", level: 0.9, isMuted: true }]);
}

async function testRejectedMuteWriteReconcilesAuthoritativeState() {
  let authoritativeMuted = null;
  let fallbackCount = 0;
  const coordinator = createMuteWriteCoordinator({
    keyForEndpoint: (endpoint) => endpoint.id,
    write: async () => ({ ok: false, error: { message: "rejected" } }),
    refresh: async () => {
      authoritativeMuted = true;
      return true;
    },
    scheduleFallback: () => {
      fallbackCount += 1;
    },
  });

  const result = await coordinator.execute({ id: "music" }, false);

  assert.deepEqual(result, { acknowledged: false, refreshed: true, stale: false });
  assert.equal(authoritativeMuted, true);
  assert.equal(fallbackCount, 0);
}

async function testSuccessfulMuteWriteUsesConfirmedState() {
  let authoritativeMuted = null;
  const coordinator = createMuteWriteCoordinator({
    keyForEndpoint: (endpoint) => endpoint.id,
    write: async () => ({ ok: true }),
    refresh: async () => {
      authoritativeMuted = false;
      return true;
    },
    scheduleFallback: () => assert.fail("confirmed refresh should not need a fallback"),
  });

  const result = await coordinator.execute({ id: "music" }, false);

  assert.deepEqual(result, { acknowledged: true, refreshed: true, stale: false });
  assert.equal(authoritativeMuted, false);
}

async function testUnavailableConfirmationSchedulesFallbackRefresh() {
  let fallbackEndpoint = null;
  const coordinator = createMuteWriteCoordinator({
    keyForEndpoint: (endpoint) => endpoint.id,
    write: async () => ({ ok: true }),
    refresh: async () => false,
    scheduleFallback: (endpoint) => {
      fallbackEndpoint = endpoint;
    },
  });
  const endpoint = { id: "music" };

  const result = await coordinator.execute(endpoint, true);

  assert.deepEqual(result, { acknowledged: true, refreshed: false, stale: false });
  assert.equal(fallbackEndpoint, endpoint);
}

async function testRapidMuteWritesIgnoreOlderReconciliation() {
  const pendingWrites = [];
  const refreshedValues = [];
  const coordinator = createMuteWriteCoordinator({
    keyForEndpoint: (endpoint) => endpoint.id,
    write: (_endpoint, muted) => new Promise((resolve) => {
      pendingWrites.push({ muted, resolve });
    }),
    refresh: async (_endpoint, isCurrent) => {
      if (isCurrent()) refreshedValues.push(pendingWrites.at(-1).muted);
      return true;
    },
    scheduleFallback: () => assert.fail("refresh should succeed"),
  });

  const first = coordinator.execute({ id: "music" }, true);
  const second = coordinator.execute({ id: "music" }, false);
  pendingWrites[0].resolve({ ok: true });
  assert.deepEqual(
    await first,
    { acknowledged: true, refreshed: false, stale: true },
  );
  pendingWrites[1].resolve({ ok: true });
  assert.deepEqual(
    await second,
    { acknowledged: true, refreshed: true, stale: false },
  );
  assert.deepEqual(refreshedValues, [false]);
}

function testDisconnectPreservesStatefulFeedback() {
  const bindings = [
    {
      id: "volume",
      action: "Volume",
      target: { Integration: { integration_id: "wavelink", kind: "channel", data: {} } },
    },
    {
      id: "mute",
      action: "ToggleMute",
      target: { Integration: { integration_id: "wavelink", kind: "channel", data: {} } },
    },
    {
      id: "effect",
      action: "ToggleEffect",
      target: { Integration: { integration_id: "wavelink", kind: "channel_effect", data: {} } },
    },
    {
      id: "output",
      action: "SetMainOutputDevice",
      target: { Integration: { integration_id: "wavelink", kind: "main_output_cycle", data: {} } },
    },
  ];

  assert.deepEqual(disconnectedFeedbackUpdates(bindings), [
    { bindingId: "volume", action: "Volume" },
    { bindingId: "output", action: "SetMainOutputDevice" },
  ]);
}

function testNotificationHandlersUsePayloadBeforeFallbackRefresh() {
  assert.match(
    wavelinkPluginSource,
    /json\.method === "channelChanged"[\s\S]*applyChannelPatch\(json\.params\?\.channel \?\? json\.params\)/u,
  );
  assert.match(
    wavelinkPluginSource,
    /json\.method === "mixChanged"[\s\S]*applyMixPatch\(json\.params\?\.mix \?\? json\.params\)/u,
  );
  assert.match(
    wavelinkPluginSource,
    /await muteWrites\.execute\(endpoint, muted\)/u,
  );
}

testFirstDeviceCyclesToSecond();
testLastDeviceWrapsToFirst();
testUnknownCurrentDeviceFallsBackToFirst();
testFewerThanTwoDevicesDoesNotExposeOrCycle();
testSnakeCaseAndCamelCaseFieldsResolve();
testCycleOptionUsesSetMainOutputMomentaryAction();
testChannelMuteNotificationMergesImmediately();
testChannelMixMutePatchPreservesSiblingMixes();
testMixMuteNotificationMergesImmediately();
await testRejectedMuteWriteReconcilesAuthoritativeState();
await testSuccessfulMuteWriteUsesConfirmedState();
await testUnavailableConfirmationSchedulesFallbackRefresh();
await testRapidMuteWritesIgnoreOlderReconciliation();
testDisconnectPreservesStatefulFeedback();
testNotificationHandlersUsePayloadBeforeFallbackRefresh();

console.log("Wave Link plugin tests passed");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { voicemeeterTestUtils as utils } from "../src-tauri/builtin_plugins/voicemeeter/plugin.mjs";

function approximately(actual, expected, epsilon = 0.0001) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

function testGainTaper() {
  assert.equal(utils.gainFromNormalized(0), -60);
  approximately(utils.gainFromNormalized(0.8), 0);
  approximately(utils.gainFromNormalized(1), 12);
  for (const normalized of [0, 0.05, 0.25, 0.5, 0.8, 0.9, 1]) {
    approximately(utils.normalizedFromGain(utils.gainFromNormalized(normalized)), normalized);
  }
}

function testEditionCapabilitiesAndRoutes() {
  assert.deepEqual(utils.capabilitiesForEdition(1), {
    strip_count: 3,
    physical_strip_count: 2,
    bus_count: 2,
    physical_bus_count: 1,
  });
  assert.equal(utils.routeProperties(1).length, 2);
  assert.deepEqual(
    utils.routeProperties(2).map((entry) => entry[0]),
    ["a1", "b1", "a2", "a3", "b2"],
  );
  assert.deepEqual(
    utils
      .routeProperties(3)
      .slice(-3)
      .map((entry) => entry[0]),
    ["a4", "a5", "b3"],
  );
}

function testProfileTextParsing() {
  assert.deepEqual(utils.parseNumberedAliases("1: Stream mute\n 12: Cough \n81: Ignored"), {
    0: "Stream mute",
    11: "Cough",
  });
  assert.deepEqual(utils.parsePresetLines("1: Streaming\n256: Last\n257: Invalid"), [
    { slot: 0, label: "Streaming" },
    { slot: 255, label: "Last" },
  ]);
}

function testIntentEchoSuppression() {
  const intent = { value: -12, at: 1000 };
  assert.equal(utils.shouldAcceptRemoteValue(intent, -20, 1100), false);
  assert.equal(utils.shouldAcceptRemoteValue(intent, -12, 1100), true);
  assert.equal(utils.shouldAcceptRemoteValue(intent, -20, 2000), true);
}

function testParameterIdentity() {
  assert.equal(utils.parameterKey({ scope: "Strip", index: 2, property: "Gain" }), "strip:2:gain");
  assert.equal(utils.denormalizeContinuous(0.5, 0, 10, "comp"), 5);
  assert.equal(utils.normalizeContinuous(5, 0, 10, "comp"), 0.5);
}

function testMeterChangesDoNotInvalidateBindingUi() {
  const state = {
    status: { connected: true, edition: "banana" },
    stripLabels: ["Mic"],
    busLabels: ["Speakers"],
    inputDevices: ["Input"],
    outputDevices: ["Output"],
    settings: { macro_aliases: {}, presets: [] },
    meters: [{ scope: "strip", index: 0, level: 0.1 }],
  };
  const before = utils.bindingUiSignature(state);
  state.meters = [{ scope: "strip", index: 0, level: 0.9 }];
  assert.equal(utils.bindingUiSignature(state), before);
  state.stripLabels = ["Renamed Mic"];
  assert.notEqual(utils.bindingUiSignature(state), before);
}

function testMetersOnlyPollOnVisibleDashboard() {
  const visible = { mounted: true, documentHidden: false, tabActive: true, pageActive: true };
  assert.equal(utils.shouldPollMeters(visible), true);
  for (const field of ["mounted", "tabActive", "pageActive"]) {
    assert.equal(utils.shouldPollMeters({ ...visible, [field]: false }), false);
  }
  assert.equal(utils.shouldPollMeters({ ...visible, documentHidden: true }), false);
  assert.equal(utils.pollingInterval({ dashboardVisible: false, needsLiveFeedback: false }), 500);
  assert.equal(utils.pollingInterval({ dashboardVisible: false, needsLiveFeedback: true }), 100);
  assert.equal(
    utils.meterPollDue({ dashboardVisible: false, force: true, now: 1000, lastMeterPollAt: 0 }),
    false,
  );
  assert.equal(
    utils.meterPollDue({ dashboardVisible: true, force: false, now: 1200, lastMeterPollAt: 1000 }),
    false,
  );
  assert.equal(
    utils.meterPollDue({ dashboardVisible: true, force: false, now: 1250, lastMeterPollAt: 1000 }),
    true,
  );
}

function testTransientFailuresDoNotFlapConnection() {
  assert.equal(utils.shouldMarkDisconnected(1), false);
  assert.equal(utils.shouldMarkDisconnected(2), false);
  assert.equal(utils.shouldMarkDisconnected(3), true);
}

function testDisconnectedRetriesDoNotRebuildDashboard() {
  assert.equal(utils.shouldRenderConnectionTransition(false, false), false);
  assert.equal(utils.shouldRenderConnectionTransition(false, true), true);
  assert.equal(utils.shouldRenderConnectionTransition(true, true), false);
}

function testProfileChangeEnvelopePreservesAutoConnect() {
  assert.deepEqual(utils.profileSettingsFromEvent({ settings: { auto_connect: false } }), {
    auto_connect: false,
  });
  assert.deepEqual(utils.profileSettingsFromEvent({ auto_connect: true }), { auto_connect: true });
}

function testButtonActionSemantics() {
  assert.deepEqual(utils.buttonAction("Mute", "stateful"), {
    label: "Mute",
    value: "ToggleEffect",
    behavior: "stateful",
  });
  assert.deepEqual(utils.buttonAction("Select Device", "momentary"), {
    label: "Select Device",
    value: "SetMainOutputDevice",
    behavior: "momentary",
  });
  for (const property of ["mode.normal", "mode.amix", "mode.tvmix", "sel"]) {
    assert.equal(utils.parameterButtonBehavior("bus", property), "momentary");
    assert.equal(
      utils.isOneShotVoicemeeterTarget({ kind: "parameter", data: { scope: "bus", property } }),
      true,
    );
  }
  for (const [scope, property] of [
    ["strip", "mute"],
    ["strip", "a1"],
    ["bus", "mute"],
    ["bus", "monitor"],
    ["bus", "eq.on"],
  ]) {
    assert.equal(utils.parameterButtonBehavior(scope, property), "stateful");
    assert.equal(utils.isOneShotVoicemeeterTarget({ kind: "parameter", data: { scope, property } }), false);
  }
  for (const kind of ["device_assignment", "preset", "command"]) {
    assert.equal(utils.isOneShotVoicemeeterTarget({ kind, data: { action_kind: "stateful" } }), true);
  }
  assert.equal(
    utils.targetUsesPersistentFeedback({
      kind: "parameter",
      data: { scope: "macro", property: "state", action_kind: "stateful" },
    }),
    true,
  );
  assert.equal(
    utils.targetUsesPersistentFeedback({
      kind: "parameter",
      data: { scope: "macro", property: "state", action_kind: "momentary" },
    }),
    false,
  );

  const state = {
    icon: null,
    busLabels: ["Speakers"],
    stripLabels: [],
    status: { capabilities: { physical_bus_count: 1 } },
  };
  const mode = utils.parameterOption("bus", 0, ["mode.normal", "Normal Mode", 1], state, true);
  assert.deepEqual(mode.buttonActions, [
    { label: "Normal Mode", value: "SetMainOutputDevice", behavior: "momentary" },
  ]);
  assert.equal(mode.target.Integration.data.action_kind, "momentary");
  const mute = utils.parameterOption("bus", 0, ["mute", "Mute", 1], state, true);
  assert.deepEqual(mute.buttonActions, [{ label: "Mute", value: "ToggleEffect", behavior: "stateful" }]);
  assert.equal(mute.target.Integration.data.action_kind, "stateful");
}

function testAsioChoicesAreLimitedToA1() {
  const devices = [
    { driver_type: "asio", name: "Interface" },
    { driver_type: "wdm", name: "Interface" },
    { driver_type: "mme", name: "Speakers" },
  ];
  assert.deepEqual(utils.assignableDevices(devices, "output", 0), devices);
  assert.deepEqual(utils.assignableDevices(devices, "output", 1), devices.slice(1));
  assert.deepEqual(utils.assignableDevices(devices, "input", 1), devices);
}

function testDeviceFeedbackHandlesDuplicateDriverNames() {
  const data = { device_name: "Interface", driver_type: "wdm" };
  const duplicateDevices = [
    { driver_type: "asio", name: "Interface" },
    { driver_type: "wdm", name: "Interface" },
  ];
  assert.equal(utils.deviceFeedbackMatches(data, "Interface", null, duplicateDevices), false);
  assert.equal(
    utils.deviceFeedbackMatches(data, "Interface", { name: "Interface", driver: "wdm" }, duplicateDevices),
    true,
  );
  assert.equal(
    utils.deviceFeedbackMatches(data, "Interface", { name: "Interface", driver: "asio" }, duplicateDevices),
    false,
  );
  assert.equal(
    utils.deviceFeedbackMatches(data, "Interface", { name: "Interface", driver: "" }, [
      { driver_type: "wdm", name: "Interface" },
    ]),
    false,
  );
  assert.equal(
    utils.deviceFeedbackMatches(data, "Other", { name: "Interface", driver: "wdm" }, duplicateDevices),
    false,
  );
}

async function testDeviceVerification() {
  const waits = [];
  let reads = 0;
  const success = await utils.verifyDeviceAssignment({
    expectedName: "Speakers",
    delays: [100, 250, 500],
    wait: async (ms) => {
      waits.push(ms);
    },
    isCurrent: () => true,
    readState: async () =>
      ++reads === 1 ? { name: "Speakers", sample_rate: 0 } : { name: "Speakers", sample_rate: 48000 },
  });
  assert.equal(success.status, "success");
  assert.equal(success.sampleRate, 48000);
  assert.deepEqual(waits, [100, 150]);

  const mismatch = await utils.verifyDeviceAssignment({
    expectedName: "Headphones",
    delays: [100],
    wait: async () => {},
    isCurrent: () => true,
    readState: async () => ({ name: "Speakers", sample_rate: 48000 }),
  });
  assert.equal(mismatch.status, "mismatch");

  const unhealthy = utils.deviceVerificationResult("Speakers", { name: "Speakers", sample_rate: 0 });
  assert.equal(unhealthy.status, "not_initialized");
  const cleared = utils.deviceVerificationResult("", { name: "", sample_rate: 0 });
  assert.equal(cleared.status, "success");

  const superseded = await utils.verifyDeviceAssignment({
    expectedName: "Speakers",
    delays: [100],
    wait: async () => {},
    isCurrent: () => false,
    readState: async () => {
      throw new Error("must not read");
    },
  });
  assert.equal(superseded.status, "superseded");
}

function testOnlyCoreBindingActionsAreEmitted() {
  const source = readFileSync(
    new URL("../src-tauri/builtin_plugins/voicemeeter/plugin.mjs", import.meta.url),
    "utf8",
  );
  for (const unsupported of [
    "SetVoicemeeterState",
    "PushVoicemeeterMacro",
    "AssignVoicemeeterDevice",
    "RecallVoicemeeterPreset",
    "RunVoicemeeterCommand",
  ]) {
    assert.equal(source.includes(unsupported), false, `plugin still emits unsupported action ${unsupported}`);
  }
}

function testDashboardUsesOneContentScrollbar() {
  const source = readFileSync(
    new URL("../src-tauri/builtin_plugins/voicemeeter/plugin.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("grid-template-columns:repeat(auto-fit,minmax(250px,1fr))"), true);
  assert.equal(source.includes("max-height:330px;overflow:auto"), false);
}

function testDashboardUsesMidimasterConfirmation() {
  const source = readFileSync(
    new URL("../src-tauri/builtin_plugins/voicemeeter/plugin.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("window.confirm"), false);
  assert.equal(source.includes("ctx.app.showConfirm"), true);
  assert.equal(source.includes("ctx.app.showAlert"), true);
  assert.equal(source.includes("window.alert"), false);
  assert.equal(source.includes('state.lastStatusUiSignature = ""'), true);
}

testGainTaper();
testEditionCapabilitiesAndRoutes();
testProfileTextParsing();
testIntentEchoSuppression();
testParameterIdentity();
testMeterChangesDoNotInvalidateBindingUi();
testMetersOnlyPollOnVisibleDashboard();
testTransientFailuresDoNotFlapConnection();
testDisconnectedRetriesDoNotRebuildDashboard();
testProfileChangeEnvelopePreservesAutoConnect();
testButtonActionSemantics();
testAsioChoicesAreLimitedToA1();
testDeviceFeedbackHandlesDuplicateDriverNames();
await testDeviceVerification();
testOnlyCoreBindingActionsAreEmitted();
testDashboardUsesOneContentScrollbar();
testDashboardUsesMidimasterConfirmation();
// One-shot options and feedback are exercised through the generated loader in test-bundled-plugin-runtime.
console.log("Voicemeeter plugin tests passed");

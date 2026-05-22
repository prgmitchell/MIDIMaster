import assert from "node:assert/strict";
import {
  createHueWriteSchedulerForTests,
  hueTestUtils,
} from "../src-tauri/builtin_plugins/hue/plugin.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testLatestWinsBeforeFirstWrite() {
  const writes = [];
  const scheduler = createHueWriteSchedulerForTests({
    lightIntervalMs: 10,
    groupIntervalMs: 20,
    put: async (kind, id, body) => {
      writes.push({ kind, id, body });
    },
  });

  scheduler.enqueue("light", "1", { on: true, bri: 254 });
  scheduler.enqueue("light", "1", { on: false });
  scheduler.enqueue("light", "1", { on: true, bri: 200 });

  await scheduler.whenIdle();

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    kind: "light",
    id: "1",
    body: { on: true, bri: 200 },
  });
}

async function testSameTargetWritesDoNotOverlap() {
  const writes = [];
  let active = 0;
  let maxActive = 0;
  const scheduler = createHueWriteSchedulerForTests({
    lightIntervalMs: 5,
    groupIntervalMs: 20,
    put: async (kind, id, body) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      writes.push({ kind, id, body });
      await sleep(25);
      active -= 1;
    },
  });

  scheduler.enqueue("light", "2", { on: true, bri: 100 });
  await sleep(5);
  scheduler.enqueue("light", "2", { on: false });

  await scheduler.whenIdle();

  assert.equal(writes.length, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(writes[1], {
    kind: "light",
    id: "2",
    body: { on: false },
  });
}

async function testGlobalLightRateLimit() {
  const writes = [];
  const scheduler = createHueWriteSchedulerForTests({
    lightIntervalMs: 30,
    groupIntervalMs: 60,
    put: async (kind, id, body) => {
      writes.push({ kind, id, body, at: Date.now() });
    },
  });

  scheduler.enqueue("light", "1", { bri: 10 });
  scheduler.enqueue("light", "2", { bri: 20 });

  await scheduler.whenIdle();

  assert.equal(writes.length, 2);
  assert.ok(
    writes[1].at - writes[0].at >= 24,
    `expected light writes to be spaced, got ${writes[1].at - writes[0].at}ms`,
  );
}

async function testCancelledPendingWriteIsSkipped() {
  const writes = [];
  const scheduler = createHueWriteSchedulerForTests({
    lightIntervalMs: 50,
    groupIntervalMs: 60,
    put: async (kind, id, body) => {
      writes.push({ kind, id, body });
    },
  });

  scheduler.enqueue("light", "1", { bri: 10 });
  scheduler.enqueue("light", "2", { bri: 20 });
  scheduler.cancel("light", "2");

  await scheduler.whenIdle();

  assert.deepEqual(writes.map((write) => write.id), ["1"]);
}

function testBrightnessHelpers() {
  assert.equal(hueTestUtils.volumeToHueBri(0), 0);
  assert.equal(hueTestUtils.volumeToHueBri(1), 254);
  assert.equal(hueTestUtils.volumeToHueBri(0.5), 127);
  assert.equal(hueTestUtils.hueVolumeFromState({ on: false, bri: 254 }), 0);
  assert.equal(hueTestUtils.hueVolumeFromState({ on: true, bri: 254 }), 1);
}

function testButtonActionSelectionHelpers() {
  assert.equal(hueTestUtils.normalizeHueButtonAction("turn-on"), "turn_on");
  assert.equal(hueTestUtils.normalizeHueButtonAction("Turn_Off"), "turn_off");
  assert.equal(hueTestUtils.normalizeHueButtonAction("unknown"), "");

  const toggle = hueTestUtils.createHueButtonActionOption(
    { kind: "light", id: "7", name: "Desk Lamp" },
    "toggle",
  );
  assert.equal(toggle.label, "Toggle On/Off");
  assert.deepEqual(toggle.buttonActions, [{
    label: "Toggle On/Off",
    value: "ToggleMute",
    behavior: "stateful",
  }]);
  assert.deepEqual(toggle.target.Integration.data, {
    id: "7",
    name: "Desk Lamp",
    label: "Desk Lamp",
    button_action: "toggle",
    action_kind: "stateful",
  });

  const turnOn = hueTestUtils.createHueButtonActionOption(
    { kind: "group", id: "2", name: "Office" },
    "turn_on",
  );
  assert.equal(turnOn.label, "Turn On");
  assert.deepEqual(turnOn.buttonActions, [{
    label: "Turn On",
    value: "Volume",
    behavior: "momentary",
  }]);
  assert.equal(turnOn.target.Integration.data.button_action, "turn_on");
  assert.equal(turnOn.target.Integration.data.osd_value_text, "ON");

  const turnOff = hueTestUtils.createHueButtonActionOption(
    { kind: "group", id: "2", name: "Office" },
    "turn_off",
  );
  assert.equal(turnOff.label, "Turn Off");
  assert.equal(turnOff.target.Integration.data.button_action, "turn_off");
  assert.equal(turnOff.target.Integration.data.action_kind, "momentary");
  assert.equal(turnOff.target.Integration.data.osd_value_text, "OFF");
}

function testPowerWriteBodies() {
  assert.deepEqual(hueTestUtils.huePowerWriteBody("turn_on", 180), {
    on: true,
    bri: 180,
    transitiontime: 0,
  });
  assert.deepEqual(hueTestUtils.huePowerWriteBody("turn_on", 0), {
    on: true,
    bri: 254,
    transitiontime: 0,
  });
  assert.deepEqual(hueTestUtils.huePowerWriteBody("turn_off", 180), {
    on: false,
    transitiontime: 0,
  });
  assert.equal(hueTestUtils.huePowerWriteBody("toggle", 180), null);
}

function testStateFeedbackClassification() {
  const entry = { on: true, bri: 127 };
  const fader = {
    action: "Volume",
    targets: [{
      Integration: {
        integration_id: "hue",
        kind: "group",
        data: { id: "2" },
      },
    }],
  };
  assert.deepEqual(hueTestUtils.hueStateFeedbackForBinding(fader, entry), {
    value: 0.5,
    action: "Volume",
  });

  const toggle = {
    action: "ToggleMute",
    targets: [{
      Integration: {
        integration_id: "hue",
        kind: "group",
        data: { id: "2", button_action: "toggle" },
      },
    }],
  };
  assert.deepEqual(hueTestUtils.hueStateFeedbackForBinding(toggle, { on: false, bri: 254 }), {
    value: 0,
    action: "ToggleMute",
  });

  const turnOn = hueTestUtils.createHueButtonActionOption(
    { kind: "group", id: "2", name: "Office" },
    "turn_on",
  );
  assert.equal(hueTestUtils.hueStateFeedbackForBinding({
    action: "Volume",
    targets: [turnOn.target],
  }, entry), null);

  const turnOff = hueTestUtils.createHueButtonActionOption(
    { kind: "group", id: "2", name: "Office" },
    "turn_off",
  );
  assert.equal(hueTestUtils.hueStateFeedbackForBinding({
    action: "Volume",
    targets: [turnOff.target],
  }, entry), null);
}

function hueBinding(id, action, target) {
  return {
    id,
    action,
    targets: [target],
  };
}

function hueTarget(kind, id, data = {}) {
  return {
    Integration: {
      integration_id: "hue",
      kind,
      data: { id, ...data },
    },
  };
}

function testSameTargetButtonOffSyncsVolumeFeedbackToZero() {
  const volumeBinding = hueBinding("volume-binding", "Volume", hueTarget("group", "2"));
  const toggleBinding = hueBinding(
    "toggle-binding",
    "ToggleMute",
    hueTarget("group", "2", { button_action: "toggle" }),
  );
  const stateByKey = new Map([
    [hueTestUtils.hueTargetKey("group", "2"), { on: false, bri: 200 }],
  ]);

  assert.deepEqual(
    hueTestUtils.hueFeedbackUpdatesForKey(
      [volumeBinding, toggleBinding],
      stateByKey,
      hueTestUtils.hueTargetKey("group", "2"),
      { silent: true, skipBindingId: "toggle-binding", forceHardwareFeedback: true },
    ),
    [{
      bindingId: "volume-binding",
      value: 0,
      action: "Volume",
      options: {
        silent: true,
        forceHardwareFeedback: true,
        force_hardware_feedback: true,
      },
    }],
  );
}

function testSameTargetTurnOffSyncsVolumeFeedbackToZero() {
  const volumeBinding = hueBinding("volume-binding", "Volume", hueTarget("light", "7"));
  const turnOffTarget = hueTestUtils.createHueButtonActionOption(
    { kind: "light", id: "7", name: "Desk Lamp" },
    "turn_off",
  ).target;
  const turnOffBinding = hueBinding("turn-off-binding", "Volume", turnOffTarget);
  const stateByKey = new Map([
    [hueTestUtils.hueTargetKey("light", "7"), { on: false, bri: 180 }],
  ]);

  assert.deepEqual(
    hueTestUtils.hueFeedbackUpdatesForKey(
      [volumeBinding, turnOffBinding],
      stateByKey,
      hueTestUtils.hueTargetKey("light", "7"),
      { silent: true, skipBindingId: "turn-off-binding", forceHardwareFeedback: true },
    ),
    [{
      bindingId: "volume-binding",
      value: 0,
      action: "Volume",
      options: {
        silent: true,
        forceHardwareFeedback: true,
        force_hardware_feedback: true,
      },
    }],
  );
}

await testLatestWinsBeforeFirstWrite();
await testSameTargetWritesDoNotOverlap();
await testGlobalLightRateLimit();
await testCancelledPendingWriteIsSkipped();
testBrightnessHelpers();
testButtonActionSelectionHelpers();
testPowerWriteBodies();
testStateFeedbackClassification();
testSameTargetButtonOffSyncsVolumeFeedbackToZero();
testSameTargetTurnOffSyncsVolumeFeedbackToZero();

console.log("Hue plugin tests passed");

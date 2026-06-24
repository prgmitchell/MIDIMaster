import assert from "node:assert/strict";
import { wavelinkTestUtils } from "../src-tauri/builtin_plugins/wavelink/plugin.mjs";

const {
  createMainOutputCycleOption,
  nextMainOutputDevice,
  outputDeviceId,
  outputDeviceName,
  outputId,
  validOutputDevices,
} = wavelinkTestUtils;

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

testFirstDeviceCyclesToSecond();
testLastDeviceWrapsToFirst();
testUnknownCurrentDeviceFallsBackToFirst();
testFewerThanTwoDevicesDoesNotExposeOrCycle();
testSnakeCaseAndCamelCaseFieldsResolve();
testCycleOptionUsesSetMainOutputMomentaryAction();

console.log("Wave Link plugin tests passed");

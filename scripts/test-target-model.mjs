import assert from "node:assert/strict";
import {
  ACTION_CATALOG,
  BUILT_IN_TARGETS,
  MEDIA_ACTIONS,
  builtInTargetKey,
  isTargetComplete,
  pickerMetadataForTarget,
  targetFromPickerKind,
  targetType,
} from "../src/core/target_model.js";

assert.equal(new Set(Object.values(BUILT_IN_TARGETS).map(({ pickerKind }) => pickerKind)).size, Object.keys(BUILT_IN_TARGETS).length);
assert.equal(new Set(Object.values(BUILT_IN_TARGETS).map(({ key }) => key)).size, Object.keys(BUILT_IN_TARGETS).length);

for (const descriptor of Object.values(BUILT_IN_TARGETS)) {
  assert.ok(descriptor.labelKey, `${descriptor.type} must declare a label`);
  assert.ok(descriptor.category, `${descriptor.type} must declare a category`);
  assert.equal(targetFromPickerKind(descriptor.pickerKind), descriptor.type);
  descriptor.actions.forEach((action) => assert.ok(ACTION_CATALOG[action], `${action} must be cataloged`));
}

assert.deepEqual(MEDIA_ACTIONS, BUILT_IN_TARGETS.MediaControl.actions);
assert.equal(targetType({ monitorBrightness: { monitorId: "DISPLAY-1" } }), "MonitorBrightness");
assert.equal(builtInTargetKey({ MonitorBrightness: { monitor_id: "DISPLAY-1" } }), "monitor-brightness:DISPLAY-1");
assert.deepEqual(pickerMetadataForTarget({ MonitorBrightness: {
  monitor_id: "DISPLAY-1",
  display_name: "Studio",
} }), {
  value: "monitor-brightness:DISPLAY-1",
  kind: "monitor-brightness",
  labelKey: "targets.monitorBrightness",
  label: "Studio",
  iconKind: "monitor-brightness",
});
assert.equal(isTargetComplete({ Application: { name: "spotify.exe" } }), true);
assert.equal(isTargetComplete({ Application: { name: "" } }), false);
assert.equal(isTargetComplete({ Integration: { integration_id: "obs", kind: "scene", data: {} } }), true);

console.log("Target model tests passed");

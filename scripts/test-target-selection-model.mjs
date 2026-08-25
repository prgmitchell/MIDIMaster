import assert from "node:assert/strict";
import {
  mapTargetOptionToTarget,
  normalizeButtonActionOption,
  normalizeSelectedTargets,
  pushUniqueAction,
  resolveTargetSelection,
  targetIdentity,
} from "../src/features/targets/selection_model.js";

assert.deepEqual(normalizeSelectedTargets(["Master", "Unset", null]), ["Master"]);
assert.equal(targetIdentity({ Device: { device_id: "device-1" } }), "device:device-1");
assert.deepEqual(resolveTargetSelection("Soundboard"), {
  integration: undefined,
  selectedAppName: undefined,
  selectedAppKey: "",
  selectedAppDisplayName: "",
  selectedAppIconData: null,
  selectedDeviceId: undefined,
  selectedBrightnessId: "",
  selectedKind: "soundboard-target",
  selectedValue: "soundboard-target",
});
assert.deepEqual(mapTargetOptionToTarget({ kind: "device", value: "device-1" }), {
  Device: { device_id: "device-1" },
});

const action = normalizeButtonActionOption(
  { value: "Toggle", behavior: "stateful", label: "Toggle" },
  null,
  (key) => key,
);
assert.equal(action.role, "state");
const actions = [];
pushUniqueAction(actions, action);
pushUniqueAction(actions, { ...action });
assert.equal(actions.length, 1);

console.log("Target selection model tests passed");

import assert from "node:assert/strict";
import { createActionPolicy } from "../src/features/targets/controllers/action_policy.js";
import { createTargetCore } from "../src/core/target_core.js";
const target = { Integration: { integration_id: "fixture", kind: "channel", id: "1" } };
const handler = {
  buttonActions: [{ value: "ToggleMute", label: "Global mute", role: "state" }],
  getTargetOptions: () => [
    { target, buttonActions: [{ value: "SetDefaultDevice", label: "Hydrated", role: "command" }] },
  ],
};
const policy = createActionPolicy({
  t: (key) => key,
  getSess: () => [],
  getPlayback: () => [],
  getRecording: () => [],
  getHost: () => ({ getIntegration: () => handler }),
  targetKey: JSON.stringify,
  targetIdentity: JSON.stringify,
  includeValueAction: true,
  includeWindowFocusAction: true,
});
const option = {
  target,
  kind: "integration-target",
  buttonActions: [{ value: "ToggleEffect", label: "Per-target effect", role: "state" }],
};
assert.deepEqual(
  (await policy.buildActionOptionsForTargetOption({ ...option }, { source: "menu" })).map((a) => a.value),
  ["ToggleEffect"],
  "menu uses the per-target override",
);
assert.deepEqual(
  (await policy.buildActionOptionsForTargetOption({ ...option, buttonActions: [] }, { source: "menu" })).map(
    (a) => a.value,
  ),
  ["ToggleMute"],
  "menu falls back to integration actions",
);
assert.deepEqual(
  (await policy.buildActionOptionsForTargetOption({ ...option })).map((a) => a.value),
  ["Volume", "ToggleEffect", "SetDefaultDevice", "ToggleMute"],
  "selected macro targets combine hydrated and declared actions",
);
assert.deepEqual(
  (await policy.buildActionOptionsForTargetOption({ kind: "session" }, { source: "menu" })).map(
    (a) => a.value,
  ),
  ["ToggleMute", "Volume"],
);
assert.deepEqual(
  (await policy.buildActionOptionsForTargetOption({ kind: "session" })).map((a) => a.value),
  ["ToggleMute", "FocusWindow", "Volume"],
);
console.log("Target action policy tests passed");

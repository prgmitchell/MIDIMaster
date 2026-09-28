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
const waveLink = "aumid:elgato.wavelink_g54w8ztgkx496!app";
let focusableNames = new Set([waveLink]);
let focusLookupFailed = false;
const focusRequests = [];
const policy = createActionPolicy({
  callInvoke: async (command, { applicationNames }) => {
    assert.equal(command, "filter_focusable_applications");
    focusRequests.push(applicationNames);
    if (focusLookupFailed) throw new Error("Window lookup failed");
    return applicationNames.filter((name) => focusableNames.has(name));
  },
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
  focusRequests,
  [],
  "ordinary audio menus do not query window availability",
);
const applicationOption = { kind: "session", value: waveLink };
assert.deepEqual(
  (await policy.buildActionOptionsForTargetOption(applicationOption)).map((a) => a.value),
  ["ToggleMute", "FocusWindow", "Volume"],
);
focusableNames.clear();
assert.deepEqual(
  (await policy.buildActionOptionsForTargetOption(applicationOption)).map((a) => a.value),
  ["ToggleMute", "Volume"],
  "macro action choices exclude Focus Window while an app is tray-only",
);
focusableNames.add(waveLink);
assert.ok((await policy.buildActionOptionsForTargetOption(applicationOption)).some((a) => a.value === "FocusWindow"));
focusLookupFailed = true;
assert.deepEqual(
  (await policy.buildActionOptionsForTargetOption(applicationOption)).map((a) => a.value),
  ["ToggleMute", "Volume"],
  "a failed window lookup does not offer unverified focus targets",
);
console.log("Target action policy tests passed");

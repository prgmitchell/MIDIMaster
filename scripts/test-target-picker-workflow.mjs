import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createDomRefs } from "../src/app/dom_refs.js";
import { createTargetsFeature } from "../src/features/targets/targets.js";
import { createTargetCore } from "../src/core/target_core.js";

await createAppDom();
const dom = createDomRefs();
const core = createTargetCore({
  getSessions: () => [],
  getPlaybackDevices: () => [],
  getRecordingDevices: () => [],
});
const feature = createTargetsFeature({
  invoke: async () => [],
  dom: dom.targets,
  i18n: { t: (key) => key },
  normalizeSessionKey: core.normalizeSessionKey,
  integrationTargetKey: core.integrationTargetKey,
  resolveOsdTarget: core.resolveOsdTarget,
});
feature.bindUi();
try {
  const normal = feature.buildTargetSelect(["Master"], true, "ToggleMute");
  document.body.append(normal);
  assert.deepEqual(normal.__selectedTargets, ["Master"]);
  assert.deepEqual(
    (await normal.getActionOptions()).map((action) => action.value),
    ["ToggleMute"],
  );
  await normal.openTargetPicker();
  assert.equal(dom.targets.targetPanel.classList.contains("hidden"), false);
  feature.closeTargetPanel();
  const macro = feature.buildTargetSelect(["Master"], true, "Volume", "", null, null, {
    includeValueAction: true,
    excludeMacroTarget: true,
    overConfigModal: true,
  });
  document.body.append(macro);
  const options = await macro.getActionOptions();
  assert.deepEqual(
    options.map((action) => action.value),
    ["ToggleMute", "Volume"],
  );
  macro.setActionOption(options[1], false);
  assert.equal(macro.dataset.actionRole, "value");
  assert.equal(macro.dataset.action, "Volume");
  await macro.openTargetPicker();
  assert.equal(dom.targets.targetPanel.classList.contains("target-panel--over-config"), true);
  const roots = feature.buildTargetOptions("Master", true).options;
  assert.ok(roots.some((option) => option.kind === "soundboard-target"));
  assert.equal(
    feature.buildTargetOptions("Master", false).options.some((option) => option.kind === "soundboard-target"),
    false,
  );
} finally {
  feature.dispose();
}
console.log("Target picker workflow tests passed");

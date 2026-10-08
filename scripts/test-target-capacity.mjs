import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createDomRefs } from "../src/app/dom_refs.js";
import { createBindingsFeature } from "../src/features/bindings/bindings.js";
import { createTargetsFeature } from "../src/features/targets/targets.js";
import { createTargetCore } from "../src/core/target_core.js";
import {
  getBindingTargets,
  normalizeBinding,
  normalizeMacroSteps,
  normalizeMacroDraftSteps,
  setBindingTargets,
} from "../src/core/binding_model.js";
import { normalizeMacroDraftSteps as normalizeEditorDraft } from "../src/features/bindings/macro_draft.js";
import { normalizeSelectedTargets } from "../src/features/targets/selection_model.js";

const apps = Array.from({ length: 32 }, (_, index) => ({
  Application: { name: `app-${index}`, display_name: `App ${index}` },
}));
assert.deepEqual(normalizeSelectedTargets([null, "Unset", ...apps]), apps);
const normalized = normalizeBinding({ action: "Volume", targets: apps });
assert.deepEqual(getBindingTargets(normalized), apps);
const reassigned = {};
setBindingTargets(reassigned, apps);
assert.deepEqual(reassigned.targets, apps);
for (const special of ["Macro", "Soundboard"]) {
  assert.deepEqual(
    normalizeBinding({ action: special, targets: apps }).targets,
    [...apps, special],
    "adding a special target must preserve every existing app",
  );
}
const steps = [
  { kind: "action", action: "Volume", action_role: "value", targets: apps },
];
assert.deepEqual(normalizeMacroSteps(steps)[0].targets, apps);
assert.deepEqual(normalizeMacroDraftSteps(steps)[0].targets, apps);
assert.deepEqual(normalizeEditorDraft(steps)[0].targets, apps);
assert.deepEqual(
  normalizeEditorDraft([{ action: "Volume", targets: apps }])[0].targets,
  apps,
);
assert.deepEqual(
  normalizeEditorDraft([{ action: "", targets: apps }])[0].targets,
  apps,
);

await createAppDom();
const refs = createDomRefs();
const sessions = apps.map(({ Application: app }, index) => ({
  id: `session-${index}`,
  application_key: app.name,
  process_name: `${app.name}.exe`,
  display_name: app.display_name,
  is_master: false,
}));
const core = createTargetCore({ getSessions: () => sessions });
const targets = createTargetsFeature({
  invoke: async () => [],
  dom: refs.targets,
  i18n: { t: (key) => key },
  getSessions: () => sessions,
  normalizeSessionKey: core.normalizeSessionKey,
  integrationTargetKey: core.integrationTargetKey,
  resolveOsdTarget: core.resolveOsdTarget,
});
let bindings = [
  normalizeBinding({
    id: "many-apps",
    device_id: "midi-dev",
    control: { channel: 0, controller: 7, msg_type: "ControlChange" },
    control_kind: "Continuous",
    action: "Volume",
    targets: ["Unset"],
  }),
];
const saved = [];
const feature = createBindingsFeature({
  invoke: async (command, args) => {
    if (command === "add_binding") saved.push(structuredClone(args.binding));
  },
  dom: refs.bindings,
  getBindings: () => bindings,
  setBindings: (next) => {
    bindings = next;
  },
  buildTargetSelect: targets.buildTargetSelect,
  getVolumeForTarget: () => 0.4,
  bindingLastValues: {},
  bindingMuteValues: {},
  bindingInteractionTimes: {},
  i18n: { t: (key) => key },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const dropdown = () =>
  feature.getRenderedBindingRefs("many-apps").targetDropdown;
targets.bindUi();
feature.bindUi();
feature.renderBindings();
try {
  for (const { Application: app } of apps) {
    await dropdown().openTargetPicker();
    const option = [
      ...refs.targets.targetPanelList.querySelectorAll(".target-option"),
    ].find(
      (item) =>
        item.querySelector(".target-label-main")?.textContent ===
        app.display_name,
    );
    assert.ok(option, `${app.display_name} must be selectable`);
    option.click();
    await settle();
  }
  assert.deepEqual(
    dropdown().__selectedTargets,
    apps,
    "the picker must accept more than 8 apps",
  );
  assert.equal(saved.length, apps.length, "every selection is saved");
  assert.deepEqual(saved.at(-1).targets, apps, "saving must retain every app");

  bindings = [normalizeBinding(JSON.parse(JSON.stringify(saved.at(-1))))];
  feature.renderBindings();
  assert.deepEqual(
    dropdown().__selectedTargets,
    apps,
    "reloading must retain every app",
  );
  const chips = dropdown().querySelectorAll(".target-chip");
  assert.equal(
    chips.length,
    apps.length,
    "every app has a visible, removable chip",
  );
  chips[16].querySelector("button").click();
  await settle();
  const remaining = apps.filter((_, index) => index !== 16);
  assert.deepEqual(
    saved.at(-1).targets,
    remaining,
    "removing a later app preserves the others",
  );
} finally {
  feature.dispose();
  targets.dispose();
}
console.log("Target capacity tests passed");

import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createDomRefs } from "../src/app/dom_refs.js";
import { createTargetsFeature } from "../src/features/targets/targets.js";
import { normalizeBinding, normalizeOpenApplicationMapping } from "../src/core/binding_model.js";

await createAppDom();
const dom = createDomRefs().targets;
let picks = 0;
let picked = { path: "C:\\Shortcuts\\My App.lnk", display: "My App", icon_data: null };
const feature = createTargetsFeature({
  dom, i18n: { t: key => key },
  invoke: async command => {
    if (command === "pick_executable_path") { picks++; return picked; }
    return [];
  },
});
const select = feature.buildTargetSelect(["Master"], true, "ToggleMute");
document.body.append(select);
const openEditor = async () => {
  await select.openTargetPicker();
  const card = [...dom.targetPanelList.querySelectorAll(".target-option")]
    .find(item => item.querySelector(".target-label")?.textContent === "targets.openApplication");
  assert.ok(card, "Open Application is a picker option");
  card.click();
  return dom.targetPanelList.querySelector("form");
};
const settle = () => new Promise(resolve => setImmediate(resolve));
feature.bindUi();
try {
  let form = await openEditor();
  assert.ok(form, "Open Application shows the editor before opening a file dialog");
  assert.equal(picks, 0);
  assert.equal(form.querySelector('[type="submit"]').disabled, true);
  form.querySelector("button").click();
  await settle();
  assert.equal(picks, 1);
  const args = '--profile "Work Profile" --path "C:\\Folder With Spaces"';
  form.querySelectorAll("input")[1].value = args;
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(dom.targetPanel.classList.contains("hidden"), true);
  assert.equal(select.getOpenApplication().path, picked.path);
  assert.equal(select.getOpenApplication().arguments, args);
  const binding = normalizeBinding({ id: "app", targets: ["OpenApplication"], control_kind: "Button", action: "OpenApplication", open_application: select.getOpenApplication() });
  assert.equal(normalizeBinding(JSON.parse(JSON.stringify(binding))).open_application.arguments, args, "binding arguments survive persistence");
  const macro = normalizeBinding({ id: "macro", control_kind: "Button", action: "Macro", macro_steps: [{ type: "Action", action: "OpenApplication", targets: ["OpenApplication"], open_application: binding.open_application }] });
  assert.equal(macro.macro_steps[0].open_application.arguments, args, "macro actions preserve launch arguments");
  form = await openEditor();
  assert.equal(form.querySelectorAll("input")[0].value, picked.path);
  assert.equal(form.querySelectorAll("input")[1].value, args, "editing pre-fills parameters");
  form.querySelectorAll("input")[1].value = "discard me";
  [...form.querySelectorAll("button")].find(button => button.textContent === "common.cancel").click();
  assert.equal(dom.targetPanel.classList.contains("target-panel--application"), false);
  assert.equal(dom.targetPanel.classList.contains("hidden"), false, "Cancel returns to the target picker");
  assert.equal(select.getOpenApplication().arguments, args, "Cancel preserves the saved launch mapping");
  form = await openEditor();
  picked = null;
  form.querySelector("button").click();
  await settle();
  assert.equal(form.querySelectorAll("input")[0].value, binding.open_application.path, "cancelling the native file picker preserves the current application");
  assert.equal(normalizeOpenApplicationMapping({ path: "old.exe" }).arguments, undefined, "legacy mappings need no new field");
} finally { feature.dispose(); }
console.log("Application launch editor, cancellation, arguments, and macro persistence tests passed");

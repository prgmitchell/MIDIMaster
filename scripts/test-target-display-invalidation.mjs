import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createDomRefs } from "../src/app/dom_refs.js";
import { createTargetsFeature } from "../src/features/targets/targets.js";

await createAppDom();
const refs = createDomRefs();
let language = "en",
  actionLabel = "Toggle input";
let metadata = { label: "Input (Audio)", icon_data: "data:image/png;base64,first", ghost: false };
const host = {
  getIntegrations: () => [{ id: "example", name: "Example" }],
  getIntegration: () => ({
    buttonActions: [{ value: "ToggleMute", label: actionLabel }],
    describeTarget: () => metadata,
  }),
};
const target = { Integration: { integration_id: "example", kind: "audio", data: { id: "input" } } };
const secondTarget = { Application: { name: "app.exe", display_name: "Application" } };
const feature = createTargetsFeature({
  invoke: async () => [],
  dom: refs.targets,
  i18n: { t: (key) => `${language}:${key}` },
  getPluginHost: () => host,
  integrationTargetKey: (integration) => JSON.stringify(integration),
  resolveOsdTarget: () => metadata,
});
const dropdown = feature.buildTargetSelect([target, secondTarget], true, "ToggleMute");
document.body.appendChild(dropdown);
const display = () => dropdown.querySelector(".target-display");
const chips = () => [...dropdown.querySelectorAll(".target-chip")];
let created = 0;
const create = document.createElement.bind(document),
  createNS = document.createElementNS.bind(document);
document.createElement = (...args) => {
  created++;
  return create(...args);
};
document.createElementNS = (...args) => {
  created++;
  return createNS(...args);
};

try {
  const initial = chips();
  assert.equal(initial.length, 2);
  for (let refresh = 0; refresh < 100; refresh++) dropdown.refreshTargetDisplay();
  assert.equal(created, 0);
  assert.deepEqual(chips(), initial, "unchanged refreshes retain the chip buttons and icons");

  metadata = { ...metadata, label: "Renamed (Audio)" };
  dropdown.refreshTargetDisplay();
  assert.match(display().textContent, /Renamed/);
  assert.notEqual(chips()[0], initial[0]);
  let previousIcon = chips()[0].querySelector("img");
  metadata = { ...metadata, icon_data: "data:image/png;base64,second" };
  dropdown.refreshTargetDisplay();
  assert.notEqual(chips()[0].querySelector("img"), previousIcon);
  assert.equal(chips()[0].querySelector("img").getAttribute("src"), metadata.icon_data);

  metadata = { ...metadata, ghost: true };
  dropdown.refreshTargetDisplay();
  assert.equal(chips()[0].classList.contains("unavailable"), true);
  metadata = { ...metadata, ghost: false };
  dropdown.refreshTargetDisplay();
  assert.equal(chips()[0].classList.contains("unavailable"), false);

  actionLabel = "Disable input";
  dropdown.refreshTargetDisplay();
  assert.match(chips()[0].textContent, /Disable input/);
  language = "fr";
  dropdown.refreshTargetDisplay();
  assert.equal(chips()[0].querySelector("button").title, "fr:targets.removeTarget");
  const localized = chips();
  dropdown.refreshTargetDisplay();
  assert.deepEqual(chips(), localized);

  chips()[0].querySelector("button").click();
  assert.deepEqual(
    dropdown.__selectedTargets,
    [secondTarget],
    "cached remove listeners act on the current selection",
  );
  assert.equal(chips().length, 1);
  assert.equal(chips()[0].dataset.index, "0");
  assert.equal(dropdown.querySelector(".target-chips-wrap").classList.contains("is-scrollable"), false);
  chips()[0].querySelector("button").click();
  assert.deepEqual(dropdown.__selectedTargets, []);
  assert.equal(chips().length, 0);
  assert.ok(dropdown.querySelector(".target-placeholder"));
  created = 0;
  dropdown.refreshTargetDisplay();
  assert.equal(created, 0, "unchanged placeholder remains attached");
} finally {
  feature.dispose();
  document.createElement = create;
  document.createElementNS = createNS;
}
console.log("Target display output caching and invalidation tests passed");

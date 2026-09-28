import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createDomRefs } from "../src/app/dom_refs.js";
import { createTargetsFeature } from "../src/features/targets/targets.js";
import { createTargetCore } from "../src/core/target_core.js";
import { focusableApplicationNames } from "../src/features/targets/controllers/window_focus.js";

await createAppDom();
const dom = createDomRefs().targets;
const waveLink = "aumid:elgato.wavelink_g54w8ztgkx496!app";
const sessions = [
  { id: "master", display_name: "Master", is_master: true },
  { id: "wave-1", display_name: "Wave Link", application_key: waveLink },
  { id: "wave-2", display_name: "Wave Link", application_key: waveLink },
  { id: "notepad", display_name: "Notepad", process_name: "notepad.exe" },
  { id: "system", display_name: "System Sounds", application_key: "system sounds" },
];
const core = createTargetCore({ getSessions: () => sessions });
let available = ["notepad"];
let failLookup = false;
let pendingLookup = null;
const requests = [];
const feature = createTargetsFeature({
  dom,
  invoke: async (command, { applicationNames }) => {
    assert.equal(command, "filter_focusable_applications");
    requests.push(applicationNames);
    if (failLookup) throw new Error("Window lookup failed");
    if (pendingLookup) return pendingLookup;
    return available;
  },
  i18n: { t: (key) => key },
  getSessions: () => sessions,
  normalizeSessionKey: core.normalizeSessionKey,
  integrationTargetKey: core.integrationTargetKey,
  resolveOsdTarget: core.resolveOsdTarget,
});
const flush = () => new Promise(setImmediate);
const cards = () => [...dom.targetPanelList.querySelectorAll("button.target-option")];
const cardNamed = (label) =>
  cards().find((card) => card.querySelector(".target-label")?.textContent === label);
async function openFocusPicker(select) {
  await select.openTargetPicker();
  assert.ok(cardNamed("Wave Link"), "tray-only apps remain available for audio controls");
  cardNamed("targets.windowFocus").click();
  await flush();
}

feature.bindUi();
try {
  const select = feature.buildTargetSelect("Unset", true, "ToggleMute", "", null, null, {
    allowEmptyInitial: true,
  });
  document.body.append(select);
  await openFocusPicker(select);
  assert.deepEqual(
    cards().map((card) => card.querySelector(".target-label").textContent),
    ["Notepad"],
  );
  assert.deepEqual(requests[0], [waveLink, "notepad", "system sounds"]);

  available = [waveLink, "notepad"];
  await openFocusPicker(select);
  assert.equal(cards().length, 2, "reopening the picker refreshes availability and deduplicates sessions");
  cardNamed("Wave Link").click();
  assert.equal(select.dataset.action, "FocusWindow");
  assert.equal(select.__selectedTargets[0].Application.name, waveLink);
  const savedTargets = structuredClone(select.__selectedTargets);

  available = ["notepad"];
  await openFocusPicker(select);
  assert.equal(cardNamed("Wave Link"), undefined);
  assert.deepEqual(
    select.__selectedTargets,
    savedTargets,
    "hiding a window does not remove its saved binding",
  );
  assert.equal(select.dataset.action, "FocusWindow");

  available = [];
  await openFocusPicker(select);
  assert.equal(cards().length, 1);
  assert.equal(cardNamed("targets.noneAvailable").disabled, true);

  available = [waveLink];
  failLookup = true;
  await openFocusPicker(select);
  assert.equal(cardNamed("Wave Link"), undefined);
  assert.equal(cardNamed("targets.noneAvailable").disabled, true);
  failLookup = false;

  let resolveLookup;
  pendingLookup = new Promise((resolve) => {
    resolveLookup = resolve;
  });
  await select.openTargetPicker();
  cardNamed("targets.windowFocus").click();
  feature.closeTargetPanel();
  resolveLookup([waveLink]);
  await flush();
  assert.equal(
    dom.targetPanel.classList.contains("hidden"),
    true,
    "a late response does not reopen a closed picker",
  );

  pendingLookup = new Promise((resolve) => {
    resolveLookup = resolve;
  });
  await select.openTargetPicker();
  cardNamed("targets.windowFocus").click();
  await select.openTargetPicker();
  resolveLookup([waveLink]);
  await flush();
  assert.equal(
    dom.targetPanelTitle.textContent,
    "targets.selectTargets",
    "a late response does not replace a newer picker",
  );

  assert.deepEqual([...(await focusableApplicationNames(null, [waveLink]))], []);
  assert.deepEqual([...(await focusableApplicationNames(async () => null, [waveLink]))], []);
} finally {
  feature.dispose();
}
console.log("Window focus picker tests passed");

import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createDomRefs } from "../src/app/dom_refs.js";
import { createBindingsFeature } from "../src/features/bindings/bindings.js";
import { createTargetsFeature } from "../src/features/targets/targets.js";
import { normalizeBinding } from "../src/core/binding_model.js";

const { document, flushFrames } = await createAppDom();
const refs = createDomRefs();
const d = refs.bindings;
const settle = () => new Promise((resolve) => setImmediate(resolve));
let language = "en",
  deviceLabel = "Controller",
  liveValue = null;
let targetDisplay = { label: "Master (System)", icon_kind: "master" };
let editingId = null,
  pendingFocusId = null,
  dragState = null;
const i18n = { t: (key) => `${language}:${key}` };
const commands = [];
let removeBindingGate = null;
const invoke = async (command, args) => {
  commands.push({ command, args });
  if (command === "remove_binding" && removeBindingGate) return removeBindingGate;
  return null;
};
const targets = createTargetsFeature({
  invoke,
  dom: refs.targets,
  i18n,
  resolveOsdTarget: () => targetDisplay,
});
let bindings = ["Other", "Music button", "Music fader", "Music extra"].map((name, index) =>
  normalizeBinding({
    id: `binding-${index}`,
    name,
    device_id: "controller",
    targets: ["Master"],
    action: index === 1 ? "ToggleMute" : "Volume",
    control_kind: index === 1 ? "Button" : "Continuous",
    control: { channel: 1, controller: index, msg_type: "ControlChange" },
  }),
);
const feature = createBindingsFeature({
  invoke,
  dom: d,
  i18n,
  getBindings: () => bindings,
  setBindings: (value) => {
    bindings = value;
  },
  getVolumeForTarget: () => 0.4,
  getMidiDeviceLabel: () => deviceLabel,
  getLiveMidiValueForControl: () => liveValue,
  bindingLastValues: {},
  bindingMuteValues: {},
  bindingInteractionTimes: {},
  buildTargetSelect: targets.buildTargetSelect,
  createTargetIcon: targets.createTargetIcon,
  resolveOsdTarget: () => targetDisplay,
  showConfirm: async () => true,
  getEditingBindingId: () => editingId,
  setEditingBindingId: (value) => {
    editingId = value;
  },
  getPendingFocusBindingId: () => pendingFocusId,
  setPendingFocusBindingId: (value) => {
    pendingFocusId = value;
  },
  getDragState: () => dragState,
  setDragState: (value) => {
    dragState = value;
  },
});
const row = (id) => feature.getRenderedBindingRefs(id)?.item;
const search = (value) => {
  d.bindingSearchInput.value = value;
  d.bindingSearchInput.dispatchEvent(new window.Event("input"));
};
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
  feature.bindUi();
  feature.renderBindings();
  flushFrames();
  const original = bindings.map(({ id }) => row(id));
  created = 0;
  search("music");
  assert.equal(created, 0, "filtering only removes rows; matching rows and target chips are reused");
  assert.equal(row("binding-0"), undefined);
  assert.equal(row("binding-2"), original[2]);
  assert.equal(original[2].dataset.visibleIndex, "1");
  assert.equal(original[2].dataset.index, "2");

  const drag = original[2].querySelector(".binding-drag");
  drag.setPointerCapture = () => {};
  const pointer = new window.Event("pointerdown");
  Object.assign(pointer, { pointerId: 1, clientX: 0, clientY: 0 });
  drag.dispatchEvent(pointer);
  assert.deepEqual(dragState.visibleBindingIds, ["binding-1", "binding-2", "binding-3"]);
  assert.equal(dragState.visibleIndex, 1, "reused drag listeners use the filtered ordering");
  feature.cancelBindingDrag();
  d.bindingTypeFilter.querySelector('[data-filter="faders"]').click();
  assert.equal(row("binding-2"), original[2]);
  assert.equal(original[2].dataset.visibleIndex, "0");
  drag.dispatchEvent(pointer);
  assert.deepEqual(dragState.visibleBindingIds, ["binding-2", "binding-3"]);
  assert.equal(dragState.visibleIndex, 0);
  feature.cancelBindingDrag();

  let rowMutations = [];
  const observer = new window.MutationObserver((records) => rowMutations.push(...records));
  observer.observe(d.bindingsContainer, { childList: true });
  created = 0;
  feature.renderBindings();
  await settle();
  observer.disconnect();
  assert.equal(created, 0);
  assert.equal(
    rowMutations.filter(({ type }) => type === "childList").length,
    0,
    "unchanged rows stay attached in place",
  );

  const unaffected = row("binding-3");
  window.HTMLElement.prototype.select = function () {};
  feature.beginBindingEdit("binding-2", true);
  assert.equal(row("binding-3"), unaffected, "editing one name does not rebuild another row");
  const input = row("binding-2").querySelector(".binding-name-input");
  input.value = "Draft name";
  input.selectionStart = 2;
  input.selectionEnd = 6;
  feature.renderBindings();
  assert.equal(row("binding-2").querySelector(".binding-name-input"), input);
  assert.equal(input.value, "Draft name");
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 6);
  editingId = pendingFocusId = null;
  feature.renderBindings();
  language = "fr";
  document.documentElement.lang = "fr";
  feature.renderBindings();
  assert.match(row("binding-3").querySelector(".binding-name").title, /^fr:/);

  feature.beginBindingEdit("binding-2");
  flushFrames();
  flushFrames();
  const initialIcon = d.bindingConfigPreviewTargetIcon.firstChild;
  const initialSummary = d.bindingConfigPreviewMainMidi.firstChild;
  created = 0;
  for (let frame = 0; frame < 120; frame++) flushFrames();
  assert.equal(created, 0, "idle editor polling must not allocate replacement DOM");
  assert.equal(d.bindingConfigPreviewTargetIcon.firstChild, initialIcon);
  assert.equal(d.bindingConfigPreviewMainMidi.firstChild, initialSummary);

  liveValue = 0.8;
  flushFrames();
  assert.equal(d.bindingConfigPreviewValue.textContent, "80%");
  assert.equal(d.bindingConfigPreviewFill.style.height, "80%");
  assert.equal(d.bindingConfigPreviewTargetIcon.firstChild, initialIcon);
  assert.equal(d.bindingConfigPreviewMainMidi.firstChild, initialSummary);
  targetDisplay = { label: "Renamed (Available)", icon_kind: "focus" };
  flushFrames();
  assert.equal(d.bindingConfigPreviewTargetLabel.textContent, "Renamed");
  assert.equal(d.bindingConfigPreviewTargetTags.textContent, "Available");
  assert.notEqual(d.bindingConfigPreviewTargetIcon.firstChild, initialIcon);
  deviceLabel = "Reconnected controller";
  flushFrames();
  assert.match(d.bindingConfigPreviewMainMidi.textContent, /Reconnected controller/);
  assert.notEqual(d.bindingConfigPreviewMainMidi.firstChild, initialSummary);
  language = "de";
  flushFrames();
  assert.equal(d.bindingConfigPreviewMute.textContent, "de:bindings.notMapped");
  assert.equal(d.bindingConfigPreviewStatus.textContent, "de:bindings.receivingLiveFeedback");

  d.bindingConfigName.value = "Cancelled";
  d.bindingConfigName.dispatchEvent(new window.Event("input"));
  d.bindingConfigCancel.click();
  await settle();
  assert.equal(bindings.find(({ id }) => id === "binding-2").name, "Music fader");
  created = 0;
  flushFrames();
  assert.equal(created, 0, "closed editor stops its frame loop");
  assert.equal(commands.filter(({ command }) => command === "add_binding").length, 0);

  search("");
  d.bindingTypeFilter.querySelector("[data-filter='all']").click();
  const priorProfileRows = bindings.map(({ id }) => row(id));
  // Profile loading supplies fresh binding objects even when IDs and values match.
  bindings = structuredClone(bindings);
  feature.renderBindings();
  bindings.forEach(({ id }, index) => {
    assert.notEqual(
      row(id),
      priorProfileRows[index],
      "profile replacement invalidates captured row bindings",
    );
  });
  const replacedRows = bindings.map(({ id }) => row(id));
  bindings = [bindings[3], bindings[1], bindings[2], bindings[0]];
  feature.renderBindings();
  assert.deepEqual(
    [...d.bindingsContainer.children].map((element) => element.dataset.bindingId),
    ["binding-3", "binding-1", "binding-2", "binding-0"],
    "reconciliation follows the actual full ordering after a reorder",
  );
  assert.equal(row("binding-2"), replacedRows[2], "unmoved rows remain attached");
  assert.equal(row("binding-3").dataset.index, "0");
  assert.equal(row("binding-0").dataset.visibleIndex, "3");

  feature.beginBindingEdit("binding-3");
  flushFrames();
  assert.equal(d.bindingConfigName.value, "Music extra");
  assert.match(d.bindingConfigPreviewMainMidi.textContent, /CC 3/);
  d.bindingConfigCancel.click();
  await settle();

  let finishRemove;
  removeBindingGate = new Promise((resolve) => {
    finishRemove = resolve;
  });
  row("binding-3").querySelector(".binding-action.delete").click();
  await settle();
  bindings = [bindings[1], bindings[2], bindings[3], bindings[0]];
  feature.renderBindings();
  finishRemove();
  await settle();
  assert.deepEqual(
    bindings.map(({ id }) => id),
    ["binding-1", "binding-2", "binding-0"],
  );
  assert.equal(
    row("binding-3"),
    undefined,
    "async deletion locates the current row by ID after ordering changes",
  );
} finally {
  feature.dispose();
  targets.dispose();
  document.createElement = create;
  document.createElementNS = createNS;
}
console.log("Binding render efficiency and preview invalidation tests passed");

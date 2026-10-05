import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createDomRefs } from "../src/app/dom_refs.js";
import { createBindingsFeature } from "../src/features/bindings/bindings.js";
import { getFaderModifiers } from "../src/core/fader_modifiers.js";
import { findControlConflict } from "../src/core/control_mapping.js";
import { applyBindingDeviceMigrations } from "../src/core/midi_preferences.js";

const mapping = (controller) => ({
  device_id: "midi",
  channel: 0,
  controller,
  msg_type: "Note",
  mute_behavior: "SetFromValue",
});
const fader = (id, extra = {}) => ({
  id,
  name: id,
  device_id: "midi",
  targets: ["Master"],
  action: "Volume",
  control_kind: "Continuous",
  control: { channel: 0, controller: 7, msg_type: "ControlChange" },
  ...extra,
});
assert.deepEqual(
  getFaderModifiers(
    fader("empty", { mute_control: null, assign_control: null }),
  ),
  [],
);
assert.deepEqual(
  getFaderModifiers(
    fader("removed", { modifiers: [], mute_control: mapping(16) }),
  ),
  [],
  "an empty list cannot resurrect an old slot",
);

const { document } = await createAppDom();
const d = createDomRefs().bindings;
let bindings = [
  fader("legacy", {
    mute_control: mapping(16),
    assign_control: mapping(17),
    assign_mode: "Clear",
  }),
  fader("empty", {
    control: { channel: 0, controller: 8, msg_type: "ControlChange" },
  }),
];
let learned = null;
let failStart = false;
const timers = new Map();
let nextTimer = 0;
const oldSetInterval = globalThis.setInterval,
  oldClearInterval = globalThis.clearInterval;
globalThis.setInterval = (callback) => {
  timers.set(++nextTimer, callback);
  return nextTimer;
};
globalThis.clearInterval = (id) => timers.delete(id);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const feature = createBindingsFeature({
  dom: d,
  getBindings: () => bindings,
  setBindings: (next) => {
    bindings = next;
  },
  invoke: async (command) => {
    if (command === "start_midi_learn" && failStart) throw new Error("MIDI unavailable");
    if (command === "consume_learned_control") {
      const result = learned;
      learned = null;
      return result;
    }
  },
  getVolumeForTarget: () => 0.5,
  i18n: { t: (key) => key },
  bindingLastValues: {},
  bindingMuteValues: {},
  bindingInteractionTimes: {},
});
const rows = () => [
  ...document.querySelectorAll(".binding-config-modifier-row"),
];
const add = (kind) => {
  d.bindingConfigModifierAdd.click();
  d.bindingConfigModifierMenu
    .querySelector(`[data-modifier-kind="${kind}"]`)
    .click();
};
const save = async () => {
  d.bindingConfigSave.click();
  await settle();
};
const completeLearn = async (control) => {
  await settle();
  assert.equal(d.learnPanel.classList.contains("hidden"), false);
  assert.equal(
    d.bindingConfigModifierAdd.disabled,
    true,
    "learning locks list mutations",
  );
  learned = control;
  await [...timers.values()][0]();
};
const learn = async (row, control) => {
  row.querySelector("[data-modifier-learn]").click();
  await completeLearn(control);
};
try {
  feature.bindUi();
  feature.bindUi();
  feature.renderBindings();
  feature.beginBindingEdit("legacy");
  assert.equal(
    rows().length,
    2,
    "both assigned legacy controls appear without empty rows",
  );
  assert.equal(rows()[0].querySelector("select").value, "SetFromValue");
  assert.equal(rows()[1].querySelector("select").value, "Clear");
  add("Mute");
  assert.equal(rows().length, 2, "new modifiers stay hidden until assigned");
  assert.equal(d.learnPanel.classList.contains("hidden"), false, "Add starts Learn immediately");
  d.learnPanelCancel.click();
  await settle();
  assert.equal(rows().length, 2, "cancelling Add discards the pending modifier");
  add("Mute");
  await completeLearn(mapping(18));
  const mode = rows()[2].querySelector("select");
  const dropdown = rows()[2].querySelector(".settings-select-dropdown");
  assert.ok(dropdown, "modifier modes use the shared app dropdown");
  [...dropdown.querySelectorAll(".target-option")]
    .find((option) => option.textContent === "common.match")
    .click();
  assert.equal(
    mode.value,
    "SetFromValue",
    "the shared dropdown updates the modifier behavior",
  );
  await learn(rows()[2], { ...mapping(18), mute_behavior: "ToggleOnPress" });
  assert.equal(
    rows()[2].querySelector("select").value,
    "SetFromValue",
    "learning keeps the chosen behavior",
  );
  add("Assign");
  await completeLearn(mapping(19));
  const assignMode = rows()[3].querySelector("select");
  assignMode.value = "Replace";
  assignMode.dispatchEvent(new window.Event("change", { bubbles: true }));
  await save();
  assert.equal(bindings[0].modifiers.length, 4, "all controls persist");
  assert.equal(bindings[0].mute_control, null);
  assert.equal(bindings[0].assign_control, null);
  assert.equal(bindings[0].modifiers[3].assign_mode, "Replace");
  feature.beginBindingEdit("legacy");
  assert.equal(rows().length, 4);
  rows()[0].querySelector("[data-modifier-learn]").click();
  await settle();
  d.learnPanelCancel.click();
  assert.equal(rows().length, 4, "cancelling relearn keeps assigned modifiers");
  rows()[0].querySelector("[data-modifier-remove]").click();
  d.bindingConfigCancel.click();
  await settle();
  feature.beginBindingEdit("legacy");
  assert.equal(rows().length, 4, "cancel restores removed modifiers");
  const key = new window.Event("keydown", { bubbles: true });
  Object.assign(key, { altKey: true, key: "ArrowUp" });
  rows()[3].querySelector("button").dispatchEvent(key);
  assert.equal(
    rows()[2].dataset.modifierId,
    bindings[0].modifiers[3].id,
    "keyboard reorder moves the complete modifier",
  );
  rows()[0].querySelector("[data-modifier-remove]").click();
  await save();
  assert.equal(bindings[0].modifiers.length, 3);
  const mapped = bindings[0].modifiers[0];
  assert.equal(
    findControlConflict(bindings, mapped.control).field,
    `modifier:${mapped.id}`,
    "all modifier addresses participate in conflicts",
  );
  const migrated = applyBindingDeviceMigrations(bindings[0], [
    { bindingId: "legacy", previousDeviceId: "midi", deviceId: "replacement" },
  ]);
  assert.ok(
    migrated.modifiers.every(
      (item) => item.control.device_id === "replacement",
    ),
  );
  feature.beginBindingEdit("empty");
  assert.equal(rows().length, 0, "unassigned legacy slots are absent");
  failStart = true;
  add("Solo");
  await settle();
  failStart = false;
  assert.equal(rows().length, 0, "failed Learn does not create an unassigned row");
  assert.equal(d.learnPanel.classList.contains("hidden"), true);
  assert.equal(d.bindingConfigModifierAdd.disabled, false);
  add("Mute");
  await completeLearn(mapped.control);
  assert.equal(
    d.learnPanelConfirm.classList.contains("hidden"),
    false,
    "learning another owner's modifier offers transfer",
  );
  d.learnPanelCancel.click();
  assert.equal(rows().length, 0, "cancelling a transfer discards the new modifier");
  d.bindingConfigCancel.click();
  await settle();
  assert.equal(
    bindings[0].modifiers.length,
    3,
    "canceling a transfer keeps the source intact",
  );
  feature.beginBindingEdit("empty");
  add("Mute");
  await completeLearn(mapped.control);
  d.learnPanelConfirm.click();
  await settle();
  await save();
  assert.equal(
    bindings[0].modifiers.length,
    2,
    "transfer removes the source modifier on save",
  );
  assert.equal(bindings[1].modifiers.length, 1);
  feature.beginBindingEdit("empty");
  add("Assign");
  await save();
  assert.equal(
    bindings[1].modifiers.length,
    1,
    "unmapped draft rows are omitted when saved",
  );
  feature.beginBindingEdit("empty");
  rows()[0].querySelector("[data-modifier-remove]").click();
  await save();
  feature.beginBindingEdit("empty");
  assert.equal(
    rows().length,
    0,
    "removing the last modifier remains empty after reopening",
  );
  add("Mute");
  await completeLearn({ ...mapping(8), msg_type: "ControlChange" });
  assert.equal(
    d.learnPanelConfirm.classList.contains("hidden"),
    true,
    "the same fader's primary control cannot be transferred away",
  );
  d.learnPanelCancel.click();
  assert.equal(rows().length, 0, "rejecting the primary control leaves no pending row");
  add("Mute");
  await completeLearn(mapping(20));
  add("Mute");
  await completeLearn(mapping(20));
  assert.equal(
    d.learnPanelConfirm.classList.contains("hidden"),
    false,
    "conflicts include newly learned draft modifiers",
  );
  d.learnPanelConfirm.click();
  await settle();
  assert.equal(rows().length, 1, "transferred-away draft modifiers disappear immediately");
  await save();
  assert.equal(
    bindings[1].modifiers.length,
    1,
    "transferring between draft rows keeps only the mapped row",
  );
  assert.ok(bindings[1].control, "the primary mapping stays intact");
  feature.beginBindingEdit("empty");
  add("Solo");
  await completeLearn(mapping(21));
  await save();
  assert.equal(bindings[1].modifiers[1].kind, "Solo");
  assert.equal(bindings[1].modifiers[1].control.controller, 21);
  feature.beginBindingEdit("empty");
  assert.equal(rows().length, 2, "Solo persists alongside other modifiers");
  assert.equal(rows()[1].querySelector(".binding-config-modifier-copy strong").textContent, "bindings.solo");
} finally {
  feature.dispose();
  globalThis.setInterval = oldSetInterval;
  globalThis.clearInterval = oldClearInterval;
}
console.log(
  "Fader modifier migration, editing, learning, transfer, and persistence tests passed",
);

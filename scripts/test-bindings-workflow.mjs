import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createBindingsFeature } from "../src/features/bindings/bindings.js";
import { createDomRefs } from "../src/app/dom_refs.js";
import { normalizeBinding } from "../src/core/binding_model.js";

const { document } = await createAppDom();
const refs = createDomRefs();
let bindings = [
  normalizeBinding({
    id: "fader-1",
    name: "Music",
    device_id: "device-1",
    action: "Volume",
    targets: ["Master"],
    control_kind: "Continuous",
    control: { channel: 1, controller: 7, msg_type: "ControlChange" },
  }),
];
const commands = [];
let learned = null;
const sound = { path: "fixture.wav", display: "Fixture", duration_ms: 1000, peaks: [] };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const change = (element, value, type = "change") => {
  element.value = value;
  element.dispatchEvent(new window.Event(type));
};
const feature = createBindingsFeature({
  invoke: async (command, args) => {
    commands.push({ command, args });
    if (command === "consume_learned_control") {
      const result = learned;
      learned = null;
      return result;
    }
    if (command === "pick_soundboard_audio" || command === "analyze_soundboard_audio") return sound;
    if (command === "list_soundboard_output_devices") return [];
    if (command === "get_virtual_audio_status") return { install_state: "not-installed" };
  },
  dom: refs.bindings,
  getBindings: () => bindings,
  setBindings: (next) => {
    bindings = next;
  },
  getVolumeForTarget: () => 0.4,
  bindingLastValues: {},
  bindingMuteValues: {},
  bindingInteractionTimes: {},
  i18n: { t: (key) => key },
});
feature.bindUi();
feature.bindUi();
feature.renderBindings();
assert.equal(document.querySelectorAll(".binding-item[data-binding-id]").length, 1);
assert.equal(document.querySelector(".binding-item").dataset.bindingId, "fader-1");
assert.ok(feature.getRenderedBindingRefs("fader-1"));
const row = document.querySelector(".binding-item");
feature.renderBindings();
assert.equal(document.querySelector(".binding-item"), row, "unchanged rows retain DOM identity");
assert.equal(commands.length, 0, "rendering must not persist or execute a binding");
feature.beginBindingEdit("fader-1");
assert.equal(refs.bindings.bindingConfigPanel.classList.contains("hidden"), false);
refs.bindings.bindingConfigName.value = "Changed draft";
refs.bindings.bindingConfigName.dispatchEvent(new window.Event("input"));
assert.equal(bindings[0].name, "Music", "draft edits do not mutate the saved binding");
const d = refs.bindings;
assert.equal(d.bindingConfigFeedbackOutputSection.classList.contains("hidden"), false);
change(d.bindingConfigFeedbackMsgType, "PitchBend");
assert.equal(d.bindingConfigFeedbackController.disabled, true);
assert.equal(d.bindingConfigFeedbackController.value, "N/A");
d.bindingConfigAssignModeClear.click();
d.bindingConfigSave.click();
await settle();
assert.equal(bindings[0].name, "Changed draft");
assert.equal(bindings[0].assign_mode, "Clear");
assert.equal(bindings[0].indicator_control.msg_type, "PitchBend");
assert.equal(bindings[0].indicator_control.controller, 0);
assert.equal(d.bindingConfigPanel.classList.contains("hidden"), true);
assert.equal(commands.filter(({ command }) => command === "add_binding").length, 1, "binding UI binds once");

feature.beginBindingEdit("fader-1");
change(d.bindingConfigFeedbackMsgType, "Disabled");
assert.equal(d.bindingConfigFeedbackOutputCustom.classList.contains("is-feedback-disabled"), true);
d.bindingConfigSave.click();
await settle();
assert.equal(bindings[0].feedback_enabled, false);
assert.equal(bindings[0].indicator_control.msg_type, "PitchBend", "disabling feedback retains its address");
feature.beginBindingEdit("fader-1");
d.bindingConfigFeedbackClear.click();
assert.equal(d.bindingConfigFeedbackMsgType.value, "ControlChange");
change(d.bindingConfigName, "Cancel this", "input");
d.bindingConfigClose.click();
await settle();
assert.equal(bindings[0].name, "Changed draft");
assert.equal(bindings[0].feedback_enabled, false, "cancel restores the persisted feedback choice");

bindings.push(
  normalizeBinding({ id: "button", control_kind: "Button", action: "ToggleMute", targets: ["Master"] }),
);
feature.renderBindings();
assert.equal(document.querySelectorAll(".binding-item[data-binding-id]").length, 2);
assert.equal(document.querySelectorAll(".error-binding").length, 0, "both row types render successfully");
feature.beginBindingEdit("button");
assert.equal(d.bindingConfigFeedbackOutputSection.classList.contains("hidden"), true);
change(d.bindingConfigButtonLightSelect, "Disabled");
d.bindingConfigSave.click();
await settle();
assert.equal(bindings[1].feedback_enabled, false);
feature.beginBindingEdit("button");
change(d.bindingConfigButtonLightSelect, "MappedWhenAssigned");
d.bindingConfigSave.click();
await settle();
assert.equal(bindings[1].feedback_enabled, true);
assert.equal(bindings[1].button_light_mode, "MappedWhenAssigned");

// Learn with a controlled scheduler while exercising the real event handlers.
const oldInterval = globalThis.setInterval,
  oldClear = globalThis.clearInterval;
const timers = new Map();
let timerId = 0;
globalThis.setInterval = (callback, delay) => {
  const id = ++timerId;
  timers.set(id, { callback, delay });
  return id;
};
globalThis.clearInterval = (id) => timers.delete(id);
try {
  feature.beginBindingEdit("fader-1");
  const icon = d.bindingConfigFeedbackLearn.innerHTML;
  d.bindingConfigFeedbackLearn.click();
  await settle();
  assert.equal(d.learnPanel.classList.contains("hidden"), false);
  assert.equal(d.bindingConfigFeedbackLearn.innerHTML, icon, "learning preserves icon markup");
  assert.equal(d.bindingConfigFeedbackLearn.getAttribute("aria-label"), "bindings.listening");
  learned = { device_id: "device-1", channel: 2, controller: 33, msg_type: "PitchBend" };
  await [...timers.values()].find((x) => x.delay === 200).callback();
  assert.equal(d.bindingConfigFeedbackController.value, "N/A");
  d.bindingConfigSave.click();
  await settle();
  assert.equal(bindings[0].indicator_control.channel, 2);
  assert.equal(bindings[0].indicator_control.controller, 0);
  feature.beginBindingEdit("fader-1");
  d.bindingConfigPreviewLearnButton.click();
  await settle();
  assert.equal(d.learnPanel.classList.contains("hidden"), false);
  d.bindingConfigClose.click();
  await settle();
  assert.equal(timers.size, 0, "closing configuration stops primary learn and preview timers");
} finally {
  globalThis.setInterval = oldInterval;
  globalThis.clearInterval = oldClear;
}

// Selecting Soundboard opens an empty editor; only Pick Sound opens the file picker.
let target = feature.getRenderedBindingRefs("button").targetDropdown;
target.__selectedTargets = ["Soundboard"];
target.dispatchEvent(new window.Event("change"));
await settle();
await settle();
assert.ok(d.bindingConfigPanel.classList.contains("binding-config-panel--soundboard-page"));
assert.equal(
  commands.some((x) => x.command === "pick_soundboard_audio"),
  false,
);
assert.equal(d.bindingConfigSoundboardSection.classList.contains("is-empty"), true);
assert.equal(d.bindingConfigSave.disabled, false);
d.bindingConfigClose.click();
await settle();
assert.equal(
  bindings.some((x) => x.id === "button"),
  true,
);
assert.equal(
  bindings.find((x) => x.id === "button").targets.includes("Soundboard"),
  false,
  "cancel removes a newly added empty target, not the binding",
);
target = feature.getRenderedBindingRefs("button").targetDropdown;
target.__selectedTargets = ["Soundboard"];
target.dispatchEvent(new window.Event("change"));
await settle();
await settle();
await d.bindingConfigSoundboardReplace.onclick();
assert.equal(d.bindingConfigSoundboardSection.classList.contains("is-empty"), false);
assert.equal(
  d.bindingConfigSoundboardVirtualMic.disabled,
  true,
  "unavailable virtual audio cannot be selected",
);
await d.bindingConfigSoundboardPreview.onclick();
await d.bindingConfigSoundboardPreview.onclick();
assert.ok(commands.some((x) => x.command === "set_soundboard_preview_paused" && x.args.paused === true));
d.bindingConfigSave.click();
await settle();
assert.equal(bindings.find((x) => x.id === "button").soundboard.path, "fixture.wav");
assert.ok(
  commands.some((x) => x.command === "stop_soundboard_preview"),
  "closing stops playback",
);

// Macro editing preserves ordering and incomplete parallel drafts across Save/Cancel.
bindings.push(
  normalizeBinding({
    id: "macro",
    name: "Scene change",
    control_kind: "Button",
    action: "Macro",
    targets: ["Macro"],
    macro_steps: [],
  }),
);
feature.renderBindings();
const openMacro = () =>
  feature.getRenderedBindingRefs("macro").item.querySelector(".binding-macro-edit-button").click();
openMacro();
const addMacroStep = (label) =>
  [...document.querySelectorAll(".binding-config-macro-add-actions button")]
    .find((button) => button.textContent === label)
    .click();
addMacroStep("macro.addWait");
addMacroStep("macro.addParallel");
assert.equal(bindings.find((b) => b.id === "macro").macro_steps.length, 0, "macro edits stay in the draft");
d.bindingConfigSave.click();
await settle();
assert.deepEqual(
  bindings.find((b) => b.id === "macro").macro_steps.map((step) => step.kind),
  ["wait", "parallel"],
);
openMacro();
addMacroStep("macro.addAction");
d.bindingConfigClose.click();
await settle();
assert.deepEqual(
  bindings.find((b) => b.id === "macro").macro_steps.map((step) => step.kind),
  ["wait", "parallel"],
  "Cancel rolls back new macro steps",
);
feature.dispose();
bindings = [];
feature.renderBindings();
assert.equal(document.querySelectorAll(".binding-item[data-binding-id]").length, 0);
assert.equal(document.querySelector(".bindings-empty").textContent, "bindings.noBindings");
console.log("Binding workflow tests passed");

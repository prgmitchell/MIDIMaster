import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createDomRefs } from "../src/app/dom_refs.js";
import { createBindingsFeature } from "../src/features/bindings/bindings.js";
import { normalizeBinding } from "../src/core/binding_model.js";
import { applyBindingDeviceMigrations } from "../src/core/midi_preferences.js";

const { document } = await createAppDom();
const d = createDomRefs().bindings;
let bindings = [
  normalizeBinding({
    id: "fader",
    name: "Fader",
    device_id: "midi",
    targets: ["Master"],
    action: "Volume",
    control_kind: "Continuous",
    mode: "Absolute",
    control: { channel: 0, controller: 0, msg_type: "PitchBend" },
  }),
];
const original = structuredClone(bindings);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const feature = createBindingsFeature({
  dom: d,
  getBindings: () => bindings,
  setBindings: (value) => {
    bindings = value;
  },
  invoke: async () => null,
  getVolumeForTarget: () => 0.5,
  getMidiDeviceLabel: () => "Controller",
  i18n: { t: (key) => key },
  bindingLastValues: {},
  bindingMuteValues: {},
  bindingInteractionTimes: {},
});
const rows = () => [...d.bindingConfigOutputsList.children];
const add = (kind) => {
  d.bindingConfigOutputAdd.click();
  d.bindingConfigOutputMenu
    .querySelector(`[data-output-kind="${kind}"]`)
    .click();
};
const input = (field, value) => {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
};
const chooseMode = (row, value) => {
  const trigger = row.querySelector("[data-output-mode-trigger]");
  assert.ok(trigger.querySelector("[data-output-mode-icon]"));
  trigger.click();
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  const selectedLabel = [
    ...row.querySelector(".binding-config-output-mode select").options,
  ].find(
    (option) =>
      option.value ===
      (value === "audioReactive" ? "AudioReactive" : "FollowValue"),
  ).textContent;
  const option = [
    ...row.querySelectorAll(".binding-config-output-mode .target-option"),
  ].find((button) => button.textContent === selectedLabel);
  assert.ok(option);
  option.click();
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.ok(
    trigger.title.includes(`bindings.${value}`),
    "gear tooltip reflects the selection",
  );
};
try {
  feature.bindUi();
  feature.beginBindingEdit("fader");
  assert.equal(rows().length, 2, "legacy profiles retain both default rows");
  for (const row of rows()) {
    row.click();
    assert.equal(d.bindingConfigOutputRemove.disabled, true);
    assert.equal(
      row.querySelector("[data-output-remove]").disabled,
      true,
      "default rows cannot be removed",
    );
  }
  chooseMode(rows()[1], "audioReactive");
  assert.equal(d.bindingConfigFeedbackMode.value, "AudioReactive");
  add("Feedback");
  add("Led");
  assert.equal(rows().length, 4);
  const feedback = rows()[2],
    led = rows()[3];
  assert.equal(
    document.querySelector(
      `[data-output-id="${feedback.dataset.outputId}"] [data-output-channel]`,
    ).value,
    "2",
    "new Pitch Bend output avoids the primary address",
  );
  const type = document.querySelector(
    `[data-output-id="${led.dataset.outputId}"] [data-output-type]`,
  );
  type.value = "ChannelPressure";
  type.dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(
    document.querySelector(
      `[data-output-id="${led.dataset.outputId}"] [data-output-channel]`,
    ).disabled,
    true,
  );
  input(
    document.querySelector(
      `[data-output-id="${led.dataset.outputId}"] [data-output-control]`,
    ),
    "4",
  );
  chooseMode(led, "audioReactive");
  d.bindingConfigSave.click();
  await settle();
  assert.equal(bindings[0].additional_outputs.length, 2);
  assert.equal(
    bindings[0].feedback_mode,
    "AudioReactive",
    "default gear selection persists",
  );
  assert.equal(bindings[0].additional_outputs[0].control.msg_type, "PitchBend");
  assert.equal(
    bindings[0].additional_outputs[1].control.controller,
    3,
    "meter strip UI is one-based",
  );
  assert.equal(
    bindings[0].additional_outputs[1].feedback_mode,
    "AudioReactive",
  );
  feature.beginBindingEdit("fader");
  assert.equal(d.bindingConfigFeedbackMode.value, "AudioReactive");
  assert.equal(
    rows().length,
    4,
    "all destinations reopen from the saved profile",
  );
  rows()[2].click();
  d.bindingConfigOutputRemove.click();
  assert.equal(rows().length, 3);
  rows()[2].querySelector("[data-output-remove]").click();
  assert.equal(rows().length, 2);
  add("Led");
  d.bindingConfigCancel.click();
  await settle();
  assert.equal(
    bindings[0].additional_outputs.length,
    2,
    "Cancel discards output edits",
  );
  const migrated = applyBindingDeviceMigrations(bindings[0], [
    { bindingId: "fader", previousDeviceId: "midi", deviceId: "reconnected" },
  ]);
  assert.ok(
    migrated.additional_outputs.every(
      (output) => output.control.device_id === "reconnected",
    ),
  );
  feature.beginBindingEdit("fader");
  rows()[3].querySelector("[data-output-remove]").click();
  d.bindingConfigSave.click();
  await settle();
  assert.equal(bindings[0].additional_outputs.length, 1);
  assert.deepEqual(
    bindings[0].control,
    original[0].control,
    "editing outputs preserves the input mapping",
  );
  const normalized = normalizeBinding({
    ...bindings[0],
    additional_outputs: [
      {
        kind: "Led",
        id: "invalid",
        control: { device_id: "midi", msg_type: "PitchBend" },
      },
      ...bindings[0].additional_outputs,
    ],
  });
  assert.equal(
    normalized.additional_outputs.length,
    1,
    "LED outputs cannot accept motor Pitch Bend addresses",
  );
  feature.beginBindingEdit("fader");
  assert.ok(
    d.bindingConfigOutputsList.contains(d.bindingConfigFeedbackChannel),
  );
  assert.ok(d.bindingConfigOutputsList.contains(d.bindingConfigLedChannel));
  assert.equal(
    d.bindingConfigOutputsList.querySelector("[data-output-edit]"),
    null,
  );
  assert.ok(
    rows().every(
      (row) =>
        row.querySelector(".binding-config-output-icon svg") &&
        row.querySelector("[data-output-grip]"),
    ),
  );
  input(d.bindingConfigFeedbackChannel, "3");
  const key = new Event("keydown", { bubbles: true });
  Object.assign(key, { altKey: true, key: "ArrowDown" });
  rows()[0].querySelector("[data-output-grip]").dispatchEvent(key);
  assert.equal(
    rows()[0].dataset.outputId,
    "default-led",
    "permanent defaults can be reordered",
  );
  const extraId = rows()[2].dataset.outputId;
  rows()[2]
    .querySelector("[data-output-grip]")
    .dispatchEvent(new Event("dragstart", { bubbles: true }));
  rows()[1].dispatchEvent(new Event("drop", { bubbles: true }));
  assert.deepEqual(
    rows().map((row) => row.dataset.outputId),
    ["default-led", extraId, "default-feedback"],
  );
  d.bindingConfigSave.click();
  await settle();
  assert.deepEqual(bindings[0].output_order, [
    "default-led",
    extraId,
    "default-feedback",
  ]);
  feature.beginBindingEdit("fader");
  assert.equal(
    d.bindingConfigFeedbackChannel.value,
    "3",
    "inline default fields persist after reordering and saving",
  );
  assert.deepEqual(
    rows().map((row) => row.dataset.outputId),
    bindings[0].output_order,
    "order survives saving and reopening",
  );
  assert.equal(rows()[2].querySelector("[data-output-remove]").disabled, true);
} finally {
  feature.dispose();
}
console.log(
  "Fader output defaults, add/remove, persistence, cancellation, and reconnect tests passed",
);

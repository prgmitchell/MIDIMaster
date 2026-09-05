import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createDomRefs } from "../src/app/dom_refs.js";
import { createBindingsFeature } from "../src/features/bindings/bindings.js";
import { normalizeBinding } from "../src/core/binding_model.js";
import { readRenderedBindingValue } from "../src/app/performance_rendered_value.js";

await createAppDom();
const dom = createDomRefs();
const bindings = [
  { id: "fader", action: "Volume", control_kind: "Continuous" },
  { id: "toggle", action: "ToggleMute", control_kind: "Button" },
  { id: "momentary", action: "Volume", control_kind: "Button" },
].map((binding) => normalizeBinding({ ...binding, targets: ["Master"] }));
const feature = createBindingsFeature({
  invoke: async () => {},
  dom: dom.bindings,
  getBindings: () => bindings,
  getVolumeForTarget: () => 0.4,
  bindingLastValues: {},
  bindingMuteValues: {},
  bindingInteractionTimes: {},
});
try {
  feature.renderBindings();
  const fader = feature.getRenderedBindingRefs("fader");
  assert.equal(readRenderedBindingValue(fader, { volume: 0.4 }), 0.4);
  fader.muteButton.classList.add("muted");
  assert.equal(readRenderedBindingValue(fader, { muted: true }), 1);

  const toggle = feature.getRenderedBindingRefs("toggle");
  feature.setButtonVisualState("toggle", true);
  assert.equal(toggle.muteButton.classList.contains("visually-hidden"), true);
  assert.equal(toggle.muteButton.classList.contains("muted"), false);
  assert.equal(
    readRenderedBindingValue(toggle, { muted: true }),
    1,
    "reads the visible face, not stale hidden mute state",
  );
  feature.setButtonVisualState("toggle", false);
  assert.equal(readRenderedBindingValue(toggle, { muted: false }), 0);
  const toggleFace = toggle.item.querySelector(".binding-momentary-value");
  toggleFace.className = "binding-toggle-value on";
  assert.equal(readRenderedBindingValue(toggle, { volume: 1 }), 1, "legacy toggle uses its on class");
  toggleFace.classList.remove("on");
  assert.equal(readRenderedBindingValue(toggle, { volume: 0 }), 0);

  const momentary = feature.getRenderedBindingRefs("momentary");
  feature.setButtonVisualState("momentary", true);
  assert.equal(readRenderedBindingValue(momentary, { volume: 1 }), 1);
  feature.setButtonVisualState("momentary", false);
  assert.equal(readRenderedBindingValue(momentary, { volume: 0 }), 0);
  assert.equal(readRenderedBindingValue(momentary, { volume: 0 }, { visibilityState: "hidden" }), null);
  dom.bindings.mainScreen.classList.add("hidden");
  assert.equal(
    readRenderedBindingValue(fader, { volume: 0.4 }),
    null,
    "another app page is not a visible MIDI result",
  );
  dom.bindings.mainScreen.classList.remove("hidden");
  fader.item.hidden = true;
  assert.equal(readRenderedBindingValue(fader, { volume: 0.4 }), null);
  fader.item.hidden = false;
  fader.item.remove();
  assert.equal(readRenderedBindingValue(fader, { volume: 0.4 }), null);
  assert.equal(readRenderedBindingValue(null, {}), null);
} finally {
  feature.dispose();
}
console.log("Performance result reads visible fader, toggle and momentary controls");

import assert from "node:assert/strict";
import { createBindingRenderModel } from "../src/features/bindings/render_model.js";

const model = createBindingRenderModel({
  fallbackNameFor: (_binding, index) => `Binding ${index + 1}`,
  labelForControl: (control) => `CC ${control.controller}`,
  displayModeName: (binding) => binding.mode,
  getTargets: (binding) => binding.targets,
  isButtonBinding: (binding) => binding.kind === "button",
});

assert.equal(model.normalizeTypeFilter("BUTTONS"), "buttons");
assert.equal(model.normalizeTypeFilter("unknown"), "all");
assert.equal(model.matchesTypeFilter({ kind: "button" }, "buttons"), true);
assert.equal(model.matchesTypeFilter({ kind: "fader" }, "buttons"), false);
assert.match(model.searchText({ control: { controller: 7 }, mode: "Absolute", targets: ["Master"] }, 0), /binding 1 cc 7 absolute.*master/);

console.log("Binding render model tests passed");

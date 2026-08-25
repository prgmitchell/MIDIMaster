import assert from "node:assert/strict";
import {
  defaultMacroParallelStep,
  ensureMacroName,
  macroActionRole,
  macroIntegrationActionLabel,
  normalizeMacroDraftSteps,
  prepareMacroDraftBinding,
} from "../src/features/bindings/macro_draft.js";

const named = { name: "Launch Scene", macro_name: "" };
assert.equal(ensureMacroName(named, { defaultIfBlank: true }), "Launch Scene");
assert.equal(defaultMacroParallelStep().steps.length, 2);

const legacy = normalizeMacroDraftSteps([{ action: "Volume", targets: ["Master"] }]);
assert.deepEqual(legacy[0], { kind: "action", action: "", targets: ["Master"], state: "Default" });

const command = {
  action: "Volume",
  targets: [{ Integration: { integration_id: "hue", data: { button_action: "turn_on" } } }],
};
assert.equal(macroActionRole(command), "command");
assert.equal(macroIntegrationActionLabel(command), "Turn On");

const binding = { name: "Binding 1", targets: ["Master"], macro_steps: [] };
prepareMacroDraftBinding(binding, { preservePlaceholders: true });
assert.equal(binding.action, "Macro");
assert.deepEqual(binding.targets, ["Macro"]);
assert.equal(binding.macro_name, "My Macro");

console.log("Macro draft tests passed");

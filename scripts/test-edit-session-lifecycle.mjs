import assert from "node:assert/strict";
import { createMappingAssignment } from "../src/features/bindings/controllers/mapping_assignment.js";
import { createConfigModal } from "../src/features/bindings/controllers/config_modal.js";
import { normalizeBinding } from "../src/core/binding_model.js";
const noop = () => {};
const mapping = { device_id: "midi", channel: 0, controller: 7, msg_type: "Note", control_kind: "Button" };
const binding = normalizeBinding({ id: "same", target: "Master", mute_control: mapping });
const state = {
  acceptedTransfers: new Map(),
  transferPrompt: { field: "assign_control", mapping, conflict: { binding, field: "mute_control" } },
};
const assignment = createMappingAssignment({
  editorState: state,
  getConfigBinding: () => binding,
  clearTransferPrompt: () => {
    state.transferPrompt = null;
  },
  hideLearnPanel: noop,
  renderConfigModal: noop,
});
await assignment.commitTransferPrompt();
assert.equal(binding.mute_control, null);
assert.equal(binding.assign_control, mapping);
assert.equal(state.acceptedTransfers.size, 0);
state.transferPrompt = {
  field: "indicator_control",
  mapping,
  conflict: { binding: { id: "other" }, field: "mute_control" },
};
await assignment.commitTransferPrompt();
assert.equal(state.acceptedTransfers.size, 1);
assert.equal(binding.feedback_enabled, true);
const calls = [];
const editorState = {
  acceptedTransfers: new Map(),
  draft: binding,
  bindingId: "same",
  removeEmptySoundboardTargetOnCancel: false,
};
const modal = createConfigModal({
  editorState,
  soundboardState: { analysisToken: 0, virtualAudioStatusToken: 0 },
  curveState: {},
  macroState: {},
  elements: {},
  stopSoundboardPreview: async () => calls.push("stop sound"),
  hotkeyLearn: { stop: () => calls.push("stop hotkey") },
  stopAuxLearn: () => calls.push("stop midi"),
  restoreConfigPreviewBindings: async () => calls.push("restore preview"),
  clearTransferPrompt: noop,
  closeMuteModeMenu: noop,
  closeAssignModeMenu: noop,
  closeCurvePresetMenu: noop,
  stopConfigPreviewTimer: noop,
  closeCurvePresetForm: noop,
  cancelMacroDrag: noop,
});
await modal.closeConfigModal();
assert.deepEqual(calls, ["stop sound", "stop hotkey", "stop midi", "restore preview"]);
assert.equal(editorState.draft, null);
assert.equal(editorState.bindingId, null);
console.log("Edit session lifecycle and mapping transfer tests passed");

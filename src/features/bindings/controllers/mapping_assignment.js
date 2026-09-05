import { findControlConflict } from "../../../core/control_mapping.js";
import {
  effectiveIsButton,
  normalizeControlKind,
  normalizeMuteBehavior,
  ensureAuxShape,
} from "../shape_helpers.js";

/** mapping assignment workflow. */
export function createMappingAssignment({
  applyPrimaryControlPreview,
  clearTransferPrompt,
  editorState,
  getBindings,
  getBindingById,
  getConfigBinding,
  hideLearnPanel,
  invoke,
  normalizeAuxControl,
  normalizeIndicatorControl,
  renderConfigModal,
  renderConfigPreview,
  setLearnPanelTransfer,
  setLearnPanelWaiting,
  setTransferPrompt,
  stopAuxLearn,
  updateAuxLearnUi,
}) {
  function findMappingConflict(bindingId, field, mapping) {
    return findControlConflict(editorState.previewOriginalBindings || getBindings(), mapping, {
      bindingId,
      field,
    });
  }

  function conflictFieldLabel(field, binding) {
    if (field === "control") return "Primary";
    if (field === "mute_control") return "Mute";
    if (field === "assign_control") return "Assign";
    if (field === "indicator_control") {
      return effectiveIsButton(binding) ? "Indicator" : "Feedback output";
    }
    return "Mapping";
  }

  async function commitTransferPrompt() {
    if (!editorState.transferPrompt) return;
    const { field, mapping, conflict } = editorState.transferPrompt;
    clearTransferPrompt();
    const binding = getConfigBinding();
    if (!binding) return;
    if (!conflict || !conflict.binding) return;
    const sameBindingTransfer = conflict.binding.id === binding.id;
    if (sameBindingTransfer && conflict.field !== field) {
      binding[conflict.field] = null;
    }
    if (field === "control") {
      binding.device_id = mapping.device_id;
      binding.control = {
        channel: mapping.channel,
        controller: mapping.controller,
        msg_type: mapping.msg_type || "ControlChange",
      };
      binding.control_kind = normalizeControlKind(mapping.control_kind);
      binding.mode = mapping.mode || binding.mode || "Absolute";
    } else {
      if (field === "mute_control" && mapping && typeof mapping === "object") {
        mapping.mute_behavior = normalizeMuteBehavior(mapping.mute_behavior || binding.mute_behavior);
      }
      binding[field] = mapping;
      if (field === "indicator_control") binding.feedback_enabled = true;
    }
    if (sameBindingTransfer) {
      editorState.acceptedTransfers.delete(field);
    } else {
      editorState.acceptedTransfers.set(field, { field, mapping, conflict });
    }
    if (field === "control") {
      await applyPrimaryControlPreview();
    }
    hideLearnPanel();
    renderConfigModal();
  }

  async function applyAuxMapping(field, mapping) {
    const binding = getConfigBinding();
    if (!binding) return;
    ensureAuxShape(binding);

    const conflict = findMappingConflict(binding.id, field, mapping);
    if (conflict) {
      const ownerName = conflict.binding.name || "Binding";
      const ownerSlot = conflictFieldLabel(conflict.field, conflict.binding);
      const message =
        conflict.field === "control"
          ? `This control is the primary mapping on "${ownerName}". Transferring it here will delete that binding. Continue?`
          : `This control is already mapped as ${ownerSlot} on "${ownerName}". Transfer it here?`;
      setTransferPrompt({
        field,
        mapping,
        conflict,
        message,
      });
      setLearnPanelTransfer(message);
      return;
    }

    if (field === "control") {
      binding.device_id = mapping.device_id;
      binding.control = {
        channel: mapping.channel,
        controller: mapping.controller,
        msg_type: mapping.msg_type || "ControlChange",
      };
      binding.control_kind = normalizeControlKind(mapping.control_kind);
      binding.mode = mapping.mode || binding.mode || "Absolute";
    } else {
      if (field === "mute_control" && mapping && typeof mapping === "object") {
        mapping.mute_behavior = normalizeMuteBehavior(mapping.mute_behavior || binding.mute_behavior);
      }
      binding[field] = mapping;
      if (field === "indicator_control") binding.feedback_enabled = true;
    }
    editorState.acceptedTransfers.delete(field);
    if (field === "control") {
      await applyPrimaryControlPreview();
    }
    hideLearnPanel();
    renderConfigModal();
  }

  async function startPrimaryLearn() {
    const binding = getBindingById(editorState.bindingId);
    if (!binding) return;
    if (editorState.transferPrompt || editorState.learnField) return;
    editorState.learnField = "control";
    renderConfigPreview();
    updateAuxLearnUi();
    setLearnPanelWaiting();
    await invoke("start_midi_learn");
    if (editorState.learnTimer) clearInterval(editorState.learnTimer);
    editorState.learnTimer = setInterval(async () => {
      try {
        const learned = await invoke("consume_learned_control");
        if (!learned) return;
        const targetField = editorState.learnField;
        stopAuxLearn({ closePanel: false });
        if (targetField !== "control") return;
        const mapping = normalizeAuxControl(learned);
        await applyAuxMapping("control", mapping);
      } catch {
        stopAuxLearn();
        renderConfigModal();
      }
    }, 200);
  }

  async function startAuxLearn(field) {
    const binding = getBindingById(editorState.bindingId);
    if (!binding) return;
    if (editorState.transferPrompt) return;
    if (editorState.learnField) return;
    editorState.learnField = field;
    updateAuxLearnUi();
    setLearnPanelWaiting();
    await invoke("start_midi_learn");
    if (editorState.learnTimer) clearInterval(editorState.learnTimer);
    editorState.learnTimer = setInterval(async () => {
      try {
        const learned = await invoke("consume_learned_control");
        if (!learned) return;
        const targetField = editorState.learnField;
        stopAuxLearn({ closePanel: false });
        if (!targetField) return;
        const isFaderFeedbackOutput =
          targetField === "indicator_control" && !effectiveIsButton(getConfigBinding());
        const mapping =
          targetField === "indicator_control"
            ? normalizeIndicatorControl(learned, {
                allowPitchBend: isFaderFeedbackOutput,
                controlKind: isFaderFeedbackOutput ? "Continuous" : "Button",
              })
            : normalizeAuxControl(learned);
        if (!mapping) {
          renderConfigModal();
          return;
        }
        if (targetField === "indicator_control" && !effectiveIsButton(getConfigBinding())) {
          mapping.control_kind = "Continuous";
        }
        await applyAuxMapping(targetField, mapping);
      } catch {
        stopAuxLearn();
      }
    }, 200);
  }

  return { commitTransferPrompt, startPrimaryLearn, startAuxLearn };
}

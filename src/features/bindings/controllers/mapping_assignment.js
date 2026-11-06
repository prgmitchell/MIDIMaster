import { createMidiLearnSession } from "../../midi/learn_session.js";
import {
  setControlMapping,
  modifierForField,
} from "../../../core/fader_modifiers.js";
import { findControlConflict } from "../../../core/control_mapping.js";
import { outputForField } from "../../../core/fader_outputs.js";
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
  t,
}) {
  function findMappingConflict(bindingId, field, mapping) {
    const current = getConfigBinding();
    const bindings = (editorState.previewOriginalBindings || getBindings()).map(
      (binding) => (binding.id === bindingId && current ? current : binding),
    );
    return findControlConflict(bindings, mapping, {
      bindingId,
      field,
    });
  }

  function conflictFieldLabel(field, binding) {
    if (field === "control") return "Primary";
    if (field.startsWith("modifier:"))
      return modifierForField(binding, field)?.kind || "Modifier";
    if (field.startsWith("output:"))
      return outputForField(binding, field)?.kind === "Led"
        ? t("bindings.ledOutput")
        : t("bindings.feedbackOutput");
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
      setControlMapping(binding, conflict.field, null);
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
        mapping.mute_behavior = normalizeMuteBehavior(
          mapping.mute_behavior || binding.mute_behavior,
        );
      }
      setControlMapping(binding, field, mapping);
      if (field === "indicator_control") binding.feedback_enabled = true;
      if (field === "led_control") binding.led_enabled = true;
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
      if (conflict.binding.id === binding.id && conflict.field === "control") {
        setLearnPanelTransfer(t("bindings.modifierPrimaryConflict"), {
          allowTransfer: false,
        });
        return;
      }
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
        mapping.mute_behavior = normalizeMuteBehavior(
          mapping.mute_behavior || binding.mute_behavior,
        );
      }
      setControlMapping(binding, field, mapping);
      if (field === "indicator_control") binding.feedback_enabled = true;
      if (field === "led_control") binding.led_enabled = true;
    }
    editorState.acceptedTransfers.delete(field);
    if (field === "control") {
      await applyPrimaryControlPreview();
    }
    hideLearnPanel();
    renderConfigModal();
  }

  function startPrimaryLearn() {
    startAuxLearn("control");
  }

  function startAuxLearn(field) {
    if (!getBindingById(editorState.bindingId) || editorState.transferPrompt || editorState.learnField) return;
    editorState.learnField = field;
    renderConfigPreview();
    updateAuxLearnUi();
    setLearnPanelWaiting();
    const session = createMidiLearnSession({
      invoke,
      intervalMs: 200,
      onLearned: async learned => {
        if (editorState.learnSession !== session) return;
        stopAuxLearn({ closePanel: false });
        const isFaderFeedbackOutput =
          (field === "indicator_control" || outputForField(getConfigBinding(), field)?.kind === "Feedback") &&
          !effectiveIsButton(getConfigBinding());
        const mapping = field === "indicator_control" || field === "led_control" || field.startsWith("output:")
          ? normalizeIndicatorControl(learned, {
              allowPitchBend: isFaderFeedbackOutput,
              controlKind: isFaderFeedbackOutput ? "Continuous" : "Button",
            })
          : normalizeAuxControl(learned);
        if (!mapping) {
          stopAuxLearn();
          renderConfigModal();
          return;
        }
        if (field === "indicator_control" && !effectiveIsButton(getConfigBinding())) mapping.control_kind = "Continuous";
        await applyAuxMapping(field, mapping);
      },
      onError: error => {
        if (editorState.learnSession && editorState.learnSession !== session) return;
        stopAuxLearn();
        renderConfigModal();
        console.error("MIDI mapping learning failed", error);
      },
    });
    editorState.learnSession = session;
  }

  return { commitTransferPrompt, startPrimaryLearn, startAuxLearn };
}

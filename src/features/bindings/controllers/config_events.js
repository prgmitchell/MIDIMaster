import { createSelectDropdownShell } from "../../ui/dropdown_select.js";
import { normalizeButtonLightBehavior, presetCurvePoints } from "../../../core/binding_model.js";
import { normalizeMuteBehavior, curveEditorPoints } from "../shape_helpers.js";
import { localCustomCurvePoint, segmentIndexForCurveX } from "../curve_geometry.js";

/** config events workflow. */
export function createConfigEvents({
  lifetime,
  activeCustomCurvePreset,
  addCustomCurvePoint,
  cancelMacroDrag,
  clearTransferPrompt,
  closeAssignModeMenu,
  closeConfigModal,
  closeCurvePresetForm,
  closeCurvePresetMenu,
  closeMuteModeMenu,
  commitTransferPrompt,
  curveState,
  customCurveSurfaceFromEvent,
  elements,
  editorState,
  endMacroDrag,
  ensureMacroConfigDom,
  getConfigBinding,
  hotkeyLearn,
  listState,
  openAssignModeMenu,
  openCurvePresetForm,
  openMuteModeMenu,
  removeCustomCurvePoint,
  renderAssignMappingLabel,
  renderButtonLightDropdown,
  renderConfigModal,
  renderConfigPreview,
  renderCurvePresetMenu,
  renderIndicatorDropdowns,
  renderMuteMappingLabel,
  saveConfigModal,
  setCurvePresetMenuOpen,
  startAuxLearn,
  startPrimaryLearn,
  stopAuxLearn,
  submitCurvePresetForm,
  syncAssignModeUi,
  syncButtonLightUi,
  syncFeedbackOutputUi,
  syncIndicatorUi,
  syncMuteModeUi,
  t,
  updateAuxLearnUi,
  updateCustomCurveFromPointer,
  updateFeedbackOutputFromFields,
  updateIndicatorFromFields,
  updateMacroDrag,
}) {
  function bindConfigModalUi() {
    const cancelAuxLearnFlow = () => {
      if (!editorState.bindingId) return;
      clearTransferPrompt();
      stopAuxLearn();
      renderConfigModal();
    };

    if (elements.bindingConfigButtonLightSelect && !listState.buttonLightDropdown) {
      listState.buttonLightDropdown = createSelectDropdownShell({
        selectEl: elements.bindingConfigButtonLightSelect,
        rootClass: "binding-config-light-dropdown settings-select-dropdown",
        title: t("bindings.toggleMuteLight"),
      });
      renderButtonLightDropdown();
    }
    if (elements.bindingConfigIndicatorMsgType && !listState.indicatorMsgTypeDropdown) {
      listState.indicatorMsgTypeDropdown = createSelectDropdownShell({
        selectEl: elements.bindingConfigIndicatorMsgType,
        rootClass: "binding-config-light-dropdown settings-select-dropdown",
        title: "Indicator message type",
      });
    }
    if (elements.bindingConfigFeedbackMsgType && !listState.feedbackOutputMsgTypeDropdown) {
      listState.feedbackOutputMsgTypeDropdown = createSelectDropdownShell({
        selectEl: elements.bindingConfigFeedbackMsgType,
        rootClass: "binding-config-light-dropdown settings-select-dropdown",
        title: t("bindings.feedbackMessageType"),
      });
    }
    renderIndicatorDropdowns();

    if (elements.bindingConfigPanel) {
      lifetime.listen(elements.bindingConfigPanel, "click", (event) => {
        if (event.target === elements.bindingConfigPanel) {
          closeConfigModal().catch((err) => console.error("Failed to close binding config:", err));
        }
      });
    }
    if (elements.bindingConfigClose) {
      lifetime.listen(elements.bindingConfigClose, "click", () => {
        closeConfigModal().catch((err) => console.error("Failed to close binding config:", err));
      });
    }
    ensureMacroConfigDom();
    if (elements.bindingConfigCancel) {
      lifetime.listen(elements.bindingConfigCancel, "click", () => {
        closeConfigModal().catch((err) => console.error("Failed to close binding config:", err));
      });
    }
    if (elements.bindingConfigSave) {
      lifetime.listen(elements.bindingConfigSave, "click", async () => {
        await saveConfigModal();
      });
    }
    if (elements.bindingConfigName) {
      lifetime.listen(elements.bindingConfigName, "input", () => {
        const binding = getConfigBinding();
        if (!binding) return;
        binding.name = elements.bindingConfigName.value;
        renderConfigPreview();
      });
    }
    if (elements.bindingConfigButtonLightSelect) {
      lifetime.listen(elements.bindingConfigButtonLightSelect, "change", () => {
        const binding = getConfigBinding();
        if (!binding) return;
        const nextMode = elements.bindingConfigButtonLightSelect.value;
        if (nextMode === "Disabled") {
          binding.feedback_enabled = false;
        } else if (nextMode === "MappedWhenAssigned") {
          binding.feedback_enabled = true;
          binding.button_light_mode = "MappedWhenAssigned";
          binding.button_light_behavior = normalizeButtonLightBehavior(binding.button_light_behavior);
        } else {
          binding.feedback_enabled = true;
          binding.button_light_mode = "Activity";
          binding.button_light_behavior = normalizeButtonLightBehavior(nextMode);
        }
        syncButtonLightUi(binding);
        updateAuxLearnUi();
        renderConfigPreview();
      });
    }
    lifetime.listen(elements.bindingConfigIndicatorMsgType, "change", updateIndicatorFromFields);
    lifetime.listen(elements.bindingConfigIndicatorChannel, "input", updateIndicatorFromFields);
    lifetime.listen(elements.bindingConfigIndicatorController, "input", updateIndicatorFromFields);
    lifetime.listen(elements.bindingConfigFeedbackMsgType, "change", updateFeedbackOutputFromFields);
    lifetime.listen(elements.bindingConfigFeedbackChannel, "input", updateFeedbackOutputFromFields);
    lifetime.listen(elements.bindingConfigFeedbackController, "input", updateFeedbackOutputFromFields);
    if (elements.bindingConfigPreviewLearnButton) {
      lifetime.listen(elements.bindingConfigPreviewLearnButton, "click", async () => {
        await startPrimaryLearn();
      });
    }
    if (elements.bindingConfigButtonLearnButton) {
      lifetime.listen(elements.bindingConfigButtonLearnButton, "click", async () => {
        await startPrimaryLearn();
      });
    }
    lifetime.listen(document, "keydown", (event) => {
      if (!editorState.bindingId || event.key !== "Escape") return;
      if (editorState.transferPrompt || editorState.learnField || hotkeyLearn.isActive()) return;
      closeConfigModal().catch((err) => console.error("Failed to close binding config:", err));
    });
    if (elements.bindingConfigCustomReset) {
      lifetime.listen(elements.bindingConfigCustomReset, "click", () => {
        const binding = getConfigBinding();
        if (!binding) return;
        binding.custom_curve = presetCurvePoints(binding.fader_curve);
        curveState.selectedCustomCurvePresetId = null;
        closeCurvePresetForm();
        renderConfigModal();
      });
    }
    if (elements.bindingConfigCurvePresetButton) {
      lifetime.listen(elements.bindingConfigCurvePresetButton, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setCurvePresetMenuOpen(!curveState.curvePresetMenuOpen);
      });
    }
    if (elements.bindingConfigCurvePresetSearch) {
      lifetime.listen(elements.bindingConfigCurvePresetSearch, "input", () => {
        curveState.curvePresetSearchQuery = elements.bindingConfigCurvePresetSearch.value || "";
        renderCurvePresetMenu();
      });
      lifetime.listen(elements.bindingConfigCurvePresetSearch, "click", (event) => {
        event.stopPropagation();
      });
    }
    if (elements.bindingConfigCurvePresetSave) {
      lifetime.listen(elements.bindingConfigCurvePresetSave, "click", () => {
        const binding = getConfigBinding();
        if (!binding) return;
        openCurvePresetForm("save", activeCustomCurvePreset(binding));
      });
    }
    if (elements.bindingConfigCurvePresetFormSave) {
      lifetime.listen(elements.bindingConfigCurvePresetFormSave, "click", async () => {
        await submitCurvePresetForm();
      });
    }
    if (elements.bindingConfigCurvePresetFormCancel) {
      lifetime.listen(elements.bindingConfigCurvePresetFormCancel, "click", () => {
        closeCurvePresetForm();
      });
    }
    if (elements.bindingConfigCurvePresetForm) {
      lifetime.listen(elements.bindingConfigCurvePresetForm, "click", (event) => {
        if (event.target === elements.bindingConfigCurvePresetForm) {
          closeCurvePresetForm();
        }
      });
    }
    if (elements.bindingConfigCurvePresetName) {
      lifetime.listen(elements.bindingConfigCurvePresetName, "keydown", async (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          await submitCurvePresetForm();
        } else if (event.key === "Escape") {
          event.preventDefault();
          closeCurvePresetForm();
        }
      });
    }
    if (elements.bindingConfigMuteLearn) {
      lifetime.listen(elements.bindingConfigMuteLearn, "click", async () => {
        await startAuxLearn("mute_control");
      });
    }
    if (elements.bindingConfigAssignLearn) {
      lifetime.listen(elements.bindingConfigAssignLearn, "click", async () => {
        await startAuxLearn("assign_control");
      });
    }
    if (elements.bindingConfigIndicatorLearn) {
      lifetime.listen(elements.bindingConfigIndicatorLearn, "click", async () => {
        await startAuxLearn("indicator_control");
      });
    }
    if (elements.bindingConfigFeedbackLearn) {
      lifetime.listen(elements.bindingConfigFeedbackLearn, "click", async () => {
        const binding = getConfigBinding();
        if (!binding) return;
        binding.feedback_enabled = true;
        syncFeedbackOutputUi(binding);
        updateAuxLearnUi();
        renderConfigPreview();
        await startAuxLearn("indicator_control");
      });
    }
    if (elements.bindingConfigMuteClear) {
      lifetime.listen(elements.bindingConfigMuteClear, "click", () => {
        if (editorState.transferPrompt) return;
        const binding = getConfigBinding();
        if (!binding) return;
        binding.mute_control = null;
        editorState.acceptedTransfers.delete("mute_control");
        renderConfigModal();
      });
    }
    if (elements.bindingConfigMuteModeButton) {
      lifetime.listen(elements.bindingConfigMuteModeButton, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const menu = elements.bindingConfigMuteModeMenu;
        if (!menu) return;
        if (menu.classList.contains("hidden")) {
          openMuteModeMenu();
        } else {
          closeMuteModeMenu();
        }
      });
    }
    if (elements.bindingConfigAssignClear) {
      lifetime.listen(elements.bindingConfigAssignClear, "click", () => {
        if (editorState.transferPrompt) return;
        const binding = getConfigBinding();
        if (!binding) return;
        binding.assign_control = null;
        editorState.acceptedTransfers.delete("assign_control");
        renderConfigModal();
      });
    }
    if (elements.bindingConfigIndicatorClear) {
      lifetime.listen(elements.bindingConfigIndicatorClear, "click", () => {
        if (editorState.transferPrompt) return;
        const binding = getConfigBinding();
        if (!binding) return;
        binding.indicator_control = null;
        editorState.acceptedTransfers.delete("indicator_control");
        syncIndicatorUi(binding);
        renderConfigPreview();
      });
    }
    if (elements.bindingConfigFeedbackClear) {
      lifetime.listen(elements.bindingConfigFeedbackClear, "click", () => {
        if (editorState.transferPrompt) return;
        const binding = getConfigBinding();
        if (!binding) return;
        binding.feedback_enabled = true;
        binding.indicator_control = null;
        editorState.acceptedTransfers.delete("indicator_control");
        syncFeedbackOutputUi(binding);
        renderConfigPreview();
      });
    }
    const onMuteModeOptionClick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      const mode = normalizeMuteBehavior(button?.dataset?.mode);
      const binding = getConfigBinding();
      if (!binding) return;
      binding.mute_behavior = mode;
      if (binding.mute_control && typeof binding.mute_control === "object") {
        binding.mute_control.mute_behavior = mode;
      }
      renderMuteMappingLabel(binding);
      syncMuteModeUi(mode);
      closeMuteModeMenu();
      renderConfigPreview();
    };
    if (elements.bindingConfigMuteModeToggle) {
      lifetime.listen(elements.bindingConfigMuteModeToggle, "click", onMuteModeOptionClick);
    }
    if (elements.bindingConfigMuteModeValue) {
      lifetime.listen(elements.bindingConfigMuteModeValue, "click", onMuteModeOptionClick);
    }
    if (elements.bindingConfigAssignModeButton) {
      lifetime.listen(elements.bindingConfigAssignModeButton, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const menu = elements.bindingConfigAssignModeMenu;
        if (!menu) return;
        if (menu.classList.contains("hidden")) {
          openAssignModeMenu();
        } else {
          closeAssignModeMenu();
        }
      });
    }
    const onAssignModeOptionClick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      const rawMode = button?.dataset?.mode;
      const mode = rawMode === "Replace" ? "Replace" : rawMode === "Clear" ? "Clear" : "Add";
      const binding = getConfigBinding();
      if (!binding) return;
      binding.assign_mode = mode;
      renderAssignMappingLabel(binding);
      syncAssignModeUi(binding.assign_mode);
      closeAssignModeMenu();
      renderConfigPreview();
    };
    if (elements.bindingConfigAssignModeAdd) {
      lifetime.listen(elements.bindingConfigAssignModeAdd, "click", onAssignModeOptionClick);
    }
    if (elements.bindingConfigAssignModeReplace) {
      lifetime.listen(elements.bindingConfigAssignModeReplace, "click", onAssignModeOptionClick);
    }
    if (elements.bindingConfigAssignModeClear) {
      lifetime.listen(elements.bindingConfigAssignModeClear, "click", onAssignModeOptionClick);
    }

    if (elements.learnPanel) {
      lifetime.listen(elements.learnPanel, "click", (event) => {
        if (event.target !== elements.learnPanel) return;
        if (hotkeyLearn.isActive()) return;
        if (!editorState.bindingId) return;
        cancelAuxLearnFlow();
      });
    }
    if (elements.learnPanelClose) {
      lifetime.listen(elements.learnPanelClose, "click", () => {
        if (hotkeyLearn.isActive()) return;
        if (!editorState.bindingId) return;
        cancelAuxLearnFlow();
      });
    }
    if (elements.learnPanelCancel) {
      lifetime.listen(elements.learnPanelCancel, "click", () => {
        if (hotkeyLearn.isActive()) return;
        if (!editorState.bindingId) return;
        cancelAuxLearnFlow();
      });
    }
    if (elements.learnPanelConfirm) {
      lifetime.listen(elements.learnPanelConfirm, "click", async () => {
        if (!editorState.bindingId || !editorState.transferPrompt) return;
        await commitTransferPrompt();
      });
    }

    if (elements.bindingConfigCurveCards) {
      lifetime.listen(elements.bindingConfigCurveCards, "pointerdown", (event) => {
        if (event.button !== 0) return;
        const target =
          event.target instanceof Element
            ? event.target.closest("circle.binding-config-curve-card-point")
            : null;
        if (target) {
          const card = target.closest(".binding-config-curve-card");
          if (!card || card.dataset.curve !== "Custom") return;
          const index = Number(target.dataset.pointIndex);
          if (!Number.isFinite(index)) return;
          event.preventDefault();
          event.stopPropagation();
          const surfaceEl = target.closest(".binding-config-curve-card-visual");
          if (!surfaceEl) return;
          curveState.customCurvePointer = { mode: "point", index, surfaceEl };
          target.setPointerCapture?.(event.pointerId);
          updateCustomCurveFromPointer(event);
          return;
        }

        const surfaceEl = customCurveSurfaceFromEvent(event);
        if (!surfaceEl || !event.altKey) return;
        const binding = getConfigBinding();
        const localPoint = binding ? localCustomCurvePoint(event, surfaceEl) : null;
        if (!binding || !localPoint) return;
        const points = curveEditorPoints(binding);
        const index = segmentIndexForCurveX(points, localPoint.x);
        if (index < 0) return;
        event.preventDefault();
        event.stopPropagation();
        curveState.customCurvePointer = { mode: "segment", index, surfaceEl };
        surfaceEl.setPointerCapture?.(event.pointerId);
        updateCustomCurveFromPointer(event);
      });

      lifetime.listen(elements.bindingConfigCurveCards, "dblclick", (event) => {
        addCustomCurvePoint(event);
      });

      lifetime.listen(elements.bindingConfigCurveCards, "contextmenu", (event) => {
        const target =
          event.target instanceof Element
            ? event.target.closest("circle.binding-config-curve-card-point")
            : null;
        if (!target) return;
        const card = target.closest(".binding-config-curve-card");
        if (!card || card.dataset.curve !== "Custom") return;
        const index = Number(target.dataset.pointIndex);
        if (!Number.isFinite(index)) return;
        removeCustomCurvePoint(index, event);
      });
    }

    lifetime.listen(document, "click", (event) => {
      if (!editorState.bindingId) return;
      const muteRoot = elements.bindingConfigMuteModeRoot;
      if (muteRoot && !muteRoot.contains(event.target)) {
        closeMuteModeMenu();
      }
      const curvePresetRoot = elements.bindingConfigCurvePresetRoot;
      if (elements.alertOverlay?.contains?.(event.target)) {
        return;
      }
      if (curvePresetRoot && !curvePresetRoot.contains(event.target)) {
        closeCurvePresetMenu();
      }
      const root = elements.bindingConfigAssignModeRoot;
      if (!root || root.contains(event.target)) return;
      closeAssignModeMenu();
    });

    lifetime.listen(document, "pointermove", (event) => {
      updateMacroDrag(event);
      if (!curveState.customCurvePointer) return;
      updateCustomCurveFromPointer(event);
    });

    lifetime.listen(document, "pointerup", () => {
      endMacroDrag();
      curveState.customCurvePointer = null;
    });

    lifetime.listen(document, "pointercancel", () => {
      cancelMacroDrag();
      curveState.customCurvePointer = null;
    });
  }

  return { bindConfigModalUi };
}

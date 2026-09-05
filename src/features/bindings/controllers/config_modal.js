import {
  normalizeSoundboardMapping,
  setBindingTargets as setTargets,
  getBindingTargets as getTargets,
} from "../../../core/binding_model.js";
import {
  cloneBindingDraft,
  isSoundboardTarget,
  ensureBindingShape,
  isMacroTarget,
  ensureAuxShape,
  effectiveIsButton,
} from "../shape_helpers.js";
import { clonePlain, normalizeMacroDraftSteps } from "../macro_draft.js";

/** config modal workflow. */
export function createConfigModal({
  cancelMacroDrag,
  clearTransferPrompt,
  closeAssignModeMenu,
  closeCurvePresetForm,
  closeCurvePresetMenu,
  closeMuteModeMenu,
  curveState,
  elements,
  editorState,
  ensureMacroConfigDom,
  finishBindingUiMutation,
  getBindings,
  getConfigBinding,
  hotkeyLearn,
  loadSoundboardAnalysis,
  macroState,
  persistBindingBackend,
  renderAssignMappingLabel,
  renderBindings,
  renderConfigPreview,
  renderCurveCards,
  renderCustomCurveEditor,
  renderMacroEditor,
  renderMuteMappingLabel,
  renderSoundboardEditor,
  restoreConfigPreviewBindings,
  setBindings,
  soundboardState,
  stopAuxLearn,
  stopConfigPreviewTimer,
  stopSoundboardPreview,
  syncAssignModeUi,
  syncButtonLightUi,
  syncCurvePresetToolbar,
  syncFeedbackOutputUi,
  syncMuteModeUi,
  t,
  updateAuxLearnUi,
}) {
  async function closeConfigModal({ commit = false } = {}) {
    if (editorState.initialPersistence) {
      await editorState.initialPersistence;
      editorState.initialPersistence = null;
    }
    const emptySoundboardBindingToClean =
      !commit &&
      editorState.removeEmptySoundboardTargetOnCancel &&
      !normalizeSoundboardMapping(editorState.draft?.soundboard)
        ? cloneBindingDraft(getBindingById(editorState.bindingId))
        : null;
    await stopSoundboardPreview();
    soundboardState.analysisToken += 1;
    soundboardState.virtualAudioStatusToken += 1;
    soundboardState.analysis = null;
    soundboardState.analysisError = "";
    soundboardState.virtualAudioState = "loading";
    soundboardState.pointerHandle = null;
    hotkeyLearn.stop();
    stopAuxLearn();
    clearTransferPrompt();
    closeMuteModeMenu();
    closeAssignModeMenu();
    closeCurvePresetMenu();
    stopConfigPreviewTimer();
    curveState.customCurvePointer = null;
    curveState.curvePresetSearchQuery = "";
    closeCurvePresetForm();
    curveState.selectedCustomCurvePresetId = null;
    cancelMacroDrag();
    if (!commit) {
      await restoreConfigPreviewBindings();
    }
    if (emptySoundboardBindingToClean) {
      try {
        setTargets(
          emptySoundboardBindingToClean,
          getTargets(emptySoundboardBindingToClean).filter((target) => !isSoundboardTarget(target)),
        );
        emptySoundboardBindingToClean.soundboard = null;
        if (emptySoundboardBindingToClean.action === "Soundboard") {
          emptySoundboardBindingToClean.action = "ToggleMute";
        }
        ensureBindingShape(emptySoundboardBindingToClean);
        await persistBindingBackend(emptySoundboardBindingToClean);
        setBindings(
          getBindings().map((binding) =>
            binding.id === emptySoundboardBindingToClean.id ? emptySoundboardBindingToClean : binding,
          ),
        );
        renderBindings();
        finishBindingUiMutation("cancel empty soundboard target");
      } catch (error) {
        console.error("Failed to remove canceled Soundboard target:", error);
      }
    }
    editorState.previewOriginalBindings = null;
    editorState.acceptedTransfers.clear();
    editorState.draft = null;
    editorState.bindingId = null;
    macroState.pageOpen = false;
    editorState.soundboardPageOpen = false;
    editorState.initialPersistence = null;
    editorState.removeEmptySoundboardTargetOnCancel = false;
    macroState.selectedPath = null;
    if (elements.bindingConfigPanel) elements.bindingConfigPanel.classList.add("hidden");
  }

  function getBindingById(bindingId) {
    return getBindings().find((binding) => binding.id === bindingId) || null;
  }

  function renderConfigModal() {
    const binding = getConfigBinding();
    if (!binding) {
      closeConfigModal().catch((err) => console.error("Failed to close binding config:", err));
      return;
    }
    closeAssignModeMenu();
    closeMuteModeMenu();
    const preserveMacroDraftSteps =
      macroState.pageOpen && (binding.action === "Macro" || getTargets(binding).some(isMacroTarget))
        ? clonePlain(binding.macro_steps || [])
        : null;
    ensureAuxShape(binding);
    ensureBindingShape(binding);
    if (preserveMacroDraftSteps) {
      binding.macro_steps = normalizeMacroDraftSteps(preserveMacroDraftSteps);
    }
    ensureMacroConfigDom();
    const isButton = effectiveIsButton(binding);
    const isMacroBinding = isButton && binding.action === "Macro";
    const isSoundboardBinding =
      isButton && (binding.action === "Soundboard" || getTargets(binding).some(isSoundboardTarget));
    const showMacroPage = isMacroBinding && macroState.pageOpen;
    const showSoundboardPage = isSoundboardBinding && editorState.soundboardPageOpen;
    const showSpecialPage = showMacroPage || showSoundboardPage;
    if (elements.bindingConfigSave) elements.bindingConfigSave.disabled = false;
    if (elements.bindingConfigTitle) {
      elements.bindingConfigTitle.textContent = showMacroPage
        ? t("macro.configure")
        : showSoundboardPage
          ? t("soundboard.configure")
          : isButton
            ? t("bindings.buttonConfiguration")
            : t("bindings.faderConfiguration");
    }
    if (elements.bindingConfigBack) {
      elements.bindingConfigBack.classList.add("hidden");
      elements.bindingConfigBack.disabled = true;
    }
    if (elements.bindingConfigPanel) {
      elements.bindingConfigPanel.classList.toggle("binding-config-panel--button", isButton);
      elements.bindingConfigPanel.classList.toggle("binding-config-panel--fader", !isButton);
      elements.bindingConfigPanel.classList.toggle("binding-config-panel--macro-page", showMacroPage);
      elements.bindingConfigPanel.classList.toggle(
        "binding-config-panel--soundboard-page",
        showSoundboardPage,
      );
    }
    const nameSection = elements.bindingConfigName?.closest?.(".binding-config-section");
    if (nameSection) nameSection.classList.toggle("hidden", showSpecialPage);
    if (elements.bindingConfigButtonLightSection)
      elements.bindingConfigButtonLightSection.classList.toggle("hidden", !isButton || showSpecialPage);
    if (elements.bindingConfigButtonLearnSection)
      elements.bindingConfigButtonLearnSection.classList.toggle("hidden", !isButton || showSpecialPage);
    if (elements.bindingConfigMacroSummarySection)
      elements.bindingConfigMacroSummarySection.classList.add("hidden");
    if (elements.bindingConfigMacroSection)
      elements.bindingConfigMacroSection.classList.toggle("hidden", !showMacroPage);
    if (elements.bindingConfigSoundboardSection)
      elements.bindingConfigSoundboardSection.classList.toggle("hidden", !showSoundboardPage);
    if (elements.bindingConfigPreviewLearnShell)
      elements.bindingConfigPreviewLearnShell.classList.toggle("hidden", isButton || showSpecialPage);
    if (elements.bindingConfigCurveSection)
      elements.bindingConfigCurveSection.classList.toggle("hidden", isButton || showSpecialPage);
    if (elements.bindingConfigFeedbackOutputSection)
      elements.bindingConfigFeedbackOutputSection.classList.toggle("hidden", isButton || showSpecialPage);
    if (elements.bindingConfigMuteSection)
      elements.bindingConfigMuteSection.classList.toggle("hidden", isButton || showSpecialPage);
    if (elements.bindingConfigAssignSection)
      elements.bindingConfigAssignSection.classList.toggle("hidden", isButton || showSpecialPage);
    if (elements.bindingConfigName) elements.bindingConfigName.value = binding.name?.trim() || "";
    if (isButton) {
      syncButtonLightUi(binding);
      if (showMacroPage) {
        renderMacroEditor(binding);
      } else if (showSoundboardPage) {
        renderSoundboardEditor(binding);
        if (soundboardState.analysis?.path !== binding.soundboard?.path && !soundboardState.analysisError) {
          loadSoundboardAnalysis(binding).catch(() => {});
        }
      } else if (elements.bindingConfigMacroList) {
        elements.bindingConfigMacroList.innerHTML = "";
        if (elements.bindingConfigMacroSummary) elements.bindingConfigMacroSummary.innerHTML = "";
      }
    } else {
      syncCurvePresetToolbar(binding);
      renderCurveCards();
      renderCustomCurveEditor();
      renderMuteMappingLabel(binding);
      renderAssignMappingLabel(binding);
      syncFeedbackOutputUi(binding);
      syncMuteModeUi(binding?.mute_control?.mute_behavior || binding?.mute_behavior || "ToggleOnPress");
      syncAssignModeUi(binding.assign_mode || "Add");
    }
    renderConfigPreview();
    updateAuxLearnUi();
  }

  return { closeConfigModal, getBindingById, renderConfigModal };
}

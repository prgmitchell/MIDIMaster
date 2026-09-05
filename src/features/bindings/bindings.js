import { createSoundboardWorkspace } from "./controllers/soundboard_workspace.js";
import { createCurveWorkspace } from "./controllers/curve_workspace.js";
import { createMacroWorkspace } from "./controllers/macro_workspace.js";
import { createUiLifetime } from "../../app/ui_lifetime.js";
import { createConfigEvents } from "./controllers/config_events.js";
import { createListRenderer } from "./controllers/list_renderer.js";
import { createEditSession } from "./controllers/edit_session.js";
import { createMappingAssignment } from "./controllers/mapping_assignment.js";
import { createBindingPersistence } from "./controllers/binding_persistence.js";
import { createAuxiliaryModes } from "./controllers/auxiliary_modes.js";
import { createConfigModal } from "./controllers/config_modal.js";

import { createConfigPreview } from "./controllers/config_preview.js";
import { createEditPreview } from "./controllers/edit_preview.js";
import { createMidiLearn } from "./controllers/midi_learn.js";

import { createLearnPanel } from "./controllers/learn_panel.js";
import { createLiveValues } from "./controllers/live_values.js";
import { createFeedbackEditor } from "./controllers/feedback_editor.js";
import { createValueDisplay } from "./controllers/value_display.js";
import { createListControls } from "./controllers/list_controls.js";

import { effectiveIsButton, muteBehaviorLabel } from "./shape_helpers.js";
import { getBindingTargets as getTargets } from "../../core/binding_model.js";

import { normalizeFaderCurvePresets } from "./fader_curve_presets.js";

import { createBindingDomIndex } from "../../app/binding_dom_index.js";

import { createBindingDragController } from "./binding_drag.js";
import { createHotkeyLearnController } from "./hotkey_learn.js";
import { createBindingRenderModel } from "./render_model.js";

export function createBindingsFeature({
  invoke,
  dom,
  getPlaybackDevices,
  getRecordingDevices,
  getBindings: readBindings,
  setBindings: writeBindings,
  bindingFallbackName,
  controlLabel,
  getMidiDeviceLabel,
  buildTargetSelect,
  getVolumeForTarget,
  getMuteForTarget,
  i18n,
  saveBindingsForProfile,
  getFaderCurvePresets,
  saveFaderCurvePresets,
  getPluginHost,
  getEditingBindingId,
  setEditingBindingId,
  getPendingFocusBindingId,
  setPendingFocusBindingId,
  getDragState,
  setDragState,
  bindingInteractionTimes,
  bindingLastValues,
  bindingMuteValues,
  getLiveMidiValueForControl,
  createTargetIcon,
  resolveOsdTarget,
  showConfirm,
  showAlert,
  onBindingsRendered,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createBindingsFeature: invoke is required");
  }

  const lifetime = createUiLifetime();
  const SLIDER_ACTION_FLUSH_MS = 16;
  const sliderIntentSequenceByBinding = {};
  const pendingSliderActionsByBinding = new Map();
  const elements = dom && typeof dom === "object" ? dom : {};
  const t = (key, params = {}) =>
    i18n && typeof i18n.t === "function" ? i18n.t(key, params) : String(key || "");
  if (!elements.bindingsContainer) {
    throw new Error("createBindingsFeature: dom.bindingsContainer is required");
  }

  const getBindings = typeof readBindings === "function" ? readBindings : () => [];
  const setBindings = typeof writeBindings === "function" ? writeBindings : () => {};
  const listState = {
    buttonLightDropdown: null,
    indicatorMsgTypeDropdown: null,
    feedbackOutputMsgTypeDropdown: null,
    bindingTypeFilter: "all",
    compactBindings: false,
    bindingDensitySaveSequence: 0,
    bindingsScrollbarWidth: 0,
    bindingsLayoutSyncQueued: false,
    pendingRevealBindingId: null,
    nextBindingObjectIdentity: 1,
    pendingRerender: false,
    suppressPendingFocusClearUntil: 0,
  };

  const getPlayback = typeof getPlaybackDevices === "function" ? getPlaybackDevices : () => [];
  const getRecording = typeof getRecordingDevices === "function" ? getRecordingDevices : () => [];

  const fallbackNameFor =
    typeof bindingFallbackName === "function" ? bindingFallbackName : (_b, i) => `Binding ${i + 1}`;
  const labelForControl =
    typeof controlLabel === "function"
      ? controlLabel
      : (c) => {
          const msgType = String(c?.msg_type || c?.msgType || "ControlChange");
          const label =
            msgType === "PitchBend"
              ? "Pitch Bend"
              : msgType === "Note"
                ? "Note"
                : msgType === "ProgramChange"
                  ? "Program"
                  : "CC";
          return `Ch ${c?.channel ?? "?"} ${label} ${msgType === "PitchBend" ? "" : (c?.controller ?? "?")}`.trim();
        };
  const labelForMidiDevice =
    typeof getMidiDeviceLabel === "function"
      ? getMidiDeviceLabel
      : (deviceId) => String(deviceId || "").trim();

  const buildTarget =
    typeof buildTargetSelect === "function"
      ? buildTargetSelect
      : () => {
          const s = document.createElement("select");
          const o = document.createElement("option");
          o.value = "Unset";
          o.textContent = "Unset";
          s.appendChild(o);
          return s;
        };

  const getVol = typeof getVolumeForTarget === "function" ? getVolumeForTarget : () => null;
  const getMuted = typeof getMuteForTarget === "function" ? getMuteForTarget : () => false;
  const getLiveMidiValue =
    typeof getLiveMidiValueForControl === "function" ? getLiveMidiValueForControl : () => null;
  const saveProfile = typeof saveBindingsForProfile === "function" ? saveBindingsForProfile : async () => {};
  const getCurvePresets = typeof getFaderCurvePresets === "function" ? getFaderCurvePresets : () => [];
  const saveCurvePresets =
    typeof saveFaderCurvePresets === "function"
      ? saveFaderCurvePresets
      : async (presets) => normalizeFaderCurvePresets(presets);
  const getHost = typeof getPluginHost === "function" ? getPluginHost : () => null;
  const iconForTarget =
    typeof createTargetIcon === "function" ? createTargetIcon : () => document.createElement("span");
  const resolveTargetDisplay = typeof resolveOsdTarget === "function" ? resolveOsdTarget : () => null;
  const confirmAction =
    typeof showConfirm === "function"
      ? showConfirm
      : async ({ message = "" } = {}) => {
          if (typeof window !== "undefined" && typeof window.confirm === "function") {
            return window.confirm(message);
          }
          return false;
        };
  const alertAction =
    typeof showAlert === "function"
      ? showAlert
      : (title = "", message = "") => {
          if (typeof window !== "undefined" && typeof window.alert === "function") {
            window.alert([title, message].filter(Boolean).join("\n\n"));
          }
        };
  const getEditingId = typeof getEditingBindingId === "function" ? getEditingBindingId : () => null;
  const setEditingId = typeof setEditingBindingId === "function" ? setEditingBindingId : () => {};
  const getPendingFocusId =
    typeof getPendingFocusBindingId === "function" ? getPendingFocusBindingId : () => null;
  const setPendingFocusId =
    typeof setPendingFocusBindingId === "function" ? setPendingFocusBindingId : () => {};

  const getDrag = typeof getDragState === "function" ? getDragState : () => null;
  const setDrag = typeof setDragState === "function" ? setDragState : () => {};
  const bindingDragController = createBindingDragController({
    container: elements.bindingsContainer,
    getDragState: getDrag,
    setDragState: setDrag,
    getBindings: getBindings,
    setBindings: setBindings,
    renderBindings: () => renderBindings(),
    finishMutation: (reason) => finishBindingUiMutation(reason),
    flushPendingRerender: () => flushPendingRerender(),
  });
  const {
    start: startBindingDrag,
    update: updateBindingDrag,
    end: endBindingDrag,
    cancel: cancelBindingDrag,
  } = bindingDragController;
  const getSearchQuery = () =>
    String(elements.bindingSearchInput?.value || "")
      .trim()
      .toLowerCase();
  const bindingRenderModel = createBindingRenderModel({
    fallbackNameFor,
    labelForControl,
    displayModeName,
    getTargets,
    isButtonBinding: effectiveIsButton,
  });
  const normalizeBindingTypeFilter = bindingRenderModel.normalizeTypeFilter;
  const bindingMatchesTypeFilter = bindingRenderModel.matchesTypeFilter;
  const bindingSearchText = bindingRenderModel.searchText;

  const bindingsCard = elements.bindingsContainer.closest?.(".bindings-card") || null;

  const renderedBindings = createBindingDomIndex();
  const bindingObjectIdentities = new WeakMap();

  function displayModeName(binding) {
    if (effectiveIsButton(binding) && binding?.action === "ToggleMute") {
      return muteBehaviorLabel(binding?.mute_behavior);
    }
    if (effectiveIsButton(binding)) return muteBehaviorLabel(binding?.mute_behavior);
    return binding?.mode === "Relative" ? "Relative" : "Absolute";
  }

  const editorState = {
    acceptedTransfers: new Map(),
    bindingId: null,
    draft: null,
    soundboardPageOpen: false,
    initialPersistence: null,
    removeEmptySoundboardTargetOnCancel: false,
    previewOriginalBindings: null,
    learnField: null,
    learnTimer: null,
    transferPrompt: null,
    previewTimer: null,
  };

  const macroState = {
    pageOpen: false,
    selectedPath: null,
    pendingSelectedScroll: false,
    macroDragState: null,
  };

  const soundboardState = {
    analysis: null,
    analysisError: "",
    analysisToken: 0,
    previewState: "stopped",
    previewStartedAt: 0,
    previewElapsedMs: 0,
    previewAnimationFrame: null,
    outputDevices: [],
    outputDevicesLoaded: false,
    outputDropdown: null,
    virtualAudioState: "loading",
    virtualAudioStatusToken: 0,
    pointerHandle: null,
  };

  const curveState = {
    customCurvePointer: null,
    curvePresetMenuOpen: false,
    curvePresetSearchQuery: "",
    curvePresetFormMode: null,
    curvePresetFormPresetId: null,
    selectedCustomCurvePresetId: null,
  };

  const nameDrafts = new Map();

  const defaultLearnPanelTitle = () => t("bindings.waitingMidiTitle");
  const defaultLearnPanelMessage = () => t("bindings.learnMessage");
  const hotkeyLearn = createHotkeyLearnController({
    dom: elements,
    translate: t,
    canStart: () => !editorState.transferPrompt && !editorState.learnField,
  });
  const startHotkeyLearn = (binding) => hotkeyLearn.start(binding);

  let uiBound = false;

  function bindUi() {
    if (uiBound) return;
    uiBound = true;

    lifetime.listen(
      document,
      "pointerdown",
      (event) => {
        const pendingId = getPendingFocusId();
        if (!pendingId) return;
        if (Date.now() < listState.suppressPendingFocusClearUntil) {
          return;
        }
        const target = event.target;
        if (target && target.classList?.contains("binding-name-input")) {
          return;
        }
        setPendingFocusId(null);
      },
      true,
    );

    bindConfigModalUi();
    bindBindingTypeFilterUi();
    bindBindingDensityUi();
    if (elements.bindingSearchInput) {
      lifetime.listen(elements.bindingSearchInput, "input", () => {
        renderBindings();
      });
    }
    lifetime.listen(window, "resize", () => {
      listState.bindingsScrollbarWidth = 0;
      queueBindingsScrollLayoutSync();
    });
    lifetime.listen(window, "midimaster:locale-changed", () => {
      updateBindingTypeFilterUi();
      renderBindings();
      resetLearnPanelUi();
      renderConfigModal();
    });
    queueBindingsScrollLayoutSync();
    updateAuxLearnUi();
  }

  const {
    bindingRenderKey,
    getBindingTypeFilter,
    showMacroAlreadyConfiguredError,
    updateBindingTypeFilterUi,
    bindBindingTypeFilterUi,
    setCompactBindings,
    bindBindingDensityUi,
    queueBindingsScrollLayoutSync,
    queueBindingReveal,
    flushQueuedBindingReveal,
    openBindingTargetPicker,
  } = createListControls({
    lifetime,
    alertAction,
    bindingMatchesTypeFilter,
    bindingObjectIdentities,
    bindingSnapshotKey: (...args) => bindingSnapshotKey(...args),
    bindingsCard,
    elements,
    getBindingById: (...args) => getBindingById(...args),
    getEditingId,
    invoke,
    listState,
    normalizeBindingTypeFilter,
    renderBindings: (...args) => renderBindings(...args),
    renderedBindings,
    setEditingId,
    setPendingFocusId,
    t,
  });

  const { buttonVisualActive, setButtonVisualState, syncButtonVisualState, buttonUsesPressReleaseCommand } =
    createValueDisplay({
      bindingLastValues,
      bindingMuteValues,
      getBindingById: (...args) => getBindingById(...args),
      getLiveMidiValue,
      getMuted,
      renderedBindings,
    });

  const {
    buttonLightSelectValue,
    renderButtonLightDropdown,
    renderIndicatorDropdowns,
    normalizeIndicatorControl,
    syncFeedbackControllerInputState,
    syncIndicatorUi,
    syncFeedbackOutputUi,
    updateIndicatorFromFields,
    updateFeedbackOutputFromFields,
  } = createFeedbackEditor({
    elements,
    editorState,
    getConfigBinding: (...args) => getConfigBinding(...args),
    listState,
    renderConfigPreview: (...args) => renderConfigPreview(...args),
    t,
    updateAuxLearnUi: (...args) => updateAuxLearnUi(...args),
  });

  const {
    pulseMomentaryValue,
    setActionIcon,
    setMuteButtonState,
    updateSliderFill,
    setSliderVolume,
    resolveRenderedBindingVolume,
    queueSliderAction,
    isBindingInteractionActive,
    updateBindingValues,
    updateBindingTargetDisplays,
  } = createLiveValues({
    SLIDER_ACTION_FLUSH_MS,
    bindingInteractionTimes,
    bindingLastValues,
    bindingMuteValues,
    elements,
    editorState,
    getBindingById: (...args) => getBindingById(...args),
    getConfigBinding: (...args) => getConfigBinding(...args),
    getMuted,
    getVol,
    invoke,
    pendingSliderActionsByBinding,
    renderPreviewTarget: (...args) => renderPreviewTarget(...args),
    renderedBindings,
    syncButtonVisualState,
    t,
  });

  const {
    clearTransferPrompt,
    setTransferPrompt,
    resetLearnPanelUi,
    hideLearnPanel,
    setLearnPanelWaiting,
    setLearnPanelTransfer,
  } = createLearnPanel({
    elements,
    defaultLearnPanelMessage,
    defaultLearnPanelTitle,
    editorState,
    t,
    updateAuxLearnUi: (...args) => updateAuxLearnUi(...args),
  });

  const {
    macroPathForFirstStep,
    ensureMacroConfigDom,
    cancelMacroDrag,
    endMacroDrag,
    updateMacroDrag,
    renderMacroEditor,
  } = createMacroWorkspace({
    buildTarget,
    elements,
    getConfigBinding: (...args) => getConfigBinding(...args),
    lifetime,
    macroState,
    renderConfigModal: (...args) => renderConfigModal(...args),
    renderConfigPreview: (...args) => renderConfigPreview(...args),
    resolveTargetDisplay,
    startHotkeyLearn,
    t,
  });

  const {
    updateAuxLearnUi,
    stopAuxLearn,
    formatMidiControlLabel,
    renderMidiMappingSummary,
    formatPreviewMidiValue,
    renderAssignMappingLabel,
    renderMuteMappingLabel,
    normalizeAuxControl,
    getConfigBinding,
  } = createMidiLearn({
    elements,
    editorState,
    hideLearnPanel,
    labelForMidiDevice,
    listState,
    renderConfigPreview: (...args) => renderConfigPreview(...args),
    syncFeedbackControllerInputState,
    t,
  });

  const {
    bindingSnapshotKey,
    applyPrimaryControlPreview,
    restoreConfigPreviewBindings,
    stopConfigPreviewTimer,
    startConfigPreviewTimer,
    parseDisplayTags,
  } = createEditPreview({
    editorState,
    getBindings,
    getConfigBinding,
    invoke,
    persistBindingBackend: (...args) => persistBindingBackend(...args),
    renderBindings: (...args) => renderBindings(...args),
    renderConfigPreview: (...args) => renderConfigPreview(...args),
    setBindings,
    syncPluginHostBindings: (...args) => syncPluginHostBindings(...args),
  });

  const { renderPreviewTarget, renderConfigPreview } = createConfigPreview({
    bindingInteractionTimes,
    bindingLastValues,
    bindingMuteValues,
    elements,
    editorState,
    formatMidiControlLabel,
    formatPreviewMidiValue,
    getConfigBinding,
    getLiveMidiValue,
    getMuted,
    getVol,
    iconForTarget,
    labelForControl,
    parseDisplayTags,
    renderMidiMappingSummary,
    resolveTargetDisplay,
    t,
  });

  const {
    activeCustomCurvePreset,
    setCurvePresetMenuOpen,
    closeCurvePresetMenu,
    closeCurvePresetForm,
    openCurvePresetForm,
    syncCurvePresetToolbar,
    renderCurvePresetMenu,
    submitCurvePresetForm,
    renderCurveCards,
    renderCustomCurveEditor,
    customCurveSurfaceFromEvent,
    addCustomCurvePoint,
    removeCustomCurvePoint,
    updateCustomCurveFromPointer,
  } = createCurveWorkspace({
    alertAction,
    confirmAction,
    curveState,
    elements,
    getConfigBinding,
    getCurvePresets,
    renderConfigModal: (...args) => renderConfigModal(...args),
    renderConfigPreview,
    saveCurvePresets,
    setActionIcon,
    t,
  });

  const {
    cancelSoundboardPreviewFrame,
    showSoundboardAlreadyConfiguredError,
    showSpecialActionConflictError,
    stopSoundboardPreview,
    loadSoundboardOutputDevices,
    loadSoundboardVirtualAudioStatus,
    loadSoundboardAnalysis,
    renderSoundboardEditor,
  } = createSoundboardWorkspace({
    alertAction,
    elements,
    editorState,
    getConfigBinding,
    invoke,
    soundboardState,
    t,
    updateSliderFill,
  });

  const { closeConfigModal, getBindingById, renderConfigModal } = createConfigModal({
    cancelMacroDrag,
    clearTransferPrompt,
    closeAssignModeMenu: (...args) => closeAssignModeMenu(...args),
    closeCurvePresetForm,
    closeCurvePresetMenu,
    closeMuteModeMenu: (...args) => closeMuteModeMenu(...args),
    curveState,
    elements,
    editorState,
    ensureMacroConfigDom,
    finishBindingUiMutation: (...args) => finishBindingUiMutation(...args),
    getBindings,
    getConfigBinding,
    hotkeyLearn,
    loadSoundboardAnalysis,
    macroState,
    persistBindingBackend: (...args) => persistBindingBackend(...args),
    renderAssignMappingLabel,
    renderBindings: (...args) => renderBindings(...args),
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
    syncAssignModeUi: (...args) => syncAssignModeUi(...args),
    syncButtonLightUi: (...args) => syncButtonLightUi(...args),
    syncCurvePresetToolbar,
    syncFeedbackOutputUi,
    syncMuteModeUi: (...args) => syncMuteModeUi(...args),
    t,
    updateAuxLearnUi,
  });

  const {
    syncButtonLightUi,
    closeMuteModeMenu,
    openMuteModeMenu,
    closeAssignModeMenu,
    openAssignModeMenu,
    syncAssignModeUi,
    syncMuteModeUi,
  } = createAuxiliaryModes({
    buttonLightSelectValue,
    elements,
    listState,
    renderButtonLightDropdown,
    syncIndicatorUi,
    t,
  });

  const { persistBindingBackend, syncPluginHostBindings, finishBindingUiMutation } = createBindingPersistence(
    {
      getBindings,
      getHost,
      invoke,
      saveProfile,
    },
  );

  const { commitTransferPrompt, startPrimaryLearn, startAuxLearn } = createMappingAssignment({
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
  });

  const {
    openConfigModal,
    saveConfigModal,
    beginBindingEdit,
    focusBindingNameInput,
    isInlineNameEditingActive,
    isBindingDragActive,
    requestSafeRerender,
    flushPendingRerender,
  } = createEditSession({
    closeConfigModal,
    elements,
    editorState,
    finishBindingUiMutation,
    getBindings,
    getBindingById,
    getConfigBinding,
    getDrag,
    getEditingId,
    invoke,
    listState,
    loadSoundboardOutputDevices,
    loadSoundboardVirtualAudioStatus,
    macroPathForFirstStep,
    macroState,
    persistBindingBackend,
    renderBindings: (...args) => renderBindings(...args),
    renderConfigModal,
    setBindings,
    setEditingId,
    setPendingFocusId,
    soundboardState,
    startConfigPreviewTimer,
  });

  const { renderBindings } = createListRenderer({
    beginBindingEdit,
    bindingInteractionTimes,
    bindingLastValues,
    bindingMatchesTypeFilter,
    bindingMuteValues,
    bindingRenderKey,
    bindingSearchText,
    buildTarget,
    buttonUsesPressReleaseCommand,
    buttonVisualActive,
    confirmAction,
    elements,
    fallbackNameFor,
    finishBindingUiMutation,
    flushPendingRerender,
    flushQueuedBindingReveal,
    focusBindingNameInput,
    getBindings,
    getBindingTypeFilter,
    getEditingId,
    getMuted,
    getPendingFocusId,
    getSearchQuery,
    getVol,
    invoke,
    isBindingDragActive,
    listState,
    nameDrafts,
    onBindingsRendered,
    openConfigModal,
    pulseMomentaryValue,
    queueBindingsScrollLayoutSync,
    queueSliderAction,
    renderedBindings,
    resolveRenderedBindingVolume,
    setActionIcon,
    setBindings,
    setEditingId,
    setMuteButtonState,
    setPendingFocusId,
    setSliderVolume,
    showMacroAlreadyConfiguredError,
    showSoundboardAlreadyConfiguredError,
    showSpecialActionConflictError,
    sliderIntentSequenceByBinding,
    startBindingDrag,
    startHotkeyLearn,
    t,
    updateSliderFill,
  });

  const { bindConfigModalUi } = createConfigEvents({
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
  });

  function dispose() {
    lifetime.dispose();
    hotkeyLearn.stop();
    stopAuxLearn();
    stopConfigPreviewTimer();
    void stopSoundboardPreview();
    cancelSoundboardPreviewFrame();
    cancelMacroDrag();
    cancelBindingDrag();
    pendingSliderActionsByBinding.forEach((entry) => clearTimeout(entry.timer));
    pendingSliderActionsByBinding.clear();
  }

  return {
    dispose,
    bindUi,
    updateSliderFill,
    setSliderVolume,
    isBindingInteractionActive,
    isInlineNameEditingActive,
    requestSafeRerender,
    flushPendingRerender,
    updateBindingValues,
    updateBindingTargetDisplays,
    setMuteButtonState,
    syncButtonVisualState,
    setButtonVisualState,
    getRenderedBindingRefs: (bindingId) => renderedBindings.get(bindingId),
    getRenderedBindingIndex: () => renderedBindings,
    queueBindingReveal,
    openBindingTargetPicker,
    beginBindingEdit,
    setCompactBindings,
    renderBindings,
    startBindingDrag,
    updateBindingDrag,
    endBindingDrag,
    cancelBindingDrag,
  };
}

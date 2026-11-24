import { setControlMapping } from "../../../core/fader_modifiers.js";
import {
  cloneBindingDraft,
  ensureBindingShape,
  isMacroTarget,
  isSoundboardTarget,
} from "../shape_helpers.js";
import {
  getBindingTargets as getTargets,
} from "../../../core/binding_model.js";

/** edit session workflow. */
export function createEditSession({
  closeConfigModal,
  elements,
  editorState,
  bindingEdits,
  getBindings,
  getBindingById,
  getConfigBinding,
  getDrag,
  getEditingId,
  listState,
  loadSoundboardOutputDevices,
  loadSoundboardVirtualAudioStatus,
  macroPathForFirstStep,
  macroState,
  renderBindings,
  renderConfigModal,
  setEditingId,
  setPendingFocusId,
  soundboardState,
  startConfigPreviewTimer,
}) {
  function openConfigModal(bindingId, options = {}) {
    const binding = getBindingById(bindingId);
    if (!binding) return;
    editorState.bindingId = bindingId;
    editorState.draft = cloneBindingDraft(options.targetDraft || binding);
    ensureBindingShape(editorState.draft);
    macroState.pageOpen = Boolean(
      options.macroPage &&
        (editorState.draft?.action === "Macro" ||
          getTargets(editorState.draft).some(isMacroTarget)),
    );
    macroState.selectedPath = macroState.pageOpen
      ? macroPathForFirstStep(editorState.draft)
      : null;
    editorState.soundboardPageOpen = Boolean(
      options.soundboardPage &&
        (editorState.draft?.action === "Soundboard" ||
          getTargets(editorState.draft).some(isSoundboardTarget)),
    );
    soundboardState.analysis = options.soundboardAnalysis || null;
    soundboardState.analysisError = "";
    soundboardState.outputDevicesLoaded = false;
    soundboardState.virtualAudioState = "loading";
    editorState.acceptedTransfers.clear();
    if (elements.bindingConfigPanel)
      elements.bindingConfigPanel.classList.remove("hidden");
    startConfigPreviewTimer();
    renderConfigModal();
    if (editorState.soundboardPageOpen) {
      loadSoundboardOutputDevices().catch(() => {});
      loadSoundboardVirtualAudioStatus().catch(() => {});
    }
  }

  async function saveConfigModal() {
    if (editorState.transferPrompt) return;
    await editorState.pendingPreview;
    const original = getBindingById(editorState.bindingId);
    const draft = getConfigBinding();
    if (!original || !draft) return;

    const previous = getBindings();
    const nextBindings = [...previous];
    for (const entry of editorState.acceptedTransfers.values()) {
      const { conflict } = entry;
      if (!conflict?.binding) continue;
      const conflictIndex = nextBindings.findIndex(
        (binding) => binding.id === conflict.binding.id,
      );
      if (conflictIndex < 0) continue;
      if (conflict.field === "control") {
        nextBindings.splice(conflictIndex, 1);
        continue;
      }
      const nextConflictBinding = cloneBindingDraft(
        nextBindings[conflictIndex],
      );
      setControlMapping(nextConflictBinding, conflict.field, null);
      nextBindings[conflictIndex] = nextConflictBinding;
    }

    const bindingIndex = nextBindings.findIndex(
      (binding) => binding.id === editorState.bindingId,
    );
    if (bindingIndex < 0) return;
    const nextBinding = cloneBindingDraft(draft);
    if (Array.isArray(nextBinding.modifiers))
      nextBinding.modifiers = nextBinding.modifiers.filter(
        (item) => item.control?.device_id,
      );
    nextBindings[bindingIndex] = nextBinding;
    await bindingEdits.applyList(previous, nextBindings);
    renderBindings();
    await closeConfigModal({ commit: true });
  }

  function beginBindingEdit(bindingId, forceInline = false) {
    const binding = getBindingById(bindingId);
    if (!binding) return;
    if (!forceInline) {
      openConfigModal(bindingId);
      return;
    }
    listState.suppressPendingFocusClearUntil = Date.now() + 250;
    setEditingId(bindingId);
    setPendingFocusId(bindingId);
    renderBindings();
  }

  function focusBindingNameInput(
    nameInput,
    bindingId,
    { select = false } = {},
  ) {
    if (!nameInput) return;
    const applyFocus = () => {
      if (bindingId !== getEditingId()) return;
      if (!nameInput.isConnected) return;
      if (typeof window.focus === "function") {
        window.focus();
      }
      nameInput.focus({ preventScroll: true });
      if (select) {
        nameInput.select();
      }
    };
    applyFocus();
    requestAnimationFrame(applyFocus);
    requestAnimationFrame(() => requestAnimationFrame(applyFocus));
    setTimeout(applyFocus, 0);
    setTimeout(applyFocus, 32);
  }

  function isInlineNameEditingActive() {
    return Boolean(getEditingId());
  }

  function isBindingDragActive() {
    return Boolean(getDrag());
  }

  function requestSafeRerender(_reason = "") {
    if (isInlineNameEditingActive() || isBindingDragActive()) {
      listState.pendingRerender = true;
      return;
    }
    renderBindings();
  }

  function flushPendingRerender({ fallbackRender = false } = {}) {
    if (listState.pendingRerender) {
      listState.pendingRerender = false;
      renderBindings();
      return true;
    }
    if (fallbackRender) {
      renderBindings();
      return true;
    }
    return false;
  }

  return {
    openConfigModal,
    saveConfigModal,
    beginBindingEdit,
    focusBindingNameInput,
    isInlineNameEditingActive,
    isBindingDragActive,
    requestSafeRerender,
    flushPendingRerender,
  };
}

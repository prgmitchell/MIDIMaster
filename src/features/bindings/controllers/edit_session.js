import {
  cloneBindingDraft,
  ensureBindingShape,
  isMacroTarget,
  isSoundboardTarget,
} from "../shape_helpers.js";
import { getBindingTargets as getTargets, normalizeSoundboardMapping } from "../../../core/binding_model.js";

/** edit session workflow. */
export function createEditSession({
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
  renderBindings,
  renderConfigModal,
  setBindings,
  setEditingId,
  setPendingFocusId,
  soundboardState,
  startConfigPreviewTimer,
}) {
  function openConfigModal(bindingId, options = {}) {
    const binding = getBindingById(bindingId);
    if (!binding) return;
    editorState.bindingId = bindingId;
    editorState.draft = cloneBindingDraft(binding);
    ensureBindingShape(editorState.draft);
    macroState.pageOpen = Boolean(
      options.macroPage &&
        (editorState.draft?.action === "Macro" || getTargets(editorState.draft).some(isMacroTarget)),
    );
    macroState.selectedPath = macroState.pageOpen ? macroPathForFirstStep(editorState.draft) : null;
    editorState.soundboardPageOpen = Boolean(
      options.soundboardPage &&
        (editorState.draft?.action === "Soundboard" ||
          getTargets(editorState.draft).some(isSoundboardTarget)),
    );
    editorState.initialPersistence = options.initialPersistence || null;
    editorState.removeEmptySoundboardTargetOnCancel = Boolean(
      options.removeEmptySoundboardTargetOnCancel &&
        editorState.soundboardPageOpen &&
        !normalizeSoundboardMapping(editorState.draft.soundboard),
    );
    soundboardState.analysis = options.soundboardAnalysis || null;
    soundboardState.analysisError = "";
    soundboardState.outputDevicesLoaded = false;
    soundboardState.virtualAudioState = "loading";
    editorState.acceptedTransfers.clear();
    if (elements.bindingConfigPanel) elements.bindingConfigPanel.classList.remove("hidden");
    startConfigPreviewTimer();
    renderConfigModal();
    if (editorState.soundboardPageOpen) {
      loadSoundboardOutputDevices().catch(() => {});
      loadSoundboardVirtualAudioStatus().catch(() => {});
    }
  }

  async function saveConfigModal() {
    if (editorState.transferPrompt) return;
    if (editorState.initialPersistence) {
      await editorState.initialPersistence;
      editorState.initialPersistence = null;
    }
    const original = getBindingById(editorState.bindingId);
    const draft = getConfigBinding();
    if (!original || !draft) return;

    let nextBindings = [...getBindings()];
    for (const entry of editorState.acceptedTransfers.values()) {
      const { conflict } = entry;
      if (!conflict?.binding) continue;
      const conflictIndex = nextBindings.findIndex((binding) => binding.id === conflict.binding.id);
      if (conflictIndex < 0) continue;
      if (conflict.field === "control") {
        await invoke("remove_binding", { binding: nextBindings[conflictIndex] });
        nextBindings.splice(conflictIndex, 1);
        continue;
      }
      const nextConflictBinding = cloneBindingDraft(nextBindings[conflictIndex]);
      nextConflictBinding[conflict.field] = null;
      nextBindings[conflictIndex] = nextConflictBinding;
      setBindings(nextBindings);
      await persistBindingBackend(nextConflictBinding);
    }

    const bindingIndex = nextBindings.findIndex((binding) => binding.id === editorState.bindingId);
    if (bindingIndex < 0) return;
    const nextBinding = cloneBindingDraft(draft);
    nextBindings[bindingIndex] = nextBinding;
    setBindings(nextBindings);
    await persistBindingBackend(nextBinding);
    renderBindings();
    await closeConfigModal({ commit: true });
    finishBindingUiMutation("config save");
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

  function focusBindingNameInput(nameInput, bindingId, { select = false } = {}) {
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

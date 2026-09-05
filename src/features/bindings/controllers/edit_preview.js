import { cloneBindingDraft, normalizeControlKind, ensureBindingShape } from "../shape_helpers.js";
import { normalizeRelativeFormat } from "../../../core/binding_model.js";

/** edit preview workflow. */
export function createEditPreview({
  editorState,
  getBindings,
  getConfigBinding,
  invoke,
  persistBindingBackend,
  renderBindings,
  renderConfigPreview,
  setBindings,
  syncPluginHostBindings,
}) {
  function cloneBindingsList(list) {
    return (Array.isArray(list) ? list : []).map((binding) => cloneBindingDraft(binding)).filter(Boolean);
  }

  function rememberConfigPreviewOriginalBindings() {
    if (!editorState.previewOriginalBindings) {
      editorState.previewOriginalBindings = cloneBindingsList(getBindings());
    }
  }

  function bindingSnapshotKey(binding) {
    try {
      return JSON.stringify(binding);
    } catch {
      return "";
    }
  }

  function applyPrimaryPreviewFields(baseBinding, draftBinding) {
    const next = cloneBindingDraft(baseBinding) || cloneBindingDraft(draftBinding);
    if (!next || !draftBinding) return next;
    next.device_id = draftBinding.device_id;
    next.control =
      draftBinding.control && typeof draftBinding.control === "object"
        ? { ...draftBinding.control }
        : draftBinding.control;
    next.control_kind = normalizeControlKind(draftBinding.control_kind);
    next.mode = draftBinding.mode === "Relative" ? "Relative" : "Absolute";
    next.relative_format = normalizeRelativeFormat(draftBinding.relative_format);
    if (Number.isFinite(Number(draftBinding.deadzone))) {
      next.deadzone = Number(draftBinding.deadzone);
    }
    if (Number.isFinite(Number(draftBinding.debounce_ms))) {
      next.debounce_ms = Number(draftBinding.debounce_ms);
    }
    ensureBindingShape(next);
    return next;
  }

  function applyPreviewConflict(nextBindings, conflict) {
    if (!conflict?.binding?.id || !conflict.field) return nextBindings;
    const conflictId = conflict.binding.id;
    if (conflict.field === "control") {
      return nextBindings.filter((binding) => binding.id !== conflictId);
    }
    return nextBindings.map((binding) => {
      if (binding.id !== conflictId) return binding;
      const next = cloneBindingDraft(binding);
      next[conflict.field] = null;
      return next;
    });
  }

  function buildPrimaryControlPreviewBindings() {
    const draft = getConfigBinding();
    if (!draft || !editorState.bindingId) return null;
    rememberConfigPreviewOriginalBindings();
    let nextBindings = cloneBindingsList(editorState.previewOriginalBindings);
    for (const entry of editorState.acceptedTransfers.values()) {
      if (entry.field === "control") {
        nextBindings = applyPreviewConflict(nextBindings, entry.conflict);
      }
    }
    const bindingIndex = nextBindings.findIndex((binding) => binding.id === editorState.bindingId);
    if (bindingIndex < 0) return null;
    nextBindings[bindingIndex] = applyPrimaryPreviewFields(nextBindings[bindingIndex], draft);
    return nextBindings;
  }

  async function persistBindingsDiff(previousBindings, nextBindings, reason) {
    const previous = cloneBindingsList(previousBindings);
    const next = cloneBindingsList(nextBindings);
    const nextById = new Map(next.map((binding) => [binding.id, binding]));
    const previousById = new Map(previous.map((binding) => [binding.id, binding]));

    for (const binding of previous) {
      if (!nextById.has(binding.id)) {
        await invoke("remove_binding", { binding });
      }
    }

    for (const binding of next) {
      const previousBinding = previousById.get(binding.id);
      if (!previousBinding || bindingSnapshotKey(previousBinding) !== bindingSnapshotKey(binding)) {
        await persistBindingBackend(binding);
      }
    }
  }

  async function applyPrimaryControlPreview() {
    const nextBindings = buildPrimaryControlPreviewBindings();
    if (!nextBindings) return;
    const previousBindings = cloneBindingsList(getBindings());
    setBindings(cloneBindingsList(nextBindings));
    renderBindings();
    syncPluginHostBindings();
    try {
      await persistBindingsDiff(previousBindings, nextBindings, "control preview");
    } catch (err) {
      console.error("Failed to apply control preview:", err);
    }
  }

  async function restoreConfigPreviewBindings() {
    if (!editorState.previewOriginalBindings) return;
    const previousBindings = cloneBindingsList(getBindings());
    const restoredBindings = cloneBindingsList(editorState.previewOriginalBindings);
    setBindings(restoredBindings);
    renderBindings();
    syncPluginHostBindings();
    try {
      await persistBindingsDiff(previousBindings, restoredBindings, "control preview rollback");
    } catch (err) {
      console.error("Failed to restore control preview:", err);
    }
  }

  function stopConfigPreviewTimer() {
    if (!editorState.previewTimer) return;
    cancelAnimationFrame(editorState.previewTimer);
    editorState.previewTimer = null;
  }

  function startConfigPreviewTimer() {
    stopConfigPreviewTimer();
    const tick = () => {
      if (!editorState.bindingId || !getConfigBinding()) {
        stopConfigPreviewTimer();
        return;
      }
      renderConfigPreview();
      editorState.previewTimer = requestAnimationFrame(tick);
    };
    editorState.previewTimer = requestAnimationFrame(tick);
  }

  function parseDisplayTags(rawLabel) {
    const label = String(rawLabel || "");
    const tags = [];
    const matchAll = label.match(/\(([^()]+)\)/g) || [];
    matchAll.forEach((tag) => {
      const text = tag.replace(/[()]/g, "").trim();
      if (text) tags.push(text);
    });
    return tags;
  }

  return {
    bindingSnapshotKey,
    applyPrimaryControlPreview,
    restoreConfigPreviewBindings,
    stopConfigPreviewTimer,
    startConfigPreviewTimer,
    parseDisplayTags,
  };
}

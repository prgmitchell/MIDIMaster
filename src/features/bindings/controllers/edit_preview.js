import { setControlMapping } from "../../../core/fader_modifiers.js";
import {
  cloneBindingDraft,
  normalizeControlKind,
  ensureBindingShape,
} from "../shape_helpers.js";
import { normalizeRelativeFormat } from "../../../core/binding_model.js";

/** edit preview workflow. */
export function createEditPreview({
  editorState,
  getBindings,
  getConfigBinding,
  bindingEdits,
  renderBindings,
  renderConfigPreview,
}) {
  function rememberConfigPreviewOriginalBindings() {
    if (!editorState.previewOriginalBindings) {
      editorState.previewOriginalBindings = [...getBindings()];
      editorState.previewAppliedBindings = editorState.previewOriginalBindings;
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
    const next =
      cloneBindingDraft(baseBinding) || cloneBindingDraft(draftBinding);
    if (!next || !draftBinding) return next;
    next.device_id = draftBinding.device_id;
    next.control =
      draftBinding.control && typeof draftBinding.control === "object"
        ? { ...draftBinding.control }
        : draftBinding.control;
    next.control_kind = normalizeControlKind(draftBinding.control_kind);
    next.mode = draftBinding.mode === "Relative" ? "Relative" : "Absolute";
    next.relative_format = normalizeRelativeFormat(
      draftBinding.relative_format,
    );
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
      setControlMapping(next, conflict.field, null);
      return next;
    });
  }

  function buildPrimaryControlPreviewBindings() {
    const draft = getConfigBinding();
    if (!draft || !editorState.bindingId) return null;
    rememberConfigPreviewOriginalBindings();
    let nextBindings = [...editorState.previewOriginalBindings];
    for (const entry of editorState.acceptedTransfers.values()) {
      if (entry.field === "control") {
        nextBindings = applyPreviewConflict(nextBindings, entry.conflict);
      }
    }
    const bindingIndex = nextBindings.findIndex(
      (binding) => binding.id === editorState.bindingId,
    );
    if (bindingIndex < 0) return null;
    nextBindings[bindingIndex] = applyPrimaryPreviewFields(
      nextBindings[bindingIndex],
      draft,
    );
    return nextBindings;
  }

  async function applyPrimaryControlPreview() {
    const next = buildPrimaryControlPreviewBindings();
    if (!next) return;
    const previousWrite = editorState.pendingPreview;
    const apply = async () => {
      await bindingEdits.applyList(editorState.previewAppliedBindings, next);
      const applied = new Map(editorState.previewAppliedBindings.map((binding) => [binding.id, binding]));
      editorState.previewAppliedBindings = next.map((binding) => {
        const old = applied.get(binding.id);
        return old && bindingSnapshotKey(old) === bindingSnapshotKey(binding) ? old : binding;
      });
      renderBindings();
    };
    const pending = Promise.resolve(previousWrite).then(apply);
    editorState.pendingPreview = pending.catch(() => {});
    await pending;
  }

  async function restoreConfigPreviewBindings() {
    if (!editorState.previewOriginalBindings) return;
    await editorState.pendingPreview;
    await bindingEdits.applyList(editorState.previewAppliedBindings, editorState.previewOriginalBindings);
    renderBindings();
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

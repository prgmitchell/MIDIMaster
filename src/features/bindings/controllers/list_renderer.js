import { createRowValueController } from "./create_row_value.js";
import { createRowTargetController } from "./create_row_target.js";
import { createRowModeController } from "./create_row_mode.js";
import { createRowNameController } from "./create_row_name.js";
import { captureElementScroll, restoreElementScroll } from "../../../app/scroll_position.js";
import { ensureBindingShape, effectiveIsButton } from "../shape_helpers.js";
import {
  setBindingTargets as setTargets,
  getBindingTargets as getTargets,
  normalizeHotkeyMapping,
  normalizeOpenApplicationMapping,
  normalizeAutoHotkeyScriptMapping,
  getPrimaryBindingTarget as getPrimaryTarget,
  buttonVisualBehavior,
} from "../../../core/binding_model.js";

/** list renderer workflow. */
export function createListRenderer({
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
}) {
  function renderBindings() {
    if (isBindingDragActive()) {
      listState.pendingRerender = true;
      return;
    }

    // Keyed rows are temporarily moved into a fragment below. That can shrink
    // the live scroll container enough for WebView2 to clamp scrollTop to zero.
    const scrollPosition = captureElementScroll(elements.bindingsContainer);

    const editingIdAtRenderStart = getEditingId();
    const activeEl = document.activeElement;
    const activeIsNameInput = Boolean(activeEl && activeEl.classList?.contains("binding-name-input"));
    const activeBindingId = activeIsNameInput ? String(activeEl.dataset?.bindingId || "") : "";
    const shouldRestoreEditingFocus = Boolean(
      editingIdAtRenderStart && activeBindingId && activeBindingId === String(editingIdAtRenderStart),
    );
    const selectionStart = shouldRestoreEditingFocus ? activeEl.selectionStart : null;
    const selectionEnd = shouldRestoreEditingFocus ? activeEl.selectionEnd : null;

    const bindings = getBindings();
    const previousRendered = new Map();
    elements.bindingsContainer.querySelectorAll(".binding-item[data-binding-id]").forEach((item) => {
      const bindingId = String(item.dataset?.bindingId || "");
      if (bindingId) {
        previousRendered.set(bindingId, renderedBindings.get(bindingId) || { item });
      }
    });
    const nextContent = document.createDocumentFragment();
    renderedBindings.clear();
    const searchQuery = getSearchQuery();
    const typeFilter = getBindingTypeFilter();
    const visibleBindingIds = [];
    let renderedCount = 0;

    if (!Array.isArray(bindings) || bindings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bindings-empty";
      empty.textContent = t("bindings.noBindings");
      elements.bindingsContainer.replaceChildren(empty);
      restoreElementScroll(elements.bindingsContainer, scrollPosition);
      queueBindingsScrollLayoutSync();
      onBindingsRendered?.();
      return;
    }

    bindings.forEach((binding, index) => {
      try {
        ensureBindingShape(binding);
        setTargets(binding, getTargets(binding));
        binding.hotkey = normalizeHotkeyMapping(binding.hotkey);
        binding.open_application = normalizeOpenApplicationMapping(binding.open_application);
        binding.autohotkey_script = normalizeAutoHotkeyScriptMapping(binding.autohotkey_script);
        if (!bindingMatchesTypeFilter(binding, typeFilter)) {
          return;
        }
        if (searchQuery && !bindingSearchText(binding, index).includes(searchQuery)) {
          return;
        }
        const visibleIndex = visibleBindingIds.length;
        const bindingId = String(binding.id || "");
        visibleBindingIds.push(bindingId);
        renderedCount += 1;
        const renderKey = bindingRenderKey(binding, index, visibleIndex, searchQuery, typeFilter);
        const previous = previousRendered.get(bindingId);
        if (previous?.item?.__bindingRenderKey === renderKey) {
          previous.item.dataset.index = String(index);
          previous.item.dataset.visibleIndex = String(visibleIndex);
          previous.targetDropdown?.refreshTargetDisplay?.();
          renderedBindings.register(bindingId, previous);
          nextContent.appendChild(previous.item);
          return;
        }
        const item = document.createElement("div");
        item.className = "list-item binding-item";
        item.__bindingRenderKey = renderKey;

        const row = document.createElement("div");
        row.className = "binding-row";

        item.dataset.index = index;
        item.dataset.visibleIndex = String(visibleIndex);
        item.dataset.bindingId = bindingId;
        renderedBindings.register(bindingId, { item });

        const { nameInput, nameField } = createRowName(binding, index);

        const rowNumber = document.createElement("button");
        rowNumber.type = "button";
        rowNumber.className = "binding-index binding-drag";
        rowNumber.title = t("bindings.dragToReorder");
        rowNumber.setAttribute("aria-label", t("bindings.dragToReorder"));
        const dragGrip = document.createElement("span");
        dragGrip.className = "drag-grip";
        dragGrip.setAttribute("aria-hidden", "true");
        rowNumber.appendChild(dragGrip);
        rowNumber.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          rowNumber.setPointerCapture(event.pointerId);
          startBindingDrag(
            item,
            {
              bindingId,
              visibleIndex,
              visibleBindingIds: visibleBindingIds.slice(),
            },
            event,
          );
        });
        rowNumber.addEventListener("pointerup", (event) => {
          rowNumber.releasePointerCapture(event.pointerId);
        });

        const isButton = effectiveIsButton(binding);

        const modeDropdown = createRowMode(binding);

        const targetSelect = createRowTarget(binding, isButton, () => ({ volumeSlider, muteButton }));

        const volumeSlider = document.createElement("input");
        volumeSlider.type = "range";
        volumeSlider.className = "binding-volume-slider";
        volumeSlider.min = "0";
        volumeSlider.max = "1";
        volumeSlider.step = "0.01";
        volumeSlider.title = "Volume";

        if (isButton) {
          volumeSlider.disabled = true;
          volumeSlider.style.visibility = "hidden";
        } else {
          const primaryTarget = getPrimaryTarget(binding);
          const resolvedVolume = resolveRenderedBindingVolume(binding.id, primaryTarget);
          const v = resolvedVolume.value;

          if (v !== null && resolvedVolume.source === "target") {
            bindingLastValues[binding.id] = v;
          }
          volumeSlider.value = v ?? 0;
          updateSliderFill(volumeSlider);

          const targetJson = JSON.stringify(primaryTarget);
          volumeSlider.dataset.targetJson = targetJson;
          volumeSlider.dataset.bindingId = binding.id;

          volumeSlider.addEventListener("input", async (e) => {
            bindingInteractionTimes[binding.id] = Date.now();
            const vol = parseFloat(e.target.value);
            const sourceSequence = (sliderIntentSequenceByBinding[binding.id] || 0) + 1;
            sliderIntentSequenceByBinding[binding.id] = sourceSequence;
            setSliderVolume(e.target, vol, { bindingId: binding.id, markMidiUpdate: true });
            queueSliderAction(binding.id, vol, sourceSequence);
          });
        }

        const muteButton = document.createElement("button");
        muteButton.type = "button";
        muteButton.className = "binding-mute-button";
        const primaryTarget = getPrimaryTarget(binding);
        const isMuted =
          bindingMuteValues[binding.id] != null
            ? Boolean(bindingMuteValues[binding.id])
            : Boolean(getMuted(primaryTarget));
        const visualBehavior = buttonVisualBehavior(binding);
        setMuteButtonState(muteButton, isMuted);
        muteButton.dataset.targetJson = JSON.stringify(primaryTarget);
        muteButton.dataset.bindingId = binding.id;
        renderedBindings.register(binding.id, {
          slider: volumeSlider,
          muteButton,
          targetDropdown: targetSelect,
          target: primaryTarget,
        });

        if (isButton) {
          muteButton.classList.add("visually-hidden");
          muteButton.tabIndex = -1;
          muteButton.setAttribute("aria-hidden", "true");
        }

        muteButton.addEventListener("click", async () => {
          bindingInteractionTimes[binding.id] = Date.now();
          const currentlyMuted = muteButton.classList.contains("muted");
          const newMuted = !currentlyMuted;
          setMuteButtonState(muteButton, newMuted);
          bindingMuteValues[binding.id] = newMuted;

          try {
            await invoke("apply_binding_action", {
              bindingId: binding.id,
              action: "ToggleMute",
              value: newMuted ? 1.0 : 0.0,
              silent: false,
            });
          } catch (err) {
            setMuteButtonState(muteButton, currentlyMuted);
            bindingMuteValues[binding.id] = currentlyMuted;
            console.error("Failed to toggle mute:", err);
          }
        });

        const actions = document.createElement("div");
        actions.className = "binding-actions";

        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "binding-action";
        setActionIcon(
          editButton,
          "edit",
          isButton ? t("bindings.configureButton") : t("bindings.configureFader"),
        );
        editButton.addEventListener("click", () => {
          beginBindingEdit(binding.id);
        });

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "binding-action delete";
        setActionIcon(deleteButton, "delete", t("bindings.deleteBinding"));
        deleteButton.addEventListener("click", async () => {
          const confirmed = await confirmAction({
            title: t("bindings.deleteBindingTitle"),
            message: t("bindings.deleteBindingMessage", { name: binding.name || t("bindings.title") }),
            confirmLabel: t("common.delete"),
            cancelLabel: t("common.cancel"),
            confirmVariant: "danger",
          });
          if (!confirmed) {
            return;
          }
          try {
            await invoke("remove_binding", { binding });
            const next = getBindings();
            next.splice(index, 1);
            setBindings(next);
            renderBindings();
            finishBindingUiMutation("delete binding");
          } catch (err) {
            console.error("Failed to remove binding:", err);
          }
        });

        actions.appendChild(editButton);
        actions.appendChild(deleteButton);

        const valueGroup = createRowValue(
          binding,
          isButton,
          visualBehavior,
          volumeSlider,
          muteButton,
          isMuted,
        );

        row.appendChild(rowNumber);
        row.appendChild(nameField);
        row.appendChild(modeDropdown);
        row.appendChild(targetSelect);
        row.appendChild(valueGroup);
        row.appendChild(actions);
        item.appendChild(row);
        nextContent.appendChild(item);

        if (nameInput && shouldRestoreEditingFocus && String(binding.id) === String(editingIdAtRenderStart)) {
          focusBindingNameInput(nameInput, binding.id);
          if (Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) {
            const max = nameInput.value.length;
            const safeStart = Math.max(0, Math.min(selectionStart, max));
            const safeEnd = Math.max(safeStart, Math.min(selectionEnd, max));
            nameInput.setSelectionRange(safeStart, safeEnd);
          }
        } else if (binding.id === getPendingFocusId() && nameInput) {
          setEditingId(binding.id);
          focusBindingNameInput(nameInput, binding.id, { select: true });
        }
      } catch (err) {
        const errorItem = document.createElement("div");
        errorItem.className = "list-item binding-item error-binding";
        errorItem.textContent = t("bindings.errorPrefix", { message: err.message || err });
        errorItem.style.color = "red";
        errorItem.style.padding = "10px";

        const delBtn = document.createElement("button");
        delBtn.textContent = "\ud83d\uddd1";
        delBtn.className = "icon-button danger";
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          const confirmed = await confirmAction({
            title: t("bindings.deleteBrokenTitle"),
            message: t("bindings.deleteBrokenMessage"),
            confirmLabel: t("common.delete"),
            cancelLabel: t("common.cancel"),
            confirmVariant: "danger",
          });
          if (!confirmed) {
            return;
          }
          try {
            await invoke("remove_binding", { binding });
          } catch {}
          renderBindings();
          finishBindingUiMutation("delete broken binding");
        };
        errorItem.appendChild(delBtn);

        nextContent.appendChild(errorItem);
      }
    });

    if (renderedCount === 0) {
      const empty = document.createElement("div");
      empty.className = "bindings-empty";
      empty.textContent = searchQuery
        ? t("bindings.noSearchResults")
        : typeFilter === "all"
          ? t("bindings.noSearchResults")
          : t("bindings.noFilterResults");
      nextContent.appendChild(empty);
    }

    elements.bindingsContainer.replaceChildren(nextContent);
    restoreElementScroll(elements.bindingsContainer, scrollPosition);

    queueBindingsScrollLayoutSync();
    flushQueuedBindingReveal();
    onBindingsRendered?.();
  }

  const { createRowName } = createRowNameController({
    beginBindingEdit,
    fallbackNameFor,
    finishBindingUiMutation,
    flushPendingRerender,
    getEditingId,
    getPendingFocusId,
    invoke,
    nameDrafts,
    setEditingId,
    setPendingFocusId,
    t,
  });

  const { createRowMode } = createRowModeController({
    finishBindingUiMutation,
    invoke,
    renderBindings,
    t,
  });

  const { createRowTarget } = createRowTargetController({
    bindingLastValues,
    bindingMuteValues,
    buildTarget,
    finishBindingUiMutation,
    getMuted,
    getVol,
    invoke,
    openConfigModal,
    renderBindings,
    renderedBindings,
    setMuteButtonState,
    setSliderVolume,
    showMacroAlreadyConfiguredError,
    showSoundboardAlreadyConfiguredError,
    showSpecialActionConflictError,
    startHotkeyLearn,
  });

  const { createRowValue } = createRowValueController({
    bindingInteractionTimes,
    bindingLastValues,
    buttonUsesPressReleaseCommand,
    buttonVisualActive,
    invoke,
    openConfigModal,
    pulseMomentaryValue,
    t,
  });

  return { renderBindings };
}

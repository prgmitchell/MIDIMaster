/** macro drag workflow. */
export function createMacroDrag({
  elements,
  findMacroPathForStep,
  getConfigBinding,
  getMacroStepAtPath,
  macroState,
  updateMacroDraft,
}) {
  function moveMacroItem(items, fromIndex, toIndex) {
    if (!Array.isArray(items)) return;
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) return;
    const [moved] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, moved);
  }

  function macroDragItemSelector(type) {
    return type === "parallel" ? ".binding-config-macro-action" : ".binding-config-macro-step";
  }

  function macroDragContainerForItem(item, dragInfo) {
    if (!item || !dragInfo) return null;
    if (dragInfo.type === "parallel") {
      return item.closest(".binding-config-macro-parallel-children");
    }
    return elements.bindingConfigMacroList;
  }

  function macroPlaceholderIndex(state = macroState.macroDragState) {
    if (!state?.container || !state?.placeholder) return null;
    let index = 0;
    for (const child of state.container.children) {
      if (child === state.placeholder) return index;
      if (child.matches?.(state.itemSelector)) {
        index += 1;
      }
    }
    return null;
  }

  function cleanupMacroDragState({ reorder = false } = {}) {
    const state = macroState.macroDragState;
    if (!state) return;
    const newIndex = reorder && state.active ? macroPlaceholderIndex(state) : null;
    macroState.macroDragState = null;
    state.item.style.display = "";
    state.item.classList.remove("is-dragging");
    state.ghost.remove();
    if (state.active) {
      state.placeholder.remove();
    }
    document.body.classList.remove("dragging-binding");

    if (!reorder || !state.active || newIndex === null || newIndex === state.index) {
      return;
    }

    const insertIndex = newIndex > state.index ? newIndex - 1 : newIndex;
    const binding = getConfigBinding();
    const selectedStepRef = getMacroStepAtPath(binding);
    updateMacroDraft((draftSteps) => {
      if (state.type === "top") {
        moveMacroItem(draftSteps, state.index, insertIndex);
      } else {
        const group = draftSteps[state.groupIndex];
        if (!group || !Array.isArray(group.steps)) return;
        moveMacroItem(group.steps, state.index, insertIndex);
      }
      macroState.selectedPath = findMacroPathForStep(draftSteps, selectedStepRef) || macroState.selectedPath;
    });
  }

  function cancelMacroDrag() {
    cleanupMacroDragState();
  }

  function endMacroDrag() {
    cleanupMacroDragState({ reorder: true });
  }

  function startMacroDrag(item, dragInfo, event) {
    if (!item || !dragInfo || event.button !== 0) return;
    const container = macroDragContainerForItem(item, dragInfo);
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = item.getBoundingClientRect();
    const ghost = item.cloneNode(true);
    ghost.classList.add("binding-config-macro-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.opacity = "0";

    const placeholder = document.createElement("div");
    placeholder.className = "binding-config-macro-placeholder";
    placeholder.style.height = `${rect.height}px`;

    document.body.appendChild(ghost);
    macroState.macroDragState = {
      ...dragInfo,
      item,
      container,
      ghost,
      placeholder,
      itemSelector: macroDragItemSelector(dragInfo.type),
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };

    item.classList.add("is-dragging");
    document.body.classList.add("dragging-binding");
  }

  function updateMacroDrag(event) {
    const state = macroState.macroDragState;
    if (!state) return;

    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    if (!state.active) {
      if (Math.hypot(deltaX, deltaY) < 6) {
        return;
      }
      state.active = true;
      state.item.style.display = "none";
      state.container.insertBefore(state.placeholder, state.item.nextSibling);
      state.ghost.style.opacity = "0.85";
    }

    state.ghost.style.left = `${event.clientX - state.offsetX}px`;
    state.ghost.style.top = `${event.clientY - state.offsetY}px`;

    const target = document.elementFromPoint(event.clientX, event.clientY);
    const macroItem = target?.closest?.(state.itemSelector);
    if (!macroItem || macroItem === state.item || macroItem.parentElement !== state.container) {
      return;
    }

    const rect = macroItem.getBoundingClientRect();
    const insertBefore = event.clientY < rect.top + rect.height / 2;
    const reference = insertBefore ? macroItem : macroItem.nextSibling;
    if (reference !== state.placeholder) {
      state.container.insertBefore(state.placeholder, reference);
    }
  }

  function createMacroDragHandle(label, dragInfo) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "binding-config-macro-drag";
    handle.title = label;
    handle.setAttribute("aria-label", label);
    const grip = document.createElement("span");
    grip.className = "drag-grip";
    grip.setAttribute("aria-hidden", "true");
    handle.appendChild(grip);
    handle.addEventListener("pointerdown", (event) => {
      const item = handle.closest(macroDragItemSelector(dragInfo?.type));
      handle.setPointerCapture?.(event.pointerId);
      startMacroDrag(item, dragInfo, event);
    });
    handle.addEventListener("pointerup", (event) => {
      handle.releasePointerCapture?.(event.pointerId);
    });
    return handle;
  }

  return { cancelMacroDrag, endMacroDrag, updateMacroDrag, createMacroDragHandle };
}

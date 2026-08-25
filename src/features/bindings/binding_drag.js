import { reorderVisibleBindings } from "./reorder.js";

export function findPlaceholderVisibleIndex(children, visibleBindingIds = []) {
  const visibleIdSet = new Set(visibleBindingIds.map((id) => String(id || "")));
  let index = 0;
  for (const child of Array.from(children || [])) {
    if (child.classList.contains("binding-placeholder")) return index;
    if (
      child.classList.contains("binding-item")
      && visibleIdSet.has(String(child.dataset?.bindingId || ""))
    ) {
      index += 1;
    }
  }
  return null;
}

export function createBindingDragController({
  container,
  getDragState,
  setDragState,
  getBindings,
  setBindings,
  renderBindings,
  finishMutation,
  flushPendingRerender,
  documentRef = document,
}) {
  function start(item, dragInfo, event) {
    const rect = item.getBoundingClientRect();
    const ghost = item.cloneNode(true);
    ghost.classList.add("binding-ghost");
    Object.assign(ghost.style, {
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      opacity: "0",
    });

    const placeholder = documentRef.createElement("div");
    placeholder.className = "binding-placeholder";
    placeholder.style.height = `${rect.height}px`;
    documentRef.body.appendChild(ghost);

    const bindingId = String(dragInfo?.bindingId || item.dataset?.bindingId || "");
    const visibleIndex = Number.isInteger(dragInfo?.visibleIndex)
      ? dragInfo.visibleIndex
      : Number(item.dataset?.visibleIndex || 0);
    const visibleBindingIds = Array.isArray(dragInfo?.visibleBindingIds)
      ? dragInfo.visibleBindingIds.map((id) => String(id || ""))
      : Array.from(container.querySelectorAll(".binding-item[data-binding-id]"))
        .map((bindingItem) => String(bindingItem.dataset?.bindingId || ""))
        .filter(Boolean);

    setDragState({
      bindingId,
      visibleIndex,
      visibleBindingIds,
      item,
      ghost,
      placeholder,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    });
    item.classList.add("dragging");
    documentRef.body.classList.add("dragging-binding");
  }

  function update(event) {
    const dragState = getDragState();
    if (!dragState) return;

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (!dragState.active) {
      if (Math.hypot(deltaX, deltaY) < 6) return;
      dragState.active = true;
      dragState.item.style.display = "none";
      container.insertBefore(dragState.placeholder, dragState.item.nextSibling);
      dragState.ghost.style.opacity = "0.85";
    }

    dragState.ghost.style.left = `${event.clientX - dragState.offsetX}px`;
    dragState.ghost.style.top = `${event.clientY - dragState.offsetY}px`;
    const bindingItem = documentRef.elementFromPoint(event.clientX, event.clientY)?.closest(".binding-item");
    if (!bindingItem || bindingItem === dragState.item) return;

    const rect = bindingItem.getBoundingClientRect();
    const reference = event.clientY < rect.top + rect.height / 2
      ? bindingItem
      : bindingItem.nextSibling;
    if (reference !== dragState.placeholder) container.insertBefore(dragState.placeholder, reference);
  }

  function cleanup(dragState) {
    dragState.item.style.display = "";
    dragState.item.classList.remove("dragging");
    dragState.ghost.remove();
    if (dragState.active) dragState.placeholder.remove();
    documentRef.body.classList.remove("dragging-binding");
  }

  async function end() {
    const dragState = getDragState();
    if (!dragState) return;
    const { bindingId, visibleIndex, visibleBindingIds, active } = dragState;
    const newIndex = active
      ? findPlaceholderVisibleIndex(container.children, visibleBindingIds)
      : null;
    setDragState(null);
    cleanup(dragState);

    if (active && newIndex !== null) {
      const destinationVisibleIndex = newIndex > visibleIndex ? newIndex - 1 : newIndex;
      const result = reorderVisibleBindings(
        getBindings(),
        visibleBindingIds,
        bindingId,
        destinationVisibleIndex,
      );
      if (result.changed) {
        setBindings(result.bindings);
        renderBindings();
        finishMutation("reorder bindings");
      }
    }
    flushPendingRerender();
  }

  function cancel() {
    const dragState = getDragState();
    if (!dragState) return;
    cleanup(dragState);
    setDragState(null);
    flushPendingRerender();
  }

  return { start, update, end, cancel };
}

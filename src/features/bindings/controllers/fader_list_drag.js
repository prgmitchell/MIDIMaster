// Outputs and modifiers use the same floating row and drop outline as bindings.
export function createFaderListDrag({
  container,
  rowSelector,
  gripSelector,
  getId,
  move,
  locked,
  lifetime,
}) {
  let drag = null;

  function cancel() {
    const previous = drag;
    drag = null;
    if (!previous) return;
    previous.row.style.display = "";
    previous.row.classList.remove("is-dragging");
    previous.ghost.remove();
    previous.placeholder.remove();
    document.body.classList.remove("dragging-binding");
    if (previous.grip.hasPointerCapture?.(previous.pointerId))
      previous.grip.releasePointerCapture(previous.pointerId);
  }

  function start(event) {
    const grip = event.target.closest(gripSelector);
    const row = grip?.closest(rowSelector);
    if (!row || row.parentElement !== container || locked() || event.button !== 0)
      return;
    event.preventDefault();
    cancel();
    const rect = row.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.className = "binding-ghost binding-config-panel--fader binding-config-list-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    const copy = row.cloneNode(true);
    for (const element of copy.querySelectorAll("[id]")) element.removeAttribute("id");
    ghost.appendChild(copy);
    Object.assign(ghost.style, {
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      opacity: "0",
    });
    const placeholder = document.createElement("div");
    placeholder.className = "binding-placeholder binding-config-list-placeholder";
    placeholder.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);
    drag = {
      id: getId(row), row, grip, ghost, placeholder,
      pointerId: event.pointerId,
      x: event.clientX, y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      active: false,
    };
    grip.setPointerCapture?.(event.pointerId);
  }

  function update(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (locked()) return cancel();
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      drag.active = true;
      drag.row.style.display = "none";
      drag.row.classList.add("is-dragging");
      container.insertBefore(drag.placeholder, drag.row.nextSibling);
      drag.ghost.style.opacity = "0.85";
      document.body.classList.add("dragging-binding");
    }
    drag.ghost.style.left = `${event.clientX - drag.offsetX}px`;
    drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!container.contains(target) || drag.placeholder.contains(target)) return;
    const reference = Array.from(container.children).find((row) => {
      if (row === drag.row || !row.matches(rowSelector)) return false;
      const rect = row.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    }) || null;
    if (reference !== drag.placeholder.nextSibling)
      container.insertBefore(drag.placeholder, reference);
  }

  function end(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const previous = drag;
    let destination = 0;
    for (const row of container.children) {
      if (row === previous.placeholder) break;
      if (row !== previous.row && row.matches(rowSelector)) destination += 1;
    }
    cancel();
    if (previous.active && !locked()) move(previous.id, destination);
  }

  function bind() {
    lifetime.listen(container, "pointerdown", start);
    lifetime.listen(document, "pointermove", update);
    lifetime.listen(document, "pointerup", end);
    lifetime.listen(document, "pointercancel", (event) => {
      if (event.pointerId === drag?.pointerId) cancel();
    });
    lifetime.listen(document, "keydown", (event) => {
      if (event.key === "Escape") cancel();
    });
    lifetime.listen(window, "blur", cancel);
  }

  return { bind, cancel };
}

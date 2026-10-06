import assert from "node:assert/strict";

export function dragFaderRow(from, to, { cancel = false } = {}) {
  const list = from.parentElement;
  const rows = [...list.children];
  const fromIndex = rows.indexOf(from), toIndex = rows.indexOf(to);
  const previousHitTest = document.elementFromPoint;
  const originalRects = rows.map((row) => row.getBoundingClientRect);
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => ({
      left: 0, top: index * 80, width: 700, height: 67,
    });
  });
  document.elementFromPoint = () => to;
  const pointer = (type, y, target = document) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { button: 0, pointerId: 1, clientX: 10, clientY: y });
    target.dispatchEvent(event);
    return event;
  };
  try {
    const down = pointer("pointerdown", fromIndex * 80 + 30,
      from.querySelector(".binding-config-modifier-grip"));
    assert.equal(down.defaultPrevented, true, "pointer dragging suppresses native dragging");
    const y = toIndex * 80 + (fromIndex < toIndex ? 60 : 5);
    pointer("pointermove", y);
    const ghost = document.querySelector(".binding-config-list-ghost");
    const placeholder = list.querySelector(".binding-config-list-placeholder");
    assert.ok(ghost, "a floating row preview appears during dragging");
    assert.equal(ghost.style.opacity, "0.85");
    assert.equal(ghost.style.width, "700px");
    assert.equal(placeholder?.style.height, "67px", "the drop outline keeps the row height");
    assert.equal(from.style.display, "none");
    assert.equal(document.body.classList.contains("dragging-binding"), true);
    pointer(cancel ? "pointercancel" : "pointerup", y);
    assert.equal(document.querySelector(".binding-config-list-ghost"), null);
    assert.equal(list.querySelector(".binding-config-list-placeholder"), null);
    assert.equal(from.style.display, "");
    assert.equal(document.body.classList.contains("dragging-binding"), false);
  } finally {
    document.elementFromPoint = previousHitTest;
    rows.forEach((row, index) => { row.getBoundingClientRect = originalRects[index]; });
  }
}

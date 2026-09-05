import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHotkeyLearnController } from "../src/features/bindings/hotkey_learn.js";

const bindingsSource = await readFile(
  new URL("../src/features/bindings/bindings.js", import.meta.url),
  "utf8",
);

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    classList: { add() {}, remove() {} },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
}

const windowRef = eventTarget();
const panel = eventTarget();
const cancel = eventTarget();
const controller = createHotkeyLearnController({
  dom: {
    learnPanel: panel,
    learnPanelCancel: cancel,
    learnPanelTitle: {},
    learnPanelMessage: {},
    learnPanelSpinner: eventTarget(),
    learnPanelActions: eventTarget(),
    learnPanelConfirm: eventTarget(),
  },
  translate: (key) => key,
  windowRef,
});

const learning = controller.start({ id: "binding-1" });
assert.equal(controller.isActive(), true);
windowRef.listeners.get("keydown")({
  key: "K",
  code: "KeyK",
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  preventDefault() {},
  stopPropagation() {},
});
assert.deepEqual(await learning, {
  keys: ["Ctrl", "K"],
  display: "Ctrl+K",
});
assert.equal(controller.isActive(), false);
assert.equal(windowRef.listeners.has("keydown"), false);

console.log("Hotkey learn tests passed");

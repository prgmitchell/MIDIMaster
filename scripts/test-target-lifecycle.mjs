import assert from "node:assert/strict";
import { createTargetsFeature } from "../src/features/targets/targets.js";

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
  };
}

const previousWindow = globalThis.window;
const windowTarget = eventTarget();
globalThis.window = windowTarget;

try {
  const panel = {
    ...eventTarget(),
    classList: { add() {}, remove() {}, contains: () => true },
    dataset: {},
    querySelector: () => null,
  };
  const closeButton = eventTarget();
  const targets = createTargetsFeature({
    dom: { targetPanel: panel, targetPanelClose: closeButton },
    i18n: { t: (key) => key },
  });

  assert.equal(windowTarget.listeners.size, 0, "construction should not bind global listeners");
  await targets.start();
  assert.equal(windowTarget.listeners.size, 0, "starting data refresh should not bind UI listeners");
  targets.bindUi();
  targets.bindUi();
  assert.equal(windowTarget.listeners.get("keydown").size, 1, "binding should be idempotent");
  assert.equal(panel.listeners.get("click").size, 1);
  targets.dispose();
  assert.equal(windowTarget.listeners.get("keydown").size, 0);
  assert.equal(panel.listeners.get("click").size, 0);
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}

console.log("Target lifecycle tests passed");

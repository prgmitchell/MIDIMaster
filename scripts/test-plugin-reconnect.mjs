import assert from "node:assert/strict";
import { createReconnectController } from "../src-tauri/plugin_sources/shared/runtime.js";
const originalTimeout = globalThis.setTimeout;
const pending = [];
globalThis.setTimeout = (wake, delay) => {
  pending.push({ wake, delay });
  return pending.length;
};
const state = {
  disposed: false,
  connecting: false,
  disconnectedByUser: false,
  autoConnect: true,
  manualConnectRequested: false,
  reconnectDelayMs: 100,
};
let connected = false,
  attempts = 0,
  succeed = false;
const controller = createReconnectController({
  state,
  initialDelay: 100,
  maximumDelay: 400,
  idleDelay: 25,
  hasConnection: () => connected,
  connect: async () => {
    attempts++;
    connected = succeed;
    return connected;
  },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const wake = async () => {
  pending.shift().wake();
  await settle();
};
try {
  const running = controller.run();
  await settle();
  assert.equal(attempts, 1);
  assert.equal(pending[0].delay, 200);
  await wake();
  assert.equal(attempts, 2);
  assert.equal(pending[0].delay, 400);
  state.disconnectedByUser = true;
  await wake();
  assert.equal(attempts, 2);
  assert.equal(pending[0].delay, 25);
  assert.equal(state.reconnectDelayMs, 100);
  state.disconnectedByUser = false;
  state.manualConnectRequested = true;
  succeed = true;
  await wake();
  assert.equal(attempts, 3);
  assert.equal(pending[0].delay, 100);
  await wake();
  assert.equal(attempts, 3, "an established connection is not reopened");
  connected = false;
  await wake();
  assert.equal(attempts, 4, "a dropped connection is retried");
  state.disposed = true;
  await wake();
  await running;
  assert.equal(pending.length, 0, "unload terminates the retry loop");
} finally {
  state.disposed = true;
  globalThis.setTimeout = originalTimeout;
}
console.log("Plugin reconnect, manual disconnect and disposal tests passed");

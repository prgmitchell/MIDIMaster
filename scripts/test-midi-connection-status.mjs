import assert from "node:assert/strict";
import { createMidiConnectionStatusHandler } from "../src/features/midi/connection_status.js";

const statusElement = { textContent: "" };
const routeCounts = [];
const shown = [];
const handler = createMidiConnectionStatusHandler({
  normalizeRoutes: ({ routes }) => routes,
  setActiveRouteCount: (count) => routeCounts.push(count),
  showMain: (...args) => shown.push(args),
  statusElement,
  translate: (key, params) => params?.message ? `${key}:${params.message}` : key,
});

handler.handle({ state: "reconnecting", route_count: 2 });
assert.equal(statusElement.textContent, "midi.searchingDevices");
assert.deepEqual(routeCounts, [2]);

const route = {
  inputDeviceId: "input-1",
  inputDeviceName: "Controller",
  outputDeviceId: "output-1",
  outputDeviceName: "Controller Out",
};
handler.handle({ state: "connected", routes: [route] });
assert.deepEqual(shown[0], ["Controller", "Controller Out", { routeCount: 1, routes: [route] }]);

handler.handle({ state: "connected", routes: [] });
assert.equal(statusElement.textContent, "midi.connected");

handler.handle({ state: "failed", reason: "unavailable" });
assert.equal(statusElement.textContent, "midi.connectFailed:unavailable");
handler.handle({ state: "disconnected", routes: [] });
assert.equal(statusElement.textContent, "midi.disconnected");

console.log("MIDI connection status tests passed");

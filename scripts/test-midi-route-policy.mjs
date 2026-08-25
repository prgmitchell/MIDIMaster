import assert from "node:assert/strict";
import {
  createMidiRoutePolicy,
  preserveUnavailableRouteDrafts,
  routeMatchesIdentity,
  routesFromResolvedPreferences,
} from "../src/features/midi/route_policy.js";

const preferred = { inputDeviceId: "in-1", inputDeviceName: "Input", outputDeviceId: "out-1", outputDeviceName: "Output", enabled: true };
assert.equal(routeMatchesIdentity(preferred, { ...preferred, outputDeviceId: "out-2" }), true);
assert.equal(routeMatchesIdentity(preferred, { ...preferred, inputDeviceName: "Different" }), false);

const merged = preserveUnavailableRouteDrafts([], [{ ...preferred, inputDeviceName: "Input (Unavailable)" }], { routes: [preferred] }, []);
assert.equal(merged.length, 1);
assert.equal(merged[0].inputDeviceName, "Input (Unavailable)");

const resolved = routesFromResolvedPreferences({ routes: [{ preference: preferred, inputMatch: { id: "in-2", name: "Input 2" }, outputMatch: { id: "out-2", name: "Output 2" } }] });
assert.equal(resolved[0].inputDeviceId, "in-2");

const warnings = [];
const policy = createMidiRoutePolicy({ warn: (...args) => warnings.push(args) });
const unavailable = policy.resolveDesiredRouteSet({ inputs: [], outputs: [] }, { routes: [preferred] }, "test");
assert.equal(unavailable.routes[0].available, false);
policy.resolveDesiredRouteSet({ inputs: [], outputs: [] }, { routes: [preferred] }, "test");
assert.equal(warnings.length, 1);

console.log("MIDI route policy tests passed");

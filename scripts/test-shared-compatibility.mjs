import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyFaderCurve,
  applyCustomFaderCurve,
  normalizeBinding,
  getBindingTargets,
} from "../src/core/binding_model.js";
import { fromOsdSettings, toPersistedOsdSettings } from "../src/core/osd_settings.js";
const cases = JSON.parse(await readFile(new URL("./fixtures/fader-curves.json", import.meta.url), "utf8"));
for (const c of cases) {
  const actual =
    c.curve === "Custom" ? applyCustomFaderCurve(c.points, c.input) : applyFaderCurve(c.curve, c.input);
  assert.ok(Math.abs(actual - c.expected) < 1e-10, c.name);
}
const profiles = JSON.parse(await readFile(new URL("./fixtures/profiles.json", import.meta.url), "utf8"));
for (const profile of profiles) {
  const binding = normalizeBinding(profile.bindings[0]);
  assert.deepEqual(getBindingTargets(binding), profile.bindings[0].targets || [profile.bindings[0].target]);
  assert.deepEqual(normalizeBinding(binding), binding);
  const osd = toPersistedOsdSettings(fromOsdSettings(profile.osd_settings));
  assert.deepEqual(toPersistedOsdSettings(fromOsdSettings(osd)), osd);
}
console.log("Cross-language curve and profile compatibility tests passed");

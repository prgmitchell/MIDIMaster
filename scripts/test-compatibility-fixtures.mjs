import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeBinding } from "../src/core/binding_model.js";
import { normalizeMacroDraftSteps } from "../src/features/bindings/macro_draft.js";
import {
  DEFAULT_OSD_SETTINGS,
  fromOsdSettings,
  toPersistedOsdSettings,
  toOsdCommandSettings,
} from "../src/core/osd_settings.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/binding-compatibility.json", import.meta.url)));
for (const { input, expected } of fixture.bindings) {
  assert.deepEqual(normalizeBinding(structuredClone(input)), expected, input.id);
}
for (const { input, expected } of fixture.macroDrafts) {
  assert.deepEqual(normalizeMacroDraftSteps(structuredClone(input)), expected);
}
assert.deepEqual(fromOsdSettings({}), DEFAULT_OSD_SETTINGS);
for (const showBindingName of [false, true]) {
  const client = { ...DEFAULT_OSD_SETTINGS, showBindingName, monitorId: "DISPLAY-2", opacity: 0.73 };
  assert.deepEqual(fromOsdSettings(toPersistedOsdSettings(client)), client);
  assert.deepEqual(toOsdCommandSettings(client), client);
}
assert.deepEqual(fromOsdSettings({ enabled: false, show_binding_name: false }).enabled, false);
assert.equal(toOsdCommandSettings({ ...DEFAULT_OSD_SETTINGS, style: "invalid", opacity: 2 }).opacity, 1);
assert.equal(toOsdCommandSettings({ ...DEFAULT_OSD_SETTINGS, style: "invalid" }).style, "midnight");
console.log("Compatibility fixture tests passed");

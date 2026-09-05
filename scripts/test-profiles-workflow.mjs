import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createProfilesFeature } from "../src/features/profiles/profiles.js";
import { normalizeBinding } from "../src/core/binding_model.js";
import { DEFAULT_OSD_SETTINGS } from "../src/core/osd_settings.js";
await createAppDom();
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const profiles = JSON.parse(await readFile(new URL("./fixtures/profiles.json", import.meta.url), "utf8"));
let active = profiles[0].name,
  bindings = profiles[0].bindings.map(normalizeBinding),
  pluginSettings = {},
  osd = { ...DEFAULT_OSD_SETTINGS },
  midi = {};
let failSave = false;
const calls = [];
const feature = createProfilesFeature({
  invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "load_profile") return structuredClone(profiles.find((p) => p.name === args.name));
    if (command === "save_profile" && failSave) throw new Error("disk full");
  },
  getActiveProfileName: () => active,
  setActiveProfileName: (next) => {
    active = next;
  },
  getBindings: () => bindings,
  setBindings: (next) => {
    bindings = next;
  },
  normalizeBinding,
  getProfilePluginSettings: () => pluginSettings,
  setProfilePluginSettings: (next) => {
    pluginSettings = next;
  },
  getOsdSettings: () => osd,
  setOsdSettings: (next) => {
    osd = next;
  },
  getActiveProfileMidiPreference: () => midi,
  setActiveProfileMidiPreference: (next) => {
    midi = next;
  },
});
const pending = feature.saveBindingsForProfile();
assert.equal(feature.saveBindingsForProfile(), pending, "successive edits coalesce into one pending save");
await feature.loadProfileByName(profiles[1].name);
await pending;
const saved = calls.find((x) => x.command === "save_profile");
assert.equal(saved.args.profile.name, profiles[0].name);
assert.ok(
  calls.findIndex((x) => x.command === "save_profile") < calls.findIndex((x) => x.command === "load_profile"),
);
assert.equal(active, profiles[1].name);
assert.equal(bindings[0].feedback_enabled, false);
assert.equal(osd.showBindingName, true);
assert.deepEqual(pluginSettings, profiles[1].plugin_settings);
failSave = true;
const rejected = feature.saveBindingsForProfile();
const rejection = assert.rejects(rejected, /disk full/);
await assert.rejects(feature.loadProfileByName(profiles[0].name), /disk full/);
await rejection;
assert.equal(active, profiles[1].name, "a failed pending save aborts the profile switch");
assert.equal(bindings[0].id, "current-button");
console.log("Profile save coalescing and switching tests passed");

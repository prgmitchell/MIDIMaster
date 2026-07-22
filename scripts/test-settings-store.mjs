import assert from "node:assert/strict";
import { createSettingsStore } from "../src/app/settings_store.js";

const calls = [];
let failSave = false;
const store = createSettingsStore({
  invoke: async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_app_settings") {
      return {
        start_with_windows: true,
        language: "fr",
        compact_bindings: true,
        fader_curve_presets: [{ id: "one" }],
      };
    }
    if (failSave) throw new Error("save failed");
    return { ...payload, compact_bindings: true };
  },
  normalizeFaderCurvePresets: (value) => Array.isArray(value) ? value : [],
  supportedLanguages: ["en", "fr"],
});

await store.load();
const loaded = store.get();
assert.equal(loaded.startWithWindows, true);
assert.equal(loaded.language, "fr");
assert.equal(loaded.compactBindings, true);
assert.deepEqual(loaded.faderCurvePresets, [{ id: "one" }]);

const previous = { ...store.get() };
store.update({ startInTray: true, language: "unsupported" });
assert.equal(store.get().language, "en");
await store.persist({ previousSettings: previous });
assert.deepEqual(calls.at(-1), {
  command: "update_app_settings",
  payload: {
    startWithWindows: true,
    startInTray: true,
    minimizeToTray: false,
    exitToTray: false,
    autoCheckUpdates: true,
    language: "en",
  },
});

const rollback = { ...store.get() };
store.update({ exitToTray: true });
failSave = true;
await assert.rejects(store.persist({ previousSettings: rollback }), /save failed/);
assert.equal(store.get().exitToTray, rollback.exitToTray);

console.log("Settings store tests passed");

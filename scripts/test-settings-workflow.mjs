import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createDomRefs } from "../src/app/dom_refs.js";
import { createSettingsFeature } from "../src/features/settings/settings.js";
import { createSettingsStore } from "../src/app/settings_store.js";
import { DEFAULT_OSD_SETTINGS } from "../src/core/osd_settings.js";
await createAppDom();
let osd = { ...DEFAULT_OSD_SETTINGS };
let monitors = [];
const commands = [];
const intervals = new Map();
let next = 0;
const originalSetInterval = globalThis.setInterval,
  originalClearInterval = globalThis.clearInterval;
globalThis.setInterval = (callback, delay) => {
  const id = ++next;
  intervals.set(id, { callback, delay });
  return id;
};
globalThis.clearInterval = (id) => intervals.delete(id);
const d = createDomRefs().settings;
const feature = createSettingsFeature({
  invoke: async (command, args) => {
    commands.push({ command, args });
    if (command === "get_virtual_audio_status") return { install_state: "ready", service_running: true };
    if (command === "list_virtual_audio_input_devices") return [];
    if (command === "get_virtual_audio_settings") return { enabled: false };
  },
  listen: async () => () => {},
  dom: d,
  i18n: { t: (key) => key },
  settingsStore: createSettingsStore({ invoke: async () => ({}) }),
  getOsdSettings: () => osd,
  setOsdSettings: (next) => {
    osd = next;
  },
  getMonitorOptions: () => monitors,
  setMonitorOptions: (next) => {
    monitors = next;
  },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
try {
  feature.bindUi();
  feature.bindUi();
  await feature.applyOsdSettings({ showBindingName: false });
  commands.length = 0;
  d.osdLabelModeSelect.value = "binding";
  d.osdLabelModeSelect.dispatchEvent(new window.Event("change"));
  await settle();
  assert.equal(osd.showBindingName, true);
  assert.equal(commands.filter((x) => x.command === "update_osd_settings").length, 1);
  assert.equal(commands.find((x) => x.command === "update_osd_settings").args.showBindingName, true);
  assert.equal(d.osdPositionPicker.querySelector(".settings-osd-preview-label").textContent, "Fader Group 1");
  feature.activateSettingsSection("virtual-audio");
  await settle();
  await settle();
  assert.ok(commands.some((x) => x.command === "get_virtual_audio_status"));
  assert.ok(
    [...intervals.values()].some((x) => x.delay === 250),
    "active ready audio meters poll at the existing interval",
  );
  feature.activateSettingsSection("startup");
  assert.equal(intervals.size, 0, "leaving Virtual Audio stops polling");
  feature.activateSettingsSection("virtual-audio");
  await settle();
  await settle();
  feature.dispose();
  assert.equal(intervals.size, 0, "disposal stops audio polling");
  const count = commands.length;
  d.osdLabelModeSelect.dispatchEvent(new window.Event("change"));
  await settle();
  assert.equal(commands.length, count, "disposed settings remove their event handlers");
} finally {
  feature.dispose();
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
}
console.log("Settings workflow tests passed");

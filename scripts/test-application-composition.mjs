import assert from "node:assert/strict";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { readFile } from "node:fs/promises";

await createAppDom();
const intervals = new Map();
let nextId = 0;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
globalThis.setInterval = (callback) => {
  intervals.set(++nextId, callback);
  return nextId;
};
globalThis.clearInterval = (id) => intervals.delete(id);
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
window.localStorage = localStorage;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () =>
    JSON.parse(
      await readFile(new URL(`../src/${String(url).replace(/^\.\//, "")}`, import.meta.url), "utf8"),
    ),
});
const commands = [],
  subscriptions = new Set(),
  unexpected = [];
window.__TAURI__ = {
  core: {
    invoke: async (command, args) => {
      commands.push({ command, args });
      if (command === "get_app_settings")
        return {
          language: "en",
          auto_check_updates: false,
          midi_device_inventory_consent: "declined",
          midi_device_inventory_notice_version: 1,
        };
      if (command === "list_profiles") return [{ name: "Default" }];
      if (command === "load_profile")
        return {
          name: "Default",
          bindings: [
            {
              id: "startup",
              name: "Music",
              target: "Master",
              action: "Volume",
              control_kind: "Continuous",
              control: { channel: 1, controller: 7, msg_type: "ControlChange" },
            },
          ],
          plugin_settings: {},
        };
      if (command === "list_midi_devices" || command === "list_midi_output_devices")
        return [{ id: "fixture-device", name: "Fixture MIDI" }];
      if (command === "get_osd_settings") return { enabled: false };
      if (command === "start_midi_device_routes") {
        assert.deepEqual(args.routes, [], "unconfigured profiles clear routes instead of guessing a device");
        return [];
      }
      if (
        [
          "list_plugins",
          "fetch_store_catalog",
          "list_monitors",
          "list_brightness_monitors",
          "take_storage_recovery_notices",
        ].includes(command)
      )
        return [];
      if (
        [
          "set_active_profile_preference",
          "stop_midi_device",
          "stop_soundboard_preview",
          "preview_osd",
        ].includes(command)
      )
        return null;
      unexpected.push(command);
      throw new Error(`Unexpected startup command: ${command}`);
    },
  },
  event: {
    listen: async (event, handler) => {
      const subscription = { event, handler };
      subscriptions.add(subscription);
      return () => subscriptions.delete(subscription);
    },
  },
};
try {
  const { createApplication } = await import("../src/app/application.js");
  const app = createApplication();
  assert.equal(typeof app.start, "function");
  await app.start();
  assert.ok(
    document.querySelector(".binding-item[data-binding-id='startup']")?.textContent.includes("Music"),
    "startup loads and renders a legacy profile through real services",
  );
  const loaded = commands.findIndex(({ command }) => command === "load_profile");
  const devices = commands.findIndex(({ command }) => command === "list_midi_devices");
  assert.ok(loaded >= 0 && devices > loaded, "the saved profile is usable before MIDI discovery");
  assert.equal(
    commands.some(({ command }) => command === "start_midi_device"),
    false,
    "no preference never connects an arbitrary device",
  );
  await app.dispose();
  await app.dispose();
  assert.equal(intervals.size, 0, "disposing the assembled app stops MIDI and editor intervals");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subscriptions.size, 0);
  assert.deepEqual(unexpected, []);
} finally {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  globalThis.fetch = originalFetch;
}
console.log("Application composition and disposal tests passed");

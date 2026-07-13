import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostSource = await readFile(path.join(rootDir, "src", "plugin_host.js"), "utf8");
const hostModule = await import(`data:text/javascript;base64,${Buffer.from(hostSource).toString("base64")}`);

const lifecycleEvents = [];
globalThis.__MIDIMASTER_PLUGIN_LIFECYCLE_TEST_EVENTS__ = lifecycleEvents;

const pluginCode = `
export async function activate(ctx) {
  const events = globalThis.__MIDIMASTER_PLUGIN_LIFECYCLE_TEST_EVENTS__;
  events.push("activate");
  events.push(typeof ctx.app.showConfirm === "function" ? "confirm-api" : "missing-confirm-api");
  ctx.lifecycle.onDispose(() => events.push("lifecycle-dispose"));
  ctx.profile.onChanged(() => events.push("profile"));
  ctx.bindings.onChanged(() => events.push("bindings"));
  ctx.tauri.listen("delayed-plugin-event", () => events.push("delayed-plugin-event"));
  await ctx.tauri.listen("plugin-event", () => events.push("plugin-event"));
  const wsId = await ctx.ws.open("ws://127.0.0.1:1");
  ctx.ws.onMessage(wsId, () => events.push("ws-message"));
  ctx.connections.registerTab({
    id: "fake",
    name: "Fake",
    mount: () => events.push("mount"),
    unmount: () => events.push("unmount"),
  });
  ctx.registerIntegration({
    id: "fake",
    onBindingTriggered: () => events.push("trigger"),
  });
  return {
    dispose() { events.push("api-dispose"); },
    stop() { events.push("api-stop"); },
  };
}
`;

class TestBlob {
  constructor(parts) {
    this.text = parts.map((part) => String(part || "")).join("");
  }
}

const originalBlob = globalThis.Blob;
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

globalThis.Blob = TestBlob;
URL.createObjectURL = (blob) => `data:text/javascript;base64,${Buffer.from(blob.text).toString("base64")}`;
URL.revokeObjectURL = () => {};

try {
  const invoked = [];
  const closedWsIds = [];
  const unlistened = [];
  let resolveDelayedListen = null;

  async function invoke(command, args = {}) {
    invoked.push({ command, args });
    if (command === "list_plugins") {
      return [{ id: "fake", entry: "plugin.mjs", enabled: true }];
    }
    if (command === "read_plugin_text") {
      return pluginCode;
    }
    if (command === "ws_open") {
      return 7;
    }
    if (command === "ws_close") {
      closedWsIds.push(args.id);
      return null;
    }
    throw new Error(`Unexpected invoke: ${command}`);
  }

  async function listen(eventName) {
    if (eventName === "delayed-plugin-event") {
      return new Promise((resolve) => {
        resolveDelayedListen = () => {
          resolve(() => {
            unlistened.push(eventName);
          });
        };
      });
    }
    return () => {
      unlistened.push(eventName);
    };
  }

  const host = hostModule.createPluginHost({
    invoke,
    listen,
    onUpdatePluginSettings: async () => {},
    onInvalidateBindingsUI: () => {},
    showConfirm: async () => true,
  });

  const loaded = await host.loadInstalledPlugins();
  assert.equal(loaded.length, 1);
  assert.equal(host.getConnectionTabs().length, 1);
  assert.ok(host.getIntegration("fake"));

  await host.start();

  const eventCountAfterLoad = lifecycleEvents.length;
  host.setProfileState({ name: "Default", plugin_settings: { fake: {} } });
  host.setBindings([{ id: "binding-1" }]);
  assert.ok(lifecycleEvents.length > eventCountAfterLoad);

  const stopPromise = host.stop();
  assert.equal(unlistened.includes("delayed-plugin-event"), false);
  assert.equal(typeof resolveDelayedListen, "function");
  resolveDelayedListen();
  await stopPromise;

  const eventCountAfterStop = lifecycleEvents.length;
  host.setProfileState({ name: "Other", plugin_settings: { fake: {} } });
  host.setBindings([{ id: "binding-2" }]);
  assert.equal(lifecycleEvents.length, eventCountAfterStop);

  assert.equal(host.getConnectionTabs().length, 0);
  assert.equal(host.getIntegration("fake"), null);
  assert.ok(lifecycleEvents.includes("unmount"));
  assert.ok(lifecycleEvents.includes("api-dispose"));
  assert.ok(lifecycleEvents.includes("api-stop"));
  assert.ok(lifecycleEvents.includes("lifecycle-dispose"));
  assert.ok(lifecycleEvents.includes("confirm-api"));
  assert.ok(closedWsIds.includes(7));
  assert.ok(unlistened.includes("delayed-plugin-event"));
  assert.ok(unlistened.includes("plugin-event"));
  assert.ok(unlistened.includes("ws_message"));
  assert.ok(unlistened.includes("ws_closed"));
  assert.ok(unlistened.includes("integration_binding_triggered"));
  assert.ok(unlistened.includes("integration_binding_triggered_batch"));
  assert.ok(invoked.some((entry) => entry.command === "read_plugin_text"));
} finally {
  globalThis.Blob = originalBlob;
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
  delete globalThis.__MIDIMASTER_PLUGIN_LIFECYCLE_TEST_EVENTS__;
}

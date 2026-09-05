import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPluginHost } from "../src/plugin_host.js";
import { bundledPlugins } from "./lib/bundled_plugins.mjs";
import { createAppDom } from "./lib/dom_fixture.mjs";

await createAppDom();
const packages = await bundledPlugins();
const sources = new Map(
  await Promise.all(
    packages.map(async (plugin) => [
      plugin.id,
      await readFile(new URL(plugin.entry, plugin.directory), "utf8"),
    ]),
  ),
);
const original = {
  Blob,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
const timers = new Map();
let timerId = 0;
globalThis.setTimeout = (callback) => {
  timers.set(++timerId, callback);
  return timerId;
};
globalThis.setInterval = globalThis.setTimeout;
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.clearInterval = globalThis.clearTimeout;
// Exercise the production Blob loader. Node supports data imports in place of
// browser blob URLs; the bytes supplied by the host remain identical.
globalThis.Blob = class {
  constructor(parts) {
    this.text = parts.join("");
  }
};
URL.createObjectURL = (blob) => `data:text/javascript;base64,${Buffer.from(blob.text).toString("base64")}`;
URL.revokeObjectURL = () => {};
const commands = [];
const activeSubscriptions = new Set();
const host = createPluginHost({
  invoke: async (command, args = {}) => {
    commands.push({ command, args });
    if (command === "list_plugins") return packages.map((plugin) => ({ ...plugin, enabled: true }));
    if (command === "read_plugin_text") return sources.get(args.pluginId);
    if (command === "read_plugin_base64") return "";
    if (command === "voicemeeter_connect")
      return { connected: true, edition: "banana", capabilities: { physical_bus_count: 3 } };
    if (command === "voicemeeter_list_devices") return [{ name: "Fixture speakers", driver_type: "wdm" }];
    if (command === "voicemeeter_snapshot")
      return { status: { connected: true, edition: "banana", capabilities: { physical_bus_count: 3 } } };
    if (command === "voicemeeter_safe_command") return null;
    if (
      ["set_integration_connection_state", "set_binding_feedback", "voicemeeter_disconnect"].includes(command)
    )
      return null;
    throw new Error(`Unexpected plugin command: ${command}`);
  },
  listen: async (event, callback) => {
    const subscription = { event, callback };
    activeSubscriptions.add(subscription);
    return () => activeSubscriptions.delete(subscription);
  },
  onUpdatePluginSettings: async () => {},
  onInvalidateBindingsUI: () => {},
});
try {
  host.setProfileState({
    name: "Offline fixture",
    plugin_settings: Object.fromEntries(
      packages.map((plugin) => [plugin.id, { auto_connect: plugin.id === "voicemeeter" }]),
    ),
  });
  const loaded = await host.loadInstalledPlugins();
  assert.equal(loaded.length, packages.length, "every generated plugin activates through the real loader");
  for (const plugin of packages) assert.ok(host.getIntegration(plugin.id), `${plugin.id} registered`);
  assert.equal(host.getConnectionTabs().length, packages.length);
  host.setBindings([
    {
      id: "obs-offline",
      action: "Volume",
      targets: [{ Integration: { integration_id: "obs", kind: "input", data: { input_name: "Music" } } }],
    },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  const cleared = commands.find(
    ({ command, args }) => command === "set_binding_feedback" && args.bindingId === "obs-offline",
  );
  assert.ok(cleared, "offline OBS bindings clear feedback through the emitted package");
  assert.equal(cleared.args.silent, true, "disconnect feedback never opens the OSD");
  assert.equal(cleared.args.value, 0);
  const voicemeeter = host.getIntegration("voicemeeter");
  const choices = voicemeeter.getTargetOptions({
    controlType: "button",
    nav: { section: "device_choices", direction: "output", scope: "bus", index: 0 },
  });
  const speakers = choices.find(
    (choice) => choice.target?.Integration?.data.device_name === "Fixture speakers",
  );
  assert.ok(speakers, "generated plugin discovers device assignments");
  assert.deepEqual(speakers.buttonActions, [
    { label: "Select Device", value: "SetMainOutputDevice", behavior: "momentary" },
  ]);
  assert.equal(speakers.target.Integration.data.action_kind, "momentary");
  const commandTarget = {
    integration_id: "voicemeeter",
    kind: "command",
    data: { command: "show", action_kind: "momentary" },
  };
  host.setBindings([{ id: "one-shot", action: "ToggleEffect", targets: [{ Integration: commandTarget }] }]);
  await voicemeeter.onBindingTriggered({
    binding_id: "one-shot",
    action: "ToggleEffect",
    target: commandTarget,
    value: 1,
  });
  const reset = commands.find(
    ({ command, args }) => command === "set_binding_feedback" && args.bindingId === "one-shot",
  );
  assert.equal(reset?.args.value, 0, "legacy one-shot actions clear persistent feedback");
  assert.equal(reset?.args.forceHardwareFeedback, true);
  const commandCount = commands.filter(({ command }) => command === "voicemeeter_safe_command").length;
  await voicemeeter.onBindingTriggered({
    binding_id: "one-shot",
    action: "ToggleEffect",
    target: commandTarget,
    value: 0,
  });
  assert.equal(
    commands.filter(({ command }) => command === "voicemeeter_safe_command").length,
    commandCount,
    "one-shot release does not execute twice",
  );
  host.setProfileState({
    name: "Second profile",
    plugin_settings: Object.fromEntries(packages.map((plugin) => [plugin.id, { auto_connect: false }])),
  });
  assert.equal(
    commands.some(({ command }) => command === "ws_open"),
    false,
    "disabled auto-connect survives profile notification",
  );
  await host.stop();
  assert.equal(host.getConnectionTabs().length, 0);
  assert.equal(activeSubscriptions.size, 0, "plugin subscriptions are released");
  // Sleeping reconnect loops may have one outstanding wakeup. After disposal
  // that wakeup must exit without scheduling another timer or opening a socket.
  const sleeping = [...timers.values()];
  timers.clear();
  sleeping.forEach((wake) => wake());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 0, "disposed plugins cannot restart timers");
} finally {
  await host.stop();
  Object.assign(globalThis, {
    Blob: original.Blob,
    setTimeout: original.setTimeout,
    clearTimeout: original.clearTimeout,
    setInterval: original.setInterval,
    clearInterval: original.clearInterval,
  });
  URL.createObjectURL = original.createObjectURL;
  URL.revokeObjectURL = original.revokeObjectURL;
}
console.log("Generated plugin activation and disposal tests passed");

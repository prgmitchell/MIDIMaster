import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [source, html, domRefs, settingsSource, css, english, commandsSource, runtimeSource] = await Promise.all([
  readFile(new URL("../src/features/settings/virtual_audio.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/app/dom_refs.js", import.meta.url), "utf8"),
  readFile(new URL("../src/features/settings/settings.js", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/settings.css", import.meta.url), "utf8"),
  readFile(new URL("../src/locales/en.json", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/commands/virtual_audio.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/virtual_audio.rs", import.meta.url), "utf8"),
]);

const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const {
  createVirtualAudioSettingsController,
  normalizeVirtualAudioSettings,
  normalizeVirtualAudioStatus,
  virtualAudioMeterPercent,
  virtualAudioStatusRefreshInterval,
  virtualAudioViewForStatus,
} = await import(moduleUrl);

assert.deepEqual(normalizeVirtualAudioSettings(), {
  enabled: false,
  follow_default_input: true,
  input_device_id: null,
  microphone_gain_db: 0,
  soundboard_gain_db: -6,
});
assert.deepEqual(normalizeVirtualAudioSettings({
  enabled: true,
  follow_default_input: false,
  input_device_id: "mic-1",
  microphone_gain_db: 80,
  soundboard_gain_db: -80,
}), {
  enabled: true,
  follow_default_input: false,
  input_device_id: "mic-1",
  microphone_gain_db: 24,
  soundboard_gain_db: -24,
});
assert.equal(normalizeVirtualAudioStatus({ state: "made_up" }).install_state, "service_error");
assert.equal(normalizeVirtualAudioStatus({ attached_port_count: 8 }).attached_port_count, 8);
assert.equal(normalizeVirtualAudioStatus({ routing_running: true }).routing_running, true);
assert.equal(normalizeVirtualAudioStatus({ service_update_available: true }).service_update_available, true);
assert.equal(virtualAudioViewForStatus({ install_state: "blocked_unsafe_version" }), "problem");
assert.equal(virtualAudioViewForStatus({ install_state: "restart_required" }), "restart-required");
assert.equal(virtualAudioMeterPercent(1), 100);
assert.equal(virtualAudioMeterPercent(0.1), 67);
assert.equal(virtualAudioMeterPercent(0.01), 33);
assert.equal(virtualAudioMeterPercent(0), 0);
assert.equal(virtualAudioMeterPercent(9), 100);
assert.equal(virtualAudioStatusRefreshInterval({ install_state: "ready" }), 250);
assert.equal(virtualAudioStatusRefreshInterval({ install_state: "service_error" }), 1000);

{
  const previousWindow = globalThis.window;
  let statusCallCount = 0;
  let scheduledPoll = null;
  globalThis.window = {
    addEventListener() {},
    clearInterval() {},
    setTimeout(callback) {
      callback();
      return 1;
    },
    setInterval(callback, interval) {
      assert.equal(interval, 250);
      scheduledPoll = callback;
      return 1;
    },
  };
  try {
    const controller = createVirtualAudioSettingsController({
      dom: {},
      invoke: async (command) => {
        if (command === "get_virtual_audio_status") {
          statusCallCount += 1;
          return { install_state: statusCallCount === 1 ? "service_error" : "ready" };
        }
        if (command === "get_virtual_audio_settings") return {};
        if (command === "list_virtual_audio_input_devices") return [];
        throw new Error(`Unexpected command: ${command}`);
      },
    });
    await controller.setActive(true);
    assert.equal(controller.getState().status.install_state, "service_error");
    assert.equal(typeof scheduledPoll, "function");
    await scheduledPoll();
    assert.equal(controller.getState().status.install_state, "ready");
    assert.equal(statusCallCount, 2);
    await controller.setActive(false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

{
  const previousWindow = globalThis.window;
  const renderedStates = [];
  const clickListeners = new Map();
  const panel = {
    dataset: new Proxy({}, {
      set(target, property, value) {
        target[property] = value;
        if (property === "virtualAudioState") renderedStates.push(value);
        return true;
      },
    }),
    querySelectorAll() { return []; },
  };
  let forcedStatusCalls = 0;
  globalThis.window = {
    addEventListener() {},
    clearInterval() {},
    setInterval() { return 1; },
    setTimeout(callback) {
      callback();
      return 1;
    },
  };
  try {
    const controller = createVirtualAudioSettingsController({
      dom: {
        virtualAudioPanel: panel,
        virtualAudioInstall: {
          disabled: false,
          addEventListener(type, listener) { clickListeners.set(type, listener); },
        },
      },
      invoke: async (command, args) => {
        if (command === "get_virtual_audio_status") {
          if (args?.force) forcedStatusCalls += 1;
          return { install_state: forcedStatusCalls >= 3 ? "ready" : "service_error" };
        }
        if (command === "get_virtual_audio_settings") return {};
        if (command === "list_virtual_audio_input_devices") return [];
        if (command === "install_virtual_audio") return { install_state: "service_error" };
        throw new Error(`Unexpected command: ${command}`);
      },
    });
    controller.bindUi();
    await controller.setActive(true);
    const renderedBeforeInstall = renderedStates.length;
    await clickListeners.get("click")();
    assert.equal(controller.getState().status.install_state, "ready");
    assert.equal(forcedStatusCalls, 3);
    assert.deepEqual(
      renderedStates.slice(renderedBeforeInstall),
      ["installing", "ready"],
      "post-install health checks should keep the setup view visible until forced status reaches ready",
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

assert.match(html, /data-settings-section="virtual-audio"/, "Virtual Audio should have a dedicated settings navigation item");
assert.match(html, /data-settings-panel="virtual-audio"/, "Virtual Audio should have a dedicated settings panel");
assert.ok(
  html.indexOf('data-settings-section="appearance"') < html.indexOf('data-settings-section="virtual-audio"')
    && html.indexOf('data-settings-section="virtual-audio"') < html.indexOf('data-settings-section="maintenance"'),
  "Virtual Audio should appear below Appearance and above Maintenance",
);
assert.doesNotMatch(html, /class="virtual-audio-intro"/, "Virtual Audio should not add a mismatched page title or description");
assert.match(html, /data-virtual-audio-state="loading"/, "Virtual Audio should start in a neutral loading state");
assert.match(html, /data-virtual-audio-view="loading"/, "Virtual Audio should show progress while its first status request runs");
assert.doesNotMatch(html, /id="virtual-audio-refresh"/, "live status polling should not also expose an unexplained refresh button");
assert.doesNotMatch(html, /id="virtual-audio-diagnostics-counts"/, "internal stream counters should not clutter component health");
for (const id of [
  "virtual-audio-install",
  "virtual-audio-update",
  "virtual-audio-update-notice",
  "virtual-audio-repair",
  "virtual-audio-remove",
  "virtual-audio-enabled",
  "virtual-audio-routing-error",
  "virtual-audio-input-device",
  "virtual-audio-microphone-gain",
  "virtual-audio-soundboard-gain",
  "virtual-audio-microphone-meter",
  "virtual-audio-soundboard-meter",
  "virtual-audio-output-meter",
  "virtual-audio-limiter-meter",
]) {
  assert.match(html, new RegExp(`id="${id}"`), `${id} should exist`);
  const domName = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()).replace(/^virtualAudio/, "virtualAudio");
  assert.match(domRefs, new RegExp(`const ${domName} = document\\.getElementById\\("${id}"\\)`), `${id} should have a DOM reference`);
}

for (const command of [
  "get_virtual_audio_status",
  "get_virtual_audio_settings",
  "set_virtual_audio_settings",
  "list_virtual_audio_input_devices",
  "install_virtual_audio",
  "repair_virtual_audio",
  "remove_virtual_audio",
  "restart_system",
  "copy_virtual_audio_diagnostics",
]) {
  assert.ok(source.includes(`"${command}"`), `${command} should be wired`);
}

assert.match(settingsSource, /virtualAudio\.setActive\(activeSection === "virtual-audio"\)/, "meter polling should follow the active settings tab");
assert.match(settingsSource, /renderSelectDropdown:\s*\(select\)\s*=>\s*renderSettingsSelectDropdown\(select\)/, "microphone selection should use the shared settings dropdown");
assert.match(source, /renderSelectDropdown\?\.\(select\)/, "microphone options should refresh the shared dropdown");
assert.match(source, /virtualAudioUpdate\?\.addEventListener\("click", \(\) => runAction\("repair_virtual_audio"\)\)/, "the service update action should reuse the elevated repair path");
assert.match(source, /virtualAudioUpdateNotice\?\.classList\.toggle\("hidden", !status\.service_update_available\)/, "the update notice should follow backend service comparison");
assert.match(source, /setInterval[\s\S]*?250/, "ready-state meters should refresh live");
assert.match(source, /virtualAudioStatusRefreshInterval\(status\)/, "non-ready health states should continue refreshing at a throttled interval");
assert.doesNotMatch(source, /if\s*\(\s*status\.install_state !== "ready"\s*\)\s*return/, "startup health polling should not freeze on a transient service error");
assert.match(source, /settleStatusAfterAction\(command\)/, "setup actions should wait for a fresh component-health result before leaving the installing view");
assert.match(source, /force:\s*true,\s*renderResult:\s*false/, "post-install health checks should bypass the backend component cache without flashing stale state");
assert.match(css, /\.virtual-audio-ready-layout/, "Virtual Audio should have dedicated layout styles");
assert.match(css, /\.virtual-audio-ready-layout\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*grid-template-rows:\s*auto minmax\(min-content, 1fr\)/s, "the ready layout should fill the settings panel and give remaining height to component health");
assert.match(css, /\.virtual-audio-health-card > \.virtual-audio-button-row\s*\{[^}]*margin-top:\s*auto/s, "component health actions should stay anchored to the bottom of the stretched card");
assert.match(css, /\.virtual-audio-section\.active\s*\{[^}]*overflow:\s*visible/s, "the compact Virtual Audio panel should not add a nested scrollbar");
assert.match(css, /--meter-level/, "meters should expose their current level to CSS");
assert.match(commandsSource, /pub async fn get_virtual_audio_status/, "status polling should run away from the UI thread");
assert.match(commandsSource, /force:\s*Option<bool>/, "status polling should support explicit cache bypass after setup changes");
assert.match(commandsSource, /service_update_available/, "status should report when the bundled service differs from the installed service");
assert.doesNotMatch(commandsSource, /refresh_if_due/, "status polling should not trigger route refreshes");
assert.match(runtimeSource, /lifecycle:\s*Mutex<\(\)>/, "route start, refresh, and stop should be serialized");
assert.match(runtimeSource, /impl Drop for ActiveRoute/, "abandoned routes should always release their workers and audio pipe");
assert.ok(JSON.parse(english)["virtualAudio.title"], "English Virtual Audio translations should exist");

console.log("Virtual Audio UI tests passed");

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
  normalizeVirtualAudioSettings,
  normalizeVirtualAudioStatus,
  virtualAudioMeterPercent,
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
assert.equal(virtualAudioMeterPercent(0.678), 68);
assert.equal(virtualAudioMeterPercent(9), 100);

assert.match(html, /data-settings-section="virtual-audio"/, "Virtual Audio should have a dedicated settings navigation item");
assert.match(html, /data-settings-panel="virtual-audio"/, "Virtual Audio should have a dedicated settings panel");
assert.ok(
  html.indexOf('data-settings-section="appearance"') < html.indexOf('data-settings-section="virtual-audio"')
    && html.indexOf('data-settings-section="virtual-audio"') < html.indexOf('data-settings-section="maintenance"'),
  "Virtual Audio should appear below Appearance and above Maintenance",
);
assert.doesNotMatch(html, /class="virtual-audio-intro"/, "Virtual Audio should not add a mismatched page title or description");
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
assert.match(css, /\.virtual-audio-ready-layout/, "Virtual Audio should have dedicated layout styles");
assert.match(css, /\.virtual-audio-section\.active\s*\{[^}]*overflow:\s*visible/s, "the compact Virtual Audio panel should not add a nested scrollbar");
assert.match(css, /--meter-level/, "meters should expose their current level to CSS");
assert.match(commandsSource, /pub async fn get_virtual_audio_status/, "status polling should run away from the UI thread");
assert.match(commandsSource, /service_update_available/, "status should report when the bundled service differs from the installed service");
assert.doesNotMatch(commandsSource, /refresh_if_due/, "status polling should not trigger route refreshes");
assert.match(runtimeSource, /lifecycle:\s*Mutex<\(\)>/, "route start, refresh, and stop should be serialized");
assert.match(runtimeSource, /impl Drop for ActiveRoute/, "abandoned routes should always release their workers and audio pipe");
assert.ok(JSON.parse(english)["virtualAudio.title"], "English Virtual Audio translations should exist");

console.log("Virtual Audio UI tests passed");

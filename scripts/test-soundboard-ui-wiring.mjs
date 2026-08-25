import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DOM_REF_IDS } from "../src/app/dom_refs.js";
import { readCssBundle } from "./css_bundle.mjs";

const [html, domRefs, bindings, targets, tableCss, configCss, controlsCss] = await Promise.all([
  readFile(new URL("../src/index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/app/dom_refs.js", import.meta.url), "utf8"),
  readFile(new URL("../src/features/bindings/bindings.js", import.meta.url), "utf8"),
  readFile(new URL("../src/features/targets/targets.js", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/bindings/table.css", import.meta.url), "utf8"),
  readCssBundle(new URL("../src/styles/bindings/config-panel.css", import.meta.url)),
  readFile(new URL("../src/styles/osd-and-controls.css", import.meta.url), "utf8"),
]);

for (const id of [
  "binding-config-soundboard-section",
  "binding-config-soundboard-waveform",
  "binding-config-soundboard-start",
  "binding-config-soundboard-end",
  "binding-config-soundboard-volume",
  "binding-config-soundboard-preview",
  "binding-config-soundboard-replace",
  "binding-config-soundboard-speed",
  "binding-config-soundboard-output",
  "binding-config-soundboard-playback-time",
  "binding-config-soundboard-monitor",
  "binding-config-soundboard-virtual-mic-option",
  "binding-config-soundboard-virtual-mic-help",
  "binding-config-soundboard-virtual-mic",
]) {
  assert.match(html, new RegExp(`id="${id}"`), `${id} should exist`);
  assert.ok(Object.values(DOM_REF_IDS).includes(id), `${id} should have a DOM reference`);
}

assert.match(targets, /kind: "soundboard-target"/, "Soundboard should be in the target picker");
assert.match(targets, /isButton[\s\S]*?soundboard-target/, "Soundboard should be button-only");
assert.equal((bindings.match(/invoke\("pick_soundboard_audio"\)/g) || []).length, 1, "the file picker should only be invoked by Pick Sound");
assert.match(bindings, /bindingConfigSoundboardReplace\.onclick = async[\s\S]*?invoke\("pick_soundboard_audio"\)/, "Pick Sound should open the file picker");
assert.match(bindings, /hasSoundboardTarget && !previousHadSoundboardTarget\)[\s\S]*?openConfigModal\(binding\.id, \{[\s\S]*?soundboardPage: true,[\s\S]*?removeEmptySoundboardTargetOnCancel: true/, "a newly selected Soundboard target should open its editor with empty-target cleanup enabled");
assert.doesNotMatch(bindings, /soundboardPage: true, soundboardAnalysis:/, "new Soundboard targets should not carry an automatic picker result into the editor");
assert.match(bindings, /bindingConfigSave\.disabled = false/, "Save should remain available for an empty Soundboard binding");
assert.match(bindings, /emptySoundboardBindingToClean = !commit[\s\S]*?configRemoveEmptySoundboardTargetOnCancel[\s\S]*?!normalizeSoundboardMapping\(configDraft\?\.soundboard\)/, "Cancel should identify only a newly added Soundboard target that still has no file");
assert.match(bindings, /if \(emptySoundboardBindingToClean\)[\s\S]*?filter\(\(target\) => !isSoundboardTarget\(target\)\)[\s\S]*?persistBindingBackend\(emptySoundboardBindingToClean\)[\s\S]*?getB\(\)\.map/, "Cancel should persist the binding without its empty Soundboard target");
const cancelCleanupStart = bindings.indexOf("if (emptySoundboardBindingToClean)");
const cancelCleanupEnd = bindings.indexOf("configPreviewOriginalBindings = null", cancelCleanupStart);
assert.ok(cancelCleanupStart >= 0 && cancelCleanupEnd > cancelCleanupStart, "empty Soundboard target cleanup block should exist");
assert.doesNotMatch(bindings.slice(cancelCleanupStart, cancelCleanupEnd), /remove_binding/, "Canceling an empty Soundboard target must not delete the binding");
assert.match(bindings, /bindingConfigSoundboardSection\.classList\.toggle\("is-empty", !mapping\)/, "the editor should expose a dedicated empty state before a file is selected");
assert.match(html, /soundboard-waveform-empty[\s\S]*?data-i18n="soundboard\.noFile"/, "the existing waveform should have an in-place empty placeholder");
assert.doesNotMatch(html, /binding-config-soundboard-summary|binding-config-soundboard-edit/, "normal Button Configuration should not include a redundant Soundboard card");
assert.doesNotMatch(`${domRefs}\n${bindings}`, /bindingConfigSoundboardSummary|bindingConfigSoundboardEdit/, "removed Soundboard summary controls should have no stale references");
assert.match(configCss, /binding-config-section--soundboard\.is-empty \.soundboard-waveform-empty[\s\S]*?display: flex/, "the in-place waveform placeholder should appear before a file is selected");
assert.doesNotMatch(configCss, /is-empty > :not\(\.soundboard-file-row\)/, "the empty state should keep the existing editor visible");
assert.match(bindings, /getTargets\(binding\)\.some\(isSoundboardTarget\)[\s\S]*?soundboardPage: true/, "Soundboard rows should open the dedicated editor even with another primary action");
assert.match(bindings, /async function closeConfigModal[\s\S]*?await stopSoundboardPreview\(\)/, "closing or canceling should stop preview playback");
assert.match(bindings, /set_soundboard_preview_volume/, "preview volume should update live");
assert.match(bindings, /set_soundboard_preview_paused/, "preview transport should pause and resume");
assert.match(bindings, /list_soundboard_output_devices/, "output devices should be selectable");
assert.match(bindings, /mapping\.send_to_monitor = d\.bindingConfigSoundboardMonitor\.checked/, "clips should independently target the monitor");
assert.match(bindings, /mapping\.send_to_virtual_mic = d\.bindingConfigSoundboardVirtualMic\.checked/, "clips should independently target the virtual microphone");
assert.match(bindings, /!mapping\.send_to_monitor && !mapping\.send_to_virtual_mic/, "clips should always retain at least one destination");
assert.match(bindings, /invoke\("get_virtual_audio_status"\)/, "the Soundboard editor should check whether Virtual Audio is ready");
assert.match(bindings, /bindingConfigSoundboardVirtualMic\.disabled = !mapping \|\| soundboardVirtualAudioState !== "ready"/, "the virtual microphone route should be disabled until Virtual Audio is ready");
assert.match(bindings, /bindingConfigSoundboardVirtualMicOption\.classList\.toggle\("is-unavailable", unavailable\)/, "the unavailable virtual microphone route should expose a dimmed state");
assert.match(configCss, /soundboard-route-option\.is-unavailable[\s\S]*?opacity:\s*\.52/, "the unavailable virtual microphone route should look disabled");
assert.match(bindings, /requestAnimationFrame/, "waveform playback should animate a playhead");
assert.doesNotMatch(targets, /replacesExclusiveTarget/, "normal targets should coexist with Soundboard and Macro");
assert.match(targets, /soundboardAlreadyConfigured[\s\S]*?onSoundboardAlreadyConfigured/, "a second Soundboard should show the configured warning");
assert.match(bindings, /showSoundboardAlreadyConfiguredError/, "Soundboard should use the existing warning-dialog pattern");
assert.match(targets, /macroBlockedBySoundboard[\s\S]*?soundboardBlockedByMacro[\s\S]*?onSpecialActionConflict/, "Macro and Soundboard should block one another in both directions");
assert.match(bindings, /hasMacroTarget && hasSoundboardTarget[\s\S]*?showSpecialActionConflictError/, "the binding handler should defensively reject two special targets");
assert.match(bindings, /createSelectDropdownShell[\s\S]*?soundboard-output-dropdown/, "the output device should use the app dropdown component");
assert.match(configCss, /binding-config-panel--button\.binding-config-panel--soundboard-page[\s\S]*?width: min\(500px/, "the Soundboard modal should override the wider button layout");
assert.match(bindings, /bindingConfigSoundboardStart[\s\S]*?bindingConfigSoundboardEnd[\s\S]*?bindingConfigSoundboardVolume[\s\S]*?updateSliderFill/, "Soundboard ranges should calculate exact endpoint fills");
assert.match(bindings, /style\.setProperty\("--range-fill", `\$\{percent\}%`\)/, "Soundboard ranges should expose their exact fill percentage to CSS");
assert.match(configCss, /webkit-slider-runnable-track[\s\S]*?var\(--slider-fill\) 0 var\(--range-fill\)[\s\S]*?var\(--slider-track\) var\(--range-fill\) 100%/, "Soundboard range tracks should render their progress fill at exact endpoints");
assert.match(controlsCss, /\.binding-volume-slider\s*\{[^}]*background-size:\s*var\(--range-fill, 0%\) 100%/, "binding value sliders should render their calculated progress fill");
assert.match(controlsCss, /body\.dark-mode \.binding-row input\.binding-volume-slider\s*\{[^}]*background-size:\s*var\(--range-fill, 0%\) 100%/, "dark binding value sliders should preserve their calculated progress fill");
assert.match(tableCss, /binding-volume-slider::\-webkit-slider-runnable-track\s*\{[^}]*var\(--slider-fill\) 0 var\(--range-fill, 0%\)[^}]*var\(--slider-track\) var\(--range-fill, 0%\) 100%/, "binding value tracks should explicitly split filled and unfilled colors in every theme");
assert.match(configCss, /--soundboard-waveform-background: var\(--surface-subtle\)[\s\S]*?--soundboard-waveform-color:[^;]*var\(--accent\)/, "the waveform should use active theme tokens");
assert.match(configCss, /soundboard-transport-button[\s\S]*?color: var\(--accent\)[\s\S]*?background: var\(--accent-soft\)/, "the preview transport should use active theme tokens");
assert.match(bindings, /soundboardWaveformColors[\s\S]*?getComputedStyle[\s\S]*?drawSoundboardWaveform/, "canvas drawing should resolve waveform colors from the active theme");
const fileRowIndex = html.indexOf('<div class="soundboard-file-row">');
const transportIndex = html.indexOf('<div class="soundboard-transport">', fileRowIndex);
const pickSoundIndex = html.indexOf('id="binding-config-soundboard-replace"', fileRowIndex);
const waveformIndex = html.indexOf('<div class="soundboard-waveform-shell">', fileRowIndex);
assert.ok(fileRowIndex >= 0 && transportIndex > fileRowIndex && pickSoundIndex > transportIndex && waveformIndex > pickSoundIndex, "preview transport should sit between the filename and Pick Sound in the file row");
assert.match(html, /data-i18n="soundboard\.pickSound">Pick Sound</, "the file action should use the Pick Sound label");
assert.match(tableCss, /binding-value-cell--soundboard/, "the Volume column should lay out Edit Sound");

console.log("Soundboard UI wiring tests passed");

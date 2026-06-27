import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = {
  html: await readFile(new URL("../src/index.html", import.meta.url), "utf8"),
  domRefs: await readFile(new URL("../src/app/dom_refs.js", import.meta.url), "utf8"),
  appEntry: await readFile(new URL("../src/app_entry.js", import.meta.url), "utf8"),
  bindings: await readFile(new URL("../src/features/bindings/bindings.js", import.meta.url), "utf8"),
};

const indicatorControls = [
  ["binding-config-indicator-custom", "bindingConfigIndicatorCustom"],
  ["binding-config-indicator-msg-type", "bindingConfigIndicatorMsgType"],
  ["binding-config-indicator-channel", "bindingConfigIndicatorChannel"],
  ["binding-config-indicator-controller", "bindingConfigIndicatorController"],
  ["binding-config-indicator-learn", "bindingConfigIndicatorLearn"],
  ["binding-config-indicator-clear", "bindingConfigIndicatorClear"],
];

for (const [elementId, refName] of indicatorControls) {
  assert.match(files.html, new RegExp(`id="${elementId}"`), `${elementId} should exist in index.html`);
  assert.match(files.domRefs, new RegExp(`const ${refName} = document\\.getElementById\\("${elementId}"\\)`), `${refName} should be read from the DOM`);
  assert.match(files.domRefs, new RegExp(`\\b${refName},`), `${refName} should be returned from createDomRefs`);
  assert.match(files.appEntry, new RegExp(`\\b${refName},`), `${refName} should be passed into createBindingsFeature`);
}

assert.doesNotMatch(files.html, /binding-config-indicator-mode/, "indicator output should not use a default/custom mode selector");
assert.doesNotMatch(files.bindings, /bindingConfigIndicatorMode|indicatorModeDropdown|applyIndicatorModeSelection/, "bindings UI should not manage an indicator mode selector");
assert.match(files.bindings, /createSelectDropdownShell\(\{\s*selectEl: d\.bindingConfigIndicatorMsgType,/s, "indicator message type should use the styled dropdown shell");
assert.match(files.html, /id="binding-config-indicator-custom" class="binding-config-indicator-custom"/, "indicator fields should be visible by default");
assert.match(files.html, /id="binding-config-indicator-learn"[^>]*binding-config-icon-button[^>]*aria-label="Learn indicator output"[^>]*>/, "indicator learn should be an icon button");
assert.match(files.html, /id="binding-config-indicator-clear"[^>]*binding-config-icon-button[^>]*aria-label="Reset indicator output"[^>]*>/, "indicator reset should be an icon button");
assert.doesNotMatch(files.html, /id="binding-config-indicator-clear"[^>]*data-i18n=/, "indicator reset icon should not be overwritten by i18n text");
assert.doesNotMatch(files.bindings, /indicatorLearn\.textContent/, "indicator learn state should preserve its icon markup");
assert.match(files.bindings, /indicatorLearn\.setAttribute\("aria-label", label\)/, "indicator learn state should update accessibility text");
assert.match(files.bindings, /async function startPrimaryLearn\(\)[\s\S]*?setLearnPanelWaiting\(\);[\s\S]*?invoke\("start_midi_learn"\)/, "primary learn should use the shared waiting modal");
assert.doesNotMatch(files.bindings, /setPrimaryLearnButtonState|button\.replaceChildren\(spinner, label\)|binding-config-button-spinner/, "primary learn should not mutate the button with inline waiting markup");
assert.doesNotMatch(files.bindings, /bindingConfigButtonLearnIndicator\.classList\.toggle\("hidden", !learningPrimary\)/, "button learn should not reveal a separate status row");
assert.match(files.bindings, /bindingConfigButtonLearnIndicator\.classList\.add\("hidden"\)/, "button learn status row should stay hidden");

const mainMidiIndex = files.html.indexOf('id="binding-config-preview-main-midi"');
const midiValueIndex = files.html.indexOf('id="binding-config-preview-midi-value"');
const buttonLearnIndex = files.html.indexOf('id="binding-config-button-learn-section"');
const muteRowIndex = files.html.indexOf('id="binding-config-preview-mute-row"');
assert.ok(mainMidiIndex >= 0, "main MIDI preview row should exist");
assert.ok(midiValueIndex > mainMidiIndex, "MIDI value should render inside the main MIDI section");
assert.ok(buttonLearnIndex > midiValueIndex, "button learn section should render below the main MIDI value");
assert.ok(buttonLearnIndex > mainMidiIndex, "button learn section should render below main MIDI");
assert.ok(muteRowIndex > buttonLearnIndex, "button learn section should stay in the right summary stack");
assert.match(files.html, /binding-config-preview-summary binding-config-preview-summary--midi/, "main MIDI should have its own summary section");
assert.match(files.html, /binding-config-preview-summary binding-config-preview-summary--status/, "status rows should be separated from the learn section");
assert.doesNotMatch(files.html, /id="binding-config-preview-light-row"/, "button light should not be duplicated in the right summary");
assert.doesNotMatch(`${files.domRefs}\n${files.appEntry}\n${files.bindings}`, /bindingConfigPreviewLight/, "removed light summary should not have stale JS references");

console.log("Binding config UI wiring tests passed");

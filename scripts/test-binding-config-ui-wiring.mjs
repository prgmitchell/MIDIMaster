import { readAppHtml } from "./lib/app_html.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DOM_REF_IDS } from "../src/app/dom_refs.js";
import { readCssBundle } from "./css_bundle.mjs";

const files = {
  html: await readAppHtml(),
  domRefs: await readFile(
    new URL("../src/app/dom_refs.js", import.meta.url),
    "utf8",
  ),
  appEntry: await readFile(
    new URL("../src/app_entry.js", import.meta.url),
    "utf8",
  ),
  bindings: await readFile(
    new URL("../src/features/bindings/bindings.js", import.meta.url),
    "utf8",
  ),
  css: await readCssBundle(
    new URL("../src/styles/bindings/config-panel.css", import.meta.url),
  ),
  tauriConfig: await readFile(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
};
const tauriConfig = JSON.parse(files.tauriConfig);
const mainWindow = tauriConfig.app.windows.find(
  (windowConfig) => windowConfig.label === "main",
);
assert.ok(mainWindow, "main Tauri window config should exist");

const indicatorControls = [
  ["binding-config-indicator-custom", "bindingConfigIndicatorCustom"],
  ["binding-config-indicator-msg-type", "bindingConfigIndicatorMsgType"],
  ["binding-config-indicator-channel", "bindingConfigIndicatorChannel"],
  ["binding-config-indicator-controller", "bindingConfigIndicatorController"],
  ["binding-config-indicator-learn", "bindingConfigIndicatorLearn"],
  ["binding-config-indicator-clear", "bindingConfigIndicatorClear"],
];

const feedbackOutputControls = [
  [
    "binding-config-feedback-output-section",
    "bindingConfigFeedbackOutputSection",
  ],
  [
    "binding-config-feedback-output-custom",
    "bindingConfigFeedbackOutputCustom",
  ],
  ["binding-config-feedback-msg-type", "bindingConfigFeedbackMsgType"],
  ["binding-config-feedback-channel", "bindingConfigFeedbackChannel"],
  ["binding-config-feedback-controller", "bindingConfigFeedbackController"],
  ["binding-config-feedback-learn", "bindingConfigFeedbackLearn"],
  ["binding-config-feedback-clear", "bindingConfigFeedbackClear"],
];

const modifierControls = [
  ["binding-config-modifiers-section", "bindingConfigModifiersSection"],
  ["binding-config-modifiers-list", "bindingConfigModifiersList"],
  ["binding-config-modifier-add", "bindingConfigModifierAdd"],
  ["binding-config-modifier-remove", "bindingConfigModifierRemove"],
  ["binding-config-modifier-menu", "bindingConfigModifierMenu"],
];

for (const [elementId, refName] of [
  ...indicatorControls,
  ...feedbackOutputControls,
  ...modifierControls,
]) {
  assert.match(
    files.html,
    new RegExp(`id="${elementId}"`),
    `${elementId} should exist in index.html`,
  );
  assert.equal(
    DOM_REF_IDS[refName],
    elementId,
    `${refName} should map to the expected DOM element`,
  );
}

assert.doesNotMatch(
  files.html,
  /binding-config-indicator-mode/,
  "indicator output should not use a default/custom mode selector",
);

assert.match(
  files.html,
  /id="binding-config-indicator-custom" class="binding-config-indicator-custom"/,
  "indicator fields should be visible by default",
);
assert.match(
  files.html,
  /id="binding-config-indicator-learn"[^>]*binding-config-icon-button[^>]*aria-label="Learn indicator output"[^>]*>/,
  "indicator learn should be an icon button",
);
assert.match(
  files.html,
  /id="binding-config-indicator-clear"[^>]*binding-config-icon-button[^>]*aria-label="Reset indicator output"[^>]*>/,
  "indicator reset should be an icon button",
);
assert.doesNotMatch(
  files.html,
  /id="binding-config-indicator-clear"[^>]*data-i18n=/,
  "indicator reset icon should not be overwritten by i18n text",
);

assert.match(
  files.html,
  /id="binding-config-button-light-select"[\s\S]*?<option value="Disabled" data-i18n="bindings\.feedbackDisabled">Disabled<\/option>/,
  "button light should expose Disabled in the existing dropdown",
);
assert.match(
  files.html,
  /id="binding-config-feedback-msg-type"[\s\S]*?<option value="Disabled" data-i18n="bindings\.feedbackDisabled">Disabled<\/option>/,
  "fader feedback should expose Disabled in the existing Type dropdown",
);
assert.match(
  files.html,
  /id="binding-config-feedback-msg-type"[\s\S]*?<option value="PitchBend"[^>]*>Pitch Bend<\/option>/,
  "fader feedback output type should include Pitch Bend",
);

assert.match(
  files.html,
  /id="binding-config-outputs-section" class="binding-config-section binding-config-section--outputs hidden"/,
  "fader feedback and LED outputs should share a section",
);
assert.match(
  files.html,
  /id="binding-config-feedback-learn"[^>]*binding-config-icon-button[^>]*aria-label="Learn feedback output"[^>]*>/,
  "fader feedback learn should be an icon button",
);
assert.match(
  files.html,
  /id="binding-config-feedback-clear"[^>]*binding-config-icon-button[^>]*aria-label="Reset feedback output"[^>]*>/,
  "fader feedback reset should be an icon button",
);
assert.match(
  files.css,
  /\.binding-config-indicator-custom\.is-feedback-disabled[\s\S]*?opacity: 0\.5;/s,
  "disabled feedback should dim the existing address UI without changing its layout",
);

assert.match(
  files.css,
  /\.binding-config-panel--fader:not\(\.binding-config-panel--macro-page\) \.binding-config-preview-learn-indicator\s*\{\s*display: none;/,
  "fader learn status row should stay hidden",
);
assert.match(
  files.css,
  /"name live"[\s\S]*?"curve live"[\s\S]*?"outputs modifiers"/,
  "fader layout follows the two-column mockup",
);
assert.doesNotMatch(
  files.css,
  /#binding-config-panel\.binding-config-panel--fader:not\(\.binding-config-panel--macro-page\)\s*\{[\s\S]*?align-items: flex-start;/,
  "fader config should use the centered modal positioning shared by button config",
);
assert.equal(
  mainWindow.height,
  820,
  "main window should open tall enough for the fader configuration",
);
assert.equal(
  mainWindow.minHeight,
  820,
  "main window minimum height should prevent cramped fader configuration layouts",
);
assert.match(
  files.css,
  /\.binding-config-panel--fader:not\(\.binding-config-panel--macro-page\) \.binding-config-content\s*\{[\s\S]*?height: min\(780px, calc\(100vh - 20px\)\);[\s\S]*?max-height: calc\(100vh - 20px\);/,
  "fader config should keep a stable centered modal height while respecting short windows",
);
assert.match(
  files.css,
  /\.binding-config-panel--fader:not\(\.binding-config-panel--macro-page\) \.binding-config-body\s*\{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto;/,
  "fader config body should scroll before overlapping the footer",
);
assert.match(
  files.css,
  /\.binding-config-panel--fader:not\(\.binding-config-panel--macro-page\) \.binding-config-preview-card\s*\{[\s\S]*?align-self: stretch;[\s\S]*?height: auto;[\s\S]*?min-height: 0;/,
  "fader live preview should fit its grid area without imposing an oversized minimum",
);
assert.match(
  files.css,
  /\.binding-config-modifiers-list[^}]*overflow-y: auto;/,
  "modifiers scroll within their panel",
);
assert.match(
  files.css,
  /\.binding-config-content\s*{\s*width: min\(1160px, 96vw\);/,
  "dialog width is unchanged",
);
assert.match(
  files.css,
  /\.binding-config-preview-shell\s*\{[\s\S]*?grid-template-rows: auto auto;[\s\S]*?flex: 0 1 auto;[\s\S]*?background: transparent;/,
  "fader right wrapper should be unframed and content-sized",
);

const mainMidiIndex = files.html.indexOf(
  'id="binding-config-preview-main-midi"',
);
const midiValueIndex = files.html.indexOf(
  'id="binding-config-preview-midi-value"',
);
const buttonLearnIndex = files.html.indexOf(
  'id="binding-config-button-learn-section"',
);
const muteRowIndex = files.html.indexOf('id="binding-config-preview-mute-row"');
assert.ok(mainMidiIndex >= 0, "main MIDI preview row should exist");
assert.ok(
  midiValueIndex > mainMidiIndex,
  "MIDI value should render inside the main MIDI section",
);
assert.ok(
  buttonLearnIndex > midiValueIndex,
  "button learn section should render below the main MIDI value",
);
assert.ok(
  buttonLearnIndex > mainMidiIndex,
  "button learn section should render below main MIDI",
);
assert.equal(muteRowIndex, -1, "duplicate mute summary should be removed");
assert.match(
  files.html,
  /binding-config-preview-summary binding-config-preview-summary--midi/,
  "main MIDI should have its own summary section",
);
assert.doesNotMatch(
  files.html,
  /binding-config-preview-summary binding-config-preview-summary--status/,
  "duplicate status summaries should be removed",
);
assert.doesNotMatch(
  files.html,
  /id="binding-config-preview-light-row"/,
  "button light should not be duplicated in the right summary",
);

console.log("Binding config UI wiring tests passed");

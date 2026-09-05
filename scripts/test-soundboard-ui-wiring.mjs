import { readAppHtml } from "./lib/app_html.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DOM_REF_IDS } from "../src/app/dom_refs.js";
import { readCssBundle } from "./css_bundle.mjs";

const [html, domRefs, bindings, targets, tableCss, configCss, controlsCss] = await Promise.all([
  readAppHtml(),
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

assert.match(
  html,
  /soundboard-waveform-empty[\s\S]*?data-i18n="soundboard\.noFile"/,
  "the existing waveform should have an in-place empty placeholder",
);
assert.doesNotMatch(
  html,
  /binding-config-soundboard-summary|binding-config-soundboard-edit/,
  "normal Button Configuration should not include a redundant Soundboard card",
);

assert.match(
  configCss,
  /binding-config-section--soundboard\.is-empty \.soundboard-waveform-empty[\s\S]*?display: flex/,
  "the in-place waveform placeholder should appear before a file is selected",
);
assert.doesNotMatch(
  configCss,
  /is-empty > :not\(\.soundboard-file-row\)/,
  "the empty state should keep the existing editor visible",
);

assert.match(
  configCss,
  /soundboard-route-option\.is-unavailable[\s\S]*?opacity:\s*\.52/,
  "the unavailable virtual microphone route should look disabled",
);

assert.match(
  configCss,
  /binding-config-panel--button\.binding-config-panel--soundboard-page[\s\S]*?width: min\(500px/,
  "the Soundboard modal should override the wider button layout",
);

assert.match(
  configCss,
  /webkit-slider-runnable-track[\s\S]*?var\(--slider-fill\) 0 var\(--range-fill\)[\s\S]*?var\(--slider-track\) var\(--range-fill\) 100%/,
  "Soundboard range tracks should render their progress fill at exact endpoints",
);
assert.match(
  controlsCss,
  /\.binding-volume-slider\s*\{[^}]*background-size:\s*var\(--range-fill, 0%\) 100%/,
  "binding value sliders should render their calculated progress fill",
);
assert.match(
  controlsCss,
  /body\.dark-mode \.binding-row input\.binding-volume-slider\s*\{[^}]*background-size:\s*var\(--range-fill, 0%\) 100%/,
  "dark binding value sliders should preserve their calculated progress fill",
);
assert.match(
  tableCss,
  /binding-volume-slider::\-webkit-slider-runnable-track\s*\{[^}]*var\(--slider-fill\) 0 var\(--range-fill, 0%\)[^}]*var\(--slider-track\) var\(--range-fill, 0%\) 100%/,
  "binding value tracks should explicitly split filled and unfilled colors in every theme",
);
assert.match(
  configCss,
  /--soundboard-waveform-background: var\(--surface-subtle\)[\s\S]*?--soundboard-waveform-color:[^;]*var\(--accent\)/,
  "the waveform should use active theme tokens",
);
assert.match(
  configCss,
  /soundboard-transport-button[\s\S]*?color: var\(--accent\)[\s\S]*?background: var\(--accent-soft\)/,
  "the preview transport should use active theme tokens",
);

const fileRowIndex = html.indexOf('<div class="soundboard-file-row">');
const transportIndex = html.indexOf('<div class="soundboard-transport">', fileRowIndex);
const pickSoundIndex = html.indexOf('id="binding-config-soundboard-replace"', fileRowIndex);
const waveformIndex = html.indexOf('<div class="soundboard-waveform-shell">', fileRowIndex);
assert.ok(
  fileRowIndex >= 0 &&
    transportIndex > fileRowIndex &&
    pickSoundIndex > transportIndex &&
    waveformIndex > pickSoundIndex,
  "preview transport should sit between the filename and Pick Sound in the file row",
);
assert.match(
  html,
  /data-i18n="soundboard\.pickSound">Pick Sound</,
  "the file action should use the Pick Sound label",
);
assert.match(tableCss, /binding-value-cell--soundboard/, "the Volume column should lay out Edit Sound");

console.log("Soundboard UI wiring tests passed");

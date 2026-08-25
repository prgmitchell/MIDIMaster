import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DOM_REF_IDS } from "../src/app/dom_refs.js";
import { readCssBundle } from "./css_bundle.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [html, domRefs, settings, profiles, osd, osdEntry, css, rustSettings, runtime, aux, commands] = await Promise.all([
  read("../src/index.html"),
  read("../src/app/dom_refs.js"),
  read("../src/features/settings/settings.js"),
  read("../src/features/profiles/profiles.js"),
  read("../src/features/osd/osd.js"),
  read("../src/osd_entry.js"),
  readCssBundle(new URL("../src/styles/settings.css", import.meta.url)),
  read("../src-tauri/src/commands/settings.rs"),
  read("../src-tauri/src/runtime_midi.rs"),
  read("../src-tauri/src/runtime_midi/aux_controls.rs"),
  read("../src-tauri/src/commands/bindings.rs"),
]);

assert.match(html, /id="osd-label-mode"[\s\S]*?value="target"[\s\S]*?value="binding"/);
assert.match(html, /data-i18n="settings\.general">General<[\s\S]*?data-i18n="settings\.enabled">Enabled<[\s\S]*?id="osd-enabled"[\s\S]*?data-i18n="settings\.monitor">Monitor<[\s\S]*?id="osd-monitor"/);
assert.equal(DOM_REF_IDS.osdLabelModeSelect, "osd-label-mode");
assert.match(settings, /renderSettingsSelectDropdown\(d\.osdLabelModeSelect\)/, "label mode should use the styled settings dropdown");
assert.match(settings, /showBindingName: d\.osdLabelModeSelect\.value === "binding"/);
assert.match(settings, /showBindingName: Boolean\(settings\.show_binding_name/);
assert.match(profiles, /show_binding_name: Boolean\(current\.showBindingName/);
assert.match(osdEntry, /showBindingName: Boolean\(value\.show_binding_name/);
assert.match(css, /\.settings-monitor-control\s*\{[\s\S]*?grid-template-columns:[^;]+;/);
assert.match(css, /\.settings-osd-enabled-control\s*\{[\s\S]*?grid-template-rows: 14px 40px;/, "the enabled label should sit above its toggle");
assert.match(css, /\.settings-monitor-control\s*\{[\s\S]*?grid-template-columns: 55px minmax\(0, 1fr\) 33\.333333%;[\s\S]*?gap: 0;/, "monitor should begin at the Glass segment while displayed name stays aligned with the third appearance column");
assert.match(css, /\.settings-osd-monitor-select-control,[\s\S]*?\.settings-osd-label-control\s*\{[\s\S]*?padding-left: 16px;/, "general controls should use the same column spacing as appearance");
assert.match(css, /\.settings-osd-monitor-select-control,[\s\S]*?\.settings-osd-label-control\s*\{[\s\S]*?grid-template-rows: 14px 40px;/, "dropdown labels should sit above their controls");

assert.match(osd, /if \(bindingId\) return `::binding::\$\{bindingId\}`;/);
assert.match(osd, /payload\.binding_primary_target \|\| payload\.target/);
assert.match(osd, /label: bindingName/);
assert.match(osd, /eventTargetKey !== primaryTargetKey\) return;/, "secondary target events should collapse into the primary binding card");

assert.match(rustSettings, /show_binding_name: bool/);
for (const source of [runtime, aux, commands]) {
  assert.match(source, /"binding_name"/);
  assert.match(source, /"binding_primary_target"/);
}

console.log("OSD binding-name tests passed");

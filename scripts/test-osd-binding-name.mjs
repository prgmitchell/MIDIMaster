import { readAppHtml } from "./lib/app_html.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DOM_REF_IDS } from "../src/app/dom_refs.js";
import { readCssBundle } from "./css_bundle.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [html, domRefs, settings, profiles, osd, osdEntry, css, rustSettings, runtime, aux, commands] =
  await Promise.all([
    readAppHtml(),
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

assert.equal(DOM_REF_IDS.osdLabelModeSelect, "osd-label-mode");

assert.match(osd, /if \(bindingId\) return `::binding::\$\{bindingId\}`;/);
assert.match(osd, /payload\.binding_primary_target \|\| payload\.target/);
assert.match(osd, /label: bindingName/);
assert.match(
  osd,
  /eventTargetKey !== primaryTargetKey\) return;/,
  "secondary target events should collapse into the primary binding card",
);

assert.match(rustSettings, /show_binding_name: bool/);
// Payload metadata is exercised by Rust binding_events tests and the settings workflow test.

console.log("OSD binding-name tests passed");

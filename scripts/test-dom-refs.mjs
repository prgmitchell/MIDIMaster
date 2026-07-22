import assert from "node:assert/strict";
import { createDomRefs } from "../src/app/dom_refs.js";

globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};

const dom = createDomRefs();
assert.ok(dom.shell && dom.bindings && dom.targets && dom.midi);
assert.ok(dom.profiles && dom.settings && dom.connections && dom.alerts);
assert.equal(dom.shell.sessionsContainer, null);
assert.equal(dom.shell.sidebarCollapseToggle, null);
assert.equal(dom.bindings.bindingConfigPanel, null);
assert.ok(Object.hasOwn(dom.bindings, "learnPanel"), "bindings should receive the shared learn panel used for hotkey capture");
assert.ok(Object.hasOwn(dom.bindings, "learnPanelMessage"), "bindings should receive the shared learn panel copy");
assert.ok(Object.hasOwn(dom.midi, "learnPanel"), "MIDI learning should retain access to the shared learn panel");

console.log("DOM reference namespace tests passed");

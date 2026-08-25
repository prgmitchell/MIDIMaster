import assert from "node:assert/strict";
import { createDomRefs, DOM_REF_IDS } from "../src/app/dom_refs.js";

const requestedIds = [];
const sentinel = { id: "binding-config-panel" };
const documentSource = {
  getElementById: (id) => {
    requestedIds.push(id);
    return id === sentinel.id ? sentinel : null;
  },
  querySelector: () => null,
  querySelectorAll: () => [],
};

const dom = createDomRefs(documentSource);
assert.ok(dom.shell && dom.bindings && dom.targets && dom.midi);
assert.ok(dom.profiles && dom.settings && dom.connections && dom.alerts);
assert.equal(dom.shell.sessionsContainer, null);
assert.equal(dom.shell.sidebarCollapseToggle, null);
assert.equal(dom.bindings.bindingConfigPanel, sentinel);
assert.ok(Object.hasOwn(dom.bindings, "learnPanel"), "bindings should receive the shared learn panel used for hotkey capture");
assert.ok(Object.hasOwn(dom.bindings, "learnPanelMessage"), "bindings should receive the shared learn panel copy");
assert.ok(Object.hasOwn(dom.midi, "learnPanel"), "MIDI learning should retain access to the shared learn panel");
assert.equal(new Set(Object.values(DOM_REF_IDS)).size, Object.keys(DOM_REF_IDS).length, "DOM IDs should not be registered twice");
assert.deepEqual(requestedIds, Object.values(DOM_REF_IDS), "each declared DOM reference should be queried once");

console.log("DOM reference namespace tests passed");

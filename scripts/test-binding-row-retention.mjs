import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAppDom } from "./lib/dom_fixture.mjs";
import { createDomRefs } from "../src/app/dom_refs.js";
import { createBindingsFeature } from "../src/features/bindings/bindings.js";
import { createTargetsFeature } from "../src/features/targets/targets.js";
import { normalizeBinding } from "../src/core/binding_model.js";

if (typeof globalThis.gc !== "function") {
  const child = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url)], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit",
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const settle = () => new Promise(resolve => setImmediate(resolve));

async function assertDiscardedRowsCollect({ retainAnchor }) {
  const { document, flushFrames } = await createAppDom();
  const dom = createDomRefs();
  const rowsPerGeneration = 50;
  const generations = 8;
  let bindings = Array.from({ length: rowsPerGeneration }, (_, index) => normalizeBinding({
    id: `retention-${index}`, name: `Binding ${index}`, targets: ["Master"],
    control_kind: index % 2 ? "Continuous" : "Button", action: index % 2 ? "Volume" : "ToggleMute",
    device_id: "controller", control: { channel: 1, controller: index, msg_type: "ControlChange" },
  }));
  const targets = createTargetsFeature({
    dom: dom.targets, invoke: async () => null,
    resolveOsdTarget: () => ({ label: "Master", icon_kind: "master" }),
  });
  const feature = createBindingsFeature({
    dom: dom.bindings, invoke: async () => null,
    getBindings: () => bindings, setBindings: value => { bindings = value; },
    bindingLastValues: {}, bindingMuteValues: {}, bindingInteractionTimes: {},
    buildTargetSelect: targets.buildTargetSelect, createTargetIcon: targets.createTargetIcon,
  });
  const historicalRows = [];
  try {
    feature.bindUi();
    feature.renderBindings();
    flushFrames();
    const anchor = retainAnchor ? feature.getRenderedBindingRefs(bindings[0].id).item : null;
    for (let generation = 0; generation < generations; generation++) {
      historicalRows.push(bindings.slice(retainAnchor ? 1 : 0)
        .map(binding => new WeakRef(feature.getRenderedBindingRefs(binding.id).item)));
      bindings = retainAnchor
        ? [bindings[0], ...structuredClone(bindings.slice(1))]
        : structuredClone(bindings);
      feature.renderBindings();
      flushFrames();
    }
    // WeakRef targets survive their creation job. Cross event-loop turns before
    // collecting; do not dereference historical rows during the GC attempts.
    for (let attempt = 0; attempt < 12; attempt++) {
      await settle();
      globalThis.gc();
    }
    const retainedCounts = historicalRows.map(rows => rows.filter(row => row.deref() !== undefined).length);
    assert.deepEqual(retainedCounts, Array(generations).fill(0),
      retainAnchor ? "a reused row must not retain replaced sibling generations"
        : "current row handlers must not retain previous profile generations");
    // Keep the complete feature, final DOM and index alive throughout the probe;
    // disposal or clearing the whole list would make collection a vacuous pass.
    assert.equal(dom.bindings.bindingsContainer.querySelectorAll(".binding-item").length, rowsPerGeneration);
    for (const binding of bindings) {
      const row = feature.getRenderedBindingRefs(binding.id)?.item;
      assert.ok(row?.isConnected);
      assert.equal(row, document.querySelector(`[data-binding-id="${binding.id}"]`));
    }
    if (anchor) assert.equal(feature.getRenderedBindingRefs(bindings[0].id).item, anchor);
    feature.beginBindingEdit(bindings[1].id);
    assert.equal(dom.bindings.bindingConfigName.value, bindings[1].name);
    dom.bindings.bindingConfigCancel.click();
    await settle();
    assert.equal(dom.bindings.bindingConfigPanel.classList.contains("hidden"), true);
  } finally {
    feature.dispose();
    targets.dispose();
  }
}

await assertDiscardedRowsCollect({ retainAnchor: false });
await assertDiscardedRowsCollect({ retainAnchor: true });
console.log("Binding row retention tests passed for profile replacement and partial row reuse");

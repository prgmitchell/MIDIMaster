import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBindingsFeature } from "../src/features/bindings/bindings.js";

const htmlSource = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../src/styles/bindings/table.css", import.meta.url), "utf8");
const profileCssSource = await readFile(new URL("../src/styles/profiles.css", import.meta.url), "utf8");
const appEntrySource = await readFile(new URL("../src/app_entry.js", import.meta.url), "utf8");

function densityMarkup() {
  const match = htmlSource.match(/<div id="binding-density-toggle"[\s\S]*?<\/div>/);
  assert.ok(match, "binding density toggle should exist in the toolbar");
  return match[0];
}

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  toggle(name, force) {
    if (force) this.values.add(name);
    else this.values.delete(name);
  }
}

function fakeDensityButton(density, selected) {
  const listeners = new Map();
  const attributes = new Map([["aria-pressed", selected ? "true" : "false"]]);
  return {
    dataset: { density },
    classList: new FakeClassList(selected ? ["selected"] : []),
    addEventListener: (name, listener) => listeners.set(name, listener),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    click: () => listeners.get("click")?.({ preventDefault() {}, stopPropagation() {} }),
  };
}

function createHarness(invoke) {
  const comfortableButton = fakeDensityButton("comfortable", true);
  const compactButton = fakeDensityButton("compact", false);
  const buttons = [comfortableButton, compactButton];
  const mainScreen = { dataset: {} };
  const bindingDensityToggle = { querySelectorAll: () => buttons };
  const bindingsContainer = { closest: () => null };
  globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
  globalThis.document = { addEventListener() {}, activeElement: null };
  globalThis.requestAnimationFrame = () => 1;

  const alerts = [];
  const feature = createBindingsFeature({
    invoke,
    dom: {
      bindingsContainer,
      bindingDensityToggle,
      mainScreen,
    },
    getBindings: () => [],
    setBindings: () => {},
    i18n: { t: (key) => key },
    showAlert: (...args) => alerts.push(args),
  });
  return { feature, alerts, mainScreen, comfortableButton, compactButton };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

assert.match(densityMarkup(), /data-density="comfortable"[^>]*aria-pressed="true"/);
assert.match(densityMarkup(), /data-density="compact"[^>]*aria-pressed="false"/);
assert.match(densityMarkup(), /data-i18n-aria-label="bindings\.comfortableView"/);
assert.match(densityMarkup(), /data-i18n-aria-label="bindings\.compactView"/);
assert.match(cssSource, /\[data-bindings-density="compact"\] \.binding-row\s*\{\s*min-height: 45px;/);
assert.match(cssSource, /\[data-bindings-density="compact"\][\s\S]*?min-height: 30px;[\s\S]*?height: 30px;/);
assert.match(cssSource, /\.binding-row\s*\{[\s\S]*?transition: min-height var\(--motion-normal, 180ms\) cubic-bezier/);
assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration: 0ms;/);
assert.match(profileCssSource, /\.bindings-toolbar\s*\{[\s\S]*?grid-template-columns: auto minmax\(0, 1fr\) auto auto;/);
assert.match(profileCssSource, /\.binding-add-button\s*\{\s*grid-column: 3;[\s\S]*?\.binding-density-toggle\s*\{\s*grid-column: 4;/);
assert.match(appEntrySource, /compactBindings: Boolean\(settings\.compact_bindings \?\? settings\.compactBindings\)/);

{
  const calls = [];
  const { feature, mainScreen, comfortableButton, compactButton } = createHarness(async (command, args) => {
    calls.push([command, args]);
    return args.compactBindings;
  });

  assert.equal(mainScreen.dataset.bindingsDensity, "comfortable");
  await feature.setCompactBindings(true);
  assert.equal(mainScreen.dataset.bindingsDensity, "compact");
  assert.equal(calls.length, 0, "startup hydration should not persist the setting again");

  await feature.setCompactBindings(false);
  compactButton.click();
  await settle();
  assert.deepEqual(calls, [["set_compact_bindings", { compactBindings: true }]]);
  assert.equal(mainScreen.dataset.bindingsDensity, "compact");
  assert.equal(compactButton.getAttribute("aria-pressed"), "true");
  assert.equal(comfortableButton.getAttribute("aria-pressed"), "false");
}

{
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const { alerts, mainScreen, comfortableButton, compactButton } = createHarness(async () => {
      throw new Error("save failed");
    });
    compactButton.click();
    await settle();
    assert.equal(mainScreen.dataset.bindingsDensity, "comfortable");
    assert.equal(comfortableButton.getAttribute("aria-pressed"), "true");
    assert.equal(alerts.length, 1, "failed persistence should notify the user");
  } finally {
    console.error = originalConsoleError;
  }
}

console.log("Binding density tests passed");

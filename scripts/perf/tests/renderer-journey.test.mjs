import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { armRendererJourney } from "../lib/renderer-journey.mjs";
import { createAppDom } from "../../lib/dom_fixture.mjs";
import { createDomRefs } from "../../../src/app/dom_refs.js";
import { createBindingsFeature } from "../../../src/features/bindings/bindings.js";
import { createProfilesFeature } from "../../../src/features/profiles/profiles.js";
import { normalizeBinding } from "../../../src/core/binding_model.js";

test("renderer journeys exclude setup/driver waits and wait for observable results", () => {
  const { document, window } = parseHTML(
    '<html><body><input id="search"><div id="result" hidden></div></body></html>',
  );
  let now = 1000;
  let mutation;
  let timeout;
  let disconnected = 0;
  let id = 0;
  const frames = new Map();
  const environment = {
    document,
    performance: { now: () => now },
    MutationObserver: class {
      constructor(callback) {
        mutation = callback;
      }
      observe() {}
      disconnect() {
        disconnected++;
      }
    },
    getComputedStyle: () => ({ display: "block" }),
    requestAnimationFrame(callback) {
      frames.set(++id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout(callback) {
      timeout = callback;
      return 1;
    },
    clearTimeout() {
      timeout = null;
    },
  };
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  };
  const contract = {
    id: "search",
    metric: "interaction.search",
    start: { event: "input", selector: "#search", value: "final" },
    completion: [{ kind: "visible", selector: "#result" }],
  };
  armRendererJourney(contract, environment);
  const input = document.querySelector("input");
  now = 9000;
  input.value = "partial";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(frames.size, 0);
  now = 10000;
  input.value = "final";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  now = 10016;
  flush();
  assert.equal(environment.__MIDIMASTER_JOURNEY__.result, null);
  document.querySelector("#result").removeAttribute("hidden");
  mutation();
  now = 10032;
  flush();
  assert.equal(environment.__MIDIMASTER_JOURNEY__.result, null);
  now = 10048;
  flush();
  assert.equal(environment.__MIDIMASTER_JOURNEY__.result.durationMs, 48);
  assert.equal(timeout, null);
  assert.equal(disconnected, 1);
  armRendererJourney(contract, environment);
  timeout();
  assert.match(environment.__MIDIMASTER_JOURNEY__.error, /expected result/);
  assert.equal(frames.size, 0);
});

test("configure and save contracts observe the real binding editor result", async () => {
  const renderer = JSON.parse(
    await readFile(new URL("../config/renderer-journeys.json", import.meta.url), "utf8"),
  );
  const installed = JSON.parse(
    await readFile(new URL("../config/installed-journeys.json", import.meta.url), "utf8"),
  );
  const { document, window, flushFrames } = await createAppDom();
  const dom = createDomRefs();
  let bindings = [normalizeBinding({ id: "perf-binding-0", name: "Initial", targets: ["Master"] })];
  const feature = createBindingsFeature({
    invoke: async () => {},
    dom: dom.bindings,
    getBindings: () => bindings,
    setBindings: (next) => {
      bindings = next;
    },
    bindingLastValues: {},
    bindingMuteValues: {},
    bindingInteractionTimes: {},
  });
  let now = 0;
  const environment = {
    document,
    performance: { now: () => now },
    MutationObserver: window.MutationObserver,
    getComputedStyle: () => ({ display: "block" }),
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    setTimeout,
    clearTimeout,
  };
  const paint = () => {
    now += 16;
    flushFrames();
  };
  try {
    feature.bindUi();
    feature.renderBindings();
    armRendererJourney(
      { ...renderer["configure-binding"], id: "configure-binding", metric: "interaction.configure" },
      environment,
    );
    // Execute the real configured steps before any frame. Cleanup must not
    // close the editor while its two-frame result check is still pending.
    for (const step of installed.journeys.find(({ id }) => id === "configure-binding").steps) {
      if (step.action === "click") document.querySelector(step.selector).click();
      else if (step.action === "wait-visible")
        assert.equal(document.querySelector(step.selector).classList.contains("hidden"), false);
      else throw new Error(`Unexpected configure step: ${step.action}`);
    }
    paint();
    paint();
    assert.ok(
      environment.__MIDIMASTER_JOURNEY__.result,
      "configuration remains open through its render checkpoint",
    );

    armRendererJourney(
      { ...renderer["edit-save"], id: "edit-save", metric: "storage.profile_save" },
      environment,
    );
    dom.bindings.bindingConfigName.value = "Performance binding edited";
    dom.bindings.bindingConfigName.dispatchEvent(new window.Event("input"));
    dom.bindings.bindingConfigSave.click();
    await new Promise((resolve) => setImmediate(resolve));
    paint();
    paint();
    assert.equal(
      document.querySelector(".binding-name-input"),
      null,
      "config save returns to the name label",
    );
    assert.equal(bindings[0].name, "Performance binding edited");
    assert.ok(
      environment.__MIDIMASTER_JOURNEY__.result,
      "save contract accepts the persisted row and closed modal",
    );
  } finally {
    environment.__MIDIMASTER_JOURNEY__?.cancel();
    feature.dispose();
  }
});

test("profile switch contract selects the profile button after the async menu refresh", async () => {
  const renderer = JSON.parse(
    await readFile(new URL("../config/renderer-journeys.json", import.meta.url), "utf8"),
  );
  const installed = JSON.parse(
    await readFile(new URL("../config/installed-journeys.json", import.meta.url), "utf8"),
  );
  const { document, window, flushFrames } = await createAppDom();
  const dom = createDomRefs();
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const profiles = ["Default", "Performance Default", "Performance 2"].map((name) => ({
    name,
    bindings: [{ id: "perf-binding-0", name: `${name} binding`, targets: ["Master"] }],
  }));
  let active = "Performance Default";
  let bindings = profiles[1].bindings.map(normalizeBinding);
  let finishListing;
  const listing = new Promise((resolve) => {
    finishListing = resolve;
  });
  let finishMidiSync;
  const midiSync = new Promise((resolve) => {
    finishMidiSync = resolve;
  });
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "list_profiles") return listing;
    if (command === "load_profile") return structuredClone(profiles.find(({ name }) => name === args.name));
  };
  const bindingFeature = createBindingsFeature({
    invoke,
    dom: dom.bindings,
    getBindings: () => bindings,
    setBindings: (next) => {
      bindings = next;
    },
    bindingLastValues: {},
    bindingMuteValues: {},
    bindingInteractionTimes: {},
  });
  const profileFeature = createProfilesFeature({
    invoke,
    dom: dom.profiles,
    getActiveProfileName: () => active,
    setActiveProfileName: (next) => {
      active = next;
    },
    getBindings: () => bindings,
    setBindings: (next) => {
      bindings = next;
    },
    normalizeBinding,
    renderBindings: bindingFeature.renderBindings,
    onProfileLoaded: () => midiSync,
  });
  let now = 0;
  const environment = {
    document,
    performance: { now: () => now },
    MutationObserver: window.MutationObserver,
    getComputedStyle: () => ({ display: "block" }),
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    setTimeout,
    clearTimeout,
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    bindingFeature.renderBindings();
    profileFeature.bindUi();
    profileFeature.setProfileSelection(active);
    armRendererJourney(
      { ...renderer["profile-switch"], id: "profile-switch", metric: "interaction.profile_switch" },
      environment,
    );
    const steps = installed.journeys.find(({ id }) => id === "profile-switch").steps;
    for (const step of steps) {
      const element = step.selector ? document.querySelector(step.selector) : null;
      if (step.action === "click") {
        assert.ok(element, `journey target exists: ${step.selector}`);
        if (step.selector !== "#profile-toggle") {
          assert.equal(element.tagName, "BUTTON", "selection must hit the actual button listener");
          assert.equal(element.matches(renderer["profile-switch"].start.selector), true);
        }
        element.click();
        await settle();
      } else if (step.action === "wait-visible") {
        assert.equal(element.classList.contains("hidden"), true, "opening awaits list_profiles");
        assert.equal(environment.__MIDIMASTER_JOURNEY__.result, null);
        finishListing(profiles);
        await settle();
        assert.equal(element.classList.contains("hidden"), false);
      } else if (step.action === "wait-text") {
        assert.equal(element.textContent, step.value);
        now += 16;
        flushFrames();
        now += 16;
        flushFrames();
        assert.equal(
          environment.__MIDIMASTER_JOURNEY__.result,
          null,
          "label alone precedes MIDI sync and menu closure",
        );
      } else if (step.action === "wait-hidden") {
        finishMidiSync();
        await settle();
        assert.equal(element.classList.contains("hidden"), true);
      } else if (step.action === "next-frame") {
        now += 16;
        flushFrames();
      } else throw new Error(`Unexpected profile step: ${step.action}`);
    }
    now += 16;
    flushFrames();
    assert.equal(active, "Performance 2");
    assert.deepEqual(
      calls.filter(({ command }) => command === "load_profile"),
      [{ command: "load_profile", args: { name: "Performance 2" } }],
    );
    assert.equal(
      calls.some(({ command }) => command === "delete_profile"),
      false,
    );
    assert.equal(document.querySelector(".binding-name").textContent, "Performance 2 binding");
    assert.equal(dom.profiles.profileList.classList.contains("hidden"), true);
    assert.ok(environment.__MIDIMASTER_JOURNEY__.result, "the measured click reaches the rendered profile");
  } finally {
    environment.__MIDIMASTER_JOURNEY__?.cancel();
    bindingFeature.dispose();
    await profileFeature.dispose();
  }
});

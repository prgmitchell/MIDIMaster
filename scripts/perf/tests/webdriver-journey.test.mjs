import assert from "node:assert/strict";
import test from "node:test";
import { createJourneyUi } from "../webdriver/journey-ui.mjs";
import { createAppDom } from "../../lib/dom_fixture.mjs";
import { createDomRefs } from "../../../src/app/dom_refs.js";
import { createBindingsFeature } from "../../../src/features/bindings/bindings.js";
import { createProfilesFeature } from "../../../src/features/profiles/profiles.js";
import { normalizeBinding } from "../../../src/core/binding_model.js";

test("WebDriver setup cancels edits, resets filters, and restores a real source profile and density", async () => {
  const { document, window, flushFrames } = await createAppDom();
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const dom = createDomRefs();
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const profileBindings = [
    normalizeBinding({ id: "perf-binding-0", name: "Music", targets: ["Master"] }),
    normalizeBinding({
      id: "perf-binding-1",
      name: "Mute",
      targets: ["Master"],
      control_kind: "Button",
      action: "ToggleMute",
    }),
  ];
  const profiles = ["Default", "Performance Default", "Performance 2"].map((name) => ({
    name,
    bindings: profileBindings,
  }));
  let bindings = structuredClone(profileBindings);
  let active = "Performance 2";
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "list_profiles") return profiles;
    if (command === "load_profile") return structuredClone(profiles.find(({ name }) => name === args.name));
    if (command === "set_compact_bindings") return args.compactBindings;
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
  });
  const visible = (element) => Boolean(element && !element.closest(".hidden,[hidden]"));
  async function until(predicate) {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await predicate()) return;
      await settle();
      flushFrames();
    }
    throw new Error("Mock WebDriver wait did not reach its expected state");
  }
  const select = async (selector) => {
    const node = () => document.querySelector(selector);
    return {
      isDisplayed: async () => visible(node()),
      waitForDisplayed: ({ reverse = false } = {}) => until(() => visible(node()) !== reverse),
      waitForClickable: () =>
        until(
          () =>
            visible(node()) &&
            !node().disabled &&
            (!visible(dom.bindings.bindingConfigPanel) || dom.bindings.bindingConfigPanel.contains(node())),
        ),
      waitForEnabled: () => until(() => node() && !node().disabled),
      click: async () => node().click(),
      getText: async () => node().textContent,
      getAttribute: async (name) => node().getAttribute(name),
      // Deliberately omit input dispatch, as a clear-only setup is insufficient.
      clearValue: async () => {
        node().value = "";
      },
      setValue: async (value) => {
        node().value = value;
        node().dispatchEvent(new window.Event("input", { bubbles: true }));
      },
    };
  };
  const browser = {
    waitUntil: until,
    execute: async (callback) => callback(),
    executeAsync: (callback) =>
      new Promise((resolve) => {
        callback(resolve);
        flushFrames();
      }),
  };
  const ui = createJourneyUi({ browser, select });
  try {
    bindingFeature.bindUi();
    profileFeature.bindUi();
    profileFeature.setProfileSelection(active);
    bindingFeature.renderBindings();
    bindingFeature.beginBindingEdit("perf-binding-0");
    dom.bindings.bindingConfigName.value = "Unsaved";
    dom.bindings.bindingConfigName.dispatchEvent(new window.Event("input"));
    dom.bindings.bindingSearchInput.value = "Mute";
    dom.bindings.bindingSearchInput.dispatchEvent(new window.Event("input"));
    dom.bindings.bindingTypeFilter.querySelector("[data-filter='buttons']").click();
    await bindingFeature.setCompactBindings(true);
    assert.equal(document.querySelectorAll("#bindings .binding-item").length, 1);

    await ui.resetJourneyUi("profile-switch");
    assert.equal(dom.bindings.bindingConfigPanel.classList.contains("hidden"), true);
    assert.equal(dom.bindings.bindingSearchInput.value, "");
    assert.equal(document.querySelectorAll("#bindings .binding-item").length, 2);
    assert.equal(
      dom.bindings.bindingTypeFilter.querySelector("[data-filter='all']").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(active, "Performance Default");
    assert.equal(dom.profiles.profileList.classList.contains("hidden"), true);
    assert.equal(bindings[0].name, "Music", "setup cancels the existing draft before switching profiles");
    assert.equal(
      calls.some(({ command }) => command === "add_binding"),
      false,
    );

    await ui.resetJourneyUi("density");
    assert.equal(dom.bindings.mainScreen.dataset.bindingsDensity, "comfortable");
    assert.ok(calls.some(({ command, args }) => command === "set_compact_bindings" && !args.compactBindings));
  } finally {
    bindingFeature.dispose();
    await profileFeature.dispose();
  }
});

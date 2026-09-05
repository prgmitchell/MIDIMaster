import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createCdpJourneyUi } from "../lib/cdp-journey-ui.mjs";
import { createAppDom } from "../../lib/dom_fixture.mjs";
import { createDomRefs } from "../../../src/app/dom_refs.js";
import { createBindingsFeature } from "../../../src/features/bindings/bindings.js";
import { normalizeBinding } from "../../../src/core/binding_model.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function fixture() {
  const { document, window, flushFrames } = await createAppDom();
  const dom = createDomRefs();
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest(".hidden,[hidden]") ? [] : [{}];
  };
  let bindings = [normalizeBinding({ id: "perf-binding-0", name: "Music", targets: ["Master"] })];
  let pendingStop = null;
  const calls = [];
  const feature = createBindingsFeature({
    dom: dom.bindings,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "stop_soundboard_preview") return pendingStop;
      if (command === "set_compact_bindings") return args.compactBindings;
    },
    getBindings: () => bindings,
    setBindings: (next) => {
      bindings = next;
    },
    bindingLastValues: {},
    bindingMuteValues: {},
    bindingInteractionTimes: {},
  });
  feature.bindUi();
  feature.renderBindings();
  let cancelClicks = 0;
  let navigationClicks = 0;
  dom.bindings.bindingConfigCancel.addEventListener("click", () => {
    cancelClicks++;
  });
  document.querySelector("[data-page='bindings']").addEventListener("click", () => {
    navigationClicks++;
  });
  const session = {};
  const environment = {
    document,
    window,
    Event: window.Event,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    requestAnimationFrame: globalThis.requestAnimationFrame,
    setTimeout,
    clearTimeout,
  };
  const ui = createCdpJourneyUi({
    session,
    evaluate: async (receivedSession, expression) => {
      assert.equal(receivedSession, session);
      const result = runInNewContext(expression, environment);
      flushFrames();
      return result;
    },
    timeoutMs: 300,
    pollIntervalMs: 1,
  });
  return {
    ui,
    feature,
    dom,
    window,
    calls,
    settle,
    cancelClicks: () => cancelClicks,
    navigationClicks: () => navigationClicks,
    blockStop() {
      pendingStop = new Promise((resolve) => {
        this.finishStop = resolve;
      });
    },
  };
}

test("CDP reset waits for actual asynchronous editor cancellation before navigation or reopening", async () => {
  const f = await fixture();
  try {
    f.feature.beginBindingEdit("perf-binding-0");
    f.blockStop();
    let resetFinished = false;
    const resetting = f.ui.resetJourneyUi("configure-binding").then(() => {
      resetFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(f.cancelClicks(), 1);
    assert.equal(f.navigationClicks(), 0, "the modal must finish closing before navigation is clicked");
    assert.equal(resetFinished, false);
    assert.equal(f.dom.bindings.bindingConfigPanel.classList.contains("hidden"), false);
    f.finishStop();
    await resetting;
    assert.equal(f.navigationClicks(), 1);
    assert.equal(f.dom.bindings.bindingConfigPanel.classList.contains("hidden"), true);
    await f.ui.runStep({
      action: "click",
      selector: "[data-binding-id='perf-binding-0'] .binding-action:not(.delete)",
    });
    await settle();
    assert.equal(
      f.dom.bindings.bindingConfigPanel.classList.contains("hidden"),
      false,
      "an earlier cancellation cannot later close the new measured editor",
    );
  } finally {
    f.finishStop?.();
    f.feature.dispose();
  }
});

test("CDP reset never clicks hidden cancel and executes shared fill, density and marker steps", async () => {
  const f = await fixture();
  try {
    f.blockStop();
    assert.equal(f.dom.bindings.bindingConfigPanel.classList.contains("hidden"), true);
    await f.ui.resetJourneyUi("configure-binding");
    assert.equal(f.cancelClicks(), 0);
    assert.equal(
      f.calls.some(({ command }) => command === "stop_soundboard_preview"),
      false,
    );
    await f.ui.runStep({ action: "fill", selector: "#binding-search", value: "absent" });
    assert.equal(f.dom.bindings.bindingsContainer.querySelectorAll(".binding-item").length, 0);
    await f.ui.resetJourneyUi("density");
    assert.equal(f.dom.bindings.bindingSearchInput.value, "");
    assert.equal(f.dom.bindings.bindingsContainer.querySelectorAll(".binding-item").length, 1);
    assert.equal(f.dom.bindings.mainScreen.dataset.bindingsDensity, "comfortable");
    f.window.__MIDIMASTER_PERF__ = { snapshot: () => ({ entries: [{ name: "bindings-usable" }] }) };
    await f.ui.runStep({ action: "wait-marker", name: "bindings-usable" });
    await f.ui.runStep({
      action: "click",
      selector: "[data-binding-id='perf-binding-0'] .binding-action:not(.delete)",
    });
    f.finishStop();
    await settle();
    assert.equal(f.dom.bindings.bindingConfigPanel.classList.contains("hidden"), false);
    assert.equal(f.cancelClicks(), 0);
    await assert.rejects(
      f.ui.runStep({ action: "drag", selector: ".binding-drag", destination: ".binding-drag" }),
      /use the WebDriver journey/,
    );
  } finally {
    f.finishStop?.();
    f.feature.dispose();
  }
});

test("CDP missing-element and suspended-frame waits fail within the configured deadline", async () => {
  const environment = {
    document: { querySelector: () => null },
    requestAnimationFrame() {},
    setTimeout,
    clearTimeout,
  };
  const ui = createCdpJourneyUi({
    evaluate: async (_session, expression) => runInNewContext(expression, environment),
    timeoutMs: 10,
    pollIntervalMs: 1,
  });
  await assert.rejects(ui.runStep({ action: "click", selector: "#missing" }), /#missing to be clickable/);
  await assert.rejects(ui.nextFrame(), /frame did not complete/);
});

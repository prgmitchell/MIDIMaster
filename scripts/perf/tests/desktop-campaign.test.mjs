import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { runInteraction, verifyLoadedFixture } from "../run-desktop-campaign.mjs";

/** A CDP-compatible browser fixture executes the campaign's actual expressions. */
function campaignBrowser() {
  const { document, window } = parseHTML(`<html><body>
    <button data-page="bindings">Bindings</button><button data-page="plugins">Plugins</button><button data-page="settings">Settings</button>
    <main id="main-screen" data-bindings-density="compact">
      <input id="binding-search"><div id="binding-density-toggle"><button data-density="comfortable">Comfortable</button><button data-density="compact">Compact</button></div>
      <div id="binding-type-filter"><button data-filter="all">All</button></div>
      <div id="profile-current">Performance Default</div><button id="profile-toggle">Profiles</button>
      <div id="profile-list" class="hidden"><div data-profile-name="Performance Default"><button>Default</button></div><div data-profile-name="Performance 2"><button>Second</button></div></div>
      <div id="bindings">${[0, 499].map(id => `<div class="binding-item" data-binding-id="perf-binding-${id}"><span class="binding-name">Performance binding ${id}</span><div class="binding-actions"><button class="binding-action">Edit</button></div></div>`).join("")}</div>
    </main>
    <section id="binding-config-panel" class="hidden"><input id="binding-config-name"><button id="binding-config-save">Save</button><button id="binding-config-cancel">Cancel</button></section>
    <section id="plugins-page" class="hidden"></section><section data-page-panel="settings" class="hidden"></section>
  </body></html>`);
  const log = [];
  const rows = [...document.querySelectorAll(".binding-item")];
  const panel = document.querySelector("#binding-config-panel");
  const input = document.querySelector("#binding-config-name");
  document.querySelector("#binding-config-cancel").onclick = () => panel.classList.add("hidden");
  document.querySelector("#binding-search").oninput = event => {
    document.querySelector("#bindings").replaceChildren(...rows.filter(row => row.textContent.includes(event.target.value)));
  };
  rows.forEach(row => {
    row.querySelector(".binding-action").onclick = () => {
      input.value = row.querySelector(".binding-name").textContent;
      panel.classList.remove("hidden");
    };
  });
  document.querySelector("#binding-config-save").onclick = () => {
    log.push({ save: input.value, previous: rows[0].querySelector(".binding-name").textContent });
    rows[0].querySelector(".binding-name").textContent = input.value;
    panel.classList.add("hidden");
  };
  document.querySelectorAll("[data-density]").forEach(button => {
    button.onclick = () => {
      const main = document.querySelector("#main-screen");
      log.push({ density: button.dataset.density, previous: main.getAttribute("data-bindings-density") });
      main.setAttribute("data-bindings-density", button.dataset.density);
    };
  });
  document.querySelectorAll("[data-page]").forEach(button => {
    button.onclick = () => {
      log.push({ page: button.dataset.page });
      document.querySelector("#plugins-page").classList.toggle("hidden", button.dataset.page !== "plugins");
      document.querySelector("[data-page-panel='settings']").classList.toggle("hidden", button.dataset.page !== "settings");
    };
  });
  document.querySelectorAll("[data-profile-name]").forEach(item => {
    item.querySelector("button").onclick = () => {
      log.push({ profile: item.dataset.profileName });
      document.querySelector("#profile-current").textContent = item.dataset.profileName;
      document.querySelector("#profile-list").classList.add("hidden");
    };
  });
  document.querySelector("#profile-toggle").onclick = () => document.querySelector("#profile-list").classList.toggle("hidden");
  window.HTMLElement.prototype.getClientRects = function () { return this.closest(".hidden,[hidden]") ? [] : [{}]; };
  let clock = 0;
  const frames = new Set();
  const timers = new Set();
  const environment = {
    document, Event: window.Event, MutationObserver: window.MutationObserver,
    performance: { now: () => clock },
    getComputedStyle: element => ({ display: element.closest(".hidden,[hidden]") ? "none" : "block", visibility: "visible" }),
    setTimeout(callback, ms) {
      const handle = setTimeout(() => { timers.delete(handle); clock += ms; callback(); }, ms);
      timers.add(handle);
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); clearTimeout(handle); },
    requestAnimationFrame(callback) {
      const handle = setImmediate(() => { frames.delete(handle); clock += 16; callback(clock); });
      frames.add(handle);
      return handle;
    },
    cancelAnimationFrame(handle) { frames.delete(handle); clearImmediate(handle); },
  };
  environment.window = environment;
  const context = vm.createContext(environment);
  return {
    document, log,
    session: { async send(command, { expression }) {
      assert.equal(command, "Runtime.evaluate");
      try { return { result: { value: await vm.runInContext(expression, context) } }; }
      catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
    } },
    dispose() {
      environment.__MIDIMASTER_JOURNEY__?.cancel?.();
      frames.forEach(clearImmediate);
      timers.forEach(clearTimeout);
    },
  };
}

test("campaign readiness requires the expected fixture rows rather than an empty fallback", async () => {
  const browser = campaignBrowser();
  try {
    await verifyLoadedFixture(browser.session, 2);
    browser.document.querySelector("#bindings").replaceChildren();
    await assert.rejects(verifyLoadedFixture(browser.session, 2), /expected 2 rendered bindings, received 0/);
    await verifyLoadedFixture(browser.session, 0);
  } finally { browser.dispose(); }
});

test("repeated density journeys restore their starting density before measurement", async () => {
  const browser = campaignBrowser();
  try {
    const first = await runInteraction(browser.session, "density", 0);
    const second = await runInteraction(browser.session, "density", 1);
    assert.equal(first.metric, "interaction.density");
    assert.equal(second.metric, first.metric);
    assert.ok(first.durationMs > 0 && second.durationMs > 0);
    assert.deepEqual(browser.log.filter(entry => entry.density), [
      { density: "comfortable", previous: "compact" }, { density: "compact", previous: "comfortable" },
      { density: "comfortable", previous: "compact" }, { density: "compact", previous: "comfortable" },
    ]);
  } finally { browser.dispose(); }
});

test("each save journey changes the name and validates that sample's saved result", async () => {
  const browser = campaignBrowser();
  try {
    const results = [];
    for (let sample = 0; sample < 3; sample++) results.push(await runInteraction(browser.session, "edit-save", sample));
    assert.ok(results.every(result => result.metric === "storage.profile_save" && result.durationMs > 0));
    assert.deepEqual(browser.log.filter(entry => entry.save), [
      { save: "Performance binding edited 0", previous: "Performance binding 0" },
      { save: "Performance binding edited 1", previous: "Performance binding edited 0" },
      { save: "Performance binding edited 2", previous: "Performance binding edited 1" },
    ]);
    assert.equal(browser.document.querySelector("#binding-config-panel").classList.contains("hidden"), true);
  } finally { browser.dispose(); }
});

test("search, configure, profile and navigation journeys report their own completed scenario", async () => {
  const browser = campaignBrowser();
  try {
    const ids = ["search-filter", "search-retain-most", "configure-binding", "profile-switch", "profile-switch",
      "plugins-navigation-first", "settings-navigation-first", "plugins-navigation-repeat", "settings-navigation-repeat"];
    for (const id of ids) {
      const result = await runInteraction(browser.session, id);
      assert.equal(result.id, id);
      assert.ok(result.durationMs > 0);
    }
    assert.deepEqual(browser.log.filter(entry => entry.profile), [
      { profile: "Performance 2" }, { profile: "Performance Default" }, { profile: "Performance 2" },
    ]);
    assert.equal(browser.document.querySelectorAll("#bindings .binding-item").length, 2);
    assert.equal(browser.document.querySelector("#binding-config-panel").classList.contains("hidden"), true);
  } finally { browser.dispose(); }
});

test("campaign surfaces missing controls instead of manufacturing an interaction sample", async () => {
  const browser = campaignBrowser();
  try {
    browser.document.querySelector("#binding-config-save").remove();
    await assert.rejects(runInteraction(browser.session, "edit-save"), /#binding-config-save to be clickable/);
    await assert.rejects(runInteraction(browser.session, "unknown"), /Unknown renderer journey/);
  } finally { browser.dispose(); }
});

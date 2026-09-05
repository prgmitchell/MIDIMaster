import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createCdpJourneyUi } from "../lib/cdp-journey-ui.mjs";
import { createAppDom } from "../../lib/dom_fixture.mjs";
import { createDomRefs } from "../../../src/app/dom_refs.js";
import { createUiLifetime } from "../../../src/app/ui_lifetime.js";
import { createProfilesFeature } from "../../../src/features/profiles/profiles.js";
import { createDropdowns } from "../../../src/features/settings/controllers/dropdowns.js";
import { createPerformanceAudit } from "../../../src/app/performance_audit.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("Profile fixture did not reach the expected state");
}

async function fixture({ enabled = true, failSync = false, emitCompletion = true } = {}) {
  const { document, window, flushFrames } = await createAppDom();
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest(".hidden,[hidden]") ? [] : [{}];
  };
  const dom = createDomRefs();
  const name = 'Stage "A" \\ guest\'s';
  let active = name;
  let bindings = [{ id: "binding-0", name: "Saved edit" }];
  const stored = new Map([
    ["Default", { name: "Default", bindings: [] }],
    [name, { name, bindings: [{ id: "binding-0", name: "Earlier value" }] }],
    ["Stage A", { name: "Stage A", bindings: [] }],
  ]);
  const saveGate = deferred();
  const syncGate = deferred();
  const calls = [];
  let clock = 100;
  let frameCount = 0;
  let snapshotCount = 0;
  const performanceSource = { now: () => ++clock };
  const audit = createPerformanceAudit({
    windowSource: { __MIDIMASTER_PERF_AUDIT__: { enabled }, location: { search: "?perf-no-frames=1" } },
    documentSource: document, performanceSource, PerformanceObserverSource: null,
  });
  window.__MIDIMASTER_PERF__ = { ...audit, snapshot: () => { snapshotCount++; return audit.snapshot(); } };
  const profiles = createProfilesFeature({
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "list_profiles") return [...stored.values()];
      if (command === "save_profile") {
        await saveGate.promise;
        stored.set(args.profile.name, structuredClone(args.profile));
      }
      if (command === "load_profile") return structuredClone(stored.get(args.name));
    },
    dom: dom.profiles,
    getActiveProfileName: () => active,
    setActiveProfileName: value => { active = value; },
    getBindings: () => bindings,
    setBindings: value => { bindings = value; },
    onProfileLoaded: async () => {
      calls.push({ command: "profile-midi-sync" });
      const finish = audit.begin("profile-midi-sync");
      await syncGate.promise;
      if (emitCompletion) finish({ ok: !failSync });
    },
  });
  profiles.bindUi();
  profiles.setProfileSelection(name);
  // Use the real settings listener that closes the profile menu on the same
  // bubbled click, before the asynchronous profile load has finished.
  const lifetime = createUiLifetime();
  const dropdowns = createDropdowns({
    lifetime, elements: {}, monitorView: {}, settingsSelectDropdowns: new Map(), viewState: {},
    t: key => key,
  });
  const setting = document.createElement("select");
  setting.innerHTML = "<option>Default</option>";
  document.body.appendChild(setting);
  dropdowns.renderSettingsSelectDropdown(setting);
  const environment = {
    document, window, CSS: globalThis.CSS, performance: performanceSource, Event: window.Event,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    requestAnimationFrame(callback) { frameCount++; return globalThis.requestAnimationFrame(callback); },
    setTimeout, clearTimeout,
  };
  const ui = createCdpJourneyUi({
    evaluate: async (_session, expression) => {
      const result = runInNewContext(expression, environment);
      flushFrames();
      return result;
    },
    timeoutMs: 300, pollIntervalMs: 1,
  });
  return {
    name, profiles, ui, dom, calls, audit, saveGate, syncGate, stored, window,
    frameCount: () => frameCount, snapshotCount: () => snapshotCount,
    async dispose() {
      saveGate.resolve();
      syncGate.resolve();
      lifetime.dispose();
      audit.stopObservers();
      await profiles.dispose();
    },
  };
}

test("reload saves the exact selected profile and waits for fresh sync despite unchanged label and closed menu", async () => {
  const f = await fixture();
  let reloading;
  try {
    const finishOlderSync = f.audit.begin("profile-midi-sync");
    const pendingSave = f.profiles.saveBindingsForProfile();
    let completed = false;
    reloading = f.ui.reloadCurrentProfile().then(name => { completed = true; return name; });
    await until(() => f.calls.some(call => call.command === "save_profile"));
    assert.equal(f.dom.profiles.profileCurrent.textContent, f.name);
    assert.equal(f.dom.profiles.profileList.classList.contains("hidden"), true,
      "the real settings document handler closes the menu before persistence completes");
    assert.equal(f.calls.some(call => call.command === "load_profile"), false);
    finishOlderSync();
    const snapshotsBefore = f.snapshotCount();
    await until(() => f.snapshotCount() > snapshotsBefore);
    assert.equal(completed, false, "completion of an older in-flight sync cannot settle this reload");
    assert.equal(f.frameCount(), 0);
    f.saveGate.resolve();
    await pendingSave;
    await until(() => f.calls.some(call => call.command === "profile-midi-sync"));
    assert.equal(completed, false, "loading the profile label still precedes sync completion");
    assert.equal(f.stored.get(f.name).bindings[0].name, "Saved edit");
    assert.deepEqual(f.calls.filter(call => call.command === "load_profile"), [
      { command: "load_profile", args: { name: f.name } },
    ]);
    assert.equal(f.calls.find(call => call.command === "save_profile").args.profile.name, f.name);
    f.syncGate.resolve();
    assert.equal(await reloading, f.name);
    assert.equal(f.frameCount(), 2);

    // Selecting an already selected profile must still run the real load again.
    await f.ui.runStep({ action: "click", selector: "#profile-toggle" });
    await f.ui.runStep({ action: "wait-visible", selector: "#profile-list" });
    assert.equal(await f.ui.reloadCurrentProfile(), f.name);
    assert.equal(f.calls.filter(call => call.command === "load_profile").length, 2);
    assert.equal(f.frameCount(), 4);
  } finally {
    await f.dispose();
    await reloading?.catch(() => {});
  }
});

test("reload rejects a fresh failed sync operation", async () => {
  const f = await fixture({ failSync: true });
  try {
    f.saveGate.resolve();
    f.syncGate.resolve();
    await assert.rejects(f.ui.reloadCurrentProfile(), /synchronization failed/);
    assert.equal(f.frameCount(), 0);
  } finally { await f.dispose(); }
});

test("stale completed markers cannot replace a missing fresh completion", async () => {
  const f = await fixture({ emitCompletion: false });
  try {
    f.audit.begin("profile-midi-sync")();
    f.saveGate.resolve();
    f.syncGate.resolve();
    await assert.rejects(f.ui.reloadCurrentProfile(), /no fresh completed profile-midi-sync/);
    assert.equal(f.dom.profiles.profileList.classList.contains("hidden"), true);
    assert.equal(f.frameCount(), 0);
  } finally { await f.dispose(); }
});

test("reload refuses disabled or unavailable audit before opening the menu", async () => {
  const f = await fixture({ enabled: false });
  try {
    await assert.rejects(f.ui.reloadCurrentProfile(), /requires an enabled performance audit/);
    delete f.window.__MIDIMASTER_PERF__;
    await assert.rejects(f.ui.reloadCurrentProfile(), /requires an enabled performance audit/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.dom.profiles.profileList.classList.contains("hidden"), true);
  } finally { await f.dispose(); }
});

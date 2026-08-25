import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBindingDomIndex } from "../src/app/binding_dom_index.js";
import { createBindingLookupIndex } from "../src/app/binding_lookup_index.js";
import { createPerformanceAudit } from "../src/app/performance_audit.js";
import { isPerformanceAuditRequested } from "../src/app/performance_audit_api.js";
import { hydrateThemeLogo, resolveInitialThemeScheme } from "../src/app/theme_logo.js";
import { isExplicitOsdPayload } from "../src/features/osd/osd.js";
import { captureElementScroll, restoreElementScroll } from "../src/app/scroll_position.js";
import { createPluginDisplayMetadataCache } from "../src/app/plugin_display_metadata.js";
import { mergePersistentIntegrationDisplayMetadata } from "../src/app/plugin_runtime.js";
import { createTargetCore } from "../src/core/target_core.js";

function testBindingDomIndex() {
  const index = createBindingDomIndex();
  const item = { id: "row" };
  const slider = { id: "slider" };
  index.register("binding-1", { item });
  index.register("binding-1", { slider, target: { Master: null } });
  assert.equal(index.size(), 1);
  assert.equal(index.get("binding-1").item, item);
  assert.equal(index.get("binding-1").slider, slider);
  assert.deepEqual(index.get("binding-1").target, { Master: null });
  index.clear();
  assert.equal(index.get("binding-1"), null);
}

function testBindingLookupIndex() {
  const first = {
    id: "first",
    device_id: "device-a",
    control: { channel: 1, controller: 7, msg_type: "ControlChange" },
  };
  const duplicateControl = {
    id: "second",
    device_id: "device-b",
    control: { channel: 1, controller: 7, msg_type: "ControlChange" },
  };
  const unique = {
    id: "unique",
    device_id: "device-a",
    control: { channel: 2, controller: 9, msg_type: "Note" },
  };
  const index = createBindingLookupIndex([first, duplicateControl, unique]);
  assert.equal(index.find({ device_id: "device-a", channel: 1, controller: 7, msg_type: "ControlChange" }), first);
  assert.equal(index.find({ device_id: "stale", channel: 1, controller: 7, msg_type: "ControlChange" }), null);
  assert.equal(index.find({ device_id: "stale", channel: 2, controller: 9, msg_type: "Note" }), unique);
  assert.equal(index.find(
    { device_id: "stale", channel: 2, controller: 9, msg_type: "Note" },
    { allowLegacyFallback: false },
  ), null);
}

function testOptInPerformanceAudit() {
  assert.equal(isPerformanceAuditRequested({ locationSource: { search: "" }, injected: null }), false);
  assert.equal(isPerformanceAuditRequested({ locationSource: { search: "?perf-audit=1" }, injected: null }), true);
  assert.equal(isPerformanceAuditRequested({ locationSource: { search: "" }, injected: { enabled: true } }), true);
  let clock = 10;
  const marks = new Map();
  const measures = [];
  const fakePerformance = {
    now: () => clock,
    mark: (name) => marks.set(name, clock),
    measure: (name, { start, end }) => {
      const startTime = marks.get(start);
      const endTime = end ? marks.get(end) : clock;
      measures.push({ name, startTime, duration: endTime - startTime });
    },
    getEntriesByName: (name) => measures.filter((entry) => entry.name === name),
    memory: { usedJSHeapSize: 100, totalJSHeapSize: 200 },
  };
  const fakeWindow = {
    location: { search: "?perf-audit=1&perf-run-id=run-1&perf-scenario=startup" },
  };
  const audit = createPerformanceAudit({
    windowSource: fakeWindow,
    documentSource: { getElementsByTagName: () => ({ length: 42 }) },
    performanceSource: fakePerformance,
    cryptoSource: null,
    PerformanceObserverSource: null,
  });
  audit.mark("bootstrap-start");
  clock = 35;
  audit.mark("bindings-usable");
  audit.measure("bootstrap-to-bindings", "bootstrap-start", "bindings-usable");
  clock = 40;
  audit.recordIpc("list_profiles", 35, true);
  audit.recordDuration("midi-visible-update", 12.5, { controller: 7 });

  const snapshot = audit.snapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.runId, "run-1");
  assert.equal(snapshot.scenario, "startup");
  assert.equal(snapshot.resources.domNodes, 42);
  assert.equal(snapshot.ipc.count, 1);
  assert.equal(snapshot.ipc.p95Ms, 5);
  assert.equal(snapshot.entries.find((entry) => entry.kind === "measure").durationMs, 25);
  assert.equal(snapshot.entries.find((entry) => entry.name === "midi-visible-update").durationMs, 12.5);
  assert.equal(fakeWindow.__MIDIMASTER_PERF__, audit);

  const disabled = createPerformanceAudit({
    windowSource: { location: { search: "" } },
    performanceSource: fakePerformance,
    PerformanceObserverSource: null,
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.mark("ignored"), null);
}

function testInitialThemeLogoLoadsOneAsset() {
  const assigned = [];
  const image = {
    dataset: { darkSrc: "dark.png", lightSrc: "light.png" },
    setAttribute: (name, value) => assigned.push([name, value]),
  };
  const source = hydrateThemeLogo({
    root: { querySelector: () => image },
    storage: { getItem: (key) => key === "uiTheme" ? "light" : null },
    matchMediaSource: { matchMedia: () => ({ matches: true }) },
  });
  assert.equal(source, "light.png");
  assert.deepEqual(assigned, [["src", "light.png"]]);
  assert.equal(resolveInitialThemeScheme({
    storage: { getItem: () => null },
    matchMediaSource: { matchMedia: () => ({ matches: true }) },
  }), "dark");
  assert.equal(resolveInitialThemeScheme({
    storage: {
      getItem: (key) => key === "midimasterAppearance"
        ? JSON.stringify({ active_theme_id: "system" })
        : "light",
    },
    matchMediaSource: { matchMedia: () => ({ matches: true }) },
  }), "dark", "system appearance should follow the current OS instead of stale resolved storage");
  assert.equal(resolveInitialThemeScheme({
    storage: {
      getItem: (key) => key === "midimasterAppearance"
        ? JSON.stringify({ active_theme_id: "custom-light", custom_themes: [{ id: "custom-light", scheme: "light" }] })
        : null,
    },
    matchMediaSource: { matchMedia: () => ({ matches: true }) },
  }), "light");
}

function testOsdIgnoresGlobalFeedbackBroadcasts() {
  assert.equal(isExplicitOsdPayload({ target: "Master", volume: 0.5 }, true), false);
  assert.equal(isExplicitOsdPayload({ target: "Master", volume: 0.5, osd_enabled: true }, true), true);
  assert.equal(isExplicitOsdPayload({ target: "Master", volume: 0.5 }, false), true);
}

function testBindingRerenderPreservesScrollPosition() {
  const container = { scrollTop: 612, scrollLeft: 14 };
  const captured = captureElementScroll(container);
  container.scrollTop = 0;
  container.scrollLeft = 0;
  restoreElementScroll(container, captured);
  assert.deepEqual(container, { scrollTop: 612, scrollLeft: 14 });
}

async function testPluginIconsAreReadyForFirstBindingRender() {
  const calls = [];
  const metadata = createPluginDisplayMetadataCache({
    invoke: async (command, args = {}) => {
      calls.push([command, args]);
      if (command === "list_plugins") {
        return [
          { id: "obs", name: "OBS Studio", icon: "OBSLogo.png" },
          { id: "hue", name: "Philips Hue", icon: "HueLogo.svg" },
        ];
      }
      if (command === "read_plugin_base64") return `${args.pluginId}-base64`;
      throw new Error(`Unexpected command: ${command}`);
    },
  });

  await metadata.loadManifests();
  await metadata.warmIntegrationIcons(["obs", "obs.scene", "missing"]);
  assert.deepEqual(metadata.getIntegrationDisplayMetadata("obs.scene"), {
    integration_id: "obs",
    label: "OBS Studio",
    icon_data: "data:image/png;base64,obs-base64",
  });
  assert.equal(metadata.getIntegrationDisplayMetadata("hue")?.icon_data, null);
  assert.equal(calls.filter(([command]) => command === "list_plugins").length, 1);
  assert.equal(calls.filter(([command]) => command === "read_plugin_base64").length, 1);
  assert.deepEqual(calls.find(([command]) => command === "read_plugin_base64"), [
    "read_plugin_base64",
    { pluginId: "obs", relPath: "OBSLogo.png" },
  ]);

  const targetCore = createTargetCore({
    getSessions: () => [],
    getPlaybackDevices: () => [],
    getRecordingDevices: () => [],
    getIntegrationDisplayMetadata: metadata.getIntegrationDisplayMetadata,
  });
  assert.deepEqual(targetCore.resolveOsdTarget({
    Integration: {
      integration_id: "obs",
      kind: "scene",
      data: { label: "Game Scene" },
    },
  }), {
    label: "Game Scene",
    icon_data: "data:image/png;base64,obs-base64",
  });
}

function testDerivedPluginIconsStayOutOfPersistentBindingData() {
  const original = {};
  const merged = mergePersistentIntegrationDisplayMetadata(original, {
    label: "OBS Scene",
    icon_data: "data:image/png;base64,derived-icon",
  });
  assert.deepEqual(merged, { label: "OBS Scene" });
  assert.equal(Object.hasOwn(merged, "icon_data"), false);

  const legacy = {
    label: "Game (Unavailable)",
    icon_data: "data:image/png;base64,legacy-icon",
  };
  assert.deepEqual(mergePersistentIntegrationDisplayMetadata(legacy), {
    label: "Game",
    icon_data: "data:image/png;base64,legacy-icon",
  });
}

async function testEntrypointIsolation() {
  const [mainSource, appSource, bindingsSource, auditApiSource, indexHtml, osdHtml, osdEntry, updateHtml, updateEntry] = await Promise.all([
    readFile(new URL("../src/main.js", import.meta.url), "utf8"),
    readFile(new URL("../src/app_entry.js", import.meta.url), "utf8"),
    readFile(new URL("../src/features/bindings/bindings.js", import.meta.url), "utf8"),
    readFile(new URL("../src/app/performance_audit_api.js", import.meta.url), "utf8"),
    readFile(new URL("../src/index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/osd.html", import.meta.url), "utf8"),
    readFile(new URL("../src/osd_entry.js", import.meta.url), "utf8"),
    readFile(new URL("../src/update.html", import.meta.url), "utf8"),
    readFile(new URL("../src/update_entry.js", import.meta.url), "utf8"),
  ]);
  assert.match(mainSource, /DOMContentLoaded/);
  assert.doesNotMatch(mainSource, /addEventListener\("load"/);
  assert.doesNotMatch(mainSource, /from ["']\.\/app\/performance_audit\.js["']/);
  assert.match(auditApiSource, /import\("\.\/performance_audit\.js"\)/);
  assert.match(osdHtml, /src="osd_entry\.js"/);
  assert.match(osdEntry, /createPluginDisplayMetadataCache/);
  assert.match(osdEntry, /getIntegrationDisplayMetadata:\s*displayMetadata\.getIntegrationDisplayMetadata/);
  assert.match(osdEntry, /warmIntegrationIcons\(\[integrationId\]\)/);
  assert.doesNotMatch(osdEntry, /plugin_host|loadInstalledPlugins/);
  assert.match(updateHtml, /src="update_entry\.js"/);
  assert.doesNotMatch(osdEntry, /app_entry\.js/);
  assert.doesNotMatch(updateEntry, /app_entry\.js/);
  assert.doesNotMatch(appSource, /setupUpdateNotificationWindow|isUpdateWindow|preload_store_catalog_failed/);
  assert.match(appSource, /completeInitialDeviceLoad/);
  assert.doesNotMatch(bindingsSource, /bindingsContainer\.innerHTML\s*=\s*["']{2}/);
  assert.match(bindingsSource, /previous\?\.item\?\.__bindingRenderKey === renderKey/);
  assert.match(bindingsSource, /previous\.targetDropdown\?\.refreshTargetDisplay\?\.\(\)/);
  assert.match(bindingsSource, /bindingsContainer\.replaceChildren\(nextContent\)/);
  assert.equal((indexHtml.match(/<img class="app-logo/g) || []).length, 1);
  assert.match(indexHtml, /data-dark-src="assets\/MIDIMaster\.png" data-light-src="assets\/MIDIMaster-light\.png"/);
}

testBindingDomIndex();
testBindingLookupIndex();
testOptInPerformanceAudit();
testInitialThemeLogoLoadsOneAsset();
testOsdIgnoresGlobalFeedbackBroadcasts();
testBindingRerenderPreservesScrollPosition();
await testPluginIconsAreReadyForFirstBindingRender();
testDerivedPluginIconsStayOutOfPersistentBindingData();
await testEntrypointIsolation();

console.log("Frontend performance tests passed");

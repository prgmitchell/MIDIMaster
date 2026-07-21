import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const contractUrl = new URL("../config/installed-journeys.json", import.meta.url);
const contract = JSON.parse(await readFile(contractUrl, "utf8"));
const requestedJourney = String(process.env.MIDIMASTER_PERF_JOURNEY || "all");
const journeys = requestedJourney === "all"
  ? contract.journeys
  : contract.journeys.filter(({ id }) => id === requestedJourney);

if (journeys.length === 0) throw new Error(`Unknown performance journey: ${requestedJourney}`);

function resultRecord(metric, value, journeyId) {
  return {
    schema_version: "1.0.0",
    run_id: process.env.MIDIMASTER_PERF_RUN_ID,
    scenario_id: process.env.MIDIMASTER_PERF_SCENARIO_ID,
    variant: process.env.MIDIMASTER_PERF_VARIANT || "current",
    timestamp: new Date().toISOString(),
    kind: "operation",
    metric,
    value,
    unit: "ms",
    commit: null,
    build: "webdriverio-tauri",
    dimensions: { journey: journeyId, driver: "webdriverio-tauri" },
  };
}

async function nextFrame() {
  await browser.executeAsync((done) => requestAnimationFrame(() => done(true)));
}

async function waitForAuditMarker(name) {
  await browser.waitUntil(async () => browser.execute((marker) => (
    window.__MIDIMASTER_PERF__?.snapshot?.().entries?.some((entry) => entry.name === marker) || false
  ), name), { timeout: 30_000, timeoutMsg: `Audit marker '${name}' was not observed` });
}

async function runStep(step) {
  if (step.action === "wait-marker") return waitForAuditMarker(step.name);
  if (step.action === "next-frame") return nextFrame();
  const element = await $(step.selector);
  if (step.action === "click") {
    await element.waitForClickable();
    return element.click();
  }
  if (step.action === "fill") {
    await element.waitForEnabled();
    await element.clearValue();
    return element.setValue(step.value);
  }
  if (step.action === "wait-visible") return element.waitForDisplayed();
  if (step.action === "wait-hidden") return element.waitForDisplayed({ reverse: true });
  if (step.action === "wait-text") return browser.waitUntil(async () => (await element.getText()).includes(step.value));
  if (step.action === "wait-attribute") {
    return browser.waitUntil(async () => await element.getAttribute(step.name) === step.value);
  }
  if (step.action === "drag") {
    const destination = await $(step.destination);
    return element.dragAndDrop(destination);
  }
  throw new Error(`Unsupported journey action: ${step.action}`);
}

async function startupDuration() {
  return browser.execute(() => {
    const entries = window.__MIDIMASTER_PERF__?.snapshot?.().entries || [];
    return entries.find((entry) => entry.kind === "measure" && entry.name === "bootstrap-to-bindings-usable")?.durationMs ?? null;
  });
}

async function resetJourneyUi() {
  const bindingsNavigation = await $("[data-page='bindings']");
  if (await bindingsNavigation.isDisplayed()) await bindingsNavigation.click();
  const configPanel = await $("#binding-config-panel");
  if (await configPanel.isDisplayed()) {
    const cancel = await $("#binding-config-cancel");
    if (await cancel.isClickable()) await cancel.click();
  }
  const search = await $("#binding-search");
  if (await search.getValue()) {
    await search.clearValue();
    await nextFrame();
  }
}

describe("MIDIMaster installed performance journeys", () => {
  for (const journey of journeys) {
    it(journey.id, async () => {
      await waitForAuditMarker("bindings-usable");
      await resetJourneyUi();
      let startedAt = await browser.execute(() => performance.now());
      for (const step of journey.steps) {
        if (journey.measure === "storage.profile_save" && step.selector === "#binding-config-save") {
          startedAt = await browser.execute(() => performance.now());
        }
        await runStep(step);
      }
      await nextFrame();
      let durationMs = await browser.execute((started) => performance.now() - started, startedAt);
      if (journey.id === "initial-render") durationMs = await startupDuration();
      if (!Number.isFinite(durationMs)) throw new Error(`Journey '${journey.id}' produced no duration`);
      const output = join(process.env.MIDIMASTER_PERF_RESULTS_DIR, "webdriver.ndjson");
      await appendFile(output, `${JSON.stringify(resultRecord(journey.measure, durationMs, journey.id))}\n`, "utf8");
    });
  }
});

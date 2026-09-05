import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { armRendererJourney, readRendererJourney } from "../lib/renderer-journey.mjs";
import { createJourneyUi } from "./journey-ui.mjs";

const contractUrl = new URL("../config/installed-journeys.json", import.meta.url);
const contract = JSON.parse(await readFile(contractUrl, "utf8"));
const rendererJourneys = JSON.parse(
  await readFile(new URL("../config/renderer-journeys.json", import.meta.url), "utf8"),
);
const requestedJourney = String(process.env.MIDIMASTER_PERF_JOURNEY || "all");
const journeys =
  requestedJourney === "all"
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

async function waitForAuditMarker(name) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (marker) =>
          window.__MIDIMASTER_PERF__?.snapshot?.().entries?.some((entry) => entry.name === marker) || false,
        name,
      ),
    { timeout: 30_000, timeoutMsg: `Audit marker '${name}' was not observed` },
  );
}

async function startupDuration() {
  return browser.execute(() => {
    const entries = window.__MIDIMASTER_PERF__?.snapshot?.().entries || [];
    return (
      entries.find((entry) => entry.kind === "measure" && entry.name === "bootstrap-to-bindings-usable")
        ?.durationMs ?? null
    );
  });
}

describe("MIDIMaster installed performance journeys", () => {
  for (const journey of journeys) {
    it(journey.id, async () => {
      await waitForAuditMarker("bindings-usable");
      const { nextFrame, runStep, resetJourneyUi } = createJourneyUi({
        browser,
        select: $,
        waitForAuditMarker,
      });
      await resetJourneyUi(journey.id);
      if (journey.id !== "initial-render") {
        await browser.execute(armRendererJourney, {
          ...rendererJourneys[journey.id],
          id: journey.id,
          metric: journey.measure,
        });
      }
      const startedAt = performance.now();
      for (const step of journey.steps) {
        await runStep(step);
      }
      await nextFrame();
      const driverDurationMs = performance.now() - startedAt;
      let durationMs;
      if (journey.id === "initial-render") durationMs = await startupDuration();
      else {
        await browser.waitUntil(
          async () => {
            const state = await browser.execute(readRendererJourney);
            if (state?.error) throw new Error(state.error);
            return Boolean(state?.result);
          },
          { timeout: 35000, timeoutMsg: `No renderer result for ${journey.id}` },
        );
        durationMs = (await browser.execute(readRendererJourney)).result.durationMs;
      }
      if (!Number.isFinite(durationMs)) throw new Error(`Journey '${journey.id}' produced no duration`);
      const output = join(process.env.MIDIMASTER_PERF_RESULTS_DIR, "webdriver.ndjson");
      await appendFile(
        output,
        `${JSON.stringify(resultRecord("driver.journey", driverDurationMs, journey.id))}\n`,
        "utf8",
      );
      await appendFile(
        output,
        `${JSON.stringify(resultRecord(journey.measure, durationMs, journey.id))}\n`,
        "utf8",
      );
    });
  }
});

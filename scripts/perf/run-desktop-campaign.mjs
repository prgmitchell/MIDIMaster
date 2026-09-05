import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpSession, findTarget, snapshotRecords } from "./capture-cdp.mjs";
import { midiCollectionExpression, normalizedRecords, validateMidiResult } from "./run-midi-cdp.mjs";
import { armRendererJourney, readRendererJourney } from "./lib/renderer-journey.mjs";
import { parseArgs, runMain } from "./lib/cli.mjs";
import { createCdpJourneyUi } from "./lib/cdp-journey-ui.mjs";
import { validateMeasurementWindow } from "./lib/measurement-window.mjs";
import { saveDuringMidi } from "./lib/save-during-midi.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rendererContracts = JSON.parse(await readFile(new URL("./config/renderer-journeys.json", import.meta.url), "utf8"));
const contracts = JSON.parse(await readFile(new URL("./config/installed-journeys.json", import.meta.url), "utf8"));

async function evaluate(session, expression) {
  const response = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
}

async function waitReady(session) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(session, "window.__MIDIMASTER_PERF__?.snapshot?.().entries.some(e => e.name === 'bindings-usable') || false")) return;
    await pause(250);
  }
  throw new Error("Bindings did not become usable in the audit window");
}

export async function verifyLoadedFixture(session, bindingCount) {
  const displayed = await evaluate(session, "document.querySelectorAll('#bindings .binding-item').length");
  if (!Number.isSafeInteger(bindingCount) || bindingCount < 0 || displayed !== bindingCount) {
    throw new Error(`Fixture expected ${bindingCount} rendered bindings, received ${displayed}`);
  }
}

async function resetUi(session) {
  await createCdpJourneyUi({ session, evaluate }).resetJourneyUi();
}

export async function runInteraction(session, id, sample = 0) {
  const journey = contracts.journeys.find(item => item.id === id);
  if (!journey || !rendererContracts[id]) throw new Error(`Unknown renderer journey: ${id}`);
  const ui = createCdpJourneyUi({ session, evaluate });
  await ui.resetJourneyUi(id);
  const contract = structuredClone(rendererContracts[id]);
  const steps = structuredClone(journey.steps);
  if (id === "edit-save") {
    const name = `Performance binding edited ${sample}`;
    steps.find(step => step.selector === "#binding-config-name").value = name;
    contract.completion.find(condition => condition.kind === "text").expected = name;
  }
  await evaluate(session, `(${armRendererJourney})(${JSON.stringify({ ...contract, id, metric: journey.measure })})`);
  for (const step of steps) await ui.runStep(step);
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = await evaluate(session, `(${readRendererJourney})()`);
    if (state?.error) throw new Error(state.error);
    if (state?.result) return state.result;
    await pause(20);
  }
  throw new Error(`No renderer completion for ${id}`);
}

async function inject(session, { rate, controls, kind, seconds = 10 }) {
  return evaluate(session, midiCollectionExpression({ messageCount: rate * seconds, ratePerSecond: rate, controlCount: controls, messageKind: kind, timeoutMs: 30000 }));
}

function resourceMetrics(response) {
  return Object.fromEntries((response.metrics || []).map(metric => [metric.name, metric.value]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode || "interactions";
  if (!["startup", "interactions", "editor-idle", "midi", "midi-save", "idle-visible", "idle-hidden", "endurance"].includes(mode)) throw new Error("Unknown campaign mode");
  if (!args.application || !args.fixture) throw new Error("--application and --fixture are required");
  const application = resolve(args.application);
  const fixture = resolve(args.fixture);
  const fixtureInfo = JSON.parse(await readFile(join(fixture, "fixture.json"), "utf8"));
  const variant = args.variant || "current";
  const iterations = Number(args.iterations || 20);
  const duration = Number(args.seconds || (mode === "endurance" ? 7200 : mode.startsWith("idle") ? 600 : 300));
  const port = Number(args.port || 9332);
  for (const [name, value, min, max] of [["iterations", iterations, 1, 1000], ["seconds", duration, 1, mode === "endurance" ? 86280 : 86380], ["port", port, 1024, 65535]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid --${name}: expected an integer from ${min} to ${max}`);
  }
  if (!/^[A-Za-z0-9._-]{1,35}$/.test(variant)) throw new Error("Invalid --variant label");
  const runId = `${variant}-${mode}-${Date.now()}`;
  const scenarioId = mode === "endurance" ? "endurance-mixed" : mode === "startup" ? `startup-clean-${fixtureInfo.fixture_id}`
    : mode === "midi-save" ? `midi-save-${fixtureInfo.fixture_id}` : `${mode}-b${fixtureInfo.binding_count}`;
  const output = resolve(args.output || "perf-results/campaign");
  const runOutput = join(output, runId);
  await mkdir(runOutput, { recursive: true });
  // PowerShell 7's inherited module path can hide Windows PowerShell's built-in cmdlets.
  const launchEnvironment = { ...process.env };
  for (const key of Object.keys(launchEnvironment)) if (key.toLowerCase() === "psmodulepath") delete launchEnvironment[key];
  const launcher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    join(repo, "scripts/perf/windows/Invoke-PerfRun.ps1"), "-ApplicationPath", application, "-FixturePath", fixture,
    "-ScenarioId", scenarioId,
    "-Variant", variant, "-RunId", runId, "-NetworkMode", "Offline", "-DurationSeconds", String(duration + (mode === "endurance" ? 120 : 20)),
    "-CdpPort", String(port), "-OutputDirectory", output,
  ], { windowsHide: true, env: launchEnvironment, stdio: ["ignore", "pipe", "pipe"] });
  let launchOutput = "";
  launcher.stdout.on("data", data => { launchOutput += data; });
  launcher.stderr.on("data", data => { launchOutput += data; });
  const finished = new Promise((resolve, reject) => {
    launcher.on("error", reject);
    launcher.on("exit", code => code === 0 ? resolve() : reject(new Error(launchOutput)));
  });
  // Attach a handler immediately so a refused launch does not become unhandled.
  finished.catch(() => {});
  let session;
  const browserErrors = [];
  let completed = false;
  let resourceMeasurementStarted = null;
  const campaignStarted = Date.now();
  const records = [];
  const record = (metric, value, unit, scenario) => records.push({
    schema_version: "1.0.0", run_id: runId, scenario_id: scenario, variant, timestamp: new Date().toISOString(),
    kind: "operation", metric, value, unit, build: "release-audit-cdp", dimensions: { driver: "cdp-dom-events" },
  });
  try {
    const target = await Promise.race([findTarget(`http://127.0.0.1:${port}`, "index.html", 40000), finished.then(() => { throw new Error("Audit window exited before CDP was ready"); })]);
    session = new CdpSession(target.webSocketDebuggerUrl); await session.open(); await waitReady(session);
    await verifyLoadedFixture(session, fixtureInfo.binding_count);
    session.on("Runtime.exceptionThrown", event => { if (browserErrors.length < 100) browserErrors.push(event); });
    await session.send("Runtime.enable");
    await session.send("Performance.enable");
    await evaluate(session, "window.__MIDIMASTER_PERF__.stopObservers()");
    if (mode === "startup") await createCdpJourneyUi({ session, evaluate, timeoutMs: 30000 }).runStep({ action: "wait-marker", name: "background-init-complete" });
    const startup = await evaluate(session, "window.__MIDIMASTER_PERF__.snapshot()");
    await writeFile(join(runOutput, "startup.json"), JSON.stringify(startup));
    // Startup milestones already arrive in the launcher's frontend.ndjson.
    records.push(...snapshotRecords(startup, { nativeRunId: runId, scenarioId, variant }).filter(record => !record.metric.startsWith("startup.")));
    if (mode === "startup") {
      await writeFile(join(runOutput, "renderer-startup-resources.json"), JSON.stringify(resourceMetrics(await session.send("Performance.getMetrics"))));
    } else if (mode === "editor-idle") {
      await runInteraction(session, "configure-binding");
      await evaluate(session, `(() => {
        let records = 0, addedElements = 0;
        const observer = new MutationObserver(batch => {
          records += batch.length;
          for (const record of batch) for (const node of record.addedNodes) if (node.nodeType === 1) addedElements += 1 + node.querySelectorAll("*").length;
        });
        observer.observe(document.querySelector("#binding-config-panel"), { subtree: true, childList: true, attributes: true, characterData: true });
        window.__MIDIMASTER_EDITOR_MUTATIONS__ = () => { observer.disconnect(); return { records, addedElements }; };
      })()`);
      await pause(duration * 1000);
      const mutations = await evaluate(session, "window.__MIDIMASTER_EDITOR_MUTATIONS__()");
      record("editor.idle.mutations", mutations.records, "count", scenarioId);
      record("editor.idle.added_elements", mutations.addedElements, "count", scenarioId);
    } else if (mode === "interactions") {
      for (let sample = 0; sample < iterations; sample++) {
        const journeys = ["search-retain-most", "search-filter", "configure-binding", "edit-save", "density", "profile-switch", `plugins-navigation-${sample ? "repeat" : "first"}`, `settings-navigation-${sample ? "repeat" : "first"}`];
        for (const id of journeys) {
          const result = await runInteraction(session, id, sample);
          record(result.metric, result.durationMs, "ms", id.startsWith("search") ? `interaction-${id}-500` : `interaction-${id}`);
        }
        console.log(`Interaction sample ${sample + 1}/${iterations}`);
      }
    } else if (mode === "midi-save") {
      for (let sample = 0; sample < iterations; sample++) {
        const result = await saveDuringMidi({
          session, sample,
          midiOptions: { messageCount: 5000, ratePerSecond: 500, controlCount: 16, messageKind: "continuous", timeoutMs: 30000 },
          collectMidi: (session, options) => evaluate(session, midiCollectionExpression(options)),
          readSnapshot: session => evaluate(session, "window.__TAURI__.core.invoke('perf_audit_snapshot')"),
          runInteraction,
        });
        await writeFile(join(runOutput, `save-during-midi-${sample}.json`), JSON.stringify(result));
        if (result.status !== "success") throw new Error(`Save/MIDI overlap was not verified: ${JSON.stringify(result.errors)}`);
        validateMidiResult(result.midi, { requireSynthetic: true, requireRenderer: false });
        result.midi.snapshot.scenario_id = scenarioId;
        // The editor can cover the rows during the save; report native completion only.
        records.push(...normalizedRecords(result.midi.snapshot, result.midi.injection, null, { runId, scenarioId, variant }));
        record("storage.profile_save", result.save.result.durationMs, "ms", scenarioId);
        console.log(`Verified concurrent save ${sample + 1}/${iterations}`);
      }
    } else if (mode === "midi") {
      for (const rate of [125, 500, 1000]) for (const controls of [1, 16]) for (const kind of ["continuous", "button", "action"]) {
        const result = await inject(session, { rate, controls, kind });
        const scenario = `midi-${kind}-${rate}hz-${controls}controls`;
        result.snapshot.scenario_id = scenario;
        await writeFile(join(runOutput, `${scenario}.json`), JSON.stringify(result));
        validateMidiResult(result, { requireSynthetic: true, requireRenderer: kind === "continuous" });
        records.push(...normalizedRecords(result.snapshot, result.injection, result.frontend, { runId, scenarioId: scenario, variant }));
        console.log(`Verified ${scenario}`);
      }
    } else {
      if (mode === "idle-hidden") await evaluate(session, "window.__TAURI__.window.getCurrentWindow().hide()");
      let cycles = 0;
      const enduranceCycle = async (cycle, warmup = false) => {
          const enduranceInteraction = async id => {
            const result = await runInteraction(session, id, cycle);
            if (!warmup) record(result.metric, result.durationMs, "ms", "endurance-mixed");
          };
          await enduranceInteraction("search-retain-most");
          await enduranceInteraction("configure-binding");
          await resetUi(session);
          await createCdpJourneyUi({ session, evaluate }).reloadCurrentProfile();
          const result = await inject(session, { rate: 125, controls: 16, kind: "button", seconds: 2 });
          await writeFile(join(runOutput, `midi-${warmup ? "warmup" : "cycle"}-${cycle}.json`), JSON.stringify(result));
          validateMidiResult(result, { requireSynthetic: true, requireRenderer: false, requireStableProfile: true });
          if (!warmup) records.push(...normalizedRecords(result.snapshot, result.injection, result.frontend, { runId, scenarioId: "endurance-mixed", variant }));
          await enduranceInteraction("edit-save");
          await enduranceInteraction("profile-switch");
          await enduranceInteraction(cycle % 2 ? "plugins-navigation-repeat" : "settings-navigation-repeat");
      };
      // Warm one-time page caches before assessing sustained memory growth.
      if (mode === "endurance") for (let cycle = 0; cycle < 3; cycle++) await enduranceCycle(cycle, true);
      const started = Date.now();
      resourceMeasurementStarted = started;
      await writeFile(join(runOutput, "measurement-window.json"), JSON.stringify({ startedAt: new Date(started).toISOString(), warmupCycles: mode === "endurance" ? 3 : 0, seconds: duration }));
      const before = resourceMetrics(await session.send("Performance.getMetrics"));
      await session.send("HeapProfiler.collectGarbage");
      const retainedBefore = resourceMetrics(await session.send("Performance.getMetrics"));
      const sampledAt = [];
      while (Date.now() - started < duration * 1000) {
        if (mode === "endurance") await enduranceCycle(cycles);
        const metrics = resourceMetrics(await session.send("Performance.getMetrics"));
        sampledAt.push(Date.now());
        // Raw protocol samples use their own extension, outside normalized report inputs.
        await appendFile(join(runOutput, "renderer-resources.cdp"), JSON.stringify({ elapsedSeconds: (Date.now() - started) / 1000, ...metrics }) + "\n");
        await pause(Math.min(30000, Math.max(0, duration * 1000 - (Date.now() - started))));
        if (++cycles % 10 === 0) console.log(`${mode}: ${Math.round((Date.now() - started) / 1000)} seconds`);
      }
      const coverage = validateMeasurementWindow({ started, finished: Date.now(), sampledAt, requestedSeconds: duration });
      await writeFile(join(runOutput, "measurement-coverage.json"), JSON.stringify(coverage));
      const after = resourceMetrics(await session.send("Performance.getMetrics"));
      if (mode === "endurance") {
        const growth = after.JSHeapUsedSize - before.JSHeapUsedSize;
        // Explicitly renderer heap; process-tree working set is recorded separately by the launcher.
        record("endurance.renderer_heap_growth_bytes", growth, "bytes", "endurance-mixed");
        record("endurance.renderer_heap_growth_percent", growth / before.JSHeapUsedSize * 100, "percent", "endurance-mixed");
        record("endurance.cycles", cycles, "count", "endurance-mixed");
        await session.send("HeapProfiler.collectGarbage");
        const retainedAfter = resourceMetrics(await session.send("Performance.getMetrics"));
        record("endurance.retained_renderer_heap_growth_bytes", retainedAfter.JSHeapUsedSize - retainedBefore.JSHeapUsedSize, "bytes", "endurance-mixed");
      }
    }
    await writeFile(join(runOutput, "campaign.ndjson"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    completed = true;
  } catch (error) {
    await writeFile(join(runOutput, "failure.json"), JSON.stringify({ error: String(error.stack || error), browserErrors }));
    if (session) {
      try {
        const state = await evaluate(session, "({html:document.documentElement.outerHTML, visibility:document.visibilityState, activeElement:document.activeElement?.outerHTML})");
        await writeFile(join(runOutput, "failure-dom.json"), JSON.stringify(state));
      } catch { /* Preserve the original failure if the renderer is unavailable. */ }
    }
    throw error;
  } finally {
    await writeFile(join(runOutput, "campaign-status.json"), JSON.stringify({ completed: false, measurementsComplete: completed, mode, requestedSeconds: duration, elapsedSeconds: (Date.now() - campaignStarted) / 1000 }));
    await writeFile(join(runOutput, "campaign.ndjson"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    session?.close();
    // The launcher owns and closes the isolated process tree, including on failure.
    await writeFile(join(runOutput, "stop.request"), "campaign complete\n");
    await finished;
    await writeFile(join(runOutput, "launcher.log"), launchOutput);
    if (mode === "endurance" && completed) {
      const processRecords = (await readFile(join(runOutput, "process.ndjson"), "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
      const samples = processRecords.filter(record => record.metric === "process.working_set" && Date.parse(record.timestamp) >= resourceMeasurementStarted);
      if (samples.length < 20) throw new Error("Endurance run has insufficient process memory samples");
      if (samples.length >= 20) {
        const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
        // Compare 10-sample windows after warmup, not noisy single readings.
        const baseline = median(samples.slice(0, 10).map(record => record.value));
        const final = median(samples.slice(-10).map(record => record.value));
        record("endurance.memory_growth_bytes", final - baseline, "bytes", "endurance-mixed");
        record("endurance.memory_growth_percent", (final - baseline) / baseline * 100, "percent", "endurance-mixed");
        await writeFile(join(runOutput, "campaign.ndjson"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
      }
    }
    await writeFile(join(runOutput, "campaign-status.json"), JSON.stringify({ completed, mode, requestedSeconds: duration, elapsedSeconds: (Date.now() - campaignStarted) / 1000 }));
  }
  console.log(`Campaign complete: ${runOutput}`);
}

runMain(import.meta.url, main);

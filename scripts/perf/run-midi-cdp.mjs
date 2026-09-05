#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CdpSession, findTarget } from "./capture-cdp.mjs";
import { parseArgs, runMain } from "./lib/cli.mjs";
import { writeJson } from "./lib/files.mjs";
import { midiCollectionExpression } from "./lib/midi-collection.mjs";
import { validateMidiResult } from "./lib/midi-validation.mjs";

export { midiCollectionExpression, validateMidiResult };

const milliseconds = value => Number.isFinite(value) ? value / 1000 : null;

function metricRecord(identity, metric, value, unit, kind = "operation", dimensions = {}) {
  return {
    schema_version: "1.0.0",
    run_id: identity.run_id,
    scenario_id: identity.scenario_id,
    variant: identity.variant,
    timestamp: new Date().toISOString(),
    kind,
    metric,
    value,
    unit,
    commit: null,
    build: "renderer-cdp-midi",
    dimensions,
  };
}

export function normalizedRecords(snapshot, injection, frontend, fallback = {}) {
  const identity = {
    run_id: snapshot?.run_id || fallback.runId,
    scenario_id: snapshot?.scenario_id || fallback.scenarioId,
    variant: snapshot?.variant || fallback.variant,
  };
  const dimensions = {
    message_kind: injection.message_kind,
    rate_per_second: injection.rate_per_second,
    control_count: injection.control_count,
    message_count: injection.message_count,
  };
  const queue = snapshot.queue ?? injection.queue ?? {};
  const native = snapshot.native_action ?? {};
  const verified = snapshot.schema_version === 2;
  const latestValue = snapshot.latest_value ?? {};
  const records = [
    metricRecord(identity, "midi.injection_duration", milliseconds(injection.scheduled_duration_us), "ms", "operation", dimensions),
    metricRecord(identity, "midi.events_enqueued", queue.enqueued, "count", "counter", dimensions),
    metricRecord(identity, "midi.events_drained", queue.drained, "count", "counter", dimensions),
    metricRecord(identity, "midi.events_coalesced", queue.coalesced, "count", "counter", dimensions),
    metricRecord(identity, "midi.events_dropped", queue.dropped, "count", "counter", dimensions),
    metricRecord(identity, "midi.queue_depth", Number.isFinite(queue.pending_continuous) && Number.isFinite(queue.pending_preserved)
      ? queue.pending_continuous + queue.pending_preserved : null, "count", "resource", dimensions),
  ];
  for (const [prefix, sample] of [["native_action", native], ["queue_dispatch", snapshot.queue_dispatch], ["native_processing", snapshot.native_processing]]) {
    const metric = `${verified ? "" : "legacy."}midi.${prefix}`;
    records.push(metricRecord(identity, `${metric}_samples`, sample?.samples, "count", "counter", dimensions));
    if (!Number.isSafeInteger(sample?.samples) || sample.samples < 1) continue;
    for (const percentile of ["p50", "p95", "p99", "max"]) {
      records.push(metricRecord(identity, `${metric}_${percentile}`, milliseconds(sample[`${percentile}_us`]), "ms", "operation", dimensions));
    }
  }
  if (verified) {
    records.push(metricRecord(identity, "midi.latest_value_mismatches", latestValue.mismatches, "count", "counter", dimensions));
    records.push(metricRecord(identity, "midi.expected_controls", latestValue.controls, "count", "counter", dimensions));
    if (Number.isSafeInteger(latestValue.controls) && Number.isSafeInteger(latestValue.mismatches)
      && latestValue.mismatches >= 0 && latestValue.mismatches <= latestValue.controls) {
      records.push(metricRecord(identity, "midi.latest_applied_controls", latestValue.controls - latestValue.mismatches, "count", "counter", dimensions));
    }
    for (const [outcome, count] of Object.entries(snapshot.action_outcomes || {})) {
      if (typeof count === "number") records.push(metricRecord(identity, `midi.outcome.${outcome}`, count, "count", "counter", dimensions));
    }
  }
  if (["button", "action"].includes(injection.message_kind)) {
    records.push(metricRecord(identity, "midi.button_events_dropped", queue.dropped, "count", "counter", dimensions));
  }
  for (const entry of frontend?.entries ?? []) {
    const metric = { "midi-visible-update": "midi.visible_update", "midi-renderer-completion": "midi.renderer_completion" }[entry?.name];
    if (verified && entry?.kind === "operation" && metric && Number.isFinite(entry.durationMs)) {
      records.push(metricRecord(identity, metric, entry.durationMs, "ms", "operation", {
        ...dimensions,
        ...(entry.detail && typeof entry.detail === "object" ? entry.detail : {}),
      }));
    }
  }
  return records.filter((record) => Number.isFinite(record.value));
}

export async function runMidiJourney({ endpoint, output, urlPattern, messageCount, ratePerSecond, controlCount, messageKind, runId, scenarioId, variant, timeoutMs = 30000 }, { locateTarget = findTarget, Session = CdpSession } = {}) {
  if (!Number.isInteger(messageCount) || messageCount < 1 || messageCount > 1_000_000) throw new Error("messageCount must be between 1 and 1,000,000");
  if (!Number.isInteger(ratePerSecond) || ratePerSecond < 1 || ratePerSecond > 10_000) throw new Error("ratePerSecond must be between 1 and 10,000");
  if (!Number.isInteger(controlCount) || controlCount < 1 || controlCount > 16) throw new Error("controlCount must be between 1 and 16");
  if (!["continuous", "button", "action"].includes(messageKind)) throw new Error("messageKind must be continuous, button, or action");
  const startedAt = Date.now();
  const identity = { run_id: runId, scenario_id: scenarioId };
  await mkdir(output, { recursive: true });
  // Reusing an output directory must not leave an older successful sample behind.
  await writeFile(join(output, "midi.ndjson"), "", "utf8");
  await writeJson(join(output, "midi-validation.json"), { valid: false, status: "collecting", ...identity });
  let session;
  try {
    const target = await locateTarget(endpoint, urlPattern, timeoutMs);
    session = new Session(target.webSocketDebuggerUrl);
    await session.open();
    const expression = midiCollectionExpression({ messageCount, ratePerSecond, controlCount, messageKind, timeoutMs });
    const response = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "MIDI audit evaluation failed");
    const result = response.result?.value;
    if (!result?.injection || !result?.snapshot) throw new Error("MIDI audit commands returned no result; use a perf-audit build");
    await writeJson(join(output, "midi-injection.json"), result.injection);
    await writeJson(join(output, "native-snapshot.json"), result.snapshot);
    await writeJson(join(output, "frontend-snapshot.json"), result.frontend);
    await writeJson(join(output, "midi-collection.json"), { renderer_frames_completed: result.renderer_frames_completed });
    const checked = validateMidiResult(result, { requireRenderer: messageKind === "continuous" && result.snapshot.synthetic_targets_enabled === true });
    const records = normalizedRecords(result.snapshot, result.injection, result.frontend, { runId, scenarioId, variant });
    await writeFile(join(output, "midi.ndjson"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    const validation = { valid: true, status: "success", elapsed_ms: Date.now() - startedAt, ...identity, ...checked };
    await writeJson(join(output, "midi-validation.json"), validation);
    return { records, ...result, validation };
  } catch (error) {
    await writeJson(join(output, "midi-validation.json"), { valid: false, status: "failed", elapsed_ms: Date.now() - startedAt, ...identity, error: String(error?.message || error) });
    throw error;
  } finally {
    session?.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["help"] });
  if (args.help) {
    console.log("Usage: node scripts/perf/run-midi-cdp.mjs [--endpoint http://127.0.0.1:9222] [--output perf-results/midi] [--messages 5000] [--rate 500] [--controls 16] [--kind continuous] [--run-id ID] [--scenario ID] [--variant current]");
    return;
  }
  const ratePerSecond = Number.parseInt(args.rate ?? "500", 10);
  const durationSeconds = Number.parseInt(args["duration-seconds"] ?? "10", 10);
  const messageCount = Number.parseInt(args.messages ?? String(ratePerSecond * durationSeconds), 10);
  const controlCount = Number.parseInt(args.controls ?? "16", 10);
  const messageKind = String(args.kind ?? "continuous").toLowerCase();
  const scenarioId = args.scenario ?? `midi-${messageKind}-${ratePerSecond}hz-${controlCount}controls`;
  const output = resolve(args.output ?? join("perf-results", "midi", scenarioId));
  const result = await runMidiJourney({
    endpoint: args.endpoint ?? "http://127.0.0.1:9222",
    output,
    urlPattern: args["url-pattern"] ?? "index.html",
    messageCount,
    ratePerSecond,
    controlCount,
    messageKind,
    runId: args["run-id"] ?? `midi-${Date.now()}`,
    scenarioId,
    variant: args.variant ?? "current",
  });
  console.log(`Injected ${result.injection.message_count} ${result.injection.message_kind} messages; wrote ${result.records.length} records to ${output}`);
}

runMain(import.meta.url, main);

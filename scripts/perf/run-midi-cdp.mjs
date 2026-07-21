#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpSession, findTarget } from "./capture-cdp.mjs";
import { parseArgs } from "./lib/cli.mjs";
import { writeJson } from "./lib/files.mjs";

function metricRecord(identity, metric, value, unit, kind = "operation", dimensions = {}) {
  return {
    schema_version: "1.0.0",
    run_id: identity.run_id,
    scenario_id: identity.scenario_id,
    variant: identity.variant,
    timestamp: new Date().toISOString(),
    kind,
    metric,
    value: Number(value),
    unit,
    commit: null,
    build: "renderer-cdp-midi",
    dimensions,
  };
}

export function normalizedRecords(snapshot, injection, frontend, fallback) {
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
  const latestValue = snapshot.latest_value ?? {};
  const records = [
    metricRecord(identity, "midi.injection_duration", injection.scheduled_duration_us / 1000, "ms", "operation", dimensions),
    metricRecord(identity, "midi.native_action_p50", native.p50_us / 1000, "ms", "operation", dimensions),
    metricRecord(identity, "midi.native_action_p95", native.p95_us / 1000, "ms", "operation", dimensions),
    metricRecord(identity, "midi.native_action_p99", native.p99_us / 1000, "ms", "operation", dimensions),
    metricRecord(identity, "midi.native_action_samples", native.samples, "count", "counter", dimensions),
    metricRecord(identity, "midi.events_enqueued", queue.enqueued, "count", "counter", dimensions),
    metricRecord(identity, "midi.events_drained", queue.drained, "count", "counter", dimensions),
    metricRecord(identity, "midi.events_coalesced", queue.coalesced, "count", "counter", dimensions),
    metricRecord(identity, "midi.events_dropped", queue.dropped, "count", "counter", dimensions),
    metricRecord(identity, "midi.queue_depth", Number(queue.pending_continuous || 0) + Number(queue.pending_preserved || 0), "count", "resource", dimensions),
    metricRecord(identity, "midi.latest_value_mismatches", latestValue.mismatches, "count", "counter", dimensions),
  ];
  if (["button", "action"].includes(injection.message_kind)) {
    records.push(metricRecord(identity, "midi.button_events_dropped", queue.dropped, "count", "counter", dimensions));
  }
  for (const entry of frontend?.entries ?? []) {
    if (entry?.kind === "operation" && entry?.name === "midi-visible-update" && Number.isFinite(entry.durationMs)) {
      records.push(metricRecord(identity, "midi.visible_update", entry.durationMs, "ms", "operation", {
        ...dimensions,
        ...(entry.detail && typeof entry.detail === "object" ? entry.detail : {}),
      }));
    }
  }
  return records.filter((record) => Number.isFinite(record.value));
}

export async function runMidiJourney({ endpoint, output, urlPattern, messageCount, ratePerSecond, controlCount, messageKind, runId, scenarioId, variant, timeoutMs = 30000 }) {
  if (!Number.isInteger(messageCount) || messageCount < 1 || messageCount > 1_000_000) throw new Error("messageCount must be between 1 and 1,000,000");
  if (!Number.isInteger(ratePerSecond) || ratePerSecond < 1 || ratePerSecond > 10_000) throw new Error("ratePerSecond must be between 1 and 10,000");
  if (!Number.isInteger(controlCount) || controlCount < 1 || controlCount > 16) throw new Error("controlCount must be between 1 and 16");
  if (!["continuous", "button", "action"].includes(messageKind)) throw new Error("messageKind must be continuous, button, or action");
  await mkdir(output, { recursive: true });
  const target = await findTarget(endpoint, urlPattern, timeoutMs);
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.open();
  try {
    const expression = `(async () => {
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) throw new Error("Tauri invoke bridge unavailable");
      await invoke("perf_audit_reset");
      const injection = await invoke("perf_audit_inject_midi", ${JSON.stringify({ messageCount, ratePerSecond, controlCount, messageKind })});
      await new Promise(resolve => setTimeout(resolve, 500));
      const snapshot = await invoke("perf_audit_snapshot");
      const frontend = window.__MIDIMASTER_PERF__?.snapshot?.() ?? null;
      return { injection, snapshot, frontend };
    })()`;
    const response = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "MIDI audit evaluation failed");
    const result = response.result?.value;
    if (!result?.injection || !result?.snapshot) throw new Error("MIDI audit commands returned no result; use a perf-audit build");
    await writeJson(join(output, "midi-injection.json"), result.injection);
    await writeJson(join(output, "native-snapshot.json"), result.snapshot);
    await writeJson(join(output, "frontend-snapshot.json"), result.frontend);
    const records = normalizedRecords(result.snapshot, result.injection, result.frontend, { runId, scenarioId, variant });
    await writeFile(join(output, "midi.ndjson"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    return { records, injection: result.injection, snapshot: result.snapshot };
  } finally {
    session.close();
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}

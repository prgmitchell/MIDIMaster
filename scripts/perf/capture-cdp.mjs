#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, runMain } from "./lib/cli.mjs";
import { writeJson } from "./lib/files.mjs";

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export class CdpSession {
  constructor(url) {
    if (typeof WebSocket === "undefined") throw new Error("Automated CDP capture requires Node 22 or newer (global WebSocket support)");
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener("open", resolvePromise, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket connection failed")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`${pending.method}: CDP connection closed`));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: CDP response timed out`));
      }, 60000);
      this.pending.set(id, { resolve: resolvePromise, reject, method, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, callback) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), callback]);
  }

  once(method) {
    return new Promise((resolvePromise) => {
      const callback = (params) => {
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((item) => item !== callback));
        resolvePromise(params);
      };
      this.on(method, callback);
    });
  }

  close() {
    this.socket.close();
  }
}

export async function findTarget(endpoint, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/list`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl && (!pattern || item.url.includes(pattern)));
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`No matching CDP page appeared at ${endpoint}${lastError ? `: ${lastError.message}` : ""}`);
}

async function readProtocolStream(session, handle) {
  let output = "";
  while (true) {
    const chunk = await session.send("IO.read", { handle });
    output += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data;
    if (chunk.eof) break;
  }
  await session.send("IO.close", { handle });
  return output;
}

export async function captureCdp({ endpoint, output, urlPattern = "index.html", durationMs = 10000, timeoutMs = 30000, heap = true, dom = true }) {
  const target = await findTarget(endpoint, urlPattern, timeoutMs);
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.open();
  try {
    await session.send("Performance.enable");
    const before = await session.send("Performance.getMetrics");
    const auditSnapshot = await session.send("Runtime.evaluate", {
      expression: "window.__MIDIMASTER_PERF__?.snapshot?.() ?? null",
      returnByValue: true,
      awaitPromise: true,
    });
    await writeJson(join(output, "frontend-snapshot.json"), auditSnapshot.result?.value ?? null);
    const nativeAuditSnapshot = await session.send("Runtime.evaluate", {
      expression: "window.__TAURI__?.core?.invoke ? window.__TAURI__.core.invoke('perf_audit_snapshot').catch(error => ({ unavailable: String(error) })) : null",
      returnByValue: true,
      awaitPromise: true,
    });
    await writeJson(join(output, "native-snapshot.json"), nativeAuditSnapshot.result?.value ?? null);
    await writeJson(join(output, "performance-before.devtools.json"), before);

    if (dom) {
      const snapshot = await session.send("DOMSnapshot.captureSnapshot", {
        computedStyles: [],
        includePaintOrder: true,
        includeDOMRects: true,
      });
      await writeJson(join(output, "dom-snapshot.devtools.json"), snapshot);
    }

    await session.send("Tracing.start", {
      categories: "devtools.timeline,blink.user_timing,v8,disabled-by-default-v8.cpu_profiler",
      transferMode: "ReturnAsStream",
      options: "sampling-frequency=10000",
    });
    await sleep(durationMs);
    const complete = session.once("Tracing.tracingComplete");
    await session.send("Tracing.end");
    const { stream } = await complete;
    if (stream) await writeFile(join(output, "renderer-trace.devtools.json"), await readProtocolStream(session, stream), "utf8");

    if (heap) {
      const chunks = [];
      session.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => chunks.push(chunk));
      await session.send("HeapProfiler.enable");
      await session.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: true });
      await writeFile(join(output, "renderer.heapsnapshot"), chunks.join(""), "utf8");
    }
    const after = await session.send("Performance.getMetrics");
    await writeJson(join(output, "performance-after.devtools.json"), after);
    await writeJson(join(output, "target.devtools.json"), { type: target.type, title: target.title, url: target.url });
  } finally {
    session.close();
  }
}

function metricName(value) {
  return String(value || "unknown").trim().toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function snapshotRecords(snapshot, { variant = "current", nativeRunId = null, scenarioId = null } = {}) {
  if (!snapshot?.runId || !snapshot?.scenario) return [];
  const runId = nativeRunId || snapshot.runId;
  const dimensions = { window: snapshot.window ?? "main", ui_run_id: snapshot.runId, ui_scenario_id: snapshot.scenario };
  const base = (entry, metric, value, unit, kind) => ({
    schema_version: "1.0.0",
    run_id: runId,
    scenario_id: scenarioId || snapshot.scenario,
    variant,
    timestamp: entry?.timestamp ?? snapshot.capturedAt ?? new Date().toISOString(),
    kind,
    metric,
    value: Number(value),
    unit,
    commit: null,
    build: "renderer-cdp",
    dimensions,
  });
  const records = [];
  const hasBootstrapMeasure = snapshot.entries?.some((entry) => entry.kind === "measure" && entry.name === "bootstrap-to-bindings-usable");
  for (const entry of snapshot.entries ?? []) {
    if (entry.kind === "measure" && entry.name === "bootstrap-to-bindings-usable") {
      records.push(base(entry, "startup.bindings_usable", entry.durationMs, "ms", "milestone"));
    } else if (entry.kind === "milestone" && entry.name === "bindings-usable" && !hasBootstrapMeasure) {
      records.push(base(entry, "startup.bindings_usable", entry.startTimeMs, "ms", "milestone"));
    } else if (entry.kind === "long-task") {
      records.push(base(entry, "renderer.long_task", entry.durationMs, "ms", "operation"));
    } else if (entry.kind === "frame") {
      records.push(base(entry, "renderer.frame", entry.durationMs, "ms", "resource"));
    } else if (entry.kind === "ipc") {
      records.push(base(entry, `ipc.${metricName(entry.name)}`, entry.durationMs, "ms", "operation"));
    } else if (Number.isFinite(entry.durationMs)) {
      records.push(base(entry, `frontend.${metricName(entry.name)}`, entry.durationMs, "ms", "operation"));
    } else if (Number.isFinite(entry.startTimeMs)) {
      records.push(base(entry, `frontend.milestone.${metricName(entry.name)}`, entry.startTimeMs, "ms", "milestone"));
    }
  }
  if (Number.isFinite(snapshot.resources?.domNodes)) records.push(base(null, "renderer.dom_nodes", snapshot.resources.domNodes, "count", "resource"));
  if (Number.isFinite(snapshot.resources?.heapUsedBytes)) records.push(base(null, "renderer.heap_used", snapshot.resources.heapUsedBytes, "bytes", "resource"));
  if (Number.isFinite(snapshot.ipc?.count)) records.push(base(null, "ipc.count", snapshot.ipc.count, "count", "counter"));
  if (Number.isFinite(snapshot.ipc?.errors)) records.push(base(null, "ipc.errors", snapshot.ipc.errors, "count", "counter"));
  return records.filter((record) => Number.isFinite(record.value));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["no-heap", "no-dom", "help"] });
  if (args.help) {
    console.log("Usage: node scripts/perf/capture-cdp.mjs [--endpoint http://127.0.0.1:9222] [--output perf-results/cdp] [--url-pattern index.html] [--duration-ms 10000] [--variant current] [--native-run-id ID] [--scenario ID] [--no-heap] [--no-dom]");
    return;
  }
  const output = resolve(args.output ?? join("perf-results", "cdp"));
  await captureCdp({
    endpoint: args.endpoint ?? "http://127.0.0.1:9222",
    output,
    urlPattern: args["url-pattern"] ?? "index.html",
    durationMs: Number.parseInt(args["duration-ms"] ?? "10000", 10),
    timeoutMs: Number.parseInt(args["timeout-ms"] ?? "30000", 10),
    heap: !args["no-heap"],
    dom: !args["no-dom"],
  });
  const snapshot = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(output, "frontend-snapshot.json"), "utf8")));
  const records = snapshotRecords(snapshot, {
    variant: args.variant ?? "current",
    nativeRunId: args["native-run-id"] ?? null,
    scenarioId: args.scenario ?? null,
  });
  await writeFile(join(output, "frontend.ndjson"), `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length ? "\n" : ""}`, "utf8");
  await writeJson(join(output, "correlation.json"), {
    schema_version: "1.0.0",
    native_run_id: args["native-run-id"] ?? null,
    ui_run_id: snapshot?.runId ?? null,
    scenario_id: args.scenario ?? snapshot?.scenario ?? null,
    ui_scenario_id: snapshot?.scenario ?? null,
    variant: args.variant ?? "current",
  });
  console.log(`Wrote private CDP artifacts to ${output}`);
}

runMain(import.meta.url, main);

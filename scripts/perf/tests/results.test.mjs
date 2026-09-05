import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateReport } from "../generate-report.mjs";
import { summarizeValues, validateRecord } from "../lib/results.mjs";
import { snapshotRecords } from "../capture-cdp.mjs";
import { normalizedRecords as midiRecords } from "../run-midi-cdp.mjs";

function record(variant, value, run) {
  return {
    schema_version: "1.0.0",
    run_id: `${variant}-${run}`,
    scenario_id: "startup-warm-b50-p1-light",
    variant,
    timestamp: new Date(1_700_000_000_000 + run).toISOString(),
    kind: "milestone",
    metric: "startup.bindings_usable",
    value,
    unit: "ms",
    commit: null,
    build: "midimaster.exe",
    dimensions: {},
    hardware: { os: "test", cpu_logical_count: 4, memory_bytes: 8_000_000_000 },
  };
}

test("summary statistics use deterministic interpolated percentiles", () => {
  const result = summarizeValues([1, 2, 3, 4, 5]);
  assert.deepEqual(result, { count: 5, minimum: 1, median: 3, mean: 3, p95: 4.8, p99: 4.96, maximum: 5 });
});

test("result validation rejects non-scalar dimensions", () => {
  assert.throws(() => validateRecord({ ...record("current", 10, 1), dimensions: { path: { private: true } } }), /dimensions values must be scalar/);
});

test("report emits JSON, trend CSV, and matched Markdown comparison", async () => {
  const root = await mkdtemp(join(tmpdir(), "midimaster-report-test-"));
  try {
    const input = join(root, "records.ndjson");
    const records = [record("installed", 1000, 1), record("installed", 1100, 2), record("current", 800, 1), record("current", 900, 2)];
    await writeFile(input, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`);
    const output = join(root, "report");
    const summary = await generateReport({ inputs: [input], output, baselineVariant: "installed" });
    assert.equal(summary.groups.length, 2);
    assert.equal(summary.comparisons.length, 1);
    assert.equal(summary.comparisons[0].deltas.median.absolute, -200);
    assert.match(await readFile(join(output, "metrics.csv"), "utf8"), /startup\.bindings_usable/);
    assert.match(await readFile(join(output, "comparison.md"), "utf8"), /installed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frontend snapshot records correlate UI and native audit identifiers", () => {
  const snapshot = {
    runId: "ui-123",
    scenario: "installed-release",
    window: "main",
    capturedAt: "2026-01-01T00:00:00.000Z",
    resources: { domNodes: 42, heapUsedBytes: 1024 },
    ipc: { count: 3, errors: 0 },
    entries: [
      { kind: "milestone", name: "bindings-usable", startTimeMs: 900, timestamp: "2026-01-01T00:00:00.000Z" },
      { kind: "measure", name: "bootstrap-to-bindings-usable", durationMs: 850, timestamp: "2026-01-01T00:00:00.000Z" },
    ],
  };
  const records = snapshotRecords(snapshot, { variant: "wave-1", nativeRunId: "native-123", scenarioId: "startup-warm-b50" });
  const startup = records.filter((record) => record.metric === "startup.bindings_usable");
  assert.equal(startup.length, 1);
  assert.equal(startup[0].value, 850);
  assert.equal(startup[0].run_id, "native-123");
  assert.equal(startup[0].scenario_id, "startup-warm-b50");
  assert.equal(startup[0].dimensions.ui_run_id, "ui-123");
});

test("MIDI results include enqueue-to-visible frontend samples", () => {
  const records = midiRecords(
    {
      run_id: "native-midi",
      schema_version: 2,
      scenario_id: "midi-continuous-500hz-16controls",
      variant: "current",
      queue: { enqueued: 2, drained: 2, coalesced: 0, dropped: 0 },
      native_action: { samples: 2, p50_us: 1_000, p95_us: 2_000, p99_us: 2_000 },
      latest_value: { controls: 1, mismatches: 0, converged: true },
    },
    { message_kind: "continuous", rate_per_second: 500, control_count: 16, message_count: 2, scheduled_duration_us: 4_000 },
    { entries: [{ kind: "operation", name: "midi-visible-update", durationMs: 8.5, detail: { controller: 1 } }] },
    { runId: "fallback", scenarioId: "fallback", variant: "current" },
  );
  const visible = records.find((record) => record.metric === "midi.visible_update");
  assert.equal(visible.value, 8.5);
  assert.equal(visible.run_id, "native-midi");
  assert.equal(visible.dimensions.controller, 1);
  assert.equal(records.find((record) => record.metric === "midi.latest_value_mismatches").value, 0);
});

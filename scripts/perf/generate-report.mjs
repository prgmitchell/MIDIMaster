#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli.mjs";
import { writeJson, writeText } from "./lib/files.mjs";
import { buildComparisons, readResultRecords, summarizeRecords } from "./lib/results.mjs";

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function groupsCsv(groups) {
  const fields = ["variant", "scenario_id", "metric", "unit", "count", "minimum", "median", "mean", "p95", "p99", "maximum"];
  return `${fields.join(",")}\n${groups.map((group) => fields.map((field) => csvCell(group[field])).join(",")).join("\n")}\n`;
}

function formatNumber(value) {
  if (value === null || value === undefined) return "n/a";
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(3);
}

export function comparisonMarkdown(summary) {
  const lines = [
    "# MIDIMaster performance comparison",
    "",
    `Generated: ${summary.generated_at}`,
    "",
    `Records: ${summary.record_count}; runs: ${summary.run_count}; baseline: ${summary.baseline_variant ?? "not selected"}.`,
    "",
  ];
  if (!summary.comparisons.length) {
    lines.push("No matched baseline/candidate metric groups were available.", "");
    return lines.join("\n");
  }
  lines.push("| Candidate | Scenario | Metric | Statistic | Baseline | Candidate | Delta | Delta % |", "|---|---|---|---:|---:|---:|---:|---:|");
  for (const item of summary.comparisons) {
    for (const statistic of ["median", "p95", "p99"]) {
      const delta = item.deltas[statistic];
      lines.push(`| ${item.candidate_variant} | ${item.scenario_id} | ${item.metric} (${item.unit}) | ${statistic} | ${formatNumber(item.baseline[statistic])} | ${formatNumber(item.candidate[statistic])} | ${formatNumber(delta.absolute)} | ${delta.percent === null ? "n/a" : `${formatNumber(delta.percent)}%`} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function sanitizedRunMetadata(records) {
  const runs = new Map();
  for (const record of records) {
    if (!runs.has(record.run_id)) {
      runs.set(record.run_id, {
        run_id: record.run_id,
        variant: record.variant,
        commit: record.commit ?? null,
        build: record.build ?? null,
        hardware: record.hardware ?? null,
      });
    }
  }
  return [...runs.values()];
}

export async function generateReport({ inputs, output, baselineVariant = null }) {
  const records = await readResultRecords(inputs);
  if (!records.length) throw new Error("No performance result records found");
  const groups = summarizeRecords(records);
  const summary = {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    baseline_variant: baselineVariant,
    record_count: records.length,
    run_count: new Set(records.map((record) => record.run_id)).size,
    runs: sanitizedRunMetadata(records),
    groups,
    comparisons: buildComparisons(groups, baselineVariant),
  };
  await mkdir(output, { recursive: true });
  await writeJson(join(output, "summary.json"), summary);
  await writeText(join(output, "metrics.csv"), groupsCsv(groups));
  await writeText(join(output, "comparison.md"), comparisonMarkdown(summary));
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { repeated: ["input"], booleans: ["help"] });
  if (args.help) {
    console.log("Usage: node scripts/perf/generate-report.mjs --input PATH [--input PATH] [--output perf-results/report] [--baseline installed]");
    return;
  }
  const inputs = (args.input ?? []).map((path) => resolve(path));
  if (!inputs.length) throw new Error("At least one --input path is required");
  const output = resolve(args.output ?? join("perf-results", "report"));
  const summary = await generateReport({ inputs, output, baselineVariant: args.baseline ?? null });
  console.log(`Wrote ${summary.groups.length} metric groups from ${summary.record_count} records to ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}

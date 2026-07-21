import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { listFilesRecursively } from "./files.mjs";

const VALID_UNITS = new Set(["ms", "bytes", "percent", "count", "bytes_per_second"]);
const VALID_KINDS = new Set(["milestone", "operation", "resource", "counter"]);

export function validateRecord(record, source = "record") {
  const problems = [];
  if (record?.schema_version !== "1.0.0") problems.push("schema_version must be 1.0.0");
  for (const field of ["run_id", "scenario_id", "variant", "timestamp", "metric", "unit"]) {
    if (typeof record?.[field] !== "string" || !record[field]) problems.push(`${field} is required`);
  }
  if (typeof record?.value !== "number" || !Number.isFinite(record.value)) problems.push("value must be finite");
  if (!VALID_UNITS.has(record?.unit)) problems.push(`unsupported unit '${record?.unit}'`);
  if (!VALID_KINDS.has(record?.kind)) problems.push(`unsupported kind '${record?.kind}'`);
  if (typeof record?.metric === "string" && !/^[a-z0-9][a-z0-9_.-]*$/.test(record.metric)) problems.push("metric has invalid characters");
  if (typeof record?.timestamp === "string" && !Number.isFinite(Date.parse(record.timestamp))) problems.push("timestamp must be ISO-compatible");
  if (record?.dimensions && Object.values(record.dimensions).some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value))) {
    problems.push("dimensions values must be scalar");
  }
  if (problems.length) throw new Error(`${source}: ${problems.join("; ")}`);
  return record;
}

function recordsFromJson(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.records)) return value.records;
  if (value?.metric) return [value];
  return [];
}

export async function readResultRecords(inputs) {
  const paths = [];
  for (const input of inputs) {
    if ((await import("node:fs/promises").then(({ stat }) => stat(input))).isDirectory()) {
      paths.push(...await listFilesRecursively(input, new Set([".json", ".jsonl", ".ndjson"])));
    } else {
      paths.push(input);
    }
  }
  const records = [];
  for (const path of paths.sort()) {
    const text = await readFile(path, "utf8");
    if (!text.trim()) continue;
    let values;
    if ([".jsonl", ".ndjson"].includes(extname(path).toLowerCase())) {
      values = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    } else {
      values = recordsFromJson(JSON.parse(text));
    }
    for (const [index, value] of values.entries()) records.push(validateRecord(value, `${path}:${index + 1}`));
  }
  return records;
}

export function percentile(sorted, quantile) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
}

export function summarizeValues(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minimum: sorted[0],
    median: percentile(sorted, 0.5),
    mean: sum / sorted.length,
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    maximum: sorted.at(-1),
  };
}

export function summarizeRecords(records) {
  const grouped = new Map();
  for (const record of records) {
    const key = JSON.stringify([record.variant, record.scenario_id, record.metric, record.unit]);
    const group = grouped.get(key) ?? {
      variant: record.variant,
      scenario_id: record.scenario_id,
      metric: record.metric,
      unit: record.unit,
      values: [],
    };
    group.values.push(record.value);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map(({ values, ...identity }) => ({ ...identity, ...summarizeValues(values) }))
    .sort((a, b) => `${a.variant}\0${a.scenario_id}\0${a.metric}`.localeCompare(`${b.variant}\0${b.scenario_id}\0${b.metric}`));
}

export function buildComparisons(groups, baselineVariant) {
  if (!baselineVariant) return [];
  const baseline = new Map();
  for (const group of groups.filter((item) => item.variant === baselineVariant)) {
    baseline.set(JSON.stringify([group.scenario_id, group.metric, group.unit]), group);
  }
  const comparisons = [];
  for (const candidate of groups.filter((item) => item.variant !== baselineVariant)) {
    const base = baseline.get(JSON.stringify([candidate.scenario_id, candidate.metric, candidate.unit]));
    if (!base) continue;
    const deltas = {};
    for (const statistic of ["median", "mean", "p95", "p99", "maximum"]) {
      const absolute = candidate[statistic] - base[statistic];
      deltas[statistic] = {
        absolute,
        percent: base[statistic] === 0 ? null : absolute / base[statistic] * 100,
      };
    }
    comparisons.push({
      baseline_variant: baselineVariant,
      candidate_variant: candidate.variant,
      scenario_id: candidate.scenario_id,
      metric: candidate.metric,
      unit: candidate.unit,
      baseline: base,
      candidate,
      deltas,
    });
  }
  return comparisons;
}

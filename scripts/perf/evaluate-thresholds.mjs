#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs, requireArg, runMain } from "./lib/cli.mjs";
import { readJson, writeJson } from "./lib/files.mjs";

function wildcard(pattern, value) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function matches(rule, group) {
  return wildcard(rule.scenario, group.scenario_id)
    && wildcard(rule.metric, group.metric)
    && (!rule.unit || rule.unit === group.unit);
}

export function evaluateBudgets({ baseline, candidate, budgets, requireAll = false }) {
  const checks = [];
  for (const rule of budgets.absolute ?? []) {
    const groups = candidate.groups.filter((group) => matches(rule, group));
    if (!groups.length) {
      checks.push({ type: "absolute", name: rule.name, status: requireAll ? "fail" : "missing", reason: "no matching metric" });
      continue;
    }
    for (const group of groups) {
      const actual = group[rule.statistic];
      checks.push({
        type: "absolute",
        name: rule.name,
        scenario_id: group.scenario_id,
        metric: group.metric,
        statistic: rule.statistic,
        actual,
        maximum: rule.maximum,
        unit: group.unit,
        status: actual <= rule.maximum ? "pass" : "fail",
      });
    }
  }

  for (const rule of budgets.compound ?? []) {
    const identities = new Map();
    for (const group of candidate.groups.filter((item) => wildcard(rule.scenario, item.scenario_id))) {
      identities.set(`${group.variant}\0${group.scenario_id}`, { variant: group.variant, scenario_id: group.scenario_id });
    }
    if (!identities.size) {
      checks.push({ type: "compound", name: rule.name, status: requireAll ? "fail" : "missing", reason: "no matching scenario" });
      continue;
    }
    for (const identity of identities.values()) {
      const results = rule.checks.map((limit) => {
        const group = candidate.groups.find((item) => item.variant === identity.variant
          && item.scenario_id === identity.scenario_id
          && wildcard(limit.metric, item.metric)
          && (!limit.unit || limit.unit === item.unit));
        return group ? {
          metric: group.metric,
          actual: group[rule.statistic],
          maximum: limit.maximum,
          unit: group.unit,
          exceeded: group[rule.statistic] > limit.maximum,
        } : null;
      });
      if (results.some((result) => result === null)) {
        checks.push({ type: "compound", name: rule.name, scenario_id: identity.scenario_id, status: requireAll ? "fail" : "missing", reason: "one or more component metrics are missing" });
        continue;
      }
      const failed = rule.failure_when === "all_exceeded"
        ? results.every((result) => result.exceeded)
        : results.some((result) => result.exceeded);
      checks.push({
        type: "compound",
        name: rule.name,
        scenario_id: identity.scenario_id,
        statistic: rule.statistic,
        components: results,
        status: failed ? "fail" : "pass",
      });
    }
  }

  if (baseline) {
    for (const rule of budgets.regression ?? []) {
      const candidateGroups = candidate.groups.filter((group) => matches(rule, group));
      if (!candidateGroups.length) {
        checks.push({ type: "regression", name: rule.name, status: requireAll ? "fail" : "missing", reason: "no matching candidate metric" });
        continue;
      }
      for (const group of candidateGroups) {
        const base = baseline.groups.find((item) => item.scenario_id === group.scenario_id && item.metric === group.metric && item.unit === group.unit);
        if (!base) {
          checks.push({ type: "regression", name: rule.name, scenario_id: group.scenario_id, metric: group.metric, status: requireAll ? "fail" : "missing", reason: "no matching baseline metric" });
          continue;
        }
        const baseValue = base[rule.statistic];
        const candidateValue = group[rule.statistic];
        const delta = candidateValue - baseValue;
        const relativePercent = baseValue === 0 ? (delta > 0 ? Number.POSITIVE_INFINITY : 0) : delta / baseValue * 100;
        // The agreed stable gate fails only when both tolerances are exceeded.
        const failed = delta > rule.absolute && relativePercent > rule.relative_percent;
        checks.push({
          type: "regression",
          name: rule.name,
          scenario_id: group.scenario_id,
          metric: group.metric,
          statistic: rule.statistic,
          baseline: baseValue,
          candidate: candidateValue,
          delta,
          relative_percent: relativePercent,
          allowed_absolute: rule.absolute,
          allowed_relative_percent: rule.relative_percent,
          unit: group.unit,
          status: failed ? "fail" : "pass",
        });
      }
    }
  }
  return {
    schema_version: "1.0.0",
    evaluated_at: new Date().toISOString(),
    passed: !checks.some((check) => check.status === "fail"),
    checks,
  };
}

function selectVariant(summary, variant) {
  if (!variant) return summary;
  return { ...summary, groups: summary.groups.filter((group) => group.variant === variant) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["require-all", "help"] });
  if (args.help) {
    console.log("Usage: node scripts/perf/evaluate-thresholds.mjs --candidate summary.json [--candidate-variant current] [--baseline summary.json] [--baseline-variant installed] [--budgets FILE] [--output FILE] [--require-all]");
    return;
  }
  const candidate = selectVariant(await readJson(resolve(requireArg(args, "candidate"))), args["candidate-variant"]);
  const baseline = args.baseline ? selectVariant(await readJson(resolve(args.baseline)), args["baseline-variant"]) : null;
  const budgets = await readJson(resolve(args.budgets ?? "scripts/perf/config/budgets.json"));
  const result = evaluateBudgets({ baseline, candidate, budgets, requireAll: Boolean(args["require-all"]) });
  if (args.output) await writeJson(resolve(args.output), result);
  for (const check of result.checks) {
    console.log(`${check.status.toUpperCase().padEnd(7)} ${check.name}${check.scenario_id ? ` [${check.scenario_id} / ${check.metric}]` : ""}`);
  }
  if (!result.passed) process.exitCode = 1;
}

runMain(import.meta.url, main);

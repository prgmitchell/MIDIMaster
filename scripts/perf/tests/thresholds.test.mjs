import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBudgets } from "../evaluate-thresholds.mjs";

const group = (median, p95 = median) => ({
  variant: "candidate",
  scenario_id: "startup-warm-b50",
  metric: "startup.bindings_usable",
  unit: "ms",
  count: 30,
  minimum: median,
  median,
  mean: median,
  p95,
  p99: p95,
  maximum: p95,
});

const budgets = {
  absolute: [{ name: "warm launch", scenario: "startup-warm-*", metric: "startup.bindings_usable", statistic: "p95", maximum: 1500, unit: "ms" }],
  regression: [{ name: "startup median", scenario: "startup-*", metric: "startup.*", statistic: "median", relative_percent: 10, absolute: 100, unit: "ms" }],
  compound: [{
    name: "memory growth",
    scenario: "endurance-*",
    statistic: "maximum",
    failure_when: "all_exceeded",
    checks: [
      { metric: "endurance.memory_growth_bytes", maximum: 10, unit: "bytes" },
      { metric: "endurance.memory_growth_percent", maximum: 5, unit: "percent" },
    ],
  }],
};

test("regression gate fails only when both relative and absolute tolerances are exceeded", () => {
  const baseline = { groups: [group(1000)] };
  assert.equal(evaluateBudgets({ baseline, candidate: { groups: [group(1090)] }, budgets }).passed, true);
  assert.equal(evaluateBudgets({ baseline, candidate: { groups: [group(1110)] }, budgets }).passed, false);
});

test("absolute acceptance budgets are independent of a baseline", () => {
  assert.equal(evaluateBudgets({ baseline: null, candidate: { groups: [group(1400)] }, budgets }).passed, true);
  assert.equal(evaluateBudgets({ baseline: null, candidate: { groups: [group(1600)] }, budgets }).passed, false);
});

test("missing metrics are advisory unless full matrix coverage is required", () => {
  assert.equal(evaluateBudgets({ candidate: { groups: [] }, budgets }).passed, true);
  assert.equal(evaluateBudgets({ candidate: { groups: [] }, budgets, requireAll: true }).passed, false);
});

test("endurance growth fails only above both byte and percentage allowances", () => {
  const enduranceGroup = (metric, maximum, unit) => ({
    ...group(maximum),
    scenario_id: "endurance-two-hour",
    metric,
    unit,
    maximum,
  });
  const belowOneAllowance = { groups: [
    enduranceGroup("endurance.memory_growth_bytes", 20, "bytes"),
    enduranceGroup("endurance.memory_growth_percent", 4, "percent"),
  ] };
  const aboveBoth = { groups: [
    enduranceGroup("endurance.memory_growth_bytes", 20, "bytes"),
    enduranceGroup("endurance.memory_growth_percent", 6, "percent"),
  ] };
  assert.equal(evaluateBudgets({ candidate: belowOneAllowance, budgets }).passed, true);
  assert.equal(evaluateBudgets({ candidate: aboveBoth, budgets }).passed, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { validateMeasurementWindow } from "../lib/measurement-window.mjs";

test("idle/endurance coverage requires the full duration with regular samples", () => {
  assert.deepEqual(validateMeasurementWindow({ started: 1000, finished: 121000, sampledAt: [1000, 31000, 61000, 91000], requestedSeconds: 120 }), {
    elapsedSeconds: 120, samples: 4, largestGapMs: 30000,
  });
});

test("suspension, missing samples, early completion and backwards clocks are rejected", () => {
  const window = { started: 0, finished: 7200000, sampledAt: [0, 30000], requestedSeconds: 7200 };
  assert.throws(() => validateMeasurementWindow(window), /interrupted/);
  assert.throws(() => validateMeasurementWindow({ ...window, sampledAt: [] }), /no resource samples/);
  assert.throws(() => validateMeasurementWindow({ ...window, finished: 30000 }), /before the requested duration/);
  assert.throws(() => validateMeasurementWindow({ ...window, sampledAt: [30000, 20000] }), /backwards/);
});

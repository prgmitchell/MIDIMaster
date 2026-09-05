import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createPerformanceAudit } from "../src/app/performance_audit.js";

performance.mark("unrelated-consumer");
let scheduled = 0;
const callbacks = new Map();
const audit = createPerformanceAudit({
  windowSource: {
    location: { search: "?perf-audit=1" },
    requestAnimationFrame(callback) { callbacks.set(++scheduled, callback); return scheduled; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
  },
  performanceSource: performance,
  PerformanceObserverSource: null,
  documentSource: null,
});
audit.startObservers();
assert.equal(scheduled, 1, "observer start is idempotent");
for (let index = 0; index < 12000; index++) audit.recordIpc("fixture", performance.now(), index % 3 !== 0);
for (let index = 0; index < 1000; index++) {
  audit.mark(`start-${index}`);
  audit.measure(`duration-${index}`, `start-${index}`);
}
const snapshot = audit.snapshot();
assert.equal(snapshot.ipc.count, 12000);
assert.equal(snapshot.ipc.errors, 4000);
assert.ok(snapshot.ipc.retainedSamples <= 5000);
assert.ok(snapshot.entries.length <= 5000);
assert.ok(performance.getEntries().filter(entry => entry.name.startsWith("midimaster:")).length <= 256);
audit.reset();
assert.equal(audit.snapshot().ipc.count, 0);
assert.equal(audit.snapshot().ipc.retainedSamples, 0);
assert.deepEqual(audit.snapshot().entries, []);
assert.equal(performance.getEntries().filter(entry => entry.name.startsWith("midimaster:")).length, 0);
assert.equal(performance.getEntriesByName("unrelated-consumer").length, 1);
audit.stopObservers();
assert.equal(callbacks.size, 0);
performance.clearMarks("unrelated-consumer");
let observed = 0;
const resultAudit = createPerformanceAudit({
  windowSource: {
    location: { search: "?perf-audit=1&perf-no-frames" },
    requestAnimationFrame(callback) { callbacks.set(++scheduled, callback); return scheduled; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
  },
  performanceSource: performance,
  PerformanceObserverSource: null,
  documentSource: null,
});
const applied = { binding_id: "a", volume: 0.5, perf_audit: { applied: true, sequence: 42, enqueued_epoch_ms: performance.timeOrigin + performance.now() } };
const flush = () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback()); };
resultAudit.recordMidiResult({ ...applied, perf_audit: { applied: false } }, () => observed);
assert.equal(callbacks.size, 0, "unverified inputs do not become renderer results");
resultAudit.recordMidiResult(applied, () => observed);
flush(); flush();
assert.deepEqual(resultAudit.snapshot().entries, [], "a stale displayed value is not counted as completion");
observed = 0.5;
resultAudit.recordMidiResult(applied, () => observed);
flush(); flush();
assert.equal(resultAudit.snapshot().entries.length, 2, "records renderer-local and correlated end-to-end intervals separately");
assert.equal(resultAudit.snapshot().renderedValues[0].sequence, 42);
resultAudit.recordMidiResult(applied, () => observed);
resultAudit.reset();
flush(); flush();
assert.deepEqual(resultAudit.snapshot().entries, [], "reset cancels pending result frames");
const rounded = { ...applied, volume: 6 / 127 };
resultAudit.recordMidiResult(rounded, () => 0.04);
flush(); flush();
assert.deepEqual(resultAudit.snapshot().renderedValues, [], "an adjacent stale slider step is not tagged with the new result sequence");
resultAudit.recordMidiResult(rounded, () => 0.05);
flush(); flush();
assert.equal(resultAudit.snapshot().renderedValues[0].value, 0.05, "the correctly rounded slider value completes");
resultAudit.stopObservers();
console.log("Performance audit buffers, reset and observer lifecycle passed");

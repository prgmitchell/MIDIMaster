import { matchesRenderedBindingValue } from "./performance_rendered_value.js";

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 5000;
const PERF_PREFIX = "midimaster:";
const MAX_TIMING_NAMES = 256;

function percentile(sorted, fraction) {
  if (!Array.isArray(sorted) || sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function randomRunId(cryptoSource) {
  if (typeof cryptoSource?.randomUUID === "function") {
    return cryptoSource.randomUUID();
  }
  return `perf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function queryOptions(locationSource) {
  try {
    const params = new URLSearchParams(locationSource?.search || "");
    return {
      enabled: params.get("perf-audit") === "1" || params.get("perfAudit") === "1",
      runId: String(params.get("perf-run-id") || params.get("perfRunId") || "").trim(),
      scenario: String(params.get("perf-scenario") || params.get("perfScenario") || "manual").trim() || "manual",
    };
  } catch {
    return { enabled: false, runId: "", scenario: "manual" };
  }
}

function windowLabel(windowSource) {
  try {
    return String(windowSource?.__TAURI_INTERNALS__?.metadata?.currentWindow?.label || "main");
  } catch {
    return "main";
  }
}

export function createPerformanceAudit({
  windowSource = typeof window !== "undefined" ? window : null,
  documentSource = typeof document !== "undefined" ? document : null,
  performanceSource = typeof performance !== "undefined" ? performance : null,
  cryptoSource = typeof crypto !== "undefined" ? crypto : null,
  PerformanceObserverSource = typeof PerformanceObserver !== "undefined" ? PerformanceObserver : null,
} = {}) {
  const query = queryOptions(windowSource?.location);
  const injected = windowSource?.__MIDIMASTER_PERF_AUDIT__;
  const enabled = query.enabled || injected === true || Boolean(injected?.enabled);
  const runId = query.runId || String(injected?.runId || "").trim() || randomRunId(cryptoSource);
  const scenario = String(injected?.scenario || query.scenario || "manual");
  const label = windowLabel(windowSource);
  const entries = [];
  const ipcDurations = [];
  let ipcCount = 0;
  let ipcErrors = 0;
  let longTaskObserver = null;
  let frameHandle = 0;
  let lastFrameAt = null;
  let observersStarted = false;
  const timingNames = new Set();
  const resultFrames = new Set();
  const pendingResults = new Map();
  const renderedValues = new Map();
  let resultFrameQueued = false;
  let resetGeneration = 0;

  function retainSample(samples, value) {
    if (samples.length >= MAX_ENTRIES) samples.splice(0, MAX_ENTRIES / 10);
    samples.push(value);
  }

  function retainTimingName(name) {
    performanceSource?.clearMarks?.(name);
    performanceSource?.clearMeasures?.(name);
    timingNames.delete(name);
    timingNames.add(name);
    if (timingNames.size > MAX_TIMING_NAMES) {
      const oldest = timingNames.values().next().value;
      performanceSource?.clearMarks?.(oldest);
      performanceSource?.clearMeasures?.(oldest);
      timingNames.delete(oldest);
    }
  }

  /** Start an independent run without retaining samples from a previous journey. */
  function reset() {
    resetGeneration += 1;
    for (const handle of resultFrames) windowSource?.cancelAnimationFrame?.(handle);
    resultFrames.clear();
    pendingResults.clear();
    renderedValues.clear();
    resultFrameQueued = false;
    entries.length = 0;
    ipcDurations.length = 0;
    ipcCount = 0;
    ipcErrors = 0;
    lastFrameAt = null;
    for (const name of timingNames) {
      performanceSource?.clearMarks?.(name);
      performanceSource?.clearMeasures?.(name);
    }
    timingNames.clear();
  }

  function now() {
    return Number(performanceSource?.now?.() ?? Date.now());
  }

  function resourceSnapshot() {
    const memory = performanceSource?.memory;
    return {
      domNodes: Number(documentSource?.getElementsByTagName?.("*")?.length || 0),
      heapUsedBytes: Number(memory?.usedJSHeapSize || 0),
      heapTotalBytes: Number(memory?.totalJSHeapSize || 0),
    };
  }

  function addEntry(kind, name, fields = {}) {
    if (!enabled) return null;
    const entry = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      scenario,
      window: label,
      kind: String(kind || "operation"),
      name: String(name || "unknown"),
      timestamp: new Date().toISOString(),
      ...fields,
    };
    retainSample(entries, entry);
    return entry;
  }

  function mark(name, detail = {}) {
    if (!enabled) return null;
    const markName = `${PERF_PREFIX}${name}`;
    const startTimeMs = now();
    retainTimingName(markName);
    try {
      performanceSource?.mark?.(markName, { detail });
    } catch {
      performanceSource?.mark?.(markName);
    }
    return addEntry("milestone", name, { startTimeMs, ...resourceSnapshot(), detail });
  }

  function measure(name, startMark, endMark = null, detail = {}) {
    if (!enabled) return null;
    const measureName = `${PERF_PREFIX}${name}`;
    retainTimingName(measureName);
    const options = {
      start: `${PERF_PREFIX}${startMark}`,
      ...(endMark ? { end: `${PERF_PREFIX}${endMark}` } : {}),
    };
    try {
      performanceSource?.measure?.(measureName, options);
      const measurement = performanceSource?.getEntriesByName?.(measureName, "measure")?.at?.(-1);
      return addEntry("measure", name, {
        startTimeMs: Number(measurement?.startTime || 0),
        durationMs: Number(measurement?.duration || 0),
        detail,
      });
    } catch {
      return null;
    }
  }

  function begin(name, detail = {}) {
    if (!enabled) return () => null;
    const startedAt = now();
    return (result = {}) => addEntry("operation", name, {
      startTimeMs: startedAt,
      durationMs: Math.max(0, now() - startedAt),
      detail: { ...detail, ...(result?.detail || {}) },
      ok: result?.ok !== false,
    });
  }

  function recordDuration(name, durationMs, detail = {}) {
    if (!enabled) return null;
    const normalizedDuration = Math.max(0, Number(durationMs || 0));
    return addEntry("operation", name, {
      startTimeMs: Math.max(0, now() - normalizedDuration),
      durationMs: normalizedDuration,
      detail,
      ok: true,
    });
  }

  function recordIpc(command, startedAt, ok, error = null) {
    if (!enabled) return;
    const durationMs = Math.max(0, now() - Number(startedAt || 0));
    ipcCount += 1;
    if (!ok) ipcErrors += 1;
    retainSample(ipcDurations, durationMs);
    addEntry("ipc", command, {
      startTimeMs: Number(startedAt || 0),
      durationMs,
      ok: Boolean(ok),
      ...(error ? { error: String(error?.message || error).slice(0, 500) } : {}),
    });
  }

  /** Measure verified action results only after the affected control has rendered. */
  function recordMidiResult(payload, readRenderedValue) {
    if (!enabled || !payload?.perf_audit?.applied || typeof windowSource?.requestAnimationFrame !== "function") return;
    const id = String(payload.binding_id || "");
    if (!id) return;
    const generation = resetGeneration;
    pendingResults.set(id, { payload, readRenderedValue, receivedAt: now() });
    if (pendingResults.size > MAX_ENTRIES) pendingResults.delete(pendingResults.keys().next().value);
    if (resultFrameQueued) return;
    resultFrameQueued = true;
    const schedule = (callback) => {
      const handle = windowSource.requestAnimationFrame(() => { resultFrames.delete(handle); callback(); });
      resultFrames.add(handle);
    };
    schedule(() => {
      const results = [...pendingResults.entries()];
      pendingResults.clear();
      resultFrameQueued = false;
      schedule(() => {
        if (generation !== resetGeneration) return;
        for (const [bindingId, result] of results) {
          const { payload: event, receivedAt, readRenderedValue: read } = result;
          const observed = read();
          if (!Number.isFinite(observed)) continue; // No visible control in this window.
          const expected = typeof event.muted === "boolean" ? Number(event.muted) : event.volume;
          if (!matchesRenderedBindingValue(observed, expected)) continue; // Superseded/echo-suppressed.
          const detail = { bindingId, sequence: event.perf_audit.sequence, value: observed };
          recordDuration("midi-renderer-completion", now() - receivedAt, detail);
          const elapsed = Number(performanceSource?.timeOrigin) + now() - Number(event.perf_audit.enqueued_epoch_ms);
          if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 60000) {
            recordDuration("midi-visible-update", elapsed, { ...detail, clock: "wall-correlated" });
          }
          renderedValues.set(bindingId, detail);
          if (renderedValues.size > MAX_ENTRIES) renderedValues.delete(renderedValues.keys().next().value);
        }
      });
    });
  }

  function snapshot() {
    const sortedIpc = ipcDurations.slice().sort((left, right) => left - right);
    return {
      schemaVersion: SCHEMA_VERSION,
      runId,
      scenario,
      window: label,
      capturedAt: new Date().toISOString(),
      resources: resourceSnapshot(),
      ipc: {
        count: ipcCount,
        errors: ipcErrors,
        retainedSamples: ipcDurations.length,
        p50Ms: percentile(sortedIpc, 0.5),
        p95Ms: percentile(sortedIpc, 0.95),
        p99Ms: percentile(sortedIpc, 0.99),
      },
      entries: entries.slice(),
      renderedValues: [...renderedValues.values()],
    };
  }

  function startObservers() {
    if (!enabled || observersStarted) return;
    observersStarted = true;
    if (PerformanceObserverSource) {
      try {
        longTaskObserver = new PerformanceObserverSource((list) => {
          list.getEntries().forEach((entry) => {
            addEntry("long-task", "renderer_long_task", {
              startTimeMs: Number(entry.startTime || 0),
              durationMs: Number(entry.duration || 0),
            });
          });
        });
        longTaskObserver.observe({ type: "longtask", buffered: true });
      } catch {
        longTaskObserver = null;
      }
    }

    const observeFrames = !new URLSearchParams(windowSource?.location?.search || "").has("perf-no-frames");
    if (observeFrames && typeof windowSource?.requestAnimationFrame === "function") {
      const onFrame = (frameAt) => {
        if (lastFrameAt != null) {
          const durationMs = Math.max(0, Number(frameAt) - lastFrameAt);
          if (durationMs >= 20) {
            addEntry("frame", "slow_frame", { startTimeMs: lastFrameAt, durationMs });
          }
        }
        lastFrameAt = Number(frameAt);
        frameHandle = windowSource.requestAnimationFrame(onFrame);
      };
      frameHandle = windowSource.requestAnimationFrame(onFrame);
    }
  }

  function stopObservers() {
    observersStarted = false;
    longTaskObserver?.disconnect?.();
    longTaskObserver = null;
    if (frameHandle && typeof windowSource?.cancelAnimationFrame === "function") {
      windowSource.cancelAnimationFrame(frameHandle);
    }
    frameHandle = 0;
    lastFrameAt = null;
  }

  const api = {
    enabled,
    runId,
    scenario,
    mark,
    measure,
    begin,
    recordDuration,
    now,
    recordIpc,
    recordMidiResult,
    snapshot,
    reset,
    startObservers,
    stopObservers,
  };

  if (enabled && windowSource) {
    windowSource.__MIDIMASTER_PERF__ = api;
    startObservers();
  }
  return api;
}

export const performanceAudit = createPerformanceAudit();

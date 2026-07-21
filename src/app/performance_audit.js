const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 5000;
const PERF_PREFIX = "midimaster:";

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
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    return entry;
  }

  function mark(name, detail = {}) {
    if (!enabled) return null;
    const markName = `${PERF_PREFIX}${name}`;
    const startTimeMs = now();
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
    ipcDurations.push(durationMs);
    addEntry("ipc", command, {
      startTimeMs: Number(startedAt || 0),
      durationMs,
      ok: Boolean(ok),
      ...(error ? { error: String(error?.message || error).slice(0, 500) } : {}),
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
        p50Ms: percentile(sortedIpc, 0.5),
        p95Ms: percentile(sortedIpc, 0.95),
        p99Ms: percentile(sortedIpc, 0.99),
      },
      entries: entries.slice(),
    };
  }

  function startObservers() {
    if (!enabled) return;
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

    if (typeof windowSource?.requestAnimationFrame === "function") {
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
    longTaskObserver?.disconnect?.();
    longTaskObserver = null;
    if (frameHandle && typeof windowSource?.cancelAnimationFrame === "function") {
      windowSource.cancelAnimationFrame(frameHandle);
    }
    frameHandle = 0;
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
    snapshot,
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

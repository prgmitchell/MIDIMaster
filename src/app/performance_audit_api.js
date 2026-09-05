const disabledAudit = {
  enabled: false,
  runId: "",
  scenario: "",
  mark: () => null,
  measure: () => null,
  begin: () => () => null,
  recordDuration: () => null,
  now: () => Number(globalThis.performance?.now?.() ?? Date.now()),
  recordIpc: () => {},
  recordMidiResult: () => {},
  snapshot: () => null,
  reset: () => {},
  startObservers: () => {},
  stopObservers: () => {},
};

let implementation = disabledAudit;
let initialization = null;

export function isPerformanceAuditRequested({
  locationSource = globalThis.location,
  injected = globalThis.__MIDIMASTER_PERF_AUDIT__,
} = {}) {
  try {
    const params = new URLSearchParams(locationSource?.search || "");
    return params.get("perf-audit") === "1"
      || params.get("perfAudit") === "1"
      || injected === true
      || Boolean(injected?.enabled);
  } catch {
    return injected === true || Boolean(injected?.enabled);
  }
}

export const performanceAudit = {
  get enabled() { return implementation.enabled; },
  get runId() { return implementation.runId; },
  get scenario() { return implementation.scenario; },
  mark(...args) { return implementation.mark(...args); },
  measure(...args) { return implementation.measure(...args); },
  begin(...args) { return implementation.begin(...args); },
  recordDuration(...args) { return implementation.recordDuration(...args); },
  now(...args) { return implementation.now(...args); },
  recordIpc(...args) { return implementation.recordIpc(...args); },
  recordMidiResult(...args) { return implementation.recordMidiResult(...args); },
  snapshot(...args) { return implementation.snapshot(...args); },
  reset(...args) { return implementation.reset(...args); },
  startObservers(...args) { return implementation.startObservers(...args); },
  stopObservers(...args) { return implementation.stopObservers(...args); },
};

export async function initializePerformanceAudit({
  loadAudit = () => import("./performance_audit.js"),
} = {}) {
  if (!isPerformanceAuditRequested()) return performanceAudit;
  if (!initialization) {
    initialization = Promise.resolve(loadAudit()).then((module) => {
      implementation = module.performanceAudit || module.createPerformanceAudit?.() || disabledAudit;
      return performanceAudit;
    });
  }
  return initialization;
}

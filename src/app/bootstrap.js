import { performanceAudit } from "./performance_audit_api.js";

export function createTauriBridge() {
  let coreApi = null;
  let eventApi = null;

  const invoke = async (...args) => {
    if (coreApi?.invoke) {
      if (!performanceAudit.enabled) {
        return coreApi.invoke(...args);
      }
      const startedAt = performanceAudit.now();
      try {
        const result = await coreApi.invoke(...args);
        performanceAudit.recordIpc(args[0], startedAt, true);
        return result;
      } catch (error) {
        performanceAudit.recordIpc(args[0], startedAt, false, error);
        throw error;
      }
    }
    throw new Error("Tauri API missing");
  };

  const listen = async (event, handler) => {
    if (eventApi?.listen) {
      return eventApi.listen(event, handler);
    }
    console.warn("Tauri Event API missing/delayed for listener:", event);
    return () => { };
  };

  const bind = () => {
    coreApi = window.__TAURI__?.core ?? null;
    eventApi = window.__TAURI__?.event ?? null;
    return Boolean(coreApi?.invoke && eventApi?.listen);
  };

  return {
    invoke,
    listen,
    bind,
  };
}

export function scheduleRetry(fn, delayMs = 200) {
  setTimeout(fn, delayMs);
}

import { initializePerformanceAudit, performanceAudit } from "./app/performance_audit_api.js";
import { hydrateThemeLogo } from "./app/theme_logo.js";

hydrateThemeLogo();

const STORAGE_KEY = "midimaster.pendingFrontendLogs";
const pendingLogs = [];
let flushInFlight = false;

function serializeError(error) {
  if (!error) return "";
  const parts = [];
  if (error.name) parts.push(`name=${error.name}`);
  if (error.message) parts.push(`message=${error.message}`);
  if (error.stack) parts.push(`stack=${error.stack}`);
  if (parts.length > 0) return parts.join(" ");
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function compactDetails(details = "") {
  return String(details || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4096);
}

function readStoredLogs() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function storePendingLogs() {
  try {
    const snapshot = pendingLogs.slice(-40);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore storage failures
  }
}

function clearStoredLogs() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

function enqueueLog(entry) {
  pendingLogs.push(entry);
  if (pendingLogs.length > 40) pendingLogs.shift();
  storePendingLogs();
}

async function flushLogs() {
  if (flushInFlight) return;
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") return;
  flushInFlight = true;
  try {
    while (pendingLogs.length > 0) {
      const entry = pendingLogs[0];
      await invoke("frontend_log", entry);
      pendingLogs.shift();
      storePendingLogs();
    }
    clearStoredLogs();
  } catch (error) {
    console.error("[midimaster:frontend-log] flush failed", error);
  } finally {
    flushInFlight = false;
  }
}

function logFrontend(level, component, event, details = "") {
  const entry = {
    level: String(level || "info"),
    component: String(component || "frontend"),
    event: String(event || "event"),
    details: compactDetails(details),
  };
  if (entry.level === "error") {
    console.error(`[midimaster:${entry.component}] ${entry.event}`, entry.details);
  }
  enqueueLog(entry);
  flushLogs();
}

window.__MIDIMASTER_DIAG__ = {
  log: logFrontend,
  error(component, event, error) {
    logFrontend("error", component, event, serializeError(error));
  },
};

readStoredLogs().forEach((entry) => enqueueLog(entry));

window.addEventListener("error", (event) => {
  logFrontend(
    "error",
    "frontend",
    "window_error",
    serializeError(event.error) || `${event.message || ""} at ${event.filename || ""}:${event.lineno || 0}:${event.colno || 0}`,
  );
});

window.addEventListener("unhandledrejection", (event) => {
  logFrontend("error", "frontend", "unhandled_rejection", serializeError(event.reason));
});

function onDocumentReady() {
  if (document.readyState !== "loading") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    document.addEventListener("DOMContentLoaded", resolve, { once: true });
  });
}

async function boot() {
  await initializePerformanceAudit();
  performanceAudit.mark("bootstrap-start", { readyState: document.readyState });
  logFrontend("info", "frontend", "boot_start", `ready_state=${document.readyState}`);
  if (window.__TAURI__?.core?.invoke) {
    logFrontend("info", "frontend", "tauri_api_seen", "phase=boot");
  }
  await onDocumentReady();
  performanceAudit.mark("dom-ready");
  logFrontend("info", "frontend", "dynamic_import_start", "module=app_entry.js");
  let appModule;
  try {
    appModule = await import("./app_entry.js");
    performanceAudit.mark("app-module-loaded");
    logFrontend("info", "frontend", "dynamic_import_ok", "module=app_entry.js");
  } catch (error) {
    logFrontend("error", "frontend", "dynamic_import_failed", serializeError(error));
    return;
  }

  try {
    logFrontend("info", "frontend", "app_start_start", "");
    await appModule.startMidimasterApp();
    logFrontend("info", "frontend", "app_start_ok", "");
  } catch (error) {
    logFrontend("error", "frontend", "app_start_failed", serializeError(error));
  }
}

boot();

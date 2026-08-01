import { createTauriBridge, scheduleRetry } from "./app/bootstrap.js";
import { initializePerformanceAudit, performanceAudit } from "./app/performance_audit_api.js";
import { createPluginDisplayMetadataCache } from "./app/plugin_display_metadata.js";
import { createTargetCore } from "./core/target_core.js";
import { createOsdFeature } from "./features/osd/osd.js";

const DEFAULT_SETTINGS = {
  enabled: true,
  anchor: "top-right",
  showBindingName: false,
  style: "midnight",
  opacity: 0.96,
  scale: 1,
};
const MASTER_ICON = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M5 4h2v10H5zM11 4h2v10h-2z' fill='white'/></svg>";
const FOCUS_ICON = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><circle cx='9' cy='9' r='5.5' stroke='white' stroke-width='2' fill='none'/><circle cx='9' cy='9' r='1.5' fill='white'/></svg>";

const bridge = createTauriBridge();
const { invoke, listen } = bridge;
const displayMetadata = createPluginDisplayMetadataCache({ invoke });
let settings = { ...DEFAULT_SETTINGS };
let sessions = [];
let focusedSession = null;
let playbackDevices = [];
let recordingDevices = [];
let refreshInFlight = null;
let lastRefreshAt = 0;
let started = false;
let firstTriggerReceivedAt = null;
let firstTriggerRecorded = false;

function normalizeSettings(value = {}) {
  return {
    enabled: Boolean(value.enabled ?? true),
    anchor: String(value.anchor || DEFAULT_SETTINGS.anchor),
    showBindingName: Boolean(value.show_binding_name ?? value.showBindingName ?? false),
    style: String(value.style || DEFAULT_SETTINGS.style),
    opacity: Math.min(1, Math.max(0.35, Number(value.opacity ?? DEFAULT_SETTINGS.opacity))),
    scale: Math.min(1.5, Math.max(0.75, Number(value.scale ?? DEFAULT_SETTINGS.scale))),
  };
}

function applySettings(value) {
  settings = normalizeSettings(value);
  document.body.dataset.anchor = settings.anchor;
  document.body.dataset.osdStyle = settings.style;
  document.body.style.setProperty("--osd-opacity", String(settings.opacity));
  document.body.style.setProperty("--osd-scale", String(settings.scale));
}

function createTargetIcon(option = {}) {
  if (option.icon_data) {
    const image = document.createElement("img");
    image.className = "target-icon";
    image.alt = "";
    const source = String(option.icon_data);
    image.src = source.startsWith("data:") || source.startsWith("assets/")
      ? source
      : `data:image/png;base64,${source}`;
    return image;
  }
  const fallback = document.createElement("span");
  fallback.className = "target-icon fallback";
  fallback.textContent = String(option.label || "?").trim().charAt(0).toUpperCase() || "?";
  return fallback;
}

const targetCore = createTargetCore({
  masterIconData: MASTER_ICON,
  focusIconData: FOCUS_ICON,
  mediaPlayPauseIconData: null,
  getSessions: () => sessions,
  getFocusedSession: () => focusedSession,
  getPlaybackDevices: () => playbackDevices,
  getRecordingDevices: () => recordingDevices,
  getPluginHost: () => null,
  getIntegrationDisplayMetadata: displayMetadata.getIntegrationDisplayMetadata,
  getIntegrationTargetState: () => null,
});

const osd = createOsdFeature({
  osdElement: document.getElementById("volume-osd"),
  isOsdWindow: true,
  osdDebugAlways: false,
  getOsdSettings: () => settings,
  resolveOsdTarget: targetCore.resolveOsdTarget,
  createTargetIcon,
  resolveTargetKey: targetCore.resolveTargetKey,
  onFirstRender: () => {
    performanceAudit.mark("osd-first-render");
    if (!performanceAudit.enabled || firstTriggerRecorded || firstTriggerReceivedAt == null) return;
    firstTriggerRecorded = true;
    const triggerReceivedAt = firstTriggerReceivedAt;
    requestAnimationFrame(() => {
      const durationMs = performanceAudit.now() - triggerReceivedAt;
      performanceAudit.recordDuration("osd-first-trigger", durationMs);
      invoke("perf_audit_record_result", {
        metric: "osd.first_trigger",
        value: durationMs,
        unit: "ms",
        kind: "operation",
        dimensions: { window: "osd" },
      }).catch(() => {});
    });
  },
});

function parsePayload(payload) {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function refreshAudioSnapshot(force = false) {
  const now = Date.now();
  if (!force && now - lastRefreshAt < 5000) return;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = Promise.allSettled([
    invoke("list_sessions"),
    invoke("focused_session"),
    invoke("list_playback_devices"),
    invoke("list_recording_devices"),
  ]).then(([nextSessions, nextFocus, nextPlayback, nextRecording]) => {
    if (nextSessions.status === "fulfilled" && Array.isArray(nextSessions.value)) sessions = nextSessions.value;
    if (nextFocus.status === "fulfilled") focusedSession = nextFocus.value ?? null;
    if (nextPlayback.status === "fulfilled" && Array.isArray(nextPlayback.value)) playbackDevices = nextPlayback.value;
    if (nextRecording.status === "fulfilled" && Array.isArray(nextRecording.value)) recordingDevices = nextRecording.value;
    lastRefreshAt = Date.now();
  }).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function integrationIdForTarget(target) {
  const integration = target?.Integration || target?.integration;
  return String(integration?.integration_id || "").trim();
}

async function ensureTargetDisplayMetadata(target) {
  const integrationId = integrationIdForTarget(target);
  if (!integrationId || displayMetadata.getIntegrationDisplayMetadata(integrationId)?.icon_data) return;
  await displayMetadata.warmIntegrationIcons([integrationId]);
}

async function handleDisplayEvent(event) {
  const payload = parsePayload(event?.payload);
  if (!payload || typeof payload !== "object") return;
  // `volume_update` and `mute_update` are also broadcast for normal main-window
  // feedback refreshes. Only the targeted OSD emission carries this marker.
  if (payload.osd_enabled !== true) return;
  if (performanceAudit.enabled && !firstTriggerRecorded && firstTriggerReceivedAt == null) {
    firstTriggerReceivedAt = performanceAudit.now();
  }
  if (Object.prototype.hasOwnProperty.call(payload, "focus_session")) {
    focusedSession = payload.focus_session ?? null;
  }
  await ensureTargetDisplayMetadata(payload.target).catch(() => {});
  refreshAudioSnapshot().catch(() => {});
  osd.handleOsdUpdate(payload);
}

async function start() {
  if (started) return;
  if (!bridge.bind()) {
    scheduleRetry(start, 50);
    return;
  }
  started = true;
  displayMetadata.loadManifests().catch(() => {});
  const loadedSettings = await invoke("get_osd_settings").catch(() => null);
  applySettings(loadedSettings || DEFAULT_SETTINGS);
  await Promise.all([
    listen("osd_settings_update", (event) => {
      const payload = parsePayload(event?.payload);
      if (!payload || typeof payload !== "object") return;
      const labelModeChanged = settings.showBindingName !== Boolean(
        payload.show_binding_name ?? payload.showBindingName ?? false,
      );
      applySettings(payload);
      if (!settings.enabled || labelModeChanged) osd.hideVolumeOsd();
    }),
    listen("volume_update", handleDisplayEvent),
    listen("mute_update", handleDisplayEvent),
  ]);
  performanceAudit.mark("osd-ready");
}

async function boot() {
  await initializePerformanceAudit();
  performanceAudit.mark("bootstrap-start", { entry: "osd" });
  await start();
}

boot().catch((error) => console.error("Failed to start OSD window", error));

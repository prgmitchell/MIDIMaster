import { PLUGINS_ICON_DATA, createPluginsTabs } from "./features/plugins/tabs.js";
import { createSettingsFeature } from "./features/settings/settings.js";
import { createProfilesFeature } from "./features/profiles/profiles.js";
import { createBindingsFeature } from "./features/bindings/bindings.js";
import { normalizeFaderCurvePresets } from "./features/bindings/fader_curve_presets.js";
import { createTargetsFeature } from "./features/targets/targets.js";
import { createMidiFeature } from "./features/midi/midi.js";
import {
  applyCustomFaderCurve,
  applyFaderCurve,
  bindingHasIntegrationTarget,
  buttonVisualBehavior,
  decodeRelativeDelta,
  getBindingTargets,
  getPrimaryBindingTarget,
  normalizeBinding,
  normalizeCustomCurvePoints,
  normalizeFaderCurve,
  presetCurvePoints,
  setBindingTargets,
} from "./core/binding_model.js";
import {
  createTargetCore,
  integrationTargetKey as canonicalIntegrationTargetKey,
} from "./core/target_core.js";
import { createConnectionsPanelController } from "./app/connections_panel.js";
import { createAlertsController } from "./app/alerts.js";
import { createTauriBridge, scheduleRetry } from "./app/bootstrap.js";
import {
  hasMidiPreference,
  normalizeMidiPreference,
  normalizeMidiRoutes,
} from "./core/midi_preferences.js";
import {
  appearanceFromLegacyTheme,
  applyAppearanceToDocument,
  defaultAppearanceSettings,
  normalizeAppearanceSettings,
} from "./app/appearance.js";
import {
  MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
  canSubmitMidiDeviceInventory,
  normalizeMidiDeviceInventorySettings,
  shouldPromptMidiDeviceInventoryConsent,
} from "./app/midi_device_inventory.js";
import { createSessionRefresher } from "./app/session_refresh.js";
import { createPluginRuntime } from "./app/plugin_runtime.js";
import {
  createFrameBatcher,
  midiPayloadControlKey,
  volumePayloadKey,
} from "./app/render_batching.js";
import { createDomRefs } from "./app/dom_refs.js";
import { createAppShell } from "./app/app_shell.js";
import { createSettingsStore } from "./app/settings_store.js";
import { performanceAudit } from "./app/performance_audit_api.js";
import { createBindingLookupIndex } from "./app/binding_lookup_index.js";
import {
  applyTranslations,
  initI18n,
  setLocale,
  supportedLocales,
  t,
} from "./app/i18n.js";

const startupLogger = window.__MIDIMASTER_DIAG__;

function diagnosticInfo(event, details = "") {
  startupLogger?.log?.("info", "frontend_app", event, details);
}

function diagnosticError(event, error) {
  if (startupLogger?.error) {
    startupLogger.error("frontend_app", event, error);
    return;
  }
  console.error(`[midimaster:frontend_app] ${event}`, error);
}

const tauriBridge = createTauriBridge();
const { invoke, listen } = tauriBridge;

function recordPerformanceResult(metric, value, kind = "operation", dimensions = {}) {
  if (!performanceAudit.enabled || !Number.isFinite(Number(value))) return Promise.resolve(false);
  return invoke("perf_audit_record_result", {
    metric,
    value: Number(value),
    unit: "ms",
    kind,
    dimensions,
  }).catch(() => false);
}

let pluginRuntime = null;

let settingsFeature = null;
let profilesFeature = null;
let bindingsFeature = null;
let targetsFeature = null;
let midiFeature = null;
let profileSwitchInFlight = false;

// Keep the app feeling native by disabling the default browser context menu.
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

function getPluginHost() {
  return pluginRuntime?.getPluginHost?.() || null;
}

function getIntegrationDisplayMetadata(integrationId) {
  return pluginRuntime?.getIntegrationDisplayMetadata?.(integrationId) || null;
}

async function startPluginHostIfNeeded(options) {
  return pluginRuntime?.startPluginHostIfNeeded?.(options);
}

function extractIntegrationTarget(target) {
  return pluginRuntime?.extractIntegrationTarget?.(target) || null;
}

async function triggerIntegration(binding, action, value) {
  return pluginRuntime?.triggerIntegration?.(binding, action, value) || false;
}
const dom = createDomRefs();
const {
  midiStatus,
  learnPanel,
  learnPanelTitle,
  learnPanelMessage,
  learnPanelSpinner,
  learnPanelActions,
  learnPanelCancel,
  learnPanelConfirm,
  learnPanelClose,
} = dom.midi;
const {
  sessionsContainer,
  mainScreen,
  appShell,
  sidebarNav,
  sidebarCollapseToggle,
  appPages,
  appNavItems,
  osd,
} = dom.shell;
const { connectionsPanel } = dom.connections;
const { resetAppDataButton } = dom.settings;
const {
  alertOverlay,
  alertTitle,
  alertMessage,
  alertClose,
  alertSecondary,
  alertCancel,
  alertOk,
} = dom.alerts;

function bindTauriApi() {
  return tauriBridge.bind();
}

let sessions = [];
let focusedSession = null;
let playbackDevices = [];
let recordingDevices = [];
let bindings = [];
let bindingLookupIndex = createBindingLookupIndex();
let profilePluginSettings = {};
let activeProfileName = "";
let activeProfileMidiPreference = {
  inputDeviceId: "",
  outputDeviceId: "",
  inputDeviceName: "",
  outputDeviceName: "",
  routes: [],
};
let targetMenuListenerBound = false;
const masterIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M5 4h2v10H5zM11 4h2v10h-2z' fill='white'/></svg>";
const focusIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><circle cx='9' cy='9' r='5.5' stroke='white' stroke-width='2' fill='none'/><circle cx='9' cy='9' r='1.5' fill='white'/></svg>";
const mediaPlayPauseIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M4.5 4.2l4.4 4.8-4.4 4.8z' fill='white'/><rect x='10.5' y='4.3' width='1.8' height='9.4' rx='.4' fill='white'/><rect x='13.1' y='4.3' width='1.8' height='9.4' rx='.4' fill='white'/></svg>";
const mediaNextTrackIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M4 4l5 5-5 5zM9 4l5 5-5 5z' fill='white'/><rect x='14' y='4' width='1.5' height='10' fill='white'/></svg>";
const mediaPrevTrackIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M14 4L9 9l5 5zM9 4L4 9l5 5z' fill='white'/><rect x='2.5' y='4' width='1.5' height='10' fill='white'/></svg>";
const mediaStopIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><rect x='5' y='5' width='8' height='8' rx='1.2' fill='white'/></svg>";
const themeStorageKey = "uiTheme";
const appearanceStorageKey = "midimasterAppearance";
const sidebarCollapsedStorageKey = "sidebarCollapsed";
const midiInputStorageKey = "midiDeviceId";
const BACKEND_ECHO_SUPPRESSION_MS = 220;
const INTEGRATION_ACTIVE_ECHO_SUPPRESSION_MS = 1000;
const FADER_TRIGGER_FLASH_MIN_MS = 120;
const midiOutputStorageKey = "midiOutputDeviceId";
const midiInputNameStorageKey = "midiDeviceName";
const midiOutputNameStorageKey = "midiOutputDeviceName";
let persistedMidiInputId = "";
let persistedMidiOutputId = "";
let persistedMidiInputName = "";
let persistedMidiOutputName = "";
let persistedMidiRoutes = [];
let persistedActiveProfileName = "";
let activeMidiRouteCount = 0;

function muteIconSvg(muted) {
  if (muted) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m18 9-4 6M14 9l4 6"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>';
}

function setInlineMuteButtonState(button, muted) {
  if (!button) return;
  if (bindingsFeature?.setMuteButtonState) {
    bindingsFeature.setMuteButtonState(button, muted);
    return;
  }
  button.innerHTML = muteIconSvg(Boolean(muted));
  button.classList.toggle("muted", Boolean(muted));
  const label = muted ? t("bindings.unmuteTarget") : t("bindings.muteTarget");
  button.title = label;
  button.setAttribute("aria-label", label);
  const toggle = button.closest(".binding-row")?.querySelector(".binding-toggle-value");
  if (toggle) {
    toggle.classList.toggle("on", Boolean(muted));
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
  }
  const fill = button.closest(".binding-row")?.querySelector(".binding-momentary-value");
  if (fill) {
    fill.classList.toggle("is-active", Boolean(muted));
  }
}

function findInlineMuteButton(bindingId) {
  if (bindingId == null) return null;
  return bindingsFeature?.getRenderedBindingRefs?.(bindingId)?.muteButton
    || document.querySelector(`.binding-mute-button[data-binding-id="${CSS.escape(String(bindingId))}"]`);
}

function loadStoredAppearance() {
  try {
    const stored = localStorage.getItem(appearanceStorageKey);
    if (stored) {
      return normalizeAppearanceSettings(JSON.parse(stored));
    }
    const storedTheme = localStorage.getItem(themeStorageKey);
    if (storedTheme === "dark" || storedTheme === "light" || storedTheme === "system") {
      return appearanceFromLegacyTheme(storedTheme);
    }
  } catch {
    // ignore storage failures
  }
  return defaultAppearanceSettings();
}

function getSavedMidiDeviceIds() {
  let inputId = "";
  let outputId = "";
  let inputName = "";
  let outputName = "";
  try {
    inputId = localStorage.getItem(midiInputStorageKey) || "";
    outputId = localStorage.getItem(midiOutputStorageKey) || "";
    inputName = localStorage.getItem(midiInputNameStorageKey) || "";
    outputName = localStorage.getItem(midiOutputNameStorageKey) || "";
  } catch {
    // ignore storage failures
  }

  return {
    inputId: inputId || persistedMidiInputId || "",
    outputId: outputId || persistedMidiOutputId || "",
    inputName: inputName || persistedMidiInputName || "",
    outputName: outputName || persistedMidiOutputName || "",
    routes: persistedMidiRoutes || [],
  };
}

function midiDeviceLabelForBindingDevice(deviceId) {
  const normalizedId = String(deviceId || "").trim();
  if (!normalizedId) return "";

  const routes = [
    ...(Array.isArray(activeProfileMidiPreference?.routes) ? activeProfileMidiPreference.routes : []),
    ...(Array.isArray(persistedMidiRoutes) ? persistedMidiRoutes : []),
  ];
  const legacyRoutes = [
    {
      inputDeviceId: activeProfileMidiPreference?.inputDeviceId,
      inputDeviceName: activeProfileMidiPreference?.inputDeviceName,
      outputDeviceId: activeProfileMidiPreference?.outputDeviceId,
      outputDeviceName: activeProfileMidiPreference?.outputDeviceName,
    },
    {
      inputDeviceId: persistedMidiInputId,
      inputDeviceName: persistedMidiInputName,
      outputDeviceId: persistedMidiOutputId,
      outputDeviceName: persistedMidiOutputName,
    },
  ];

  const allRoutes = [...routes, ...legacyRoutes];
  const inputMatch = allRoutes.find((route) => String(route?.inputDeviceId || route?.input_device_id || "").trim() === normalizedId);
  if (inputMatch) {
    return stripDeviceStateSuffix(inputMatch.inputDeviceName || inputMatch.input_device_name || normalizedId) || normalizedId;
  }

  const outputMatch = allRoutes.find((route) => String(route?.outputDeviceId || route?.output_device_id || "").trim() === normalizedId);
  if (outputMatch) {
    return stripDeviceStateSuffix(outputMatch.outputDeviceName || outputMatch.output_device_name || normalizedId) || normalizedId;
  }

  return normalizedId;
}

async function clearSavedMidiDeviceIds() {
}

async function hydrateClientPreferences(loadedSettings = null) {
  try {
    const settings = loadedSettings || await invoke("get_app_settings");
    if (!settings || typeof settings !== "object") {
      return;
    }

    const hydratedSettings = settingsStore.hydrate(settings);
    applyAppearanceToDocument(hydratedSettings.appearance, { matchMediaSource: window });

    const savedInputId = settings.midi_input_device_id ?? settings.midiInputDeviceId ?? "";
    const savedOutputId = settings.midi_output_device_id ?? settings.midiOutputDeviceId ?? "";
    const savedInputName = settings.midi_input_device_name ?? settings.midiInputDeviceName ?? "";
    const savedOutputName = settings.midi_output_device_name ?? settings.midiOutputDeviceName ?? "";
    persistedMidiInputId = savedInputId || "";
    persistedMidiOutputId = savedOutputId || "";
    persistedMidiInputName = savedInputName || "";
    persistedMidiOutputName = savedOutputName || "";
    persistedMidiRoutes = normalizeMidiRoutes(settings);
    const savedActiveProfileName = settings.active_profile_name ?? settings.activeProfileName ?? "";
    persistedActiveProfileName = String(savedActiveProfileName || "").trim();

    try {
      if (persistedMidiInputId && !localStorage.getItem(midiInputStorageKey)) {
        localStorage.setItem(midiInputStorageKey, persistedMidiInputId);
      }
      if (persistedMidiOutputId && !localStorage.getItem(midiOutputStorageKey)) {
        localStorage.setItem(midiOutputStorageKey, persistedMidiOutputId);
      }
      if (persistedMidiInputName && !localStorage.getItem(midiInputNameStorageKey)) {
        localStorage.setItem(midiInputNameStorageKey, persistedMidiInputName);
      }
      if (persistedMidiOutputName && !localStorage.getItem(midiOutputNameStorageKey)) {
        localStorage.setItem(midiOutputNameStorageKey, persistedMidiOutputName);
      }
      if (persistedActiveProfileName) {
        localStorage.setItem("activeProfileName", persistedActiveProfileName);
      }
    } catch {
      // ignore storage failures
    }
  } catch {
    // ignore preference hydration failures
  }
}

const integrationTargetStateByKey = new Map();

function integrationStateKeyForTarget(target) {
  if (!target || typeof target !== "object") return "";
  const integration = target.Integration || target.integration;
  return canonicalIntegrationTargetKey(integration);
}

function getIntegrationStateForTarget(target) {
  const key = integrationStateKeyForTarget(target);
  if (!key) return null;
  return integrationTargetStateByKey.get(key) || null;
}

function updateIntegrationStateFromEventPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  const key = integrationStateKeyForTarget(payload.target);
  if (!key) return;
  const prev = integrationTargetStateByKey.get(key) || {};
  const next = { ...prev };
  if (typeof payload.volume === "number") {
    next.volume = payload.volume;
  }
  if (typeof payload.muted === "boolean") {
    next.muted = payload.muted;
  }
  integrationTargetStateByKey.set(key, next);
}

const targetCore = createTargetCore({
  masterIconData,
  focusIconData,
  mediaPlayPauseIconData,
  getSessions: () => sessions,
  getFocusedSession: () => focusedSession,
  getPlaybackDevices: () => playbackDevices,
  getRecordingDevices: () => recordingDevices,
  getPluginHost,
  getIntegrationDisplayMetadata,
  getIntegrationTargetState: getIntegrationStateForTarget,
});

const {
  stableStringify,
  integrationTargetKey,
  normalizeSessionKey,
  resolveOsdTarget,
  resolveTargetKey,
  targetsMatch,
  resolveTargetVolume,
  getVolumeForTarget,
  getMuteForTarget,
} = targetCore;
const defaultOsdSettings = {
  enabled: true,
  monitorIndex: 0,
  monitorName: null,
  monitorId: null,
  anchor: "top-right",
  showBindingName: false,
  style: "midnight",
  opacity: 0.96,
  scale: 1,
};

// Integration connectivity is plugin-owned.

function applyOsdAppearanceAttributes(settings = {}) {
  const style = String(settings.style || defaultOsdSettings.style).trim() || defaultOsdSettings.style;
  const opacity = Math.min(1, Math.max(0.35, Number(settings.opacity ?? defaultOsdSettings.opacity)));
  const scale = Math.min(1.5, Math.max(0.75, Number(settings.scale ?? defaultOsdSettings.scale)));
  document.body.dataset.osdStyle = style;
  document.body.style.setProperty("--osd-opacity", String(opacity));
  document.body.style.setProperty("--osd-scale", String(scale));
}

applyOsdAppearanceAttributes(defaultOsdSettings);

function stripDeviceStateSuffix(label) {
  return String(label || "")
    .replace(/\s*\((?:Unavailable|Disconnected)\)\s*$/i, "")
    .trim();
}

function showMain(inputName, outputName, options = {}) {
  if (mainScreen?.classList?.contains?.("active")) {
    mainScreen.classList.remove("hidden");
  }
  const input = stripDeviceStateSuffix(inputName) || t("midi.notSelected");
  const output = stripDeviceStateSuffix(outputName) || t("midi.notSelected");
  const routeCount = Number(options.routeCount || options.routes?.length || 0);
  midiStatus.textContent = routeCount > 1
    ? t("midi.statusConnectedMultiple", { input, output, count: routeCount })
    : t("midi.statusConnected", { input, output });
}

function enabledMidiRouteCount(routes = []) {
  return normalizeMidiRoutes({ routes })
    .filter((route) => route.enabled !== false)
    .length;
}

function knownMidiRouteCount() {
  return activeMidiRouteCount
    || enabledMidiRouteCount(persistedMidiRoutes)
    || enabledMidiRouteCount(activeProfileMidiPreference.routes);
}

function normalizeMidiMessageType(value) {
  return String(value || "ControlChange");
}

async function preparePage(page) {
  if (page === "plugins") {
    await openConnectionsPanel();
    return;
  }
  if (page === "profiles") {
    await profilesFeature?.refreshProfiles?.(activeProfileName || "Default");
    return;
  }
  if (page === "settings") {
    await loadOsdSettings();
    await loadMonitorOptions();
    await loadAppSettings();
    await settingsFeature?.loadCurrentAppVersion?.();
    syncAppSettingsUI(settingsStore.get());
    settingsFeature?.ensureAutoUpdateCheck?.();
    settingsFeature?.openSettingsPanel?.();
    settingsFeature?.renderAllSettingsSelectDropdowns?.();
    settingsFeature?.syncOsdAppearanceControls?.();
  }
}

const appShellRuntime = createAppShell({
  appShell,
  sidebarNav,
  sidebarCollapseToggle,
  appPages,
  appNavItems,
  storageKey: sidebarCollapsedStorageKey,
  preparePage,
});

const {
  applySidebarCollapsed,
  scheduleSidebarNavIndicatorSync,
  switchAppPage,
} = appShellRuntime;

applyAppearanceToDocument(loadStoredAppearance(), { matchMediaSource: window });
applySidebarCollapsed(true);

function startSessionRefresh() {
  midiFeature?.startSessionRefresh?.();
}

function stopSessionRefresh() {
  midiFeature?.stopSessionRefresh?.();
}

async function refreshMidiDevices() {
  return midiFeature?.refreshMidiDevices?.() ?? { inputs: [], outputs: [] };
}

function updateSliderFill(slider) {
  bindingsFeature?.updateSliderFill?.(slider);
}

function setBindingSliderVolume(slider, volume, options = {}) {
  if (!slider) return;
  if (bindingsFeature?.setSliderVolume) {
    bindingsFeature.setSliderVolume(slider, volume, options);
    return;
  }
  const next = Number(volume);
  if (!Number.isFinite(next)) return;
  slider.value = String(next);
  updateSliderFill(slider);
  const percent = slider.closest(".binding-value-cell")?.querySelector(".binding-volume-percent");
  if (percent) {
    percent.textContent = `${Math.round(next * 100)}%`;
  }
  const bindingId = options.bindingId || slider.dataset.bindingId;
  if (bindingId) {
    bindingLastValues[bindingId] = next;
  }
  if (options.markMidiUpdate) {
    slider.dataset.lastMidiUpdate = Date.now().toString();
  }
}

function flashBindingTrigger(bindingId, options = {}) {
  if (!bindingId) return;
  const rateLimitMs = Number(options.rateLimitMs || 0);
  if (rateLimitMs > 0) {
    const now = Date.now();
    const previous = Number(bindingTriggerFlashTimes[bindingId] || 0);
    if (previous > 0 && now - previous < rateLimitMs) {
      return;
    }
    bindingTriggerFlashTimes[bindingId] = now;
  }
  const item = bindingsFeature?.getRenderedBindingRefs?.(bindingId)?.item
    || document.querySelector(`.binding-item[data-binding-id="${CSS.escape(String(bindingId))}"]`);
  if (item) {
    const el = item;
    el.classList.add("triggered");
    clearTimeout(el._triggerTimer);
    el._triggerTimer = setTimeout(() => el.classList.remove("triggered"), 300);
  }
}

function findBindingSlider(bindingId) {
  if (!bindingId) return null;
  return bindingsFeature?.getRenderedBindingRefs?.(bindingId)?.slider
    || document.querySelector(`.binding-volume-slider[data-binding-id="${CSS.escape(String(bindingId))}"]`);
}

function bindingIsButtonLike(binding, payload = null) {
  const controlKind = String(binding?.control_kind || binding?.controlKind || "Auto");
  if (controlKind === "Button") return true;
  if (controlKind === "Continuous") return false;
  const msgType = normalizeMidiMessageType(
    binding?.control?.msg_type
      || binding?.control?.msgType
      || payload?.msg_type
      || payload?.msgType,
  );
  return msgType === "Note" || msgType === "ProgramChange";
}

function shouldPreserveMidiUiEvent(payload) {
  return bindingIsButtonLike(findBindingForEvent(payload), payload);
}

function getMidiUiBatcher() {
  if (!midiUiBatcher) {
    midiUiBatcher = createFrameBatcher({
      keyFor: midiPayloadControlKey,
      shouldPreserve: shouldPreserveMidiUiEvent,
      onFlush: flushMidiUiEvents,
    });
  }
  return midiUiBatcher;
}

function queueMidiUiEvent(payload) {
  getMidiUiBatcher().queue(payload);
}

function queuePerfMidiDispatch(payload) {
  const key = midiPayloadControlKey(payload);
  if (!key) return;
  const pending = perfMidiDispatches.get(key) || [];
  pending.push(payload);
  if (pending.length > 2_048) pending.splice(0, pending.length - 2_048);
  perfMidiDispatches.set(key, pending);
}

function takePerfMidiDispatch(payload) {
  const key = midiPayloadControlKey(payload);
  const pending = key ? perfMidiDispatches.get(key) : null;
  if (!pending?.length) return null;
  const next = pending.shift();
  if (pending.length === 0) perfMidiDispatches.delete(key);
  return next;
}

function flushMidiUiEvents(events) {
  for (const payload of events) {
    applyMidiUiEvent(payload);
  }
}

function isBindingTargetMenuOpen() {
  return Boolean(document.querySelector(".target-dropdown.open"));
}

function isBindingNameEditing() {
  return Boolean(document.querySelector(".binding-name-input:focus"));
}

function isBindingSelectEditing() {
  const active = document.activeElement;
  return Boolean(active && active.closest(".binding-item") && active.tagName === "SELECT");
}

function isBindingInteractionActive() {
  return bindingsFeature?.isBindingInteractionActive?.() ?? (isBindingTargetMenuOpen() || isBindingNameEditing() || isBindingSelectEditing());
}

function updateBindingValues() {
  bindingsFeature?.updateBindingValues?.();
}

function updateFocusedSessionState(nextFocusedSession) {
  const normalized = nextFocusedSession && typeof nextFocusedSession === "object"
    ? nextFocusedSession
    : null;
  if (JSON.stringify(normalized) === JSON.stringify(focusedSession ?? null)) {
    return;
  }
  focusedSession = normalized;
  bindingsFeature?.updateBindingTargetDisplays?.();
  if (!isBindingInteractionActive()) {
    bindingsFeature?.updateBindingValues?.();
  }
}

const sessionRefresher = createSessionRefresher({
  invoke,
  getState: () => ({
    sessions,
    focusedSession,
    playbackDevices,
    recordingDevices,
    sessionsContainer,
  }),
  setState: (next) => {
    if (Object.prototype.hasOwnProperty.call(next, "sessions")) sessions = next.sessions;
    if (Object.prototype.hasOwnProperty.call(next, "focusedSession")) focusedSession = next.focusedSession;
    if (Object.prototype.hasOwnProperty.call(next, "playbackDevices")) playbackDevices = next.playbackDevices;
    if (Object.prototype.hasOwnProperty.call(next, "recordingDevices")) recordingDevices = next.recordingDevices;
  },
  actions: {
    isBindingInteractionActive,
    renderBindings,
    updateBindingValues,
    updateBindingTargetDisplays: () => bindingsFeature?.updateBindingTargetDisplays?.(),
  },
  getLastVolumeUpdateAt: () => lastVolumeUpdateAt,
});

async function refreshSessions(options = {}) {
  return sessionRefresher.refreshSessions(options);
}

async function refreshProfiles(preferredName = "") {
  if (profilesFeature && typeof profilesFeature.refreshProfiles === "function") {
    return profilesFeature.refreshProfiles(preferredName);
  }
}

let pendingFocusBindingId = null;
let editingBindingId = null;
let dragState = null;

const bindingInteractionTimes = {}; // Track last interaction time per binding ID
const bindingLastValues = {}; // Track last valid volume per binding ID
const bindingMuteValues = {}; // Track last known mute per binding ID (from feedback)
const bindingTriggerFlashTimes = {};
const liveMidiValuesByControl = new Map();
let midiUiBatcher = null;
let volumeUpdateBatcher = null;
const perfMidiDispatches = new Map();

function midiControlSignature(deviceId, control) {
  if (!control) return "";
  return [
    String(deviceId || ""),
    Number(control.channel),
    Number(control.controller),
    normalizeMidiMessageType(control.msg_type || control.msgType),
  ].join(":");
}

function getLiveMidiValueForControl(deviceId, control) {
  const key = midiControlSignature(deviceId, control);
  if (!key) return null;
  const value = liveMidiValuesByControl.get(key);
  return typeof value === "number" ? value : null;
}

let lastVolumeUpdateAt = 0;
const osdBindingValues = new Map();
const osdRelativeAutoFormatByBinding = new Map();
let osdSettings = { ...defaultOsdSettings };
let monitorOptions = [];
const settingsStore = createSettingsStore({
  invoke,
  normalizeFaderCurvePresets,
  supportedLanguages: supportedLocales.map((locale) => locale.code),
  onChange: (settings) => bindingsFeature?.setCompactBindings?.(settings.compactBindings),
});
let appStarted = false;
let storageRecoveryNoticeShown = false;

function applyGlobalAppearance(nextAppearance) {
  const appearance = normalizeAppearanceSettings(nextAppearance || settingsStore.get().appearance);
  settingsStore.update({ appearance });
  return applyAppearanceToDocument(appearance, { matchMediaSource: window });
}

async function saveFaderCurvePresets(nextPresets) {
  const presets = normalizeFaderCurvePresets(nextPresets);
  const saved = await invoke("update_fader_curve_presets", { presets });
  const normalized = normalizeFaderCurvePresets(saved);
  settingsStore.update({ faderCurvePresets: normalized });
  return normalized;
}

function bindSystemAppearanceListener() {
  const query = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  if (!query) return;
  const handler = () => {
    const appearance = normalizeAppearanceSettings(settingsStore.get().appearance || loadStoredAppearance());
    if (appearance.activeThemeId === "system") {
      applyGlobalAppearance(appearance);
      settingsFeature?.syncAppearanceControls?.();
    }
  };
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", handler);
  } else if (typeof query.addListener === "function") {
    query.addListener(handler);
  }
}

pluginRuntime = createPluginRuntime({
  invoke,
  listen,
  isOsdWindow: false,
  getActiveProfileName: () => activeProfileName,
  setActiveProfileName: (next) => { activeProfileName = next; },
  getProfilePluginSettings: () => profilePluginSettings,
  setProfilePluginSettings: (next) => { profilePluginSettings = next; },
  getBindings: () => bindings,
  getProfilesFeature: () => profilesFeature,
  getBindingsFeature: () => bindingsFeature,
  getConnectionsPanel: () => connectionsPanel,
  getBindingTargets,
  setBindingTargets,
  saveBindingsForProfile,
  isBindingInteractionActive,
  requestBindingsRerender,
  mountConnectionsTabs: (options) => connectionsController?.mountConnectionsTabs?.(options),
  showAlert: (title, message = "") => showAlert(title, message),
  showConfirm: (options = {}) => alertsController?.showConfirm?.(options) || Promise.resolve(false),
});

// Feature modules
diagnosticInfo("settings_factory_start");
settingsFeature = createSettingsFeature({
  invoke,
  listen,
  dom: dom.settings,
  i18n: {
    applyTranslations,
    setLocale,
    supportedLocales,
    t,
  },
  getOsdSettings: () => osdSettings,
  setOsdSettings: (next) => { osdSettings = next; },
  getMonitorOptions: () => monitorOptions,
  setMonitorOptions: (next) => { monitorOptions = next; },
  settingsStore,
  applyAppearance: applyGlobalAppearance,
  showAlert: (title, message = "") => showAlert(title, message),
  onUpdateAvailableClick: showUpdateAvailableDialog,
  onMidiDeviceInventoryConsentChanged: () => {
    queueMidiDeviceInventorySubmit("consent_changed");
  },
});
diagnosticInfo("settings_factory_ok");
diagnosticInfo("settings_bind_start");
settingsFeature.bindUi();
diagnosticInfo("settings_bind_ok");

diagnosticInfo("profiles_factory_start");
profilesFeature = createProfilesFeature({
  invoke,
  i18n: { t },
  dom: dom.profiles,
  defaultOsdSettings,
  getActiveProfileName: () => activeProfileName,
  setActiveProfileName: (next) => { activeProfileName = next; },
  getProfilePluginSettings: () => profilePluginSettings,
  setProfilePluginSettings: (next) => { profilePluginSettings = next; },
  getBindings: () => bindings,
  setBindings: (next) => {
    bindings = next;
    rebuildBindingLookupIndex();
  },
  normalizeBinding,
  bindingFallbackName,
  renderBindings,
  getPluginHost,
  startPluginHostIfNeeded,
  getOsdSettings: () => osdSettings,
  setOsdSettings: (next) => { osdSettings = next; },
  applyOsdSettings,
  getCurrentMidiPreference: () => (
    midiFeature?.getDesiredMidiPreference?.()
    || activeProfileMidiPreference
  ),
  getActiveProfileMidiPreference: () => activeProfileMidiPreference,
  setActiveProfileMidiPreference: (next) => {
    activeProfileMidiPreference = normalizeMidiPreference(next);
  },
  onProfileLoaded: async ({ midiDevicePreference, midiDevicePreferenceSet }) => {
    activeProfileMidiPreference = normalizeMidiPreference({
      ...(midiDevicePreference || {}),
      configured: Boolean(midiDevicePreferenceSet),
    });
    await midiFeature?.syncToProfileDevice?.(activeProfileMidiPreference);
  },
  showAlert: (title, message = "") => showAlert(title, message),
  showChoices: (options = {}) => alertsController?.showChoices?.(options) || Promise.resolve("close"),
});
diagnosticInfo("profiles_factory_ok");
diagnosticInfo("profiles_bind_start");
profilesFeature.bindUi();
diagnosticInfo("profiles_bind_ok");

diagnosticInfo("targets_factory_start");
targetsFeature = createTargetsFeature({
  invoke,
  i18n: { t },
  dom: dom.targets,
  masterIconData,
  focusIconData,
  mediaPlayPauseIconData,
  mediaNextTrackIconData,
  mediaPrevTrackIconData,
  mediaStopIconData,
  getPluginHost,
  getSessions: () => sessions,
  getPlaybackDevices: () => playbackDevices,
  getRecordingDevices: () => recordingDevices,
  normalizeSessionKey,
  integrationTargetKey,
  resolveOsdTarget,
});
diagnosticInfo("targets_factory_ok");
diagnosticInfo("targets_bind_start");
targetsFeature.bindUi();
diagnosticInfo("targets_bind_ok");

diagnosticInfo("bindings_factory_start");
bindingsFeature = createBindingsFeature({
  invoke,
  dom: dom.bindings,
  getPlaybackDevices: () => playbackDevices,
  getRecordingDevices: () => recordingDevices,
  getBindings: () => bindings,
  setBindings: (next) => { bindings = next; },
  bindingFallbackName,
  controlLabel,
  getMidiDeviceLabel: midiDeviceLabelForBindingDevice,
  buildTargetSelect,
  getVolumeForTarget,
  getMuteForTarget,
  triggerIntegration,
  extractIntegrationTarget,
  i18n: { t },
  showVolumeOsd,
  showMuteOsd,
  saveBindingsForProfile,
  getFaderCurvePresets: () => settingsStore.get().faderCurvePresets || [],
  saveFaderCurvePresets,
  getPluginHost,
  getEditingBindingId: () => editingBindingId,
  setEditingBindingId: (next) => { editingBindingId = next; },
  getPendingFocusBindingId: () => pendingFocusBindingId,
  setPendingFocusBindingId: (next) => { pendingFocusBindingId = next; },
  getDragState: () => dragState,
  setDragState: (next) => { dragState = next; },
  bindingInteractionTimes,
  bindingLastValues,
  bindingMuteValues,
  getLiveMidiValueForControl,
  createTargetIcon,
  resolveOsdTarget,
  showAlert: (title, message = "") => showAlert(title, message),
  showChoices: (options = {}) => alertsController?.showChoices?.(options) || Promise.resolve("close"),
  showConfirm: (options = {}) => alertsController?.showConfirm?.(options) || Promise.resolve(false),
  onBindingsRendered: rebuildBindingLookupIndex,
});
diagnosticInfo("bindings_factory_ok");

diagnosticInfo("midi_factory_start");
midiFeature = createMidiFeature({
  invoke,
  dom: dom.midi,
  i18n: { t },
  showMain,
  refreshSessions,
  addBindingFromLearn: async (learned) => {
    try {
      const learnedMapping = normalizeLearnedControlMapping(learned);
      const conflict = findCreateBindingConflict(learnedMapping);

      if (conflict && conflict.field === "control") {
        hideCreateLearnPanel();
        const owner = conflict.binding?.name || t("bindings.unnamedBinding");
        showAlert(
          t("bindings.alreadyAssignedTitle"),
          t("bindings.alreadyAssignedMessage", { name: owner }),
        );
        return;
      }

      if (conflict && (conflict.field === "mute_control" || conflict.field === "assign_control" || conflict.field === "indicator_control")) {
        const owner = conflict.binding?.name || t("bindings.unnamedBinding");
        const ownerSlot = conflict.field === "mute_control"
          ? t("bindings.mute")
          : (conflict.field === "assign_control" ? t("common.assign") : "Indicator");
        const confirmed = await promptCreateLearnTransfer(
          t("bindings.transferFromAuxMessage", { slot: ownerSlot, name: owner }),
        );
        if (!confirmed) {
          hideCreateLearnPanel();
          return;
        }

        conflict.binding[conflict.field] = null;
        await invoke("add_binding", { binding: conflict.binding });
      }

      const binding = createBindingFromLearn(learned);
      bindings.push(binding);
      await invoke("add_binding", { binding });
      editingBindingId = null;
      pendingFocusBindingId = null;
      renderBindings();
      syncPluginHostBindings();
      scheduleBindingsSave("add binding learn");
      await bindingsFeature?.openBindingTargetPicker?.(binding.id);
      hideCreateLearnPanel();
    } catch (error) {
      hideCreateLearnPanel();
      showAlert(t("bindings.createFailedTitle"), String(error));
    }
  },
  getSavedMidiDeviceIds,
  clearSavedMidiDeviceIds,
  onConnected: (connection = {}) => {
    activeMidiRouteCount = enabledMidiRouteCount(connection.routes || []);
    queueMidiDeviceInventorySubmit("midi_connected");
  },
  onDisconnected: () => {
    activeMidiRouteCount = 0;
  },
  onDeviceInventoryChanged: () => {
    queueMidiDeviceInventorySubmit("device_inventory_changed");
  },
  onProfileDeviceSelected: async (nextPreference) => {
    const normalized = normalizeMidiPreference(nextPreference);
    activeProfileMidiPreference = normalized;
    await profilesFeature?.updateProfileMidiPreference?.(normalized);
    queueMidiDeviceInventorySubmit("midi_routes_changed");
  },
});
diagnosticInfo("midi_factory_ok");
diagnosticInfo("midi_bind_start");
midiFeature.bindUi();
diagnosticInfo("midi_bind_ok");

function bindingFallbackName(_binding, index) {
  return t("bindings.bindingFallback", { number: index + 1 });
}

function beginBindingEdit(bindingId) {
  bindingsFeature?.beginBindingEdit?.(bindingId);
}

function renderBindings() {
  bindingsFeature?.renderBindings?.();
}

function rebuildBindingLookupIndex() {
  bindingLookupIndex = createBindingLookupIndex(bindings);
}

function requestBindingsRerender(reason = "") {
  if (bindingsFeature?.requestSafeRerender) {
    bindingsFeature.requestSafeRerender(reason);
    return;
  }
  renderBindings();
}

function startBindingDrag(item, index, event) {
  bindingsFeature?.startBindingDrag?.(item, index, event);
}

function updateBindingDrag(event) {
  bindingsFeature?.updateBindingDrag?.(event);
}

async function endBindingDrag() {
  await bindingsFeature?.endBindingDrag?.();
}

function cancelBindingDrag() {
  bindingsFeature?.cancelBindingDrag?.();
}

function controlLabel(control) {
  const msgType = normalizeMidiMessageType(control?.msg_type || control?.msgType);
  const channel = control?.channel ?? "?";
  const controller = control?.controller ?? "?";
  if (msgType === "PitchBend" || controller === 224) {
    return `Ch ${channel} Pitch Bend`;
  }
  if (msgType === "Note") {
    return `Ch ${channel} Note ${controller}`;
  }
  if (msgType === "ProgramChange") {
    return `Ch ${channel} Program ${controller}`;
  }
  return `Ch ${channel} CC ${controller}`;
}

function closeTargetMenus(except = null) {
  targetsFeature?.closeTargetMenus?.(except);
}

function createTargetIcon(option) {
  return targetsFeature?.createTargetIcon?.(option) || document.createElement("span");
}

function findBindingForEvent(payload) {
  if (!payload || !bindings.length) {
    return null;
  }
  return bindingLookupIndex.find(payload, {
    allowLegacyFallback: knownMidiRouteCount() <= 1,
  });
}

function resolveOsdVolume(binding, payload) {
  if (!binding || !payload) {
    return null;
  }
  if (binding.mode === "Relative") {
    const delta = decodeRelativeDelta(binding, payload.value, osdRelativeAutoFormatByBinding);
    if (delta == null) {
      return null;
    }
    let current = osdBindingValues.get(binding.id);
    if (current == null) {
      // Prefer last known feedback for integrations (and everything else).
      current = (bindingLastValues[binding.id] != null)
        ? bindingLastValues[binding.id]
        : (resolveTargetVolume(getPrimaryBindingTarget(binding)) ?? 0);
    }
    const next = Math.min(1, Math.max(0, current + delta * 0.02));
    osdBindingValues.set(binding.id, next);
    return next;
  }
  if (binding.control?.controller === 224 && payload.value_14 != null) {
    const normalized = payload.value_14 / 16383;
    return normalizeFaderCurve(binding.fader_curve) === "Custom"
      ? applyCustomFaderCurve(binding.custom_curve, normalized)
      : applyFaderCurve(binding.fader_curve, normalized);
  }
  const normalized = payload.value / 127;
  return normalizeFaderCurve(binding.fader_curve) === "Custom"
    ? applyCustomFaderCurve(binding.custom_curve, normalized)
    : applyFaderCurve(binding.fader_curve, normalized);
}

function syncButtonValueVisual(bindingId, options = {}) {
  bindingsFeature?.syncButtonVisualState?.(bindingId, options);
}

function updateButtonVisualFromMidiEvent(binding, payload, inputValue) {
  const behavior = buttonVisualBehavior(binding);
  if (!behavior || !binding?.id) {
    return false;
  }

  const bindingId = binding.id;
  if (behavior === "momentary") {
    bindingLastValues[bindingId] = inputValue;
    syncButtonValueVisual(bindingId, { inputValue });
    return true;
  }

  if ((Number(payload?.value) || 0) <= 0) {
    syncButtonValueVisual(bindingId, { inputValue });
    return true;
  }

  if (binding.action === "ToggleMute") {
    const muteButton = findInlineMuteButton(bindingId);
    const currentlyMuted = bindingMuteValues[bindingId] != null
      ? Boolean(bindingMuteValues[bindingId])
      : Boolean(muteButton?.classList?.contains("muted"));
    const nextMuted = !currentlyMuted;
    bindingMuteValues[bindingId] = nextMuted;
    if (muteButton) {
      setInlineMuteButtonState(muteButton, nextMuted);
    }
    syncButtonValueVisual(bindingId, {
      inputValue,
      muted: nextMuted,
      stateValue: nextMuted ? 1 : 0,
    });
    return true;
  }

  const currentlyOn = bindingLastValues[bindingId] != null
    ? Number(bindingLastValues[bindingId]) > 0.5
    : false;
  const nextValue = currentlyOn ? 0.0 : 1.0;
  bindingLastValues[bindingId] = nextValue;
  syncButtonValueVisual(bindingId, { inputValue, stateValue: nextValue });
  return true;
}

function applyMidiUiEvent(payload) {
  const normalizedLiveValue = payload.controller === 224 && payload.value_14 != null
    ? payload.value_14 / 16383
    : ((Number(payload.value) || 0) / 127);
  liveMidiValuesByControl.set(midiControlSignature(payload.device_id, {
    channel: payload.channel,
    controller: payload.controller,
    msg_type: payload.msg_type || "ControlChange",
  }), normalizedLiveValue);

  const binding = findBindingForEvent(payload);
  if (!binding || getBindingTargets(binding).length === 0) {
    return;
  }
  const buttonLike = bindingIsButtonLike(binding, payload);
  flashBindingTrigger(binding.id, {
    rateLimitMs: buttonLike ? 0 : FADER_TRIGGER_FLASH_MIN_MS,
  });
  const handledButtonVisual = updateButtonVisualFromMidiEvent(binding, payload, normalizedLiveValue);
  if (binding.action === "ToggleMute") {
    return;
  }

  if (handledButtonVisual && buttonVisualBehavior(binding) === "stateful") {
    return;
  }

  const volume = resolveOsdVolume(binding, payload);
  if (volume == null) {
    return;
  }

  const directSlider = findBindingSlider(binding.id);
  if (directSlider) {
    setBindingSliderVolume(directSlider, volume, {
      bindingId: binding.id,
      markMidiUpdate: true,
    });
  }

  if (!bindingHasIntegrationTarget(binding)) {
    showVolumeOsd(getPrimaryBindingTarget(binding), volume);
  }
}

function getVolumeUpdateBatcher() {
  if (!volumeUpdateBatcher) {
    volumeUpdateBatcher = createFrameBatcher({
      keyFor: volumePayloadKey,
      onFlush: flushVolumeUpdatePayloads,
    });
  }
  return volumeUpdateBatcher;
}

function queueVolumeUpdatePayload(payload) {
  if (!payload || typeof payload !== "object") return;
  lastVolumeUpdateAt = Date.now();
  getVolumeUpdateBatcher().queue(payload);
}

function volumeSliderEntries() {
  const indexed = bindingsFeature?.getRenderedBindingEntries?.();
  if (Array.isArray(indexed)) {
    return indexed.filter((entry) => entry.slider).map(({ slider, target }) => ({
      slider,
      bindingId: String(slider.dataset.bindingId || ""),
      target,
      lastMidiUpdate: Number(slider.dataset.lastMidiUpdate || 0),
    }));
  }
  return Array.from(document.querySelectorAll(".binding-volume-slider")).map((slider) => {
    let target = null;
    try { target = JSON.parse(slider.dataset.targetJson || "null"); } catch { target = null; }
    return {
      slider,
      bindingId: String(slider.dataset.bindingId || ""),
      target,
      lastMidiUpdate: Number(slider.dataset.lastMidiUpdate || 0),
    };
  });
}

function flushVolumeUpdatePayloads(payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0) return;
  const now = Date.now();
  const sliderEntries = volumeSliderEntries();
  const slidersByBinding = new Map();
  sliderEntries.forEach((entry) => {
    if (entry.bindingId && !slidersByBinding.has(entry.bindingId)) {
      slidersByBinding.set(entry.bindingId, entry);
    }
  });
  const bindingsById = new Map(bindings.map((binding) => [String(binding.id), binding]));
  const shouldSuppressIntegrationEcho = (entry) => {
    const bindingId = entry.bindingId;
    if (!bindingId) return false;
    const binding = bindingsById.get(bindingId);
    if (!binding || !bindingHasIntegrationTarget(binding)) return false;
    const lastInteraction = Number(bindingInteractionTimes[bindingId] || 0);
    return lastInteraction > 0 && (now - lastInteraction) < INTEGRATION_ACTIVE_ECHO_SUPPRESSION_MS;
  };
  const canAcceptBackendVolume = (entry) => (
    entry
    && now - entry.lastMidiUpdate > BACKEND_ECHO_SUPPRESSION_MS
    && !shouldSuppressIntegrationEcho(entry)
  );

  for (const payload of payloads) {
    applyVolumeUpdatePayload(payload, {
      sliderEntries,
      slidersByBinding,
      canAcceptBackendVolume,
    });
  }
}

function applyVolumeUpdatePayload(payload, context) {
  updateIntegrationStateFromEventPayload(payload);
  if (Object.prototype.hasOwnProperty.call(payload, "focus_session")) {
    updateFocusedSessionState(payload.focus_session);
  }

  const buttonInputValue = typeof payload.input_value === "number" ? payload.input_value : null;
  const feedbackBinding = payload.binding_id
    ? bindings.find((binding) => binding && String(binding.id) === String(payload.binding_id))
    : null;
  const feedbackButtonBehavior = feedbackBinding ? buttonVisualBehavior(feedbackBinding) : null;

  if (payload.binding_id && feedbackButtonBehavior) {
    if (feedbackButtonBehavior === "momentary") {
      if (buttonInputValue != null) {
        bindingLastValues[payload.binding_id] = buttonInputValue;
        syncButtonValueVisual(payload.binding_id, { inputValue: buttonInputValue });
      }
    } else if (typeof payload.volume === "number") {
      bindingLastValues[payload.binding_id] = payload.volume;
      syncButtonValueVisual(payload.binding_id, {
        stateValue: payload.volume,
        ...(buttonInputValue != null ? { inputValue: buttonInputValue } : {}),
      });
    }
  }

  if (payload.binding_id) {
    const direct = context.slidersByBinding.get(String(payload.binding_id));
    if (context.canAcceptBackendVolume(direct)) {
      setBindingSliderVolume(direct.slider, payload.volume, { bindingId: payload.binding_id });
    }
  }

  for (const entry of context.sliderEntries) {
    if (payload.binding_id && entry.bindingId === String(payload.binding_id)) continue;
    if (!context.canAcceptBackendVolume(entry)) continue;
    if (entry.target && targetsMatch(entry.target, payload.target)) {
      setBindingSliderVolume(entry.slider, payload.volume);
    }
  }

  if (!payload.silent) {
    showVolumeOsd(payload.target, payload.volume, payload.focus_session, {
      inputValue: buttonInputValue,
    });
  }
}

function showVolumeOsd(target, volume, focusSession, options = null) {
  void target;
  void volume;
  void focusSession;
  void options;
}

function showMuteOsd(target, muted, focusSession) {
  void target;
  void muted;
  void focusSession;
}

function hideVolumeOsd() {
}

function closeTargetPanel() {
  targetsFeature?.closeTargetPanel?.();
}

function openTargetPanel(options, selectedValue, selectedKind, onSelect, title = "Select Target", nav = null) {
  targetsFeature?.openTargetPanel?.(options, selectedValue, selectedKind, onSelect, title, nav);
}

function closeSettingsPanel() {
  settingsFeature?.closeSettingsPanel?.();
}

function openSettingsPanel() {
  settingsFeature?.openSettingsPanel?.();
}

function closeConnectionsPanel() {
  if (!connectionsPanel) {
    return;
  }
  connectionsPanel.classList.add("hidden");
}
let connectionsController = null;

const pluginsTabs = createPluginsTabs({
  invoke,
  i18n: { t },
  getPluginHost,
  reloadPlugins: () => connectionsController?.reloadPlugins?.(),
  showConfirm: (options = {}) => alertsController?.showConfirm?.(options) || Promise.resolve(false),
});

connectionsController = createConnectionsPanelController({
  dom: {
    ...dom.connections,
    closeConnectionsPanel,
  },
  pluginsTabs: {
    PLUGINS_ICON_DATA,
    preloadInstalledPlugins: () => pluginsTabs.preloadInstalledPlugins(),
    preloadStoreCatalog: () => pluginsTabs.preloadStoreCatalog(),
    getPluginsBrowserSections: () => pluginsTabs.getPluginsBrowserSections(),
    mountPluginsBrowserTab: (...args) => pluginsTabs.mountPluginsBrowserTab(...args),
  },
  i18n: { t },
  getPluginHost,
  setPluginHost: (next) => pluginRuntime?.setPluginHost?.(next),
  startPluginHostIfNeeded,
});

const mountConnectionsTabs = (...args) => connectionsController?.mountConnectionsTabs?.(...args);
const openConnectionsPanel = (...args) => connectionsController?.openConnectionsPanel?.(...args);

async function applyOsdSettings(nextSettings) {
  if (settingsFeature && typeof settingsFeature.applyOsdSettings === "function") {
    return settingsFeature.applyOsdSettings(nextSettings);
  }
}

async function loadOsdSettings() {
  if (settingsFeature && typeof settingsFeature.loadOsdSettings === "function") {
    return settingsFeature.loadOsdSettings();
  }
}

async function loadMonitorOptions() {
  if (settingsFeature && typeof settingsFeature.loadMonitorOptions === "function") {
    return settingsFeature.loadMonitorOptions();
  }
}

function syncAppSettingsUI(nextSettings) {
  if (settingsFeature && typeof settingsFeature.syncAppSettingsUI === "function") {
    return settingsFeature.syncAppSettingsUI(nextSettings);
  }
}

function persistAppSettings() {
  if (settingsFeature && typeof settingsFeature.persistAppSettings === "function") {
    return settingsFeature.persistAppSettings();
  }
}

async function loadAppSettings(options) {
  if (settingsFeature && typeof settingsFeature.loadAppSettings === "function") {
    return settingsFeature.loadAppSettings(options);
  }
}

const alertsController = createAlertsController({
  alertOverlay,
  alertTitle,
  alertMessage,
  alertClose,
  alertSecondary,
  alertCancel,
  alertOk,
});
const showAlert = (title, message = "") => alertsController.showAlert(message, title);
const showChoices = (options = {}) => alertsController.showChoices(options);
const closeAlert = (...args) => alertsController.closeAlert(...args);

function showUpdateAvailableDialog(info = {}, { standaloneIfMainHidden = false } = {}) {
  const latest = String(info.latestVersion || info.version || "").trim();
  const current = String(info.currentVersion || info.current_version || "").trim();
  if (!latest) return Promise.resolve("close");

  const showInlineDialog = () => showChoices({
    title: "Update Available",
    message: `MIDIMaster ${latest} is available (current: ${current || "unknown"})`,
    options: [
      { id: "skip", label: "Skip Update", variant: "secondary" },
      { id: "install", label: "Download and Install", variant: "primary" },
    ],
  }).then((choice) => {
    if (choice === "skip") {
      try {
        localStorage.setItem("updaterSkippedVersion", latest);
      } catch {
        // ignore storage failures
      }
      return choice;
    }
    if (choice === "install") {
      settingsFeature?.installAvailableUpdate?.();
    }
    return choice;
  });

  if (!standaloneIfMainHidden) {
    return showInlineDialog();
  }

  return invoke("show_update_notification_window_if_main_hidden", {
    currentVersion: current || null,
    latestVersion: latest,
  }).then((shownStandalone) => (
    shownStandalone ? "standalone" : showInlineDialog()
  )).catch((error) => {
    diagnosticError("update_notification_window_failed", error);
    return showInlineDialog();
  });
}

connectionsController?.bindUi?.();

appNavItems.forEach((item) => {
  item.addEventListener("click", async () => {
    const page = item.dataset.page || "bindings";
    await switchAppPage(page);
  });
});

window.addEventListener("resize", scheduleSidebarNavIndicatorSync);
appShell?.addEventListener?.("transitionend", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (
    target === appShell
    || target.closest(".app-sidebar")
    || target.classList.contains("sidebar-nav-item")
  ) {
    scheduleSidebarNavIndicatorSync();
  }
});
scheduleSidebarNavIndicatorSync();

alertsController.bindUi();

// Connections panel opens via openConnectionsPanel()

if (resetAppDataButton) {
  resetAppDataButton.addEventListener("click", async () => {
    const confirmed = await alertsController.showConfirm({
      title: t("settings.resetAppData"),
      message: t("settings.resetAppDataConfirmMessage"),
      confirmLabel: t("common.reset"),
      cancelLabel: t("common.cancel"),
      confirmVariant: "danger",
    });
    if (!confirmed) {
      return;
    }
    try {
      await invoke("reset_app_data");
    } catch (error) {
      console.error("Failed to reset app data", error);
    }
    localStorage.clear();
    window.location.reload();
  });
}

let midiDeviceInventorySubmitTimer = 0;
let midiDeviceInventorySubmitInFlight = false;
let midiDeviceInventorySubmitQueued = false;

function applyMidiDeviceInventorySettings(settings = {}) {
  const normalized = normalizeMidiDeviceInventorySettings(settings);
  settingsStore.update({
    midiDeviceInventoryConsent: normalized.consent,
    midiDeviceInventoryNoticeVersion: normalized.noticeVersion,
  });
  settingsFeature?.syncAppSettingsUI?.({
    midiDeviceInventoryConsent: normalized.consent,
    midiDeviceInventoryNoticeVersion: normalized.noticeVersion,
  });
  return normalized;
}

async function updateMidiDeviceInventoryConsent(consent) {
  const updated = await invoke("update_midi_device_inventory_consent", {
    consent,
    noticeVersion: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
  });
  return applyMidiDeviceInventorySettings(updated || {
    consent,
    noticeVersion: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
  });
}

async function maybePromptMidiDeviceInventoryConsent() {
  if (!shouldPromptMidiDeviceInventoryConsent(settingsStore.get())) {
    return;
  }
  const choice = await showChoices({
    title: t("privacy.midiDeviceInventoryTitle"),
    message: t("privacy.midiDeviceInventoryMessage"),
    panelClass: "alert-panel-content--midi-consent",
    options: [
      { id: "disabled", label: t("privacy.midiDeviceInventoryDecline"), variant: "secondary" },
      { id: "enabled", label: t("privacy.midiDeviceInventoryAccept"), variant: "primary" },
    ],
  });
  if (choice !== "enabled" && choice !== "disabled") {
    return;
  }
  const consent = choice;
  const normalized = await updateMidiDeviceInventoryConsent(consent).catch((error) => {
    diagnosticError("midi_device_inventory_consent_update_failed", error);
    return applyMidiDeviceInventorySettings({
      consent: "disabled",
      noticeVersion: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
    });
  });
  if (normalized.consent === "enabled") {
    queueMidiDeviceInventorySubmit("consent_prompt_enabled");
  }
}

function queueMidiDeviceInventorySubmit(reason = "unknown") {
  if (!canSubmitMidiDeviceInventory(settingsStore.get())) {
    return;
  }
  midiDeviceInventorySubmitQueued = true;
  if (midiDeviceInventorySubmitTimer) {
    clearTimeout(midiDeviceInventorySubmitTimer);
  }
  midiDeviceInventorySubmitTimer = setTimeout(() => {
    midiDeviceInventorySubmitTimer = 0;
    flushMidiDeviceInventorySubmit(reason).catch((error) => {
      diagnosticError("midi_device_inventory_submit_flush_failed", error);
    });
  }, 900);
}

async function flushMidiDeviceInventorySubmit(reason = "unknown") {
  if (!midiDeviceInventorySubmitQueued || midiDeviceInventorySubmitInFlight) {
    return;
  }
  midiDeviceInventorySubmitQueued = false;
  if (!canSubmitMidiDeviceInventory(settingsStore.get())) {
    return;
  }
  midiDeviceInventorySubmitInFlight = true;
  try {
    await invoke("submit_midi_device_inventory");
  } catch (error) {
    diagnosticError(`midi_device_inventory_submit_failed_${reason}`, error);
  } finally {
    midiDeviceInventorySubmitInFlight = false;
    if (midiDeviceInventorySubmitQueued) {
      flushMidiDeviceInventorySubmit("queued").catch((error) => {
        diagnosticError("midi_device_inventory_submit_flush_failed", error);
      });
    }
  }
}

function buildTargetOptions(currentTarget, isButton = false) {
  return targetsFeature?.buildTargetOptions?.(currentTarget, isButton);
}

function buildTargetSelect(
  currentTarget,
  isBindingButton = false,
  currentAction = "Volume",
  currentHotkeyDisplay = "",
  currentOpenApplication = null,
  currentAutoHotkeyScript = null,
  selectOptions = {},
) {
  return targetsFeature?.buildTargetSelect?.(
    currentTarget,
    isBindingButton,
    currentAction,
    currentHotkeyDisplay,
    currentOpenApplication,
    currentAutoHotkeyScript,
    selectOptions,
  );
}

function resetCreateLearnPanelUi() {
  if (!learnPanel) return;
  if (learnPanelTitle) learnPanelTitle.textContent = t("bindings.waitingMidiTitle");
  if (learnPanelMessage) learnPanelMessage.textContent = t("bindings.learnMessage");
  if (learnPanelSpinner) learnPanelSpinner.classList.remove("hidden");
  if (learnPanelActions) learnPanelActions.classList.add("hidden");
  if (learnPanelConfirm) learnPanelConfirm.textContent = t("common.transfer");
}

function hideCreateLearnPanel() {
  if (!learnPanel) return;
  learnPanel.classList.add("hidden");
  resetCreateLearnPanelUi();
}

function normalizeLearnedControlMapping(learned) {
  return {
    device_id: String(learned?.device_id || ""),
    channel: Number(learned?.channel),
    controller: Number(learned?.controller),
    msg_type: String(learned?.msg_type || "ControlChange"),
  };
}

function controlsMatch(a, b) {
  if (!a || !b) return false;
  return String(a.device_id || "") === String(b.device_id || "")
    && Number(a.channel) === Number(b.channel)
    && Number(a.controller) === Number(b.controller)
    && String(a.msg_type || "ControlChange") === String(b.msg_type || "ControlChange");
}

function bindingPrimaryMapping(binding) {
  return {
    device_id: binding?.device_id,
    channel: binding?.control?.channel,
    controller: binding?.control?.controller,
    msg_type: binding?.control?.msg_type || "ControlChange",
  };
}

function findCreateBindingConflict(learnedMapping) {
  for (const binding of bindings || []) {
    if (!binding) continue;
    if (controlsMatch(bindingPrimaryMapping(binding), learnedMapping)) {
      return { binding, field: "control" };
    }
    if (controlsMatch(binding.mute_control, learnedMapping)) {
      return { binding, field: "mute_control" };
    }
    if (controlsMatch(binding.assign_control, learnedMapping)) {
      return { binding, field: "assign_control" };
    }
    if (controlsMatch(binding.indicator_control, learnedMapping)) {
      return { binding, field: "indicator_control" };
    }
  }
  return null;
}

async function promptCreateLearnTransfer(message) {
  if (!learnPanel) return false;
  if (learnPanelTitle) learnPanelTitle.textContent = "Transfer Mapping";
  if (learnPanelMessage) learnPanelMessage.textContent = message || "";
  if (learnPanelSpinner) learnPanelSpinner.classList.add("hidden");
  if (learnPanelActions) learnPanelActions.classList.remove("hidden");
  if (learnPanelConfirm) learnPanelConfirm.textContent = "Transfer";
  learnPanel.classList.remove("hidden");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onCancel = () => finish(false);
    const onConfirm = () => finish(true);
    const onOverlay = (event) => {
      if (event.target === learnPanel) {
        finish(false);
      }
    };
    const cleanup = () => {
      learnPanelCancel?.removeEventListener("click", onCancel);
      learnPanelClose?.removeEventListener("click", onCancel);
      learnPanelConfirm?.removeEventListener("click", onConfirm);
      learnPanel?.removeEventListener("click", onOverlay);
    };

    learnPanelCancel?.addEventListener("click", onCancel);
    learnPanelClose?.addEventListener("click", onCancel);
    learnPanelConfirm?.addEventListener("click", onConfirm);
    learnPanel?.addEventListener("click", onOverlay);
  });
}

function createBindingFromLearn(payload) {
  const msgType = payload.msg_type || "ControlChange";
  const controlKind = payload.control_kind || "Auto";
  const isButton = controlKind === "Button"
    || (controlKind === "Auto" && (msgType === "Note" || msgType === "ProgramChange"));
  const control = {
    channel: payload.channel,
    controller: payload.controller,
    msg_type: msgType,
  };
  const defaultName = t("bindings.bindingFallback", { number: bindings.length + 1 });
  return {
    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    name: defaultName,
    device_id: payload.device_id,
    control,
    control_kind: controlKind,
    targets: ["Unset"],
    target: "Unset",
    action: isButton ? "ToggleMute" : "Volume",
    mode: "Absolute",
    relative_format: "Auto",
    fader_curve: "Linear",
    custom_curve: normalizeCustomCurvePoints([]),
    deadzone: 0,
    debounce_ms: 0,
    mute_behavior: "ToggleOnPress",
    indicator_control: null,
    mute_control: null,
    assign_control: null,
    assign_mode: "Add",
    hotkey: null,
    open_application: null,
  };
}

async function saveBindingsForProfile() {
  if (profilesFeature && typeof profilesFeature.saveBindingsForProfile === "function") {
    return profilesFeature.saveBindingsForProfile();
  }
}

function scheduleBindingsSave(reason = "binding update") {
  saveBindingsForProfile()?.catch((error) => {
    console.error(`Failed to save profile after ${reason}:`, error);
  });
}

function syncPluginHostBindings() {
  try {
    getPluginHost()?.setBindings?.(bindings);
  } catch { }
}

async function loadProfileByName(name, options) {
  if (profilesFeature && typeof profilesFeature.loadProfileByName === "function") {
    return profilesFeature.loadProfileByName(name, options);
  }
}

async function deleteProfileByName(name) {
  if (profilesFeature && typeof profilesFeature.deleteProfileByName === "function") {
    return profilesFeature.deleteProfileByName(name);
  }
}

function setProfileSelection(name) {
  if (profilesFeature && typeof profilesFeature.setProfileSelection === "function") {
    return profilesFeature.setProfileSelection(name);
  }
}

async function toggleProfileDropdown() {
  // handled by profilesFeature
}

function closeProfileDropdown() {
  if (profilesFeature && typeof profilesFeature.closeProfileDropdown === "function") {
    return profilesFeature.closeProfileDropdown();
  }
}

document.addEventListener("pointermove", (event) => {
  updateBindingDrag(event);
});

document.addEventListener("pointerup", () => {
  endBindingDrag();
});

document.addEventListener("pointercancel", () => {
  cancelBindingDrag();
});


async function setupListeners() {
  if (performanceAudit.enabled) {
    await listen("perf_audit_midi_dispatch", (event) => {
      const payload = typeof event.payload === "string"
        ? (() => {
          try {
            return JSON.parse(event.payload);
          } catch {
            return null;
          }
        })()
        : event.payload;
      if (payload && typeof payload === "object") {
        queuePerfMidiDispatch(payload);
      }
    });
  }

  await listen("profile_switch_requested", async (event) => {
    if (profileSwitchInFlight) return;
    let payload = event.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    const name = String(payload?.name || "").trim();
    if (!name || name === activeProfileName) return;

    profileSwitchInFlight = true;
    try {
      await profilesFeature?.loadProfileByName?.(name);
      await profilesFeature?.refreshProfiles?.(name);
    } catch (error) {
      diagnosticError("binding_profile_switch_failed", error);
      showAlert(
        t("dialogs.profileSwitchUnavailableTitle"),
        t("dialogs.profileSwitchFailedMessage", { name }),
      );
    } finally {
      profileSwitchInFlight = false;
    }
  });

  await listen("osd_settings_update", (event) => {
    let payload = event.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (!payload || typeof payload !== "object") return;
    osdSettings = {
      enabled: Boolean(payload.enabled),
      monitorIndex: Number(payload.monitor_index ?? payload.monitorIndex ?? 0),
      monitorName: payload.monitor_name ?? payload.monitorName ?? null,
      monitorId: payload.monitor_id ?? payload.monitorId ?? null,
      anchor: payload.anchor || "top-right",
      showBindingName: Boolean(payload.show_binding_name ?? payload.showBindingName ?? false),
      style: payload.style || defaultOsdSettings.style,
      opacity: Number(payload.opacity ?? defaultOsdSettings.opacity),
      scale: Number(payload.scale ?? defaultOsdSettings.scale),
    };
    document.body.setAttribute("data-anchor", osdSettings.anchor || "top-right");
    applyOsdAppearanceAttributes(osdSettings);
    if (!osdSettings.enabled) hideVolumeOsd();
  });

  await listen("bindings_migrated", (event) => {
    let payload = event.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    const count = Number(payload?.count || 0);
    if (!Number.isFinite(count) || count <= 0) {
      return;
    }

    const migrations = Array.isArray(payload?.migrations) ? payload.migrations : [];
    if (migrations.length > 0) {
      const parsedMigrations = migrations.map((migration) => {
        const bindingId = String(migration?.bindingId || migration?.binding_id || "");
        const deviceId = String(migration?.deviceId || migration?.device_id || "");
        const previousDeviceId = String(migration?.previousDeviceId || migration?.previous_device_id || "");
        if (!bindingId || !deviceId) return null;
        return { bindingId, deviceId, previousDeviceId };
      }).filter(Boolean);
      if (parsedMigrations.length === 0) return;

      const migrateAuxControl = (control, migration) => {
        if (!control || typeof control !== "object") return control;
        if (migration.previousDeviceId && control.device_id !== migration.previousDeviceId) {
          return control;
        }
        return { ...control, device_id: migration.deviceId };
      };

      bindings = (bindings || []).map((binding) => {
        let nextBinding = binding;
        parsedMigrations.forEach((migration) => {
          if (migration.bindingId !== String(nextBinding?.id || "")) return;
          nextBinding = {
            ...nextBinding,
            device_id: migration.previousDeviceId && nextBinding.device_id !== migration.previousDeviceId
              ? nextBinding.device_id
              : migration.deviceId,
            mute_control: migrateAuxControl(nextBinding?.mute_control, migration),
            assign_control: migrateAuxControl(nextBinding?.assign_control, migration),
            indicator_control: migrateAuxControl(nextBinding?.indicator_control, migration),
          };
        });
        return nextBinding;
      });
      requestBindingsRerender("bindings_migrated");
      return;
    }

    const deviceId = payload?.device_id;
    if (!deviceId) {
      return;
    }

    const migrateAuxControl = (control) => (
      control && typeof control === "object"
        ? { ...control, device_id: deviceId }
        : control
    );
    bindings = (bindings || []).map((binding) => ({
      ...binding,
      device_id: deviceId,
      mute_control: migrateAuxControl(binding?.mute_control),
      assign_control: migrateAuxControl(binding?.assign_control),
      indicator_control: migrateAuxControl(binding?.indicator_control),
    }));
    requestBindingsRerender("bindings_migrated");
  });

  await listen("binding_aux_error", (event) => {
    let payload = event.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    if (!payload) return;
    if (payload.reason === "target_list_full") {
      showAlert(t("dialogs.targetListFullTitle"), t("dialogs.targetListFullMessage"));
      return;
    }
    if (payload.reason === "focused_app_unavailable") {
      showAlert(t("dialogs.assignFailedTitle"), t("dialogs.assignFailedMessage"));
    }
  });

  await listen("binding_action_error", (event) => {
    let payload = event.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    if (!payload || typeof payload !== "object") return;
    const params = (payload.params && typeof payload.params === "object") ? payload.params : {};
    const title = String(
      payload.title_key ? t(payload.title_key, params) : (payload.title || t("dialogs.actionFailedTitle")),
    ).trim() || t("dialogs.actionFailedTitle");
    const message = String(
      payload.message_key ? t(payload.message_key, params) : (payload.message || t("dialogs.actionFailedMessage")),
    ).trim() || t("dialogs.actionFailedMessage");
    showAlert(title, message);
  });

  await listen("binding_aux_assign_update", (event) => {
    let payload = event.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    if (payload?.binding_id) {
      const binding = bindings.find((b) => b && b.id === payload.binding_id);
      if (binding) {
        if (Array.isArray(payload.targets)) {
          setBindingTargets(binding, payload.targets);
        } else if (payload.target) {
          const nextTargets = getBindingTargets(binding);
          const exists = nextTargets.some((target) => (
            JSON.stringify(target) === JSON.stringify(payload.target)
          ));
          if (!exists) {
            nextTargets.push(payload.target);
            setBindingTargets(binding, nextTargets);
          }
        }
      }
    }
    refreshSessions().catch((error) => {
      diagnosticError("aux_assign_refresh_sessions_failed", error);
    });
    requestBindingsRerender("binding_aux_assign_update");
  });

  await listen("binding_aux_mute_update", (event) => {
    let payload = event.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    if (!payload || !payload.binding_id) return;
    bindingMuteValues[payload.binding_id] = Boolean(payload.muted);
    const muteButton = findInlineMuteButton(payload.binding_id);
    if (muteButton) {
      setInlineMuteButtonState(muteButton, Boolean(payload.muted));
    }
    const binding = bindings.find((b) => b && b.id === payload.binding_id);
    if (!binding) return;
    const primaryTarget = getPrimaryBindingTarget(binding);
    showMuteOsd(primaryTarget, Boolean(payload.muted));
  });

  await listen("midi_event", (event) => {
    if (mainScreen.classList.contains("hidden")) {
      midiStatus.textContent = t("midi.eventStatus", { payload: JSON.stringify(event.payload) });
    }
    const payload = typeof event.payload === "string"
      ? (() => {
        try {
          return JSON.parse(event.payload);
        } catch {
          return null;
        }
      })()
      : event.payload;

    if (!payload || typeof payload !== "object") {
      return;
    }
    const perfDispatch = performanceAudit.enabled ? takePerfMidiDispatch(payload) : null;
    const rendererReceivedAt = performanceAudit.enabled ? performanceAudit.now() : 0;
    queueMidiUiEvent(payload);
    if (perfDispatch && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        const nativeDurationMs = Number(perfDispatch.enqueue_to_dispatch_us || 0) / 1000;
        const rendererDurationMs = performanceAudit.now() - rendererReceivedAt;
        performanceAudit.recordDuration(
          "midi-visible-update",
          nativeDurationMs + rendererDurationMs,
          {
            controller: Number(payload.controller),
            msgType: String(payload.msg_type || payload.msgType || "ControlChange"),
          },
        );
      });
    }
  });

  await listen("midi_connection_status", (event) => {
    const payload = typeof event.payload === "string"
      ? (() => {
        try {
          return JSON.parse(event.payload);
        } catch {
          return null;
        }
      })()
      : event.payload;
    if (!payload || typeof payload !== "object" || !midiStatus) return;
    const routes = normalizeMidiRoutes({ routes: payload.routes || [] });
    const routeCount = Number(payload.routeCount ?? payload.route_count ?? routes.length);
    if (Number.isFinite(routeCount)) {
      activeMidiRouteCount = Math.max(0, routeCount);
    }
    if (payload.state === "disconnected") {
      if (routes.length > 0) {
        const first = routes[0] || {};
        showMain(
          first.inputDeviceName || first.inputDeviceId,
          first.outputDeviceName || first.outputDeviceId,
          { routeCount: routes.length, routes },
        );
      } else {
        midiStatus.textContent = t("midi.disconnected");
      }
    } else if (payload.state === "reconnecting") {
      midiStatus.textContent = t("midi.searchingDevices");
    } else if (payload.state === "failed") {
      midiStatus.textContent = t("midi.connectFailed", { message: payload.reason || "MIDI connection failed" });
    } else if (payload.state === "connected") {
      if (routes.length > 0) {
        const first = routes[0] || {};
        showMain(
          first.inputDeviceName || first.inputDeviceId,
          first.outputDeviceName || first.outputDeviceId,
          { routeCount: routes.length, routes },
        );
      } else {
        midiStatus.textContent = "Connected.";
      }
    }
  });

  await listen("focused_session_update", (event) => {
    let payload = event.payload ?? null;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    updateFocusedSessionState(payload);
  });

  await listen("mute_update", (event) => {
    let payload = event.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (!payload) return;
    updateIntegrationStateFromEventPayload(payload);
    if (Object.prototype.hasOwnProperty.call(payload, "focus_session")) {
      updateFocusedSessionState(payload.focus_session);
    }

    if (payload.binding_id != null && typeof payload.muted === "boolean") {
      const buttonInputValue = typeof payload.input_value === "number" ? payload.input_value : null;
      bindingMuteValues[payload.binding_id] = payload.muted;
      syncButtonValueVisual(payload.binding_id, {
        muted: payload.muted,
        stateValue: payload.muted ? 1 : 0,
        ...(buttonInputValue != null ? { inputValue: buttonInputValue } : {}),
      });
    }

    // Update inline mute buttons.
    // Prefer exact binding-id match first; fall back to target match for mirrored bindings.
    const indexedButtons = bindingsFeature?.getRenderedBindingEntries?.();
    const buttons = Array.isArray(indexedButtons)
      ? indexedButtons.filter((entry) => entry.muteButton)
      : Array.from(document.querySelectorAll(".binding-mute-button")).map((muteButton) => ({ muteButton, target: null }));
    buttons.forEach(({ muteButton: btn, target: indexedTarget }) => {
      let shouldUpdate = false;
      if (payload.binding_id != null && btn.dataset.bindingId === String(payload.binding_id)) {
        shouldUpdate = true;
      } else {
        try {
          const buttonTarget = indexedTarget ?? JSON.parse(btn.dataset.targetJson || "null");
          shouldUpdate = targetsMatch(buttonTarget, payload.target);
        } catch {
          shouldUpdate = false;
        }
      }
      if (!shouldUpdate) return;
      setInlineMuteButtonState(btn, payload.muted);
    });

    if (!payload.silent) {
      showMuteOsd(payload.target, payload.muted);
    }
  });

  await listen("volume_update", (event) => {
    let payload = event.payload ?? {};
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = {};
      }
    }
    if (!payload || typeof payload !== "object") {
      return;
    }
    queueVolumeUpdatePayload(payload);
  });

  // Plugin host starts after the active profile loads (see startMainApp).

}

async function loadMidiDevices() {
  return midiFeature?.loadMidiDevicesWithRetry?.() ?? { inputs: [], outputs: [] };
}

async function attemptAutoConnect(deviceData) {
  return midiFeature?.attemptAutoConnect?.(deviceData);
}

function getStartupProfileName() {
  try {
    return String(
      localStorage.getItem("activeProfileName")
      || persistedActiveProfileName
      || "Default",
    ).trim() || "Default";
  } catch {
    return String(persistedActiveProfileName || "Default").trim() || "Default";
  }
}

function applyCurrentOsdAppearance() {
  document.body.setAttribute("data-anchor", osdSettings.anchor || "top-right");
  applyOsdAppearanceAttributes(osdSettings);
}

async function loadStartupProfile(preferredName) {
  const startupProfileOptions = {
    applyOsd: false,
    persistActiveProfile: false,
    render: false,
    startPlugins: false,
    syncMidi: false,
  };
  const names = [preferredName, "Default"]
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .filter((name, index, list) => list.indexOf(name) === index);

  for (const name of names) {
    try {
      await loadProfileByName(name, startupProfileOptions);
      return true;
    } catch (error) {
      diagnosticError(`startup_load_profile_failed_${name === "Default" ? "default" : "preferred"}`, error);
    }
  }

  try {
    bindings = [];
  } catch (error) {
    diagnosticError("startup_empty_bindings_render_failed", error);
  }
  return false;
}

function storageRecoveryStoreLabel(notices) {
  const stores = new Set(notices.map((notice) => String(notice?.store || "")));
  if (stores.has("profiles") && stores.has("app_settings")) {
    return t("storage.profilesAndSettings");
  }
  if (stores.has("profiles")) {
    return t("storage.profiles");
  }
  return t("storage.appSettings");
}

async function showStorageRecoveryNotices() {
  try {
    const notices = await invoke("take_storage_recovery_notices");
    if (!Array.isArray(notices) || notices.length === 0) {
      return;
    }

    const stores = storageRecoveryStoreLabel(notices);
    const quarantinedPaths = Array.from(new Set(
      notices.flatMap((notice) => Array.isArray(notice?.quarantinedPaths)
        ? notice.quarantinedPaths.map((path) => String(path || "").trim()).filter(Boolean)
        : []),
    ));
    const details = quarantinedPaths.length > 0
      ? t("storage.recoveryPreserved", { paths: quarantinedPaths.join("\n") })
      : "";
    const resetToDefaults = notices.some((notice) => notice?.action === "reset_to_defaults");
    storageRecoveryNoticeShown = true;
    showAlert(
      t(resetToDefaults ? "storage.recoveryResetTitle" : "storage.recoveryTitle"),
      t(
        resetToDefaults ? "storage.recoveryResetMessage" : "storage.recoveryRestoredMessage",
        { stores, details },
      ),
    );
  } catch (error) {
    diagnosticError("storage_recovery_notice_failed", error);
  }
}

async function startMainApp() {
  if (appStarted) {
    return;
  }
  appStarted = true;
  const savedMidi = getSavedMidiDeviceIds();
  const savedDevice = savedMidi.inputId || savedMidi.routes?.[0]?.inputDeviceId || "";
  if (!savedDevice && midiStatus) {
    midiStatus.textContent = t("bindings.selectDevicesSentence");
  }
  const startupProfileName = getStartupProfileName();
  const pluginManifestsPromise = pluginRuntime?.preloadPluginManifests?.().catch(() => []);
  await refreshProfiles(startupProfileName);
  await loadStartupProfile(startupProfileName);
  await pluginManifestsPromise;
  await pluginRuntime?.preloadBindingDisplayMetadata?.().catch(() => { });
  renderBindings();
  performanceAudit.mark("bindings-usable", {
    bindingCount: Array.isArray(bindings) ? bindings.length : 0,
    profile: activeProfileName || startupProfileName,
  });
  const bindingsUsable = performanceAudit.measure(
    "bootstrap-to-bindings-usable",
    "bootstrap-start",
    "bindings-usable",
  );
  recordPerformanceResult(
    "startup.bindings_usable",
    bindingsUsable?.durationMs,
    "milestone",
    { window: "main", binding_count: Array.isArray(bindings) ? bindings.length : 0 },
  );
  applyCurrentOsdAppearance();
  if (activeProfileName) {
    invoke("set_active_profile_preference", { profileName: activeProfileName }).catch(() => { });
  }

  const pluginStartPromise = startPluginHostIfNeeded({ suppressInitialBindingsInvalidation: true })
    .then((result) => {
      if (result?.metadataChanged) {
        requestBindingsRerender("plugin_metadata_hydrated");
      }
      const pluginsReady = performanceAudit.mark("plugins-ready", { started: Boolean(result?.started) });
      recordPerformanceResult("startup.plugins_ready", pluginsReady?.startTimeMs, "milestone", { window: "main" });
      return result;
    })
    .catch((error) => {
      console.error("startPluginHostIfNeeded failed", error);
      diagnosticError("start_plugin_host_failed", error);
      const pluginsReady = performanceAudit.mark("plugins-ready", { error: String(error?.message || error) });
      recordPerformanceResult("startup.plugins_ready", pluginsReady?.startTimeMs, "milestone", { window: "main", error: true });
      return null;
    });
  const [deviceData] = await Promise.all([
    loadMidiDevices(),
    loadMonitorOptions(),
    loadOsdSettings(),
  ]);
  applyCurrentOsdAppearance();

  const profileHasMidiPreference = hasMidiPreference(activeProfileMidiPreference);
  let usedLegacyFallback = false;

  try {
    if (profileHasMidiPreference) {
      await midiFeature?.syncToProfileDevice?.(activeProfileMidiPreference);
    } else {
      usedLegacyFallback = true;
      await attemptAutoConnect(deviceData);
    }
  } finally {
    midiFeature?.completeInitialDeviceLoad?.();
  }

  if (usedLegacyFallback && savedDevice && midiStatus) {
    midiStatus.textContent = t("midi.selectAvailableReconnect");
  }
  const midiReady = performanceAudit.mark("midi-ready", { connectedRouteCount: activeMidiRouteCount });
  recordPerformanceResult("startup.midi_ready", midiReady?.startTimeMs, "milestone", {
    window: "main",
    connected_route_count: activeMidiRouteCount,
  });
  await pluginStartPromise;
  await showStorageRecoveryNotices();
  queueMidiDeviceInventorySubmit("startup");
}

async function init() {
  performanceAudit.mark("app-init-start");
  if (!bindTauriApi()) {
    scheduleRetry(() => init(), 200);
    return;
  }
  diagnosticInfo("setup_listeners_start");
  await setupListeners().catch((error) => {
    diagnosticError("setup_listeners_failed", error);
  });
  diagnosticInfo("setup_listeners_done");
  diagnosticInfo("load_app_settings_start");
  const loadedSettings = await loadAppSettings({ applyLocale: false });
  diagnosticInfo("load_app_settings_done");
  await initI18n(settingsStore.get().language || "en").catch((error) => {
    diagnosticError("i18n_init_failed", error);
  });
  applyTranslations();
  applyGlobalAppearance(settingsStore.get().appearance || loadStoredAppearance());
  bindSystemAppearanceListener();
  diagnosticInfo("hydrate_client_preferences_start");
  await hydrateClientPreferences(loadedSettings);
  diagnosticInfo("hydrate_client_preferences_done");
  mainScreen?.classList?.remove?.("hidden");
  diagnosticInfo("start_main_app_start");
  await startMainApp();
  diagnosticInfo("start_main_app_done");
  setTimeout(() => {
    if (storageRecoveryNoticeShown) {
      return;
    }
    maybePromptMidiDeviceInventoryConsent().catch((error) => {
      diagnosticError("midi_device_inventory_prompt_failed", error);
    });
  }, 0);
  try {
    const resetSkipOnceKey = "updaterResetSkipOnce";
    if (localStorage.getItem(resetSkipOnceKey) !== "1") {
      localStorage.removeItem("updaterSkippedVersion");
      localStorage.setItem(resetSkipOnceKey, "1");
    }
  } catch {
    // ignore storage failures
  }
  if (settingsStore.get().autoCheckUpdates !== false) {
    settingsFeature?.checkForUpdates?.({ silent: true }).then((info) => {
      if (!info || !info.available) return;
      if (storageRecoveryNoticeShown) return;
      const latest = String(info.latestVersion || "").trim();
      const current = String(info.currentVersion || "").trim();
      if (!latest) return;
      const skippedVersionKey = "updaterSkippedVersion";
      try {
        if (localStorage.getItem(skippedVersionKey) === latest) return;
      } catch {
        // ignore storage failures
      }
      showUpdateAvailableDialog(
        { latestVersion: latest, currentVersion: current },
        { standaloneIfMainHidden: true },
      );
    }).catch((error) => {
      diagnosticError("auto_update_check_failed", error);
    });
  }
  const backgroundReady = performanceAudit.mark("background-init-complete");
  recordPerformanceResult("startup.background_complete", backgroundReady?.startTimeMs, "milestone", { window: "main" });
}

export async function startMidimasterApp() {
  await init();
}

window.addEventListener("beforeunload", () => {
  invoke("stop_midi_device").catch(() => { });
});

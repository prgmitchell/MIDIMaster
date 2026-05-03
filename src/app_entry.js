import { PLUGINS_ICON_DATA, createPluginsTabs } from "./features/plugins/tabs.js";
import { createSettingsFeature } from "./features/settings/settings.js";
import { createProfilesFeature } from "./features/profiles/profiles.js";
import { createBindingsFeature } from "./features/bindings/bindings.js";
import { createTargetsFeature } from "./features/targets/targets.js";
import { createOsdFeature } from "./features/osd/osd.js";
import { createMidiFeature } from "./features/midi/midi.js";
import {
  applyCustomFaderCurve,
  applyFaderCurve,
  bindingHasIntegrationTarget,
  decodeRelativeDelta,
  getBindingTargets,
  getPrimaryBindingTarget,
  normalizeBinding,
  normalizeCustomCurvePoints,
  normalizeFaderCurve,
  presetCurvePoints,
  setBindingTargets,
} from "./core/binding_model.js";
import { createTargetCore } from "./core/target_core.js";
import { createConnectionsPanelController } from "./app/connections_panel.js";
import { createAlertsController } from "./app/alerts.js";
import { createTauriBridge, scheduleRetry } from "./app/bootstrap.js";
import {
  hasProfileMidiPreference,
  normalizeProfileMidiPreference,
} from "./app/preferences.js";
import { createSessionRefresher } from "./app/session_refresh.js";
import { createPluginRuntime } from "./app/plugin_runtime.js";
import { createDomRefs } from "./app/dom_refs.js";
import { createAppShell } from "./app/app_shell.js";
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

let pluginRuntime = null;

let settingsFeature = null;
let profilesFeature = null;
let bindingsFeature = null;
let targetsFeature = null;
let osdFeature = null;
let midiFeature = null;

// Keep the app feeling native by disabling the default browser context menu.
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

function getPluginHost() {
  return pluginRuntime?.getPluginHost?.() || null;
}

async function startPluginHostIfNeeded() {
  return pluginRuntime?.startPluginHostIfNeeded?.();
}

function extractIntegrationTarget(target) {
  return pluginRuntime?.extractIntegrationTarget?.(target) || null;
}

async function triggerIntegration(binding, action, value) {
  return pluginRuntime?.triggerIntegration?.(binding, action, value) || false;
}
const {
  midiSelect,
  midiOutputSelect,
  midiStatus,
  sessionsContainer,
  profileDropdown,
  profileToggle,
  profileCurrent,
  profileList,
  profilePageList,
  profilePageCreateInput,
  profilePageCreateButton,
  profilePageImportButton,
  profilePageExportCurrentButton,
  bindingsContainer,
  bindingSearchInput,
  mainScreen,
  appShell,
  sidebarNav,
  sidebarCollapseToggle,
  appPages,
  appNavItems,
  targetPanel,
  targetPanelList,
  targetPanelTitle,
  targetPanelClose,
  targetPanelBack,
  bindingConfigPanel,
  bindingConfigClose,
  bindingConfigCancel,
  bindingConfigSave,
  bindingConfigName,
  bindingConfigMuteLabel,
  bindingConfigMuteLearn,
  bindingConfigMuteClear,
  bindingConfigMuteModeRoot,
  bindingConfigMuteModeButton,
  bindingConfigMuteModeMenu,
  bindingConfigMuteModeToggle,
  bindingConfigMuteModeValue,
  bindingConfigAssignLabel,
  bindingConfigAssignLearn,
  bindingConfigAssignClear,
  bindingConfigAssignModeRoot,
  bindingConfigAssignModeButton,
  bindingConfigAssignModeMenu,
  bindingConfigAssignModeAdd,
  bindingConfigAssignModeReplace,
  bindingConfigCurveCards,
  bindingConfigCurveHelp,
  bindingConfigCustomEditor,
  bindingConfigCustomSurface,
  bindingConfigCustomReset,
  bindingConfigAssignHelp,
  bindingConfigPreviewLearnButton,
  bindingConfigPreviewLearnIndicator,
  bindingConfigPreviewLearnStatus,
  bindingConfigPreviewTargetIcon,
  bindingConfigPreviewTargetLabel,
  bindingConfigPreviewTargetTags,
  bindingConfigPreviewFill,
  bindingConfigPreviewThumb,
  bindingConfigPreviewValue,
  bindingConfigPreviewStatus,
  bindingConfigPreviewMainMidi,
  bindingConfigPreviewMute,
  bindingConfigPreviewAssign,
  bindingConfigPreviewCurve,
  bindingConfigPreviewMidiValue,
  learnPanel,
  learnPanelTitle,
  learnPanelMessage,
  learnPanelSpinner,
  learnPanelActions,
  learnPanelCancel,
  learnPanelConfirm,
  learnPanelClose,
  settingsButton,
  themeToggleButton,
  topbarUpdateButton,
  settingsPanel,
  settingsPanelClose,
  connectionsButton,
  connectionsPanel,
  connectionsPanelClose,
  connectionsSidebar,
  connectionsContent,
  osdEnabledToggle,
  osdMonitorSelect,
  osdStyleSelect,
  osdTransparencyInput,
  osdTransparencyValue,
  osdScaleInput,
  osdScaleValue,
  osdPositionPicker,
  startWithWindowsSelect,
  startInTraySelect,
  minimizeToTraySelect,
  exitToTraySelect,
  languageSelect,
  autoCheckUpdatesButton,
  openLogsFolderButton,
  resetAppDataButton,
  checkForUpdatesButton,
  settingsUpdateStatus,
  updateCurrentVersion,
  updateLatestVersion,
  sidebarAppVersion,
  osd,
  alertOverlay,
  alertTitle,
  alertMessage,
  alertClose,
  alertSecondary,
  alertCancel,
  alertOk,
} = createDomRefs();

function bindTauriApi() {
  return tauriBridge.bind();
}

let sessions = [];
let playbackDevices = [];
let recordingDevices = [];
let bindings = [];
let profilePluginSettings = {};
let activeProfileName = "";
let activeProfileMidiPreference = {
  inputDeviceId: "",
  outputDeviceId: "",
  inputDeviceName: "",
  outputDeviceName: "",
};
let targetMenuListenerBound = false;
const masterIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M5 4h2v10H5zM11 4h2v10h-2z' fill='white'/></svg>";
const focusIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><circle cx='9' cy='9' r='5.5' stroke='white' stroke-width='2' fill='none'/><circle cx='9' cy='9' r='1.5' fill='white'/></svg>";
const mediaPlayPauseIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M4.5 4.2l4.4 4.8-4.4 4.8z' fill='white'/><rect x='10.5' y='4.3' width='1.8' height='9.4' rx='.4' fill='white'/><rect x='13.1' y='4.3' width='1.8' height='9.4' rx='.4' fill='white'/></svg>";
const mediaNextTrackIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M4 4l5 5-5 5zM9 4l5 5-5 5z' fill='white'/><rect x='14' y='4' width='1.5' height='10' fill='white'/></svg>";
const mediaPrevTrackIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M14 4L9 9l5 5zM9 4L4 9l5 5z' fill='white'/><rect x='2.5' y='4' width='1.5' height='10' fill='white'/></svg>";
const mediaStopIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><rect x='5' y='5' width='8' height='8' rx='1.2' fill='white'/></svg>";
const osdDebugAlways = false;
const isOsdWindow = new URLSearchParams(window.location.search).has("osd");
const themeStorageKey = "uiTheme";
const sidebarCollapsedStorageKey = "sidebarCollapsed";
const midiInputStorageKey = "midiDeviceId";
const BACKEND_ECHO_SUPPRESSION_MS = 220;
const INTEGRATION_ACTIVE_ECHO_SUPPRESSION_MS = 1000;
const midiOutputStorageKey = "midiOutputDeviceId";
const midiInputNameStorageKey = "midiDeviceName";
const midiOutputNameStorageKey = "midiOutputDeviceName";
let persistedMidiInputId = "";
let persistedMidiOutputId = "";
let persistedMidiInputName = "";
let persistedMidiOutputName = "";
let persistedActiveProfileName = "";

function updateThemeToggleMeta(isDark) {
  if (!themeToggleButton) return;
  const label = isDark ? t("theme.switchToLight") : t("theme.switchToDark");
  themeToggleButton.setAttribute("aria-label", label);
  themeToggleButton.setAttribute("aria-pressed", String(isDark));
  themeToggleButton.setAttribute("title", label);
  themeToggleButton.title = label;
}

function applyTheme(nextTheme) {
  const isDark = nextTheme === "dark";
  document.body.dataset.theme = isDark ? "dark" : "light";
  document.body.classList.toggle("dark-mode", isDark);
  updateThemeToggleMeta(isDark);
}

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
  return Array.from(document.querySelectorAll(".binding-mute-button"))
    .find((btn) => btn.dataset.bindingId === String(bindingId)) || null;
}

function loadStoredTheme() {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // ignore storage failures
  }
  return "dark";
}

function toggleTheme() {
  const nextTheme = document.body.classList.contains("dark-mode") ? "light" : "dark";
  applyTheme(nextTheme);
  try {
    localStorage.setItem(themeStorageKey, nextTheme);
  } catch {
    // ignore storage failures
  }
  invoke("set_theme_preference", { theme: nextTheme }).catch(() => { });
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
  };
}

async function saveMidiDeviceIds(inputId, outputId, inputName = "", outputName = "") {
  persistedMidiInputId = inputId || "";
  persistedMidiOutputId = outputId || "";
  persistedMidiInputName = inputName || "";
  persistedMidiOutputName = outputName || "";
  try {
    if (persistedMidiInputId) {
      localStorage.setItem(midiInputStorageKey, persistedMidiInputId);
    }
    if (persistedMidiOutputId) {
      localStorage.setItem(midiOutputStorageKey, persistedMidiOutputId);
    }
    if (persistedMidiInputName) {
      localStorage.setItem(midiInputNameStorageKey, persistedMidiInputName);
    }
    if (persistedMidiOutputName) {
      localStorage.setItem(midiOutputNameStorageKey, persistedMidiOutputName);
    }
  } catch {
    // ignore storage failures
  }
  if (persistedMidiInputId && persistedMidiOutputId) {
    await invoke("set_midi_device_preferences", {
      inputDeviceId: persistedMidiInputId,
      outputDeviceId: persistedMidiOutputId,
      inputDeviceName: persistedMidiInputName || null,
      outputDeviceName: persistedMidiOutputName || null,
    }).catch(() => { });
  }
}

async function clearSavedMidiDeviceIds() {
  persistedMidiInputId = "";
  persistedMidiOutputId = "";
  persistedMidiInputName = "";
  persistedMidiOutputName = "";
  try {
    localStorage.removeItem(midiInputStorageKey);
    localStorage.removeItem(midiOutputStorageKey);
    localStorage.removeItem(midiInputNameStorageKey);
    localStorage.removeItem(midiOutputNameStorageKey);
  } catch {
    // ignore storage failures
  }
  await invoke("clear_midi_device_preferences").catch(() => { });
}

async function hydrateClientPreferences() {
  try {
    const settings = await invoke("get_app_settings");
    if (!settings || typeof settings !== "object") {
      return;
    }

    const savedTheme = settings.ui_theme ?? settings.uiTheme;
    if (savedTheme === "dark" || savedTheme === "light") {
      applyTheme(savedTheme);
      try {
        localStorage.setItem(themeStorageKey, savedTheme);
      } catch {
        // ignore storage failures
      }
    }

    const savedInputId = settings.midi_input_device_id ?? settings.midiInputDeviceId ?? "";
    const savedOutputId = settings.midi_output_device_id ?? settings.midiOutputDeviceId ?? "";
    const savedInputName = settings.midi_input_device_name ?? settings.midiInputDeviceName ?? "";
    const savedOutputName = settings.midi_output_device_name ?? settings.midiOutputDeviceName ?? "";
    persistedMidiInputId = savedInputId || "";
    persistedMidiOutputId = savedOutputId || "";
    persistedMidiInputName = savedInputName || "";
    persistedMidiOutputName = savedOutputName || "";
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

function stableStringifyForIntegrationState(value) {
  if (value == null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringifyForIntegrationState).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringifyForIntegrationState(value[k])}`);
  return `{${parts.join(",")}}`;
}

function integrationStateKeyForTarget(target) {
  if (!target || typeof target !== "object") return "";
  const integration = target.Integration || target.integration;
  if (!integration || !integration.integration_id) return "";
  const id = String(integration.integration_id || "");
  const kind = String(integration.kind || "");
  const data = (integration.data && typeof integration.data === "object") ? { ...integration.data } : {};
  delete data.label;
  delete data.icon_data;
  delete data.iconData;
  delete data.display_label;
  delete data.displayLabel;
  return `${id}:${kind}:${stableStringifyForIntegrationState(data)}`;
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
  getPlaybackDevices: () => playbackDevices,
  getRecordingDevices: () => recordingDevices,
  getPluginHost,
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
  style: "midnight",
  opacity: 0.96,
  scale: 1,
};

// Integration connectivity is plugin-owned.

if (isOsdWindow) {
  document.body.classList.add("osd-only");
}

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
  mainScreen?.classList?.remove?.("hidden");
  const input = stripDeviceStateSuffix(inputName) || t("midi.notSelected");
  const output = stripDeviceStateSuffix(outputName) || t("midi.notSelected");
  midiStatus.textContent = t("midi.statusConnected", { input, output });
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
    syncAppSettingsUI(appSettings);
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

if (!isOsdWindow) {
  applyTheme(loadStoredTheme());
  applySidebarCollapsed(true);
}

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

function flashBindingTrigger(bindingId) {
  if (!bindingId) return;
  const selector = `.binding-item[data-binding-id="${CSS.escape(String(bindingId))}"]`;
  document.querySelectorAll(selector).forEach((el) => {
    el.classList.add("triggered");
    clearTimeout(el._triggerTimer);
    el._triggerTimer = setTimeout(() => el.classList.remove("triggered"), 300);
  });
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

const sessionRefresher = createSessionRefresher({
  invoke,
  getState: () => ({
    sessions,
    playbackDevices,
    recordingDevices,
    sessionsContainer,
  }),
  setState: (next) => {
    if (Object.prototype.hasOwnProperty.call(next, "sessions")) sessions = next.sessions;
    if (Object.prototype.hasOwnProperty.call(next, "playbackDevices")) playbackDevices = next.playbackDevices;
    if (Object.prototype.hasOwnProperty.call(next, "recordingDevices")) recordingDevices = next.recordingDevices;
  },
  actions: {
    isBindingInteractionActive,
    renderBindings,
    updateBindingValues,
  },
});

async function refreshSessions() {
  return sessionRefresher.refreshSessions();
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
const liveMidiValuesByControl = new Map();

function midiControlSignature(deviceId, control) {
  if (!control) return "";
  return [
    String(deviceId || ""),
    Number(control.channel),
    Number(control.controller),
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
let appSettings = {
  startWithWindows: false,
  startInTray: false,
  minimizeToTray: false,
  exitToTray: false,
  autoCheckUpdates: true,
  language: "en",
};
let appStarted = false;

pluginRuntime = createPluginRuntime({
  invoke,
  listen,
  isOsdWindow,
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
});

// Feature modules
diagnosticInfo("settings_factory_start");
settingsFeature = createSettingsFeature({
  invoke,
  listen,
  dom: {
    settingsButton,
    settingsPanel,
    settingsPanelClose,
    osdEnabledToggle,
    osdMonitorSelect,
    osdStyleSelect,
    osdTransparencyInput,
    osdTransparencyValue,
    osdScaleInput,
    osdScaleValue,
    osdPositionPicker,
    startWithWindowsSelect,
    startInTraySelect,
    minimizeToTraySelect,
    exitToTraySelect,
    languageSelect,
    autoCheckUpdatesButton,
    openLogsFolderButton,
    checkForUpdatesButton,
    settingsUpdateStatus,
    updateCurrentVersion,
    updateLatestVersion,
    sidebarAppVersion,
    topbarUpdateButton,
  },
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
  getAppSettings: () => appSettings,
  setAppSettings: (next) => { appSettings = next; },
  onUpdateAvailableClick: showUpdateAvailableDialog,
});
diagnosticInfo("settings_factory_ok");
diagnosticInfo("settings_bind_start");
settingsFeature.bindUi();
diagnosticInfo("settings_bind_ok");

diagnosticInfo("profiles_factory_start");
profilesFeature = createProfilesFeature({
  invoke,
  i18n: { t },
  dom: {
    profileDropdown,
    profileToggle,
    profileCurrent,
    profileList,
    profilePageList,
    profilePageCreateInput,
    profilePageCreateButton,
    profilePageImportButton,
    profilePageExportCurrentButton,
  },
  defaultOsdSettings,
  getActiveProfileName: () => activeProfileName,
  setActiveProfileName: (next) => { activeProfileName = next; },
  getProfilePluginSettings: () => profilePluginSettings,
  setProfilePluginSettings: (next) => { profilePluginSettings = next; },
  getBindings: () => bindings,
  setBindings: (next) => { bindings = next; },
  bindingFallbackName,
  renderBindings,
  getPluginHost,
  startPluginHostIfNeeded,
  getOsdSettings: () => osdSettings,
  setOsdSettings: (next) => { osdSettings = next; },
  applyOsdSettings,
  getCurrentMidiPreference: () => (
    midiFeature?.getCurrentConnectedPreference?.()
    || activeProfileMidiPreference
  ),
  getActiveProfileMidiPreference: () => activeProfileMidiPreference,
  setActiveProfileMidiPreference: (next) => {
    activeProfileMidiPreference = normalizeProfileMidiPreference(next);
  },
  onProfileLoaded: async ({ midiDevicePreference }) => {
    activeProfileMidiPreference = normalizeProfileMidiPreference(midiDevicePreference);
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
  dom: {
    targetPanel,
    targetPanelList,
    targetPanelTitle,
    targetPanelClose,
    targetPanelBack,
  },
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

diagnosticInfo("osd_factory_start");
osdFeature = createOsdFeature({
  osdElement: osd,
  isOsdWindow,
  osdDebugAlways,
  getOsdSettings: () => osdSettings,
  resolveOsdTarget,
  createTargetIcon,
  resolveTargetKey,
});
diagnosticInfo("osd_factory_ok");

diagnosticInfo("bindings_factory_start");
bindingsFeature = createBindingsFeature({
  invoke,
  dom: {
    bindingsContainer,
    bindingSearchInput,
    bindingConfigPanel,
    bindingConfigClose,
    bindingConfigCancel,
    bindingConfigSave,
    bindingConfigName,
    bindingConfigMuteLabel,
    bindingConfigMuteLearn,
    bindingConfigMuteClear,
    bindingConfigMuteModeRoot,
    bindingConfigMuteModeButton,
    bindingConfigMuteModeMenu,
    bindingConfigMuteModeToggle,
    bindingConfigMuteModeValue,
    bindingConfigAssignLabel,
    bindingConfigAssignLearn,
    bindingConfigAssignClear,
    bindingConfigAssignModeRoot,
    bindingConfigAssignModeButton,
    bindingConfigAssignModeMenu,
    bindingConfigAssignModeAdd,
    bindingConfigAssignModeReplace,
    bindingConfigCurveCards,
    bindingConfigCurveHelp,
    bindingConfigCustomEditor,
    bindingConfigCustomSurface,
    bindingConfigCustomReset,
    bindingConfigAssignHelp,
    bindingConfigPreviewLearnButton,
    bindingConfigPreviewLearnIndicator,
    bindingConfigPreviewLearnStatus,
    bindingConfigPreviewTargetIcon,
    bindingConfigPreviewTargetLabel,
    bindingConfigPreviewTargetTags,
    bindingConfigPreviewFill,
    bindingConfigPreviewThumb,
    bindingConfigPreviewValue,
    bindingConfigPreviewStatus,
    bindingConfigPreviewMainMidi,
    bindingConfigPreviewMute,
    bindingConfigPreviewAssign,
    bindingConfigPreviewCurve,
    bindingConfigPreviewMidiValue,
    learnPanel,
    learnPanelTitle,
    learnPanelMessage,
    learnPanelSpinner,
    learnPanelActions,
    learnPanelCancel,
    learnPanelConfirm,
    learnPanelClose,
  },
  getPlaybackDevices: () => playbackDevices,
  getRecordingDevices: () => recordingDevices,
  getBindings: () => bindings,
  setBindings: (next) => { bindings = next; },
  bindingFallbackName,
  controlLabel,
  buildTargetSelect,
  getVolumeForTarget,
  getMuteForTarget,
  triggerIntegration,
  extractIntegrationTarget,
  i18n: { t },
  showVolumeOsd,
  showMuteOsd,
  saveBindingsForProfile,
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
  showChoices: (options = {}) => alertsController?.showChoices?.(options) || Promise.resolve("close"),
  showConfirm: (options = {}) => alertsController?.showConfirm?.(options) || Promise.resolve(false),
});
diagnosticInfo("bindings_factory_ok");

diagnosticInfo("midi_factory_start");
midiFeature = createMidiFeature({
  invoke,
  dom: {
    midiSelect,
    midiOutputSelect,
    midiStatus,
    mainScreen,
    learnPanel,
    learnPanelTitle,
    learnPanelMessage,
    learnPanelSpinner,
    learnPanelActions,
    learnPanelCancel,
    learnPanelConfirm,
    learnPanelClose,
    refreshMidiButton: document.getElementById("refresh-midi"),
    learnBindingButton: document.getElementById("learn-binding"),
    bindingAddFooterButton: document.getElementById("binding-add-footer-button"),
  },
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

      if (conflict && (conflict.field === "mute_control" || conflict.field === "assign_control")) {
        const owner = conflict.binding?.name || t("bindings.unnamedBinding");
        const ownerSlot = conflict.field === "mute_control" ? t("bindings.mute") : t("common.assign");
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
      await saveBindingsForProfile();
      hideCreateLearnPanel();
      editingBindingId = binding.id;
      pendingFocusBindingId = binding.id;
      renderBindings();
    } catch (error) {
      hideCreateLearnPanel();
      showAlert(t("bindings.createFailedTitle"), String(error));
    }
  },
  getSavedMidiDeviceIds,
  saveMidiDeviceIds,
  clearSavedMidiDeviceIds,
  onProfileDeviceSelected: async (nextPreference) => {
    const normalized = normalizeProfileMidiPreference(nextPreference);
    activeProfileMidiPreference = normalized;
    await profilesFeature?.updateProfileMidiPreference?.(normalized);
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
  if (control.controller === 224) {
    return `Ch ${control.channel} Pitch Bend`;
  }
  return `Ch ${control.channel} CC ${control.controller}`;
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
  const exact = bindings.find((binding) =>
    binding.device_id === payload.device_id
    && binding.control?.channel === payload.channel
    && binding.control?.controller === payload.controller,
  );
  if (exact) {
    return exact;
  }

  // Back-compat fallback for stale saved device IDs.
  // Match by channel/controller only when this is unambiguous.
  const fallback = bindings.filter((binding) =>
    binding.control?.channel === payload.channel
    && binding.control?.controller === payload.controller,
  );
  return fallback.length === 1 ? fallback[0] : null;
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

function showVolumeOsd(target, volume, focusSession) {
  osdFeature?.showVolumeOsd?.(target, volume, focusSession);
}

function showMuteOsd(target, muted, focusSession) {
  osdFeature?.showMuteOsd?.(target, muted, focusSession);
}

function hideVolumeOsd() {
  osdFeature?.hideVolumeOsd?.();
}

window.__OSD_UPDATE__ = (payload) => {
  osdFeature?.handleOsdUpdate?.(payload);
};

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
    connectionsPanel,
    connectionsPanelClose,
    connectionsButton,
    connectionsSidebar,
    connectionsContent,
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

async function loadAppSettings() {
  if (settingsFeature && typeof settingsFeature.loadAppSettings === "function") {
    return settingsFeature.loadAppSettings();
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

function showUpdateAvailableDialog(info = {}) {
  const latest = String(info.latestVersion || info.version || "").trim();
  const current = String(info.currentVersion || info.current_version || "").trim();
  if (!latest) return Promise.resolve("close");
  return showChoices({
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

if (themeToggleButton) {
  themeToggleButton.addEventListener("click", toggleTheme);
}

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

function buildTargetOptions(currentTarget, isButton = false) {
  return targetsFeature?.buildTargetOptions?.(currentTarget, isButton);
}

function buildTargetSelect(
  currentTarget,
  isBindingButton = false,
  currentAction = "Volume",
  currentHotkeyDisplay = "",
  currentOpenApplication = null,
) {
  return targetsFeature?.buildTargetSelect?.(
    currentTarget,
    isBindingButton,
    currentAction,
    currentHotkeyDisplay,
    currentOpenApplication,
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
  const isButton = controlKind === "Button" || (controlKind === "Auto" && msgType === "Note");
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

async function loadProfileByName(name) {
  if (profilesFeature && typeof profilesFeature.loadProfileByName === "function") {
    return profilesFeature.loadProfileByName(name);
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
      style: payload.style || defaultOsdSettings.style,
      opacity: Number(payload.opacity ?? defaultOsdSettings.opacity),
      scale: Number(payload.scale ?? defaultOsdSettings.scale),
    };
    document.body.setAttribute("data-anchor", osdSettings.anchor || "top-right");
    applyOsdAppearanceAttributes(osdSettings);
    if (!osdSettings.enabled && isOsdWindow) {
      hideVolumeOsd();
    }
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
    const deviceId = payload?.device_id;
    const count = Number(payload?.count || 0);
    if (!deviceId || !Number.isFinite(count) || count <= 0) {
      return;
    }

    bindings = (bindings || []).map((binding) => ({
      ...binding,
      device_id: deviceId,
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
    const title = String(payload.title || t("dialogs.actionFailedTitle")).trim() || t("dialogs.actionFailedTitle");
    const message = String(payload.message || "").trim() || t("dialogs.actionFailedMessage");
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
    flashBindingTrigger(binding.id);
    if (binding.action === "ToggleMute") {
      if ((Number(payload.value) || 0) > 0) {
        const muteButton = findInlineMuteButton(binding.id);
        if (muteButton) {
          const currentlyMuted = bindingMuteValues[binding.id] != null
            ? Boolean(bindingMuteValues[binding.id])
            : muteButton.classList.contains("muted");
          const nextMuted = !currentlyMuted;
          bindingMuteValues[binding.id] = nextMuted;
          setInlineMuteButtonState(muteButton, nextMuted);
        }
      }
      return;
    }
    if (bindingHasIntegrationTarget(binding)) {
      // Integrations drive OSD/feedback through set_binding_feedback.
      // We still update the slider directly below to keep UI responsive.
    }
    const volume = resolveOsdVolume(binding, payload);
    if (volume == null) {
      return;
    }

    // Direct UI Update (Midi Event)
    // 1. Find the specific slider for this binding ID
    const allSliders = Array.from(document.querySelectorAll(".binding-volume-slider"));
    const directSlider = binding.id ? allSliders.find(s => s.dataset.bindingId === binding.id) : null;

    if (directSlider) {
      setBindingSliderVolume(directSlider, volume, {
        bindingId: binding.id,
        markMidiUpdate: true,
      });
    }

    if (!bindingHasIntegrationTarget(binding)) {
      showVolumeOsd(getPrimaryBindingTarget(binding), volume);
    }
  });

  await listen("mute_update", (event) => {
    if (!osdSettings.enabled && isOsdWindow) {
      return;
    }
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

    if (payload.binding_id != null && typeof payload.muted === "boolean") {
      bindingMuteValues[payload.binding_id] = payload.muted;
      const fill = document.querySelector(`.binding-momentary-value[data-binding-id="${payload.binding_id}"]`);
      if (fill) {
        fill.classList.toggle("is-active", payload.muted);
      }
    }

    // Update inline mute buttons.
    // Prefer exact binding-id match first; fall back to target match for mirrored bindings.
    const buttons = document.querySelectorAll(".binding-mute-button");
    buttons.forEach((btn) => {
      let shouldUpdate = false;
      if (payload.binding_id != null && btn.dataset.bindingId === String(payload.binding_id)) {
        shouldUpdate = true;
      } else {
        try {
          const buttonTarget = JSON.parse(btn.dataset.targetJson || "null");
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
    if (!osdSettings.enabled && isOsdWindow) {
      return;
    }
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
    updateIntegrationStateFromEventPayload(payload);

    if (payload.binding_id && typeof payload.volume === "number") {
      bindingLastValues[payload.binding_id] = payload.volume;
    }

    // Update timestamp to signal that a volume change just happened
    lastVolumeUpdateAt = Date.now();

    // Backend Event Update
    // Similar logic to polling: respect local MIDI updates to prevent jitter
    const shouldSuppressIntegrationEcho = (slider) => {
      const bindingId = String(slider?.dataset?.bindingId || "");
      if (!bindingId) return false;
      const binding = bindings.find((b) => b && String(b.id) === bindingId);
      if (!binding || !bindingHasIntegrationTarget(binding)) return false;
      const lastInteraction = Number(bindingInteractionTimes[bindingId] || 0);
      return lastInteraction > 0 && (Date.now() - lastInteraction) < INTEGRATION_ACTIVE_ECHO_SUPPRESSION_MS;
    };

    // 1. Direct update if ID available
    if (payload.binding_id) {
      const momentary = document.querySelector(`.binding-momentary-value[data-binding-id="${payload.binding_id}"]`);
      if (momentary) {
        momentary.classList.toggle("is-active", Number(payload.volume) > 0.5);
      }
      const toggle = document.querySelector(`.binding-toggle-value[data-binding-id="${payload.binding_id}"]`);
      if (toggle) {
        toggle.classList.toggle("on", Number(payload.volume) > 0.5);
      }
      const s = document.querySelector(`.binding-volume-slider[data-binding-id="${payload.binding_id}"]`);
      if (s) {
        const lastMidi = Number(s.dataset.lastMidiUpdate || 0);
        // Ignore immediate backend echo briefly so hardware feedback does not
        // fight the active user move, but release control quickly afterward.
        if (
          Date.now() - lastMidi > BACKEND_ECHO_SUPPRESSION_MS
          && !shouldSuppressIntegrationEcho(s)
        ) {
          setBindingSliderVolume(s, payload.volume, { bindingId: payload.binding_id });
        }
      }
    }

    // 2. Sync others
    const allSliders = document.querySelectorAll(".binding-volume-slider");
    allSliders.forEach(slider => {
      if (payload.binding_id && slider.dataset.bindingId === payload.binding_id) return;

      const lastMidi = Number(slider.dataset.lastMidiUpdate || 0);
      if (
        Date.now() - lastMidi > BACKEND_ECHO_SUPPRESSION_MS
        && !shouldSuppressIntegrationEcho(slider)
      ) {
        try {
          const t = JSON.parse(slider.dataset.targetJson);
          if (targetsMatch(t, payload.target)) {
            setBindingSliderVolume(slider, payload.volume);
          }
        } catch (e) { }
      }
    });

    if (!payload.silent) {
      showVolumeOsd(payload.target, payload.volume, payload.focus_session);
    }
  });

  // Plugin host starts after the active profile loads (see startMainApp).

}

async function loadMidiDevices() {
  return midiFeature?.loadMidiDevicesWithRetry?.() ?? { inputs: [], outputs: [] };
}

async function attemptAutoConnect(deviceData) {
  return midiFeature?.attemptAutoConnect?.(deviceData);
}

async function startMainApp() {
  if (appStarted) {
    return;
  }
  appStarted = true;
  const savedDevice = getSavedMidiDeviceIds().inputId;
  if (!savedDevice && midiStatus) {
    midiStatus.textContent = t("bindings.selectDevicesSentence");
  }
  const deviceData = await loadMidiDevices();
  
  // Load monitors and settings
  await loadMonitorOptions();
  await loadOsdSettings();
  
  await refreshProfiles();
  const profile = await invoke("get_active_profile");
  if (profile) {
    activeProfileName = profile.name;
    localStorage.setItem("activeProfileName", profile.name);
    profilePluginSettings = (profile.plugin_settings && typeof profile.plugin_settings === "object") ? profile.plugin_settings : {};
    activeProfileMidiPreference = normalizeProfileMidiPreference(profile.midi_device_preference);
    bindings = (profile.bindings || []).map((binding, index) => {
      const normalized = normalizeBinding(binding);
      normalized.name = normalized.name?.trim() || bindingFallbackName(normalized, index);
      return normalized;
    });
    if (profile.osd_settings) {
      osdSettings = {
        enabled: Boolean(profile.osd_settings.enabled),
        monitorIndex: Number(profile.osd_settings.monitor_index ?? 0),
        monitorName: profile.osd_settings.monitor_name || null,
        monitorId: profile.osd_settings.monitor_id || null,
        anchor: profile.osd_settings.anchor || "top-right",
        style: profile.osd_settings.style || defaultOsdSettings.style,
        opacity: Number(profile.osd_settings.opacity ?? defaultOsdSettings.opacity),
        scale: Number(profile.osd_settings.scale ?? defaultOsdSettings.scale),
      };
      applyOsdAppearanceAttributes(osdSettings);
    }
    try {
      await startPluginHostIfNeeded();
      renderBindings();
    } catch (e) {
      console.error("renderBindings failed", e);
      diagnosticError("render_bindings_failed", e);
    }
    setProfileSelection(profile.name);
    await applyOsdSettings(osdSettings);
  } else {
    const storedProfile = localStorage.getItem("activeProfileName") || persistedActiveProfileName || "Default";
    await loadProfileByName(storedProfile).catch((error) => {
      diagnosticError("load_profile_by_name_failed", error);
    });
  }

  await refreshProfiles(activeProfileName || "Default");

  const profileHasMidiPreference = hasProfileMidiPreference(activeProfileMidiPreference);
  let usedLegacyFallback = false;

  if (profileHasMidiPreference) {
    await midiFeature?.syncToProfileDevice?.(activeProfileMidiPreference);
  } else {
    usedLegacyFallback = true;
    await attemptAutoConnect(deviceData);
  }

  if (usedLegacyFallback && savedDevice && midiStatus) {
    midiStatus.textContent = t("midi.selectAvailableReconnect");
  }
}

async function init() {
  if (!bindTauriApi()) {
    scheduleRetry(() => init(), 200);
    return;
  }
  diagnosticInfo("setup_listeners_start");
  await setupListeners().catch((error) => {
    diagnosticError("setup_listeners_failed", error);
  });
  diagnosticInfo("setup_listeners_done");
  if (isOsdWindow) {
    await initI18n("en").catch(() => {});
    await loadOsdSettings();
    document.body.setAttribute("data-anchor", osdSettings.anchor || "top-right");
    await refreshSessions().catch((error) => {
      diagnosticError("osd_refresh_sessions_failed", error);
    });
    setInterval(() => {
      refreshSessions().catch((error) => {
        diagnosticError("osd_interval_refresh_sessions_failed", error);
      });
    }, 2000);
    if (osdDebugAlways) {
      showVolumeOsd("Master", 0.5);
    }
    return;
  }

  // Warm plugin list early so the Connections->Plugins UI can render instantly.
  pluginsTabs.preloadInstalledPlugins().catch((error) => {
    diagnosticError("preload_installed_plugins_failed", error);
  });
  pluginsTabs.preloadStoreCatalog().catch((error) => {
    diagnosticError("preload_store_catalog_failed", error);
  });

  diagnosticInfo("load_app_settings_start");
  await loadAppSettings();
  diagnosticInfo("load_app_settings_done");
  await initI18n(appSettings.language || "en").catch((error) => {
    diagnosticError("i18n_init_failed", error);
  });
  applyTranslations();
  applyTheme(document.body.classList.contains("dark-mode") ? "dark" : "light");
  diagnosticInfo("hydrate_client_preferences_start");
  await hydrateClientPreferences();
  diagnosticInfo("hydrate_client_preferences_done");
  mainScreen?.classList?.remove?.("hidden");
  diagnosticInfo("start_main_app_start");
  await startMainApp();
  diagnosticInfo("start_main_app_done");
  try {
    const resetSkipOnceKey = "updaterResetSkipOnce";
    if (localStorage.getItem(resetSkipOnceKey) !== "1") {
      localStorage.removeItem("updaterSkippedVersion");
      localStorage.setItem(resetSkipOnceKey, "1");
    }
  } catch {
    // ignore storage failures
  }
  if (appSettings.autoCheckUpdates !== false) {
    settingsFeature?.checkForUpdates?.({ silent: true }).then((info) => {
      if (!info || !info.available) return;
      const latest = String(info.latestVersion || "").trim();
      const current = String(info.currentVersion || "").trim();
      if (!latest) return;
      const skippedVersionKey = "updaterSkippedVersion";
      try {
        if (localStorage.getItem(skippedVersionKey) === latest) return;
      } catch {
        // ignore storage failures
      }
      showUpdateAvailableDialog({ latestVersion: latest, currentVersion: current });
    }).catch((error) => {
      diagnosticError("auto_update_check_failed", error);
    });
  }
}

export async function startMidimasterApp() {
  await init();
}

window.addEventListener("beforeunload", () => {
  invoke("stop_midi_device").catch(() => { });
});

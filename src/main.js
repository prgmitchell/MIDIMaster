import { createPluginHost } from "./plugin_host.js";
import { PLUGINS_ICON_DATA, createPluginsTabs } from "./features/plugins/tabs.js";
import { createSettingsFeature } from "./features/settings/settings.js";
import { createProfilesFeature } from "./features/profiles/profiles.js";
import { createBindingsFeature } from "./features/bindings/bindings.js";
import { createTargetsFeature } from "./features/targets/targets.js";
import { createOsdFeature } from "./features/osd/osd.js";
import { createMidiFeature } from "./features/midi/midi.js";
import { createTargetCore } from "./core/target_core.js";
import { createConnectionsPanelController } from "./app/connections_panel.js";
import { createAlertsController } from "./app/alerts.js";

let coreApi = null;
let eventApi = null;
let invoke = async (...args) => {
  if (window.__TAURI__?.core?.invoke) {
    return window.__TAURI__.core.invoke(...args);
  }
  throw new Error("Tauri API missing");
};
let listen = async (event, handler) => {
  if (window.__TAURI__?.event?.listen) {
    return window.__TAURI__.event.listen(event, handler);
  }
  console.warn("Tauri Event API missing/delayed for listener:", event);
  return () => { };
};

let pluginHost = null;
let pluginHostStarted = false;

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

async function startPluginHostIfNeeded() {
  if (isOsdWindow) return;

  if (!pluginHost) {
    pluginHost = createPluginHost({
      invoke,
      listen,
      onUpdatePluginSettings: updateProfilePluginSettings,
      onInvalidateBindingsUI: (() => {
        let t = null;
        return () => {
          // Debounce rapid status updates.
          if (t) return;
      t = setTimeout(() => {
        t = null;
        try {
          if (bindingsFeature?.isInlineNameEditingActive?.()) {
            requestBindingsRerender("plugin_invalidate");
            return;
          }
          // Avoid replacing binding rows while the user is actively editing/selecting.
          if (isBindingInteractionActive()) {
            return;
          }
          requestBindingsRerender("plugin_invalidate");
        } catch { }
      }, 75);
    };
  })(),
    });
  }

  // Push profile state BEFORE plugin activation so plugins read correct settings.
  try {
    pluginHost.setProfileState({
      name: activeProfileName || localStorage.getItem("activeProfileName") || "Default",
      plugin_settings: profilePluginSettings || {},
    });
  } catch { }

  if (!pluginHostStarted) {
    await pluginHost.loadInstalledPlugins().catch(() => { });
    await pluginHost.start().catch(() => { });
    pluginHostStarted = true;
  }

  try {
    pluginHost.setBindings(bindings);
  } catch { }

  // Hydrate integration targets with stored display metadata so bindings keep
  // a stable, user-friendly label/icon even if a plugin is later missing.
  try {
    const changed = hydrateIntegrationDisplayMetadata();
    if (changed) {
      try { pluginHost.setBindings(bindings); } catch { }
      await saveBindingsForProfile();
    }
  } catch { }

  // If the connections panel is open, refresh tabs.
  try {
    if (connectionsPanel && !connectionsPanel.classList.contains("hidden")) {
      mountConnectionsTabs({ force: true });
    }
  } catch { }
}

function hydrateIntegrationDisplayMetadata() {
  if (!Array.isArray(bindings) || !bindings.length) return false;
  let changed = false;

  for (const b of bindings) {
    const targets = getBindingTargets(b);
    let updatedAny = false;
    const nextTargets = targets.map((t) => {
      const integ = t?.Integration || t?.integration;
      if (!integ || typeof integ !== "object" || !integ.integration_id) return t;
      const data = (integ.data && typeof integ.data === "object") ? integ.data : {};

      if (typeof data.label === "string") {
        const suffixes = [" (Unavailable)", " (Connecting...)", " (Disconnected)"];
        let nextLabel = data.label;
        for (const s of suffixes) {
          if (nextLabel.endsWith(s)) nextLabel = nextLabel.slice(0, -s.length);
        }
        if (nextLabel !== data.label) {
          updatedAny = true;
          return {
            Integration: {
              integration_id: String(integ.integration_id),
              kind: String(integ.kind || ""),
              data: { ...data, label: nextLabel },
            },
          };
        }
      }

      const hasLabel = typeof data.label === "string" && data.label.trim().length > 0;
      const hasIcon = typeof data.icon_data === "string" && data.icon_data.trim().length > 0;
      if (hasLabel && hasIcon) return t;

      let desc = null;
      try {
        const handler = pluginHost?.getIntegration?.(integ.integration_id);
        if (handler && typeof handler.describeTarget === "function") {
          desc = handler.describeTarget({ Integration: integ });
        }
      } catch {
        desc = null;
      }

      if (!desc || typeof desc !== "object") return t;
      const next = { ...data };
      if (!hasLabel && typeof desc.label === "string" && desc.label.trim()) next.label = desc.label;
      if (!hasIcon && typeof desc.icon_data === "string" && desc.icon_data.trim()) next.icon_data = desc.icon_data;

      if (next.label !== data.label || next.icon_data !== data.icon_data) {
        updatedAny = true;
        return {
          Integration: {
            integration_id: String(integ.integration_id),
            kind: String(integ.kind || ""),
            data: next,
          },
        };
      }
      return t;
    });

    if (updatedAny) {
      setBindingTargets(b, nextTargets);
      changed = true;
    }
  }

  return changed;
}

function getBindingTargets(binding) {
  if (!binding || typeof binding !== "object") return [];
  if (Array.isArray(binding.targets) && binding.targets.length > 0) {
    const normalized = binding.targets.filter(Boolean).filter((t) => t !== "Unset").slice(0, 8);
    if (normalized.length > 0) return normalized;
  }
  if (binding.target != null) {
    return [binding.target];
  }
  return [];
}

function setBindingTargets(binding, targets) {
  if (!binding || typeof binding !== "object") return;
  const normalized = Array.isArray(targets) ? targets.filter(Boolean).slice(0, 8) : [];
  if (normalized.length === 0) normalized.push("Unset");
  binding.targets = normalized;
  binding.target = normalized[0] || "Unset";
}

function getPrimaryBindingTarget(binding) {
  return getBindingTargets(binding)[0] || "Unset";
}

function bindingHasIntegrationTarget(binding) {
  return getBindingTargets(binding).some((target) => {
    const integ = target?.Integration || target?.integration;
    return Boolean(integ && typeof integ === "object" && integ.integration_id);
  });
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== "object") return binding;
  const out = { ...binding };
  setBindingTargets(out, getBindingTargets(out));
  out.mode = (out.mode === "Relative") ? "Relative" : "Absolute";
  out.relative_format = "Auto";
  if (out.assign_mode !== "Replace") out.assign_mode = "Add";
  if (!out.hotkey || typeof out.hotkey !== "object") out.hotkey = null;
  if (!out.open_application || typeof out.open_application !== "object") {
    out.open_application = null;
  } else {
    const path = String(out.open_application.path || "").trim();
    const display = String(out.open_application.display || "").trim();
    const icon_data = typeof out.open_application.icon_data === "string" && out.open_application.icon_data.trim()
      ? out.open_application.icon_data.trim()
      : null;
    out.open_application = path ? { path, display: display || path, icon_data } : null;
  }
  return out;
}

async function updateProfilePluginSettings(pluginId, nextSettings) {
  if (profilesFeature && typeof profilesFeature.updateProfilePluginSettings === "function") {
    return profilesFeature.updateProfilePluginSettings(pluginId, nextSettings);
  }

  // Fallback: update local state and best-effort persist.
  if (!pluginId || typeof pluginId !== "string") return;
  const safe = (nextSettings && typeof nextSettings === "object") ? nextSettings : {};
  profilePluginSettings = { ...(profilePluginSettings || {}), [pluginId]: safe };
  const name = activeProfileName || localStorage.getItem("activeProfileName") || "Default";
  if (!activeProfileName) activeProfileName = name;
  try { pluginHost?.setProfileState?.({ name, plugin_settings: profilePluginSettings }); } catch { }
  await saveBindingsForProfile();
}

function extractIntegrationTarget(target) {
  if (!target || typeof target !== "object") return null;
  const integ = target.Integration || target.integration;
  if (!integ || typeof integ !== "object" || !integ.integration_id) return null;
  return {
    integration_id: String(integ.integration_id),
    kind: String(integ.kind || ""),
    data: integ.data || {},
  };
}

async function triggerIntegration(binding, action, value) {
  if (!pluginHost || !binding) return false;
  const targets = getBindingTargets(binding);
  let invoked = false;
  for (let i = 0; i < targets.length; i += 1) {
    const rawTarget = targets[i];
    const target = extractIntegrationTarget(rawTarget);
    if (!target) continue;
    const handler = pluginHost.getIntegration(target.integration_id);
    if (!handler || typeof handler.onBindingTriggered !== "function") continue;

    await handler.onBindingTriggered({
      binding_id: binding.id,
      action,
      value,
      target,
      target_index: i,
      target_count: targets.length,
      is_primary_target: i === 0,
    });
    invoked = true;
  }
  return invoked;
}

const midiSelect = document.getElementById("midi-device");
const midiOutputSelect = document.getElementById("midi-output-device");
const midiStatus = document.getElementById("midi-status");
const sessionsContainer = document.getElementById("sessions");
const profileDropdown = document.getElementById("profiles-dropdown");
const profileToggle = document.getElementById("profile-toggle");
const profileCurrent = document.getElementById("profile-current");
const profileList = document.getElementById("profile-list");
const bindingsContainer = document.getElementById("bindings");
const mainScreen = document.getElementById("main-screen");
const targetPanel = document.getElementById("target-panel");
const targetPanelList = document.getElementById("target-panel-list");
const targetPanelTitle = document.getElementById("target-panel-title");
const targetPanelClose = document.getElementById("target-panel-close");
const targetPanelBack = document.getElementById("target-panel-back");
const bindingConfigPanel = document.getElementById("binding-config-panel");
const bindingConfigClose = document.getElementById("binding-config-close");
const bindingConfigName = document.getElementById("binding-config-name");
const bindingConfigMuteLabel = document.getElementById("binding-config-mute-label");
const bindingConfigMuteLearn = document.getElementById("binding-config-mute-learn");
const bindingConfigMuteClear = document.getElementById("binding-config-mute-clear");
const bindingConfigAssignLabel = document.getElementById("binding-config-assign-label");
const bindingConfigAssignLearn = document.getElementById("binding-config-assign-learn");
const bindingConfigAssignClear = document.getElementById("binding-config-assign-clear");
const bindingConfigAssignModeRoot = document.getElementById("binding-config-assign-mode-root");
const bindingConfigAssignModeButton = document.getElementById("binding-config-assign-mode-button");
const bindingConfigAssignModeMenu = document.getElementById("binding-config-assign-mode-menu");
const bindingConfigAssignModeAdd = document.getElementById("binding-config-assign-mode-add");
const bindingConfigAssignModeReplace = document.getElementById("binding-config-assign-mode-replace");

// Defensive cleanup for older builds that injected extra back buttons.
try {
  const header = targetPanelTitle?.closest?.(".target-panel-header");
  if (header) {
    header.querySelectorAll(".target-panel-back").forEach((btn) => {
      if (btn.id !== "target-panel-back") {
        btn.remove();
      }
    });
    // Flatten any nested header-left wrappers.
    const left = header.querySelector(".target-panel-header-left");
    if (left) {
      left.querySelectorAll(".target-panel-header-left").forEach((inner) => {
        if (inner === left) return;
        while (inner.firstChild) {
          left.appendChild(inner.firstChild);
        }
        inner.remove();
      });
      if (targetPanelBack && targetPanelBack.parentElement !== left) {
        left.insertBefore(targetPanelBack, left.firstChild);
      }
      if (targetPanelTitle && targetPanelTitle.parentElement !== left) {
        left.appendChild(targetPanelTitle);
      }
    }
  }
} catch (e) {
  // ignore
}
const learnPanel = document.getElementById("learn-panel");
const learnPanelTitle = document.getElementById("learn-panel-title");
const learnPanelMessage = document.getElementById("learn-panel-message");
const learnPanelSpinner = document.getElementById("learn-panel-spinner");
const learnPanelActions = document.getElementById("learn-panel-actions");
const learnPanelCancel = document.getElementById("learn-panel-cancel");
const learnPanelConfirm = document.getElementById("learn-panel-confirm");
const learnPanelClose = document.getElementById("learn-panel-close");
const settingsButton = document.getElementById("settings-button");
const themeToggleButton = document.getElementById("theme-toggle-button");
const settingsPanel = document.getElementById("settings-panel");
const settingsPanelClose = document.getElementById("settings-panel-close");
const connectionsButton = document.getElementById("connections-button");
const connectionsPanel = document.getElementById("connections-panel");
const connectionsPanelClose = document.getElementById("connections-panel-close");
const connectionsSidebar = document.getElementById("connections-sidebar");
const connectionsContent = document.getElementById("connections-content");
const osdEnabledToggle = document.getElementById("osd-enabled");
const osdMonitorSelect = document.getElementById("osd-monitor");
const osdPositionPicker = document.getElementById("osd-position-picker");
const startWithWindowsSelect = document.getElementById("start-with-windows");
const startInTraySelect = document.getElementById("start-in-tray");
const minimizeToTraySelect = document.getElementById("minimize-to-tray");
const exitToTraySelect = document.getElementById("exit-to-tray");
const autoCheckUpdatesButton = document.getElementById("auto-check-updates-button");
const openLogsFolderButton = document.getElementById("open-logs-folder");
const resetAppDataButton = document.getElementById("reset-app-data");
const checkForUpdatesButton = document.getElementById("check-for-updates");
const settingsUpdateStatus = document.getElementById("settings-update-status");
const updateCurrentVersion = document.getElementById("update-current-version");
const updateLatestVersion = document.getElementById("update-latest-version");
const osd = document.getElementById("volume-osd");
// OSD elements are now dynamic
const alertOverlay = document.getElementById("alert-overlay");
const alertTitle = document.getElementById("alert-title");
const alertMessage = document.getElementById("alert-message");
const alertClose = document.getElementById("alert-close");
const alertSecondary = document.getElementById("alert-secondary");
const alertCancel = document.getElementById("alert-cancel");
const alertOk = document.getElementById("alert-ok");

function bindTauriApi() {
  coreApi = window.__TAURI__?.core ?? null;
  eventApi = window.__TAURI__?.event ?? null;
  if (coreApi?.invoke && eventApi?.listen) {
    return true;
  }
  return false;
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
const midiInputStorageKey = "midiDeviceId";
const midiOutputStorageKey = "midiOutputDeviceId";
const midiInputNameStorageKey = "midiDeviceName";
const midiOutputNameStorageKey = "midiOutputDeviceName";
let persistedMidiInputId = "";
let persistedMidiOutputId = "";
let persistedMidiInputName = "";
let persistedMidiOutputName = "";
let persistedActiveProfileName = "";

function normalizeProfileMidiPreference(source) {
  const current = (source && typeof source === "object") ? source : {};
  return {
    inputDeviceId: String(current.inputDeviceId || current.input_device_id || "").trim(),
    outputDeviceId: String(current.outputDeviceId || current.output_device_id || "").trim(),
    inputDeviceName: String(current.inputDeviceName || current.input_device_name || "").trim(),
    outputDeviceName: String(current.outputDeviceName || current.output_device_name || "").trim(),
  };
}

function hasProfileMidiPreference(source) {
  const pref = normalizeProfileMidiPreference(source);
  return Boolean(pref.inputDeviceId && pref.outputDeviceId);
}

function updateThemeToggleMeta(isDark) {
  if (!themeToggleButton) return;
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  themeToggleButton.setAttribute("aria-label", label);
  themeToggleButton.setAttribute("aria-pressed", String(isDark));
  themeToggleButton.setAttribute("title", label);
  themeToggleButton.title = label;
}

function applyTheme(nextTheme) {
  const isDark = nextTheme === "dark";
  document.body.classList.toggle("dark-mode", isDark);
  updateThemeToggleMeta(isDark);
}

function loadStoredTheme() {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // ignore storage failures
  }
  return "light";
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
    if (savedTheme === "light" || savedTheme === "dark") {
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
  for (const k of Object.keys(data)) {
    if (k.endsWith("_name") || k.endsWith("Name") || k === "label" || k === "icon_data") {
      delete data[k];
    }
  }
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
  getSessions: () => sessions,
  getPlaybackDevices: () => playbackDevices,
  getRecordingDevices: () => recordingDevices,
  getPluginHost: () => pluginHost,
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
};

// Integration connectivity is plugin-owned.

if (isOsdWindow) {
  document.body.classList.add("osd-only");
} else {
  applyTheme(loadStoredTheme());
}

function showMain(inputName, outputName) {
  mainScreen?.classList?.remove?.("hidden");
  const input = String(inputName || "").trim() || "Not selected";
  const output = String(outputName || "").trim() || "Not selected";
  midiStatus.textContent = `Input: ${input} | Output: ${output}`;
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

function simplifySessionForComparison(s) {
  // Return a version of the session object without volatile fields like volume/mute
  if (!s) return null;
  const { volume, muted, ...rest } = s;
  return rest;
}

function structurallyEqual(list1, list2) {
  if (list1.length !== list2.length) return false;
  const s1 = list1.map(simplifySessionForComparison);
  const s2 = list2.map(simplifySessionForComparison);
  return JSON.stringify(s1) === JSON.stringify(s2);
}

function updateBindingValues() {
  bindingsFeature?.updateBindingValues?.();
}

async function refreshSessions() {
  let sessionsChanged = false;
  let sessionsStructureChanged = false;
  try {
    const nextSessions = await invoke("list_sessions");
    if (JSON.stringify(nextSessions) !== JSON.stringify(sessions)) {
      if (!structurallyEqual(nextSessions, sessions)) {
        sessionsStructureChanged = true;
      }
      sessions = nextSessions;
      sessionsChanged = true;
    }
  } catch (error) {
    console.warn("Failed to refresh sessions, keeping previous state:", error);
    // Don't clear sessions on transient error
  }

  let devicesChanged = false;
  let devicesStructureChanged = false;
  try {
    const nextPlayback = await invoke("list_playback_devices");
    if (JSON.stringify(nextPlayback) !== JSON.stringify(playbackDevices)) {
      if (!structurallyEqual(nextPlayback, playbackDevices)) {
        devicesStructureChanged = true;
      }
      playbackDevices = nextPlayback;
      devicesChanged = true;
    }
  } catch (error) {
    console.warn("Failed to refresh playback devices, keeping previous state:", error);
    // Don't clear devices on transient error
  }

  try {
    const nextRecording = await invoke("list_recording_devices");
    if (JSON.stringify(nextRecording) !== JSON.stringify(recordingDevices)) {
      if (!structurallyEqual(nextRecording, recordingDevices)) {
        devicesStructureChanged = true;
      }
      recordingDevices = nextRecording;
      devicesChanged = true;
    }
  } catch (error) {
    console.warn("Failed to refresh recording devices, keeping previous state:", error);
    // Don't clear devices on transient error
  }

  if (sessionsStructureChanged && sessionsContainer) {
    sessionsContainer.innerHTML = "";
    sessions.forEach((session) => {
      if (session.is_master || session.id === "master") {
        return;
      }
      const item = document.createElement("div");
      item.className = "list-item";
      const title = document.createElement("div");
      title.textContent = session.display_name;
      const detail = document.createElement("div");
      detail.className = "path";
      detail.textContent = session.process_path || "System";
      item.appendChild(title);
      item.appendChild(detail);
      sessionsContainer.appendChild(item);
    });
  }

  if ((sessionsStructureChanged || devicesStructureChanged) && !isBindingInteractionActive()) {
    renderBindings();
  } else if ((sessionsChanged || devicesChanged) && !isBindingInteractionActive()) {
    // Structure matched (so we didn't re-render), but values changed.
    // Update sliders/buttons in place.
    updateBindingValues();
  }
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
};
let appStarted = false;

// Feature modules
settingsFeature = createSettingsFeature({
  invoke,
  listen,
  dom: {
    settingsButton,
    settingsPanel,
    settingsPanelClose,
    osdEnabledToggle,
    osdMonitorSelect,
    osdPositionPicker,
    startWithWindowsSelect,
    startInTraySelect,
    minimizeToTraySelect,
    exitToTraySelect,
    autoCheckUpdatesButton,
    openLogsFolderButton,
    checkForUpdatesButton,
    settingsUpdateStatus,
    updateCurrentVersion,
    updateLatestVersion,
  },
  getOsdSettings: () => osdSettings,
  setOsdSettings: (next) => { osdSettings = next; },
  getMonitorOptions: () => monitorOptions,
  setMonitorOptions: (next) => { monitorOptions = next; },
  getAppSettings: () => appSettings,
  setAppSettings: (next) => { appSettings = next; },
});
settingsFeature.bindUi();

profilesFeature = createProfilesFeature({
  invoke,
  dom: {
    profileDropdown,
    profileToggle,
    profileCurrent,
    profileList,
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
  getPluginHost: () => pluginHost,
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
});
profilesFeature.bindUi();

targetsFeature = createTargetsFeature({
  invoke,
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
  getPluginHost: () => pluginHost,
  getSessions: () => sessions,
  getPlaybackDevices: () => playbackDevices,
  getRecordingDevices: () => recordingDevices,
  normalizeSessionKey,
  integrationTargetKey,
  resolveOsdTarget,
});
targetsFeature.bindUi();

osdFeature = createOsdFeature({
  osdElement: osd,
  isOsdWindow,
  osdDebugAlways,
  getOsdSettings: () => osdSettings,
  resolveOsdTarget,
  createTargetIcon,
  resolveTargetKey,
});

bindingsFeature = createBindingsFeature({
  invoke,
  dom: {
    bindingsContainer,
    bindingConfigPanel,
    bindingConfigClose,
    bindingConfigName,
    bindingConfigMuteLabel,
    bindingConfigMuteLearn,
    bindingConfigMuteClear,
    bindingConfigAssignLabel,
    bindingConfigAssignLearn,
    bindingConfigAssignClear,
    bindingConfigAssignModeRoot,
    bindingConfigAssignModeButton,
    bindingConfigAssignModeMenu,
    bindingConfigAssignModeAdd,
    bindingConfigAssignModeReplace,
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
  showVolumeOsd,
  showMuteOsd,
  saveBindingsForProfile,
  getPluginHost: () => pluginHost,
  getEditingBindingId: () => editingBindingId,
  setEditingBindingId: (next) => { editingBindingId = next; },
  getPendingFocusBindingId: () => pendingFocusBindingId,
  setPendingFocusBindingId: (next) => { pendingFocusBindingId = next; },
  getDragState: () => dragState,
  setDragState: (next) => { dragState = next; },
  bindingInteractionTimes,
  bindingLastValues,
  bindingMuteValues,
});

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
  showMain,
  refreshSessions,
  addBindingFromLearn: async (learned) => {
    try {
      const learnedMapping = normalizeLearnedControlMapping(learned);
      const conflict = findCreateBindingConflict(learnedMapping);

      if (conflict && conflict.field === "control") {
        hideCreateLearnPanel();
        const owner = conflict.binding?.name || "Unnamed binding";
        showAlert(
          "Already Assigned",
          `This control is already assigned to "${owner}" and can't be added again.`,
        );
        return;
      }

      if (conflict && (conflict.field === "mute_control" || conflict.field === "assign_control")) {
        const owner = conflict.binding?.name || "Unnamed binding";
        const ownerSlot = conflict.field === "mute_control" ? "Mute" : "Assign";
        const confirmed = await promptCreateLearnTransfer(
          `This control is currently mapped as ${ownerSlot} on "${owner}". Transfer it to this new binding?`,
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
      showAlert("Create Binding Failed", String(error));
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
midiFeature.bindUi();

function bindingFallbackName(_binding, index) {
  return `Binding ${index + 1}`;
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

function normalizeRelativeFormat(raw) {
  const value = String(raw || "Auto");
  if (
    value === "Auto"
    || value === "TwosComplement"
    || value === "BinaryOffset"
    || value === "SignMagnitude"
  ) {
    return value;
  }
  return "Auto";
}

function decodeRelativeTwosComplement(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return value;
  if (value >= 65 && value <= 127) return value - 128;
  return null;
}

function decodeRelativeBinaryOffset(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return -(64 - value);
  if (value >= 65 && value <= 127) return value - 64;
  return null;
}

function decodeRelativeSignMagnitude(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return value;
  if (value >= 65 && value <= 127) return -(value - 64);
  return null;
}

function detectRelativeFormatAuto(value, previousFormat) {
  if (previousFormat && previousFormat !== "Auto") {
    return previousFormat;
  }
  if (value >= 96 && value <= 127) return "TwosComplement";
  if (value === 63) return "BinaryOffset";
  if (value >= 65 && value <= 95) return "SignMagnitude";
  return null;
}

function decodeRelativeDelta(binding, value) {
  const configured = normalizeRelativeFormat(binding?.relative_format);
  let format = configured;
  if (format === "Auto") {
    const key = String(binding?.id || "");
    const previouslyDetected = key ? osdRelativeAutoFormatByBinding.get(key) : null;
    const detected = detectRelativeFormatAuto(value, previouslyDetected);
    if (detected && key) {
      osdRelativeAutoFormatByBinding.set(key, detected);
    }
    format = detected || previouslyDetected || "TwosComplement";
  }

  if (format === "TwosComplement") return decodeRelativeTwosComplement(value);
  if (format === "BinaryOffset") return decodeRelativeBinaryOffset(value);
  if (format === "SignMagnitude") return decodeRelativeSignMagnitude(value);
  return null;
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
    const delta = decodeRelativeDelta(binding, payload.value);
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
    return payload.value_14 / 16383;
  }
  return payload.value / 127;
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

window.__OSD_HIDE__ = () => {
  osdFeature?.hideVolumeOsd?.();
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
  getPluginHost: () => pluginHost,
  reloadPlugins: () => connectionsController?.reloadPlugins?.(),
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
    mountPluginsManagerTab: pluginsTabs.mountPluginsManagerTab,
    mountPluginsStoreTab: pluginsTabs.mountPluginsStoreTab,
    preloadInstalledPlugins: () => pluginsTabs.preloadInstalledPlugins(),
  },
  getPluginHost: () => pluginHost,
  setPluginHost: (next) => {
    pluginHost = next;
    if (!next) {
      pluginHostStarted = false;
    }
  },
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

connectionsController?.bindUi?.();

if (themeToggleButton) {
  themeToggleButton.addEventListener("click", toggleTheme);
}

alertsController.bindUi();

// Connections panel opens via openConnectionsPanel()

if (resetAppDataButton) {
  let awaitingResetConfirm = false;
  const resetLabel = "Reset app data";
  const confirmLabel = "Are you sure?";

  resetAppDataButton.addEventListener("click", async () => {
    if (!awaitingResetConfirm) {
      awaitingResetConfirm = true;
      resetAppDataButton.textContent = confirmLabel;
      resetAppDataButton.classList.add("confirming");
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

  settingsPanel?.addEventListener("click", (event) => {
    if (event.target !== resetAppDataButton && awaitingResetConfirm) {
      awaitingResetConfirm = false;
      resetAppDataButton.textContent = resetLabel;
      resetAppDataButton.classList.remove("confirming");
    }
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

const LEARN_PANEL_DEFAULT_TITLE = "Waiting for MIDI Input";
const LEARN_PANEL_DEFAULT_MESSAGE = "Move a control on your MIDI device to create a binding.";

function resetCreateLearnPanelUi() {
  if (!learnPanel) return;
  if (learnPanelTitle) learnPanelTitle.textContent = LEARN_PANEL_DEFAULT_TITLE;
  if (learnPanelMessage) learnPanelMessage.textContent = LEARN_PANEL_DEFAULT_MESSAGE;
  if (learnPanelSpinner) learnPanelSpinner.classList.remove("hidden");
  if (learnPanelActions) learnPanelActions.classList.add("hidden");
  if (learnPanelConfirm) learnPanelConfirm.textContent = "Transfer";
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
  const defaultName = `Binding ${bindings.length + 1}`;
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
    deadzone: 0,
    debounce_ms: 0,
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
  await listen("plugin_osd", (event) => {
    let payload = event?.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (!payload || typeof payload !== "object") return;
    osdFeature?.handleOsdUpdate?.(payload);
  });

  await listen("plugin_osd_hide", () => {
    osdFeature?.hideVolumeOsd?.();
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
      showAlert("Target List Full", "This fader already has 8 targets. Remove one before assigning another app.");
      return;
    }
    if (payload.reason === "focused_app_unavailable") {
      showAlert("Assign Failed", "Could not resolve the focused application. Click the app window and try again.");
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
    const title = String(payload.title || "Action Failed").trim() || "Action Failed";
    const message = String(payload.message || "").trim() || "MIDIMaster could not complete this action.";
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
    refreshSessions().catch(() => { });
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
    const binding = bindings.find((b) => b && b.id === payload.binding_id);
    if (!binding) return;
    const primaryTarget = getPrimaryBindingTarget(binding);
    showMuteOsd(primaryTarget, Boolean(payload.muted));
  });

  await listen("midi_event", (event) => {
    if (mainScreen.classList.contains("hidden")) {
      midiStatus.textContent = `MIDI: ${JSON.stringify(event.payload)}`;
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
    const binding = findBindingForEvent(payload);
    if (!binding || getBindingTargets(binding).length === 0) {
      return;
    }
    if (binding.action === "ToggleMute") {
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
      directSlider.value = volume;
      updateSliderFill(directSlider);
      directSlider.dataset.lastMidiUpdate = Date.now().toString();
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
      btn.innerHTML = payload.muted ? "\ud83d\udd07" : "\ud83d\udd0a";
      btn.classList.toggle("muted", payload.muted);
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

    // 1. Direct update if ID available
    if (payload.binding_id) {
      const s = document.querySelector(`.binding-volume-slider[data-binding-id="${payload.binding_id}"]`);
      if (s) {
        const lastMidi = Number(s.dataset.lastMidiUpdate || 0);
        // If user moved fader < 1s ago, ignore backend echo
        if (Date.now() - lastMidi > 1000) {
          s.value = payload.volume;
          updateSliderFill(s);
        }
      }
    }

    // 2. Sync others
    const allSliders = document.querySelectorAll(".binding-volume-slider");
    allSliders.forEach(slider => {
      if (payload.binding_id && slider.dataset.bindingId === payload.binding_id) return;

      const lastMidi = Number(slider.dataset.lastMidiUpdate || 0);
      if (Date.now() - lastMidi > 1000) {
        try {
          const t = JSON.parse(slider.dataset.targetJson);
          if (targetsMatch(t, payload.target)) {
            slider.value = payload.volume;
            updateSliderFill(slider);
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
    midiStatus.textContent = "Select input and output MIDI devices.";
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
      };
    }
    try {
      await startPluginHostIfNeeded();
      renderBindings();
    } catch (e) {
      console.error("renderBindings failed", e);
    }
    setProfileSelection(profile.name);
    await applyOsdSettings(osdSettings);
  } else {
    const storedProfile = localStorage.getItem("activeProfileName") || persistedActiveProfileName || "Default";
    await loadProfileByName(storedProfile).catch(() => { });
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
    midiStatus.textContent = "Select available input/output devices to reconnect.";
  }
}

async function init() {
  if (!bindTauriApi()) {
    setTimeout(() => init(), 200);
    return;
  }
  await setupListeners().catch(() => { });
  if (isOsdWindow) {
    await loadOsdSettings();
    await refreshSessions().catch(() => { });
    setInterval(() => {
      refreshSessions().catch(() => { });
    }, 2000);
    if (osdDebugAlways) {
      showVolumeOsd("Master", 0.5);
    }
    return;
  }

  // Warm plugin list early so the Connections->Plugins UI can render instantly.
  pluginsTabs.preloadInstalledPlugins().catch(() => { });

  await loadAppSettings();
  await hydrateClientPreferences();
  mainScreen?.classList?.remove?.("hidden");
  await startMainApp();
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
      showChoices({
        title: "Update Available",
        message: `MIDIMaster ${latest} is available (current: ${current || "unknown"})`,
        options: [
          { id: "skip", label: "Skip Update", variant: "secondary" },
          { id: "install", label: "Download and Install", variant: "primary" },
        ],
      }).then((choice) => {
        if (choice === "skip") {
          try {
            localStorage.setItem(skippedVersionKey, latest);
          } catch {
            // ignore storage failures
          }
          return;
        }
        if (choice === "install") {
          settingsFeature?.installAvailableUpdate?.();
        }
      });
    }).catch(() => { });
  }
}

window.addEventListener("load", () => {
  init();
});

window.addEventListener("beforeunload", () => {
  invoke("stop_midi_device").catch(() => { });
});

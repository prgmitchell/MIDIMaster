import { createPluginHost } from "./plugin_host.js";
import { PLUGINS_ICON_DATA, createPluginsTabs } from "./features/plugins/tabs.js";
import { createSettingsFeature } from "./features/settings/settings.js";
import { createProfilesFeature } from "./features/profiles/profiles.js";
import { createBindingsFeature } from "./features/bindings/bindings.js";
import { createTargetsFeature } from "./features/targets/targets.js";
import { createOsdFeature } from "./features/osd/osd.js";
import { createMidiFeature } from "./features/midi/midi.js";
import { createTargetCore } from "./core/target_core.js";

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
            try { renderBindings(); } catch { }
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
    const integ = b?.target?.Integration || b?.target?.integration;
    if (!integ || typeof integ !== "object" || !integ.integration_id) continue;
    const data = (integ.data && typeof integ.data === "object") ? integ.data : {};

    // Sanitize stored labels (older builds stored status suffixes).
    if (typeof data.label === "string") {
      const suffixes = [" (Unavailable)", " (Connecting...)", " (Disconnected)"];
      let nextLabel = data.label;
      for (const s of suffixes) {
        if (nextLabel.endsWith(s)) {
          nextLabel = nextLabel.slice(0, -s.length);
        }
      }
      if (nextLabel !== data.label) {
        const nextData = { ...data, label: nextLabel };
        b.target = {
          Integration: {
            integration_id: String(integ.integration_id),
            kind: String(integ.kind || ""),
            data: nextData,
          },
        };
        changed = true;
        continue;
      }
    }

    const hasLabel = typeof data.label === "string" && data.label.trim().length > 0;
    const hasIcon = typeof data.icon_data === "string" && data.icon_data.trim().length > 0;
    if (hasLabel && hasIcon) continue;

    let desc = null;
    try {
      const handler = pluginHost?.getIntegration?.(integ.integration_id);
      if (handler && typeof handler.describeTarget === "function") {
        desc = handler.describeTarget({ Integration: integ });
      }
    } catch {
      desc = null;
    }

    if (!desc || typeof desc !== "object") continue;
    const next = { ...data };
    if (!hasLabel && typeof desc.label === "string" && desc.label.trim()) {
      next.label = desc.label;
    }
    if (!hasIcon && typeof desc.icon_data === "string" && desc.icon_data.trim()) {
      next.icon_data = desc.icon_data;
    }
    if (next.label !== data.label || next.icon_data !== data.icon_data) {
      b.target = {
        Integration: {
          integration_id: String(integ.integration_id),
          kind: String(integ.kind || ""),
          data: next,
        },
      };
      changed = true;
    }
  }

  return changed;
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
  const target = extractIntegrationTarget(binding.target);
  if (!target) return false;
  const handler = pluginHost.getIntegration(target.integration_id);
  if (!handler || typeof handler.onBindingTriggered !== "function") return false;

  await handler.onBindingTriggered({
    binding_id: binding.id,
    action,
    value,
    target,
  });
  return true;
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
const setupScreen = document.getElementById("setup-screen");
const mainScreen = document.getElementById("main-screen");
const connectedDevice = document.getElementById("connected-device");
const connectedOutputDevice = document.getElementById("connected-output-device");
const targetPanel = document.getElementById("target-panel");
const targetPanelList = document.getElementById("target-panel-list");
const targetPanelTitle = document.getElementById("target-panel-title");
const targetPanelClose = document.getElementById("target-panel-close");
const targetPanelBack = document.getElementById("target-panel-back");

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
const learnPanelMessage = document.getElementById("learn-panel-message");
const learnPanelClose = document.getElementById("learn-panel-close");
const settingsButton = document.getElementById("settings-button");
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
const resetAppDataButton = document.getElementById("reset-app-data");
const osd = document.getElementById("volume-osd");
// OSD elements are now dynamic
const alertOverlay = document.getElementById("alert-overlay");
const alertTitle = document.getElementById("alert-title");
const alertMessage = document.getElementById("alert-message");
const alertClose = document.getElementById("alert-close");
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
let targetMenuListenerBound = false;
const masterIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M5 4h2v10H5zM11 4h2v10h-2z' fill='white'/></svg>";
const focusIconData = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><circle cx='9' cy='9' r='5.5' stroke='white' stroke-width='2' fill='none'/><circle cx='9' cy='9' r='1.5' fill='white'/></svg>";
const osdDebugAlways = false;
const isOsdWindow = new URLSearchParams(window.location.search).has("osd");

const targetCore = createTargetCore({
  masterIconData,
  focusIconData,
  getSessions: () => sessions,
  getPlaybackDevices: () => playbackDevices,
  getRecordingDevices: () => recordingDevices,
  getPluginHost: () => pluginHost,
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
  anchor: "top-right",
};

// Integration connectivity is plugin-owned.

if (isOsdWindow) {
  document.body.classList.add("osd-only");
}

function showSetup(statusText) {
  setupScreen.classList.remove("hidden");
  mainScreen.classList.add("hidden");
  connectedDevice.textContent = "Not connected";
  midiFeature?.stopSessionRefresh?.();
  if (statusText) {
    midiStatus.textContent = statusText;
  }
}

function showMain(inputName, outputName) {
  setupScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");
  connectedDevice.textContent = "Input: " + (inputName || "Connected");
  connectedOutputDevice.textContent = "Output: " + (outputName || "Connected");
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
let osdSettings = { ...defaultOsdSettings };
let monitorOptions = [];
let appSettings = {
  startWithWindows: false,
  startInTray: false,
  minimizeToTray: false,
  exitToTray: false,
};
let appStarted = false;

// Feature modules
settingsFeature = createSettingsFeature({
  invoke,
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
});
profilesFeature.bindUi();

targetsFeature = createTargetsFeature({
  dom: {
    targetPanel,
    targetPanelList,
    targetPanelTitle,
    targetPanelClose,
    targetPanelBack,
  },
  masterIconData,
  focusIconData,
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
    learnPanelMessage,
    learnPanelClose,
    refreshMidiButton: document.getElementById("refresh-midi"),
    connectMidiButton: document.getElementById("connect-midi"),
    disconnectMidiButton: document.getElementById("disconnect-midi"),
    learnBindingButton: document.getElementById("learn-binding"),
    bindingAddFooterButton: document.getElementById("binding-add-footer-button"),
  },
  showSetup,
  showMain,
  refreshSessions,
  addBindingFromLearn: async (learned) => {
    const binding = createBindingFromLearn(learned);
    bindings.push(binding);
    editingBindingId = binding.id;
    pendingFocusBindingId = binding.id;
    renderBindings();
    await invoke("add_binding", { binding });
    await saveBindingsForProfile();
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

function relativeDelta(value) {
  if (value === 0 || value === 64) {
    return 0;
  }
  if (value >= 1 && value <= 63) {
    return value;
  }
  if (value >= 65 && value <= 127) {
    return -(value - 64);
  }
  return null;
}

function findBindingForEvent(payload) {
  if (!payload || !bindings.length) {
    return null;
  }
  return bindings.find((binding) =>
    binding.device_id === payload.device_id
    && binding.control?.channel === payload.channel
    && binding.control?.controller === payload.controller,
  );
}

function resolveOsdVolume(binding, payload) {
  if (!binding || !payload) {
    return null;
  }
  if (binding.mode === "Relative") {
    const delta = relativeDelta(payload.value);
    if (delta == null) {
      return null;
    }
    let current = osdBindingValues.get(binding.id);
    if (current == null) {
      // Prefer last known feedback for integrations (and everything else).
      current = (bindingLastValues[binding.id] != null)
        ? bindingLastValues[binding.id]
        : (resolveTargetVolume(binding.target) ?? 0);
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
async function reloadPlugins() {
  try {
    if (pluginHost) {
      await pluginHost.stop().catch(() => { });
    }
  } catch { }
  pluginHost = null;
  pluginHostStarted = false;
  await startPluginHostIfNeeded().catch(() => { });
  mountConnectionsTabs({ force: true });
}

const pluginsTabs = createPluginsTabs({
  invoke,
  getPluginHost: () => pluginHost,
  reloadPlugins,
});

const mountPluginsManagerTab = pluginsTabs.mountPluginsManagerTab;
const mountPluginsStoreTab = pluginsTabs.mountPluginsStoreTab;

let connectionsTabsSignature = "";
let connectionsSidebarListenerBound = false;

function mountConnectionsTabs(opts = null) {
  const force = (opts && typeof opts === "object") ? Boolean(opts.force) : false;
  if (!connectionsSidebar || !connectionsContent) {
    return;
  }

  if (!connectionsSidebarListenerBound) {
    connectionsSidebarListenerBound = true;
    // Click handling via delegation
    connectionsSidebar.addEventListener("click", (event) => {
      const btn = event.target?.closest?.(".connections-nav-item");
      if (!btn) return;
      const tabId = btn.dataset.tab;
      if (!tabId) return;

      connectionsSidebar.querySelectorAll(".connections-nav-item").forEach((i) => i.classList.remove("active"));
      connectionsContent.querySelectorAll(".connection-tab").forEach((t) => t.classList.remove("active"));

      btn.classList.add("active");
      const pane = document.getElementById(`connection-tab-${tabId}`);
      if (pane) pane.classList.add("active");
    });
  }

  const pluginTabs = pluginHost ? pluginHost.getConnectionTabs() : [];
  const tabs = [
    {
      id: "__plugins_manager__",
      name: "Installed",
      icon_data: PLUGINS_ICON_DATA,
      mount: mountPluginsManagerTab,
    },
    {
      id: "__plugins_store__",
      name: "Store",
      icon_data: PLUGINS_ICON_DATA,
      mount: mountPluginsStoreTab,
    },
    ...pluginTabs,
  ];

  const sig = Array.isArray(tabs) ? tabs.map((t) => t.id).join("|") : "";
  if (!force && sig === connectionsTabsSignature && connectionsSidebar.childElementCount > 0) {
    return;
  }
  connectionsTabsSignature = sig;

  connectionsSidebar.innerHTML = "";
  connectionsContent.innerHTML = "";

  if (!tabs.length) {
    return;
  }

  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "connections-nav-item";
    btn.dataset.tab = tab.id;
    const icon = document.createElement("img");
    icon.className = "nav-icon";
    icon.alt = "";
    icon.src = tab.icon_data || "";
    const label = document.createElement("span");
    label.textContent = tab.name;
    btn.appendChild(icon);
    btn.appendChild(label);
    connectionsSidebar.appendChild(btn);

    const pane = document.createElement("div");
    pane.id = `connection-tab-${tab.id}`;
    pane.className = "connection-tab";
    connectionsContent.appendChild(pane);

    try {
      tab.mount(pane);
    } catch (e) {
      pane.innerHTML = `<div class=\"connection-description\"><p>Failed to load ${tab.name} UI.</p></div>`;
    }
  }

  // Activate first tab by default
  const firstBtn = connectionsSidebar.querySelector(".connections-nav-item");
  const firstPane = connectionsContent.querySelector(".connection-tab");
  if (firstBtn) firstBtn.classList.add("active");
  if (firstPane) firstPane.classList.add("active");
}

async function openConnectionsPanel() {
  if (!connectionsPanel) {
    return;
  }

  // Preload installed plugins so the first render doesn't flash "Loading...".
  await pluginsTabs.preloadInstalledPlugins().catch(() => { });

  connectionsPanel.classList.remove("hidden");

  // Show something immediately, then refresh once plugins are ready.
  mountConnectionsTabs({ force: true });
  startPluginHostIfNeeded()
    .then(() => mountConnectionsTabs({ force: true }))
    .catch(() => { });
}

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

function reconcileMonitorSelection() {
  if (settingsFeature && typeof settingsFeature.reconcileMonitorSelection === "function") {
    return settingsFeature.reconcileMonitorSelection();
  }
  return false;
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

function showAlert(message, title = "Alert") {
  if (!alertOverlay || !alertMessage) {
    return;
  }
  if (alertTitle) {
    alertTitle.textContent = title;
  }
  alertMessage.textContent = message;
  alertOverlay.classList.remove("hidden");
}

function closeAlert() {
  if (alertOverlay) {
    alertOverlay.classList.add("hidden");
  }
}

if (connectionsPanel) {
  connectionsPanel.addEventListener("click", (event) => {
    if (event.target === connectionsPanel) {
      closeConnectionsPanel();
    }
  });
}

if (connectionsPanelClose) {
  connectionsPanelClose.addEventListener("click", closeConnectionsPanel);
}

if (connectionsButton) {
  connectionsButton.addEventListener("click", () => {
    openConnectionsPanel();
  });
}

if (alertClose) {
  alertClose.addEventListener("click", closeAlert);
}

if (alertOk) {
  alertOk.addEventListener("click", closeAlert);
}

if (alertOverlay) {
  alertOverlay.addEventListener("click", (event) => {
    if (event.target === alertOverlay) {
      closeAlert();
    }
  });
}

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

function buildTargetOptions(currentTarget) {
  return targetsFeature?.buildTargetOptions?.(currentTarget);
}

function buildTargetSelect(currentTarget, isBindingButton = false, currentAction = "Volume") {
  return targetsFeature?.buildTargetSelect?.(currentTarget, isBindingButton, currentAction);
}

function createBindingFromLearn(payload) {
  const msgType = payload.msg_type || "ControlChange";
  const isButton = msgType === "Note";
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
    target: "Unset",
    action: isButton ? "ToggleMute" : "Volume",
    mode: "Absolute",
    deadzone: 0,
    debounce_ms: 0,
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
    if (!binding || binding.target === "Unset") {
      return;
    }
    if (binding.action === "ToggleMute") {
      return;
    }
    if (binding.target && (binding.target.Integration || binding.target.integration)) {
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

    if (!(binding.target && (binding.target.Integration || binding.target.integration))) {
      showVolumeOsd(binding.target, volume);
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

    if (payload.binding_id != null && typeof payload.muted === "boolean") {
      bindingMuteValues[payload.binding_id] = payload.muted;
    }

    // Update inline mute buttons
    const buttons = document.querySelectorAll(".binding-mute-button");
    const targetJsonToCheck = JSON.stringify(payload.target);
    buttons.forEach(btn => {
      // Direct match
      if (btn.dataset.targetJson === targetJsonToCheck) {
        btn.innerHTML = payload.muted ? "🔇" : "🔊";
        btn.classList.toggle("muted", payload.muted);
      }
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
  const savedDevice = localStorage.getItem("midiDeviceId");
  if (savedDevice) {
    setupScreen.classList.add("hidden");
    mainScreen.classList.add("hidden");
  } else {
    showSetup("Searching for devices...");
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
    bindings = (profile.bindings || []).map((binding, index) => ({
      ...binding,
      name: binding.name?.trim() || bindingFallbackName(binding, index),
    }));
    if (profile.osd_settings) {
      osdSettings = {
        enabled: Boolean(profile.osd_settings.enabled),
        monitorIndex: Number(profile.osd_settings.monitor_index ?? 0),
        monitorName: profile.osd_settings.monitor_name || null,
        monitorId: profile.osd_settings.monitor_id || null,
        anchor: profile.osd_settings.anchor || "top-right",
      };
      
      // Reconcile index if ID matches a different monitor (e.g. after cable swap/reboot)
      reconcileMonitorSelection();
      
      await applyOsdSettings(osdSettings);
    }
    try {
      await startPluginHostIfNeeded();
      renderBindings();
    } catch (e) {
      console.error("renderBindings failed", e);
    }
    setProfileSelection(profile.name);
  } else {
    const storedProfile = localStorage.getItem("activeProfileName") || "Default";
    await loadProfileByName(storedProfile).catch(() => { });
  }
  await refreshProfiles(activeProfileName || "Default");
  await attemptAutoConnect(deviceData);
  if (savedDevice && mainScreen.classList.contains("hidden")) {
    showSetup("Select MIDI devices to connect.");
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
  setupScreen.classList.add("hidden");
  mainScreen.classList.add("hidden");
  await startMainApp();
}

window.addEventListener("load", () => {
  init();
});

window.addEventListener("beforeunload", () => {
  invoke("stop_midi_device").catch(() => { });
});

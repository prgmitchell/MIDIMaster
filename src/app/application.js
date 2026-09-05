import { createApplicationState } from "./application_state.js";
import { createClientPreferences } from "./controllers/client_preferences.js";
import { createBindingFeedback } from "./controllers/binding_feedback.js";
import { createIntegrationState } from "./controllers/integration_state.js";
import { createBindingDisplay } from "./controllers/binding_display.js";
import { createMidiDisplay } from "./controllers/midi_display.js";
import { createVolumeEvents } from "./controllers/volume_events.js";
import { createBindingCreation } from "./controllers/binding_creation.js";
import { createBackendEvents } from "./controllers/backend_events.js";
import { createStartup } from "./controllers/startup.js";

import { mountFeatureTemplates } from "./feature_templates.js";
import { createUiLifetime } from "./ui_lifetime.js";

import { DEFAULT_OSD_SETTINGS, clampOsdOpacity, clampOsdScale } from "../core/osd_settings.js";
import { PLUGINS_ICON_DATA, createPluginsTabs } from "../features/plugins/tabs.js";
import { createSettingsFeature } from "../features/settings/settings.js";
import { createProfilesFeature } from "../features/profiles/profiles.js";
import { createBindingsFeature } from "../features/bindings/bindings.js";
import { normalizeFaderCurvePresets } from "../features/bindings/fader_curve_presets.js";

import { createTargetsFeature } from "../features/targets/targets.js";
import { createMidiFeature } from "../features/midi/midi.js";
import { createMidiConnectionStatusHandler } from "../features/midi/connection_status.js";
import { getBindingTargets, normalizeBinding, setBindingTargets } from "../core/binding_model.js";
import { createTargetCore } from "../core/target_core.js";
import { createConnectionsPanelController } from "../app/connections_panel.js";
import { createAlertsController } from "../app/alerts.js";
import { createTauriBridge } from "../app/bootstrap.js";
import { normalizeMidiPreference, normalizeMidiRoutes } from "../core/midi_preferences.js";
import {
  appearanceFromLegacyTheme,
  applyAppearanceToDocument,
  defaultAppearanceSettings,
  normalizeAppearanceSettings,
} from "../app/appearance.js";
import { createMidiInventoryController } from "../app/midi_inventory_controller.js";
import { createSessionRefresher } from "../app/session_refresh.js";
import { createPluginRuntime } from "../app/plugin_runtime.js";

import { createDomRefs } from "../app/dom_refs.js";
import { createAppShell } from "../app/app_shell.js";
import { createSettingsStore } from "../app/settings_store.js";
import { performanceAudit } from "../app/performance_audit_api.js";
import { createBindingLookupIndex } from "../app/binding_lookup_index.js";

import { createEventSubscriptions } from "../app/event_subscriptions.js";
import { createMidiEventDispatch } from "../app/midi_event_dispatch.js";
import { applyTranslations, setLocale, supportedLocales, t } from "../app/i18n.js";

export function createApplication() {
  mountFeatureTemplates();
  const lifetime = createUiLifetime();
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
  const eventSubscriptions = createEventSubscriptions({ listen });

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

  const {
    features,
    profileState,
    audioState,
    viewState,
    clientPreferences,
    liveState,
    osdState,
    startupState,
  } = createApplicationState();

  // Keep the app feeling native by disabling the default browser context menu.
  lifetime.listen(document, "contextmenu", (event) => {
    event.preventDefault();
  });

  function getPluginHost() {
    return features.plugins?.getPluginHost?.() || null;
  }

  function getIntegrationDisplayMetadata(integrationId) {
    return features.plugins?.getIntegrationDisplayMetadata?.(integrationId) || null;
  }

  async function startPluginHostIfNeeded(options) {
    return features.plugins?.startPluginHostIfNeeded?.(options);
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
  const { alertOverlay, alertTitle, alertMessage, alertClose, alertSecondary, alertCancel, alertOk } =
    dom.alerts;

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

  function bindTauriApi() {
    return tauriBridge.bind();
  }

  const masterIconData =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M5 4h2v10H5zM11 4h2v10h-2z' fill='white'/></svg>";
  const focusIconData =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><circle cx='9' cy='9' r='5.5' stroke='white' stroke-width='2' fill='none'/><circle cx='9' cy='9' r='1.5' fill='white'/></svg>";
  const mediaPlayPauseIconData =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M4.5 4.2l4.4 4.8-4.4 4.8z' fill='white'/><rect x='10.5' y='4.3' width='1.8' height='9.4' rx='.4' fill='white'/><rect x='13.1' y='4.3' width='1.8' height='9.4' rx='.4' fill='white'/></svg>";
  const mediaNextTrackIconData =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M4 4l5 5-5 5zM9 4l5 5-5 5z' fill='white'/><rect x='14' y='4' width='1.5' height='10' fill='white'/></svg>";
  const mediaPrevTrackIconData =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M14 4L9 9l5 5zM9 4L4 9l5 5z' fill='white'/><rect x='2.5' y='4' width='1.5' height='10' fill='white'/></svg>";
  const mediaStopIconData =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><rect x='5' y='5' width='8' height='8' rx='1.2' fill='white'/></svg>";
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

  const targetCore = createTargetCore({
    masterIconData,
    focusIconData,
    mediaPlayPauseIconData,
    getSessions: () => audioState.sessions,
    getFocusedSession: () => audioState.focusedSession,
    getPlaybackDevices: () => audioState.playbackDevices,
    getRecordingDevices: () => audioState.recordingDevices,
    getPluginHost,
    getIntegrationDisplayMetadata,
    getIntegrationTargetState: (...args) => integrationState.getIntegrationStateForTarget(...args),
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
  const defaultOsdSettings = DEFAULT_OSD_SETTINGS;

  // Integration connectivity is plugin-owned.

  function applyOsdAppearanceAttributes(settings = {}) {
    const style = String(settings.style || defaultOsdSettings.style).trim() || defaultOsdSettings.style;
    const opacity = clampOsdOpacity(settings.opacity ?? defaultOsdSettings.opacity);
    const scale = clampOsdScale(settings.scale ?? defaultOsdSettings.scale);
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
    midiStatus.textContent =
      routeCount > 1
        ? t("midi.statusConnectedMultiple", { input, output, count: routeCount })
        : t("midi.statusConnected", { input, output });
  }

  const midiConnectionStatus = createMidiConnectionStatusHandler({
    normalizeRoutes: normalizeMidiRoutes,
    setActiveRouteCount: (count) => {
      viewState.activeMidiRouteCount = count;
    },
    showMain,
    statusElement: midiStatus,
    translate: t,
  });

  function enabledMidiRouteCount(routes = []) {
    return normalizeMidiRoutes({ routes }).filter((route) => route.enabled !== false).length;
  }

  function knownMidiRouteCount() {
    return (
      viewState.activeMidiRouteCount ||
      enabledMidiRouteCount(clientPreferences.persistedMidiRoutes) ||
      enabledMidiRouteCount(profileState.midiPreference.routes)
    );
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
      await features.profiles?.refreshProfiles?.(profileState.name || "Default");
      return;
    }
    if (page === "settings") {
      await features.settings?.loadOsdSettings();
      await features.settings?.loadMonitorOptions();
      await features.settings?.loadAppSettings();
      await features.settings?.loadCurrentAppVersion?.();
      features.settings?.syncAppSettingsUI(settingsStore.get());
      features.settings?.ensureAutoUpdateCheck?.();
      features.settings?.openSettingsPanel?.();
      features.settings?.renderAllSettingsSelectDropdowns?.();
      features.settings?.syncOsdAppearanceControls?.();
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

  const { applySidebarCollapsed, scheduleSidebarNavIndicatorSync, switchAppPage } = appShellRuntime;

  applyAppearanceToDocument(loadStoredAppearance(), { matchMediaSource: window });
  applySidebarCollapsed(true);

  const sessionRefresher = createSessionRefresher({
    invoke,
    getState: () => ({
      sessions: audioState.sessions,
      focusedSession: audioState.focusedSession,
      playbackDevices: audioState.playbackDevices,
      recordingDevices: audioState.recordingDevices,
      sessionsContainer,
    }),
    setState: (next) => {
      if (Object.prototype.hasOwnProperty.call(next, "sessions")) audioState.sessions = next.sessions;
      if (Object.prototype.hasOwnProperty.call(next, "focusedSession"))
        audioState.focusedSession = next.focusedSession;
      if (Object.prototype.hasOwnProperty.call(next, "playbackDevices"))
        audioState.playbackDevices = next.playbackDevices;
      if (Object.prototype.hasOwnProperty.call(next, "recordingDevices"))
        audioState.recordingDevices = next.recordingDevices;
    },
    actions: {
      isBindingInteractionActive: (...args) => bindingDisplay.isBindingInteractionActive(...args),
      renderBindings: (...args) => features.bindings?.renderBindings(...args),
      updateBindingValues: (...args) => bindingDisplay.updateBindingValues(...args),
      updateBindingTargetDisplays: () => features.bindings?.updateBindingTargetDisplays?.(),
    },
    getLastVolumeUpdateAt: () => liveState.lastVolumeUpdateAt,
  });

  async function refreshSessions(options = {}) {
    return sessionRefresher.refreshSessions(options);
  }

  // Track last interaction time per binding ID
  // Track last valid volume per binding ID
  // Track last known mute per binding ID (from feedback)

  const midiEventDispatch = createMidiEventDispatch({
    shouldPreserve: (payload) =>
      bindingDisplay.bindingIsButtonLike(midiDisplay.findBindingForEvent(payload), payload),
    applyEvent: (payload) => midiDisplay.applyMidiUiEvent(payload),
  });
  const queueMidiUiEvent = (payload) => midiEventDispatch.queue(payload);
  const queuePerfMidiDispatch = (payload) => midiEventDispatch.queuePerformance(payload);
  const takePerfMidiDispatch = (payload) => midiEventDispatch.takePerformance(payload);

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
    const value = liveState.liveMidiValuesByControl.get(key);
    return typeof value === "number" ? value : null;
  }

  const settingsStore = createSettingsStore({
    invoke,
    normalizeFaderCurvePresets,
    supportedLanguages: supportedLocales.map((locale) => locale.code),
    onChange: (settings) => features.bindings?.setCompactBindings?.(settings.compactBindings),
  });

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
    const query =
      typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    if (!query) return;
    const handler = () => {
      const appearance = normalizeAppearanceSettings(
        settingsStore.get().appearance || loadStoredAppearance(),
      );
      if (appearance.activeThemeId === "system") {
        applyGlobalAppearance(appearance);
        features.settings?.syncAppearanceControls?.();
      }
    };
    if (typeof query.addEventListener === "function") {
      lifetime.listen(query, "change", handler);
    } else if (typeof query.addListener === "function") {
      query.addListener(handler);
    }
  }

  const preferenceActions = createClientPreferences({
    clientPreferences,
    invoke,
    midiInputNameStorageKey,
    midiInputStorageKey,
    midiOutputNameStorageKey,
    midiOutputStorageKey,
    profileState,
    settingsStore,
    stripDeviceStateSuffix: (...args) => stripDeviceStateSuffix(...args),
  });

  const bindingFeedback = createBindingFeedback({ features });

  const integrationState = createIntegrationState({ liveState });

  const bindingDisplay = createBindingDisplay({ audioState, features, liveState });

  const midiDisplay = createMidiDisplay({
    BACKEND_ECHO_SUPPRESSION_MS,
    FADER_TRIGGER_FLASH_MIN_MS,
    INTEGRATION_ACTIVE_ECHO_SUPPRESSION_MS,
    applyVolumeUpdatePayload: (...args) => volumeEvents.applyVolumeUpdatePayload(...args),
    bindingIsButtonLike: (...args) => bindingDisplay.bindingIsButtonLike(...args),
    features,
    findBindingSlider: (...args) => bindingDisplay.findBindingSlider(...args),
    findInlineMuteButton: (...args) => bindingFeedback.findInlineMuteButton(...args),
    flashBindingTrigger: (...args) => bindingDisplay.flashBindingTrigger(...args),
    knownMidiRouteCount: (...args) => knownMidiRouteCount(...args),
    getTargetMetadata: () => [audioState.sessions, audioState.playbackDevices,
      audioState.recordingDevices, audioState.focusedSession],
    liveState,
    midiControlSignature: (...args) => midiControlSignature(...args),
    profileState,
    resolveTargetVolume,
    resolveTargetKey,
    targetsMatch,
    setBindingSliderVolume: (...args) => bindingDisplay.setBindingSliderVolume(...args),
    setInlineMuteButtonState: (...args) => bindingFeedback.setInlineMuteButtonState(...args),
  });

  const volumeEvents = createVolumeEvents({
    liveState,
    profileState,
    setBindingSliderVolume: (...args) => bindingDisplay.setBindingSliderVolume(...args),
    syncButtonValueVisual: (...args) => midiDisplay.syncButtonValueVisual(...args),
    targetsMatch,
    updateFocusedSessionState: (...args) => bindingDisplay.updateFocusedSessionState(...args),
    updateIntegrationStateFromEventPayload: (...args) =>
      integrationState.updateIntegrationStateFromEventPayload(...args),
  });

  const bindingCreation = createBindingCreation({
    invoke,
    features,
    viewState,
    showAlert,
    scheduleBindingsSave,
    syncPluginHostBindings,
    learnPanel,
    learnPanelActions,
    learnPanelCancel,
    learnPanelClose,
    learnPanelConfirm,
    learnPanelMessage,
    learnPanelSpinner,
    learnPanelTitle,
    profileState,
  });

  const backendEvents = createBackendEvents({
    applyOsdAppearanceAttributes: (...args) => applyOsdAppearanceAttributes(...args),
    defaultOsdSettings,
    diagnosticError: (...args) => diagnosticError(...args),
    eventSubscriptions,
    features,
    findInlineMuteButton: (...args) => bindingFeedback.findInlineMuteButton(...args),
    liveState,
    mainScreen,
    midiConnectionStatus,
    midiStatus,
    osdState,
    profileState,
    queueMidiUiEvent,
    queuePerfMidiDispatch,
    queueVolumeUpdatePayload: (...args) => midiDisplay.queueVolumeUpdatePayload(...args),
    refreshSessions: (...args) => refreshSessions(...args),
    requestBindingsRerender: (...args) => requestBindingsRerender(...args),
    setInlineMuteButtonState: (...args) => bindingFeedback.setInlineMuteButtonState(...args),
    showAlert,
    syncButtonValueVisual: (...args) => midiDisplay.syncButtonValueVisual(...args),
    takePerfMidiDispatch,
    targetsMatch,
    updateFocusedSessionState: (...args) => bindingDisplay.updateFocusedSessionState(...args),
    updateIntegrationStateFromEventPayload: (...args) =>
      integrationState.updateIntegrationStateFromEventPayload(...args),
  });

  const startup = createStartup({
    applyGlobalAppearance: (...args) => applyGlobalAppearance(...args),
    applyOsdAppearanceAttributes: (...args) => applyOsdAppearanceAttributes(...args),

    bindSystemAppearanceListener: (...args) => bindSystemAppearanceListener(...args),
    bindTauriApi: (...args) => bindTauriApi(...args),
    clientPreferences,
    diagnosticError: (...args) => diagnosticError(...args),
    diagnosticInfo: (...args) => diagnosticInfo(...args),
    features,
    getSavedMidiDeviceIds: (...args) => preferenceActions.getSavedMidiDeviceIds(...args),
    hydrateClientPreferences: (...args) => preferenceActions.hydrateClientPreferences(...args),
    invoke,

    loadStoredAppearance: (...args) => loadStoredAppearance(...args),
    mainScreen,
    maybePromptMidiDeviceInventoryConsent: () => maybePromptMidiDeviceInventoryConsent(),
    midiStatus,
    osdState,
    profileState,
    queueMidiDeviceInventorySubmit: (reason) => queueMidiDeviceInventorySubmit(reason),
    recordPerformanceResult: (...args) => recordPerformanceResult(...args),

    requestBindingsRerender: (...args) => requestBindingsRerender(...args),
    settingsStore,
    setupListeners: (...args) => backendEvents.setupListeners(...args),
    showAlert,
    showUpdateAvailableDialog: (...args) => showUpdateAvailableDialog(...args),

    startupState,
    viewState,
  });

  features.plugins = createPluginRuntime({
    invoke,
    listen,
    isOsdWindow: false,
    getActiveProfileName: () => profileState.name,

    getProfilePluginSettings: () => profileState.pluginSettings,

    getBindings: () => profileState.bindings,
    getProfilesFeature: () => features.profiles,
    getBindingsFeature: () => features.bindings,
    getConnectionsPanel: () => connectionsPanel,
    getBindingTargets,
    setBindingTargets,
    saveBindingsForProfile,
    isBindingInteractionActive: bindingDisplay.isBindingInteractionActive,
    requestBindingsRerender,
    mountConnectionsTabs: (options) => features.connections?.mountConnectionsTabs?.(options),
    showAlert: (title, message = "") => showAlert(title, message),
    showConfirm: (options = {}) => alertsController.showConfirm(options),
  });

  // Feature modules
  diagnosticInfo("settings_factory_start");
  features.settings = createSettingsFeature({
    invoke,
    listen,
    dom: dom.settings,
    i18n: {
      applyTranslations,
      setLocale,
      supportedLocales,
      t,
    },
    getOsdSettings: () => osdState.settings,
    setOsdSettings: (next) => {
      osdState.settings = next;
    },
    getMonitorOptions: () => osdState.monitors,
    setMonitorOptions: (next) => {
      osdState.monitors = next;
    },
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
  features.settings.bindUi();
  diagnosticInfo("settings_bind_ok");

  diagnosticInfo("profiles_factory_start");
  features.profiles = createProfilesFeature({
    invoke,
    i18n: { t },
    dom: dom.profiles,
    defaultOsdSettings,
    getActiveProfileName: () => profileState.name,
    setActiveProfileName: (next) => {
      profileState.name = next;
    },
    getProfilePluginSettings: () => profileState.pluginSettings,
    setProfilePluginSettings: (next) => {
      profileState.pluginSettings = next;
    },
    getBindings: () => profileState.bindings,
    setBindings: (next) => {
      profileState.bindings = next;
      rebuildBindingLookupIndex();
    },
    normalizeBinding,
    bindingFallbackName,
    renderBindings: (...args) => features.bindings?.renderBindings(...args),
    getPluginHost,
    startPluginHostIfNeeded,
    getOsdSettings: () => osdState.settings,
    setOsdSettings: (next) => {
      osdState.settings = next;
    },
    applyOsdSettings: (...args) => features.settings?.applyOsdSettings(...args),
    getCurrentMidiPreference: () =>
      features.midi?.getDesiredMidiPreference?.() || profileState.midiPreference,
    getActiveProfileMidiPreference: () => profileState.midiPreference,
    setActiveProfileMidiPreference: (next) => {
      profileState.midiPreference = normalizeMidiPreference(next);
    },
    onProfileLoaded: async ({ midiDevicePreference, midiDevicePreferenceSet }) => {
      const finish = performanceAudit.begin("profile-midi-sync");
      profileState.midiPreference = normalizeMidiPreference({
        ...(midiDevicePreference || {}),
        configured: Boolean(midiDevicePreferenceSet),
      });
      try {
        await features.midi?.syncToProfileDevice?.(profileState.midiPreference);
        finish();
      } catch (error) {
        finish({ ok: false });
        throw error;
      }
    },
    showAlert: (title, message = "") => showAlert(title, message),
    showChoices,
  });
  diagnosticInfo("profiles_factory_ok");
  diagnosticInfo("profiles_bind_start");
  features.profiles.bindUi();
  diagnosticInfo("profiles_bind_ok");

  diagnosticInfo("targets_factory_start");
  features.targets = createTargetsFeature({
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
    getSessions: () => audioState.sessions,
    getPlaybackDevices: () => audioState.playbackDevices,
    getRecordingDevices: () => audioState.recordingDevices,
    normalizeSessionKey,
    integrationTargetKey,
    resolveOsdTarget,
  });
  diagnosticInfo("targets_factory_ok");
  diagnosticInfo("targets_bind_start");
  features.targets.bindUi();
  void features.targets.start();
  diagnosticInfo("targets_bind_ok");

  diagnosticInfo("bindings_factory_start");
  features.bindings = createBindingsFeature({
    invoke,
    dom: dom.bindings,
    getPlaybackDevices: () => audioState.playbackDevices,
    getRecordingDevices: () => audioState.recordingDevices,
    getBindings: () => profileState.bindings,
    setBindings: (next) => {
      profileState.bindings = next;
    },
    bindingFallbackName,
    controlLabel,
    getMidiDeviceLabel: preferenceActions.midiDeviceLabelForBindingDevice,
    buildTargetSelect: (...args) => features.targets?.buildTargetSelect(...args),
    getVolumeForTarget,
    getMuteForTarget,
    i18n: { t },
    saveBindingsForProfile,
    getFaderCurvePresets: () => settingsStore.get().faderCurvePresets || [],
    saveFaderCurvePresets,
    getPluginHost,
    getEditingBindingId: () => viewState.editingBindingId,
    setEditingBindingId: (next) => {
      viewState.editingBindingId = next;
    },
    getPendingFocusBindingId: () => viewState.pendingFocusBindingId,
    setPendingFocusBindingId: (next) => {
      viewState.pendingFocusBindingId = next;
    },
    getDragState: () => viewState.dragState,
    setDragState: (next) => {
      viewState.dragState = next;
    },
    bindingInteractionTimes: liveState.bindingInteractionTimes,
    bindingLastValues: liveState.bindingLastValues,
    bindingMuteValues: liveState.bindingMuteValues,
    getLiveMidiValueForControl,
    createTargetIcon,
    resolveOsdTarget,
    showAlert: (title, message = "") => showAlert(title, message),
    showConfirm: (options = {}) => alertsController.showConfirm(options),
    onBindingsRendered: rebuildBindingLookupIndex,
  });
  const midiInventoryController = createMidiInventoryController({
    invoke,
    settingsStore,
    syncSettingsUi: (patch) => features.settings?.syncAppSettingsUI?.(patch),
    showChoices,
    translate: t,
    reportError: diagnosticError,
  });
  const queueMidiDeviceInventorySubmit = (reason) => midiInventoryController.queueSubmit(reason);
  const maybePromptMidiDeviceInventoryConsent = () => midiInventoryController.maybePromptConsent();
  diagnosticInfo("bindings_factory_ok");
  diagnosticInfo("bindings_bind_start");
  features.bindings.bindUi();
  diagnosticInfo("bindings_bind_ok");

  diagnosticInfo("midi_factory_start");
  features.midi = createMidiFeature({
    invoke,
    dom: dom.midi,
    i18n: { t },
    showMain,
    refreshSessions,
    addBindingFromLearn: bindingCreation.addBindingFromLearn,
    getSavedMidiDeviceIds: preferenceActions.getSavedMidiDeviceIds,
    clearSavedMidiDeviceIds: preferenceActions.clearSavedMidiDeviceIds,
    onConnected: (connection = {}) => {
      viewState.activeMidiRouteCount = enabledMidiRouteCount(connection.routes || []);
      queueMidiDeviceInventorySubmit("midi_connected");
    },
    onDisconnected: () => {
      viewState.activeMidiRouteCount = 0;
    },
    onDeviceInventoryChanged: () => {
      queueMidiDeviceInventorySubmit("device_inventory_changed");
    },
    onProfileDeviceSelected: async (nextPreference) => {
      const normalized = normalizeMidiPreference(nextPreference);
      profileState.midiPreference = normalized;
      await features.profiles?.updateProfileMidiPreference?.(normalized);
      queueMidiDeviceInventorySubmit("midi_routes_changed");
    },
  });
  diagnosticInfo("midi_factory_ok");
  diagnosticInfo("midi_bind_start");
  features.midi.bindUi();
  diagnosticInfo("midi_bind_ok");

  function bindingFallbackName(_binding, index) {
    return t("bindings.bindingFallback", { number: index + 1 });
  }

  function rebuildBindingLookupIndex() {
    profileState.bindingLookupIndex = createBindingLookupIndex(profileState.bindings);
  }

  function requestBindingsRerender(reason = "") {
    if (features.bindings?.requestSafeRerender) {
      features.bindings.requestSafeRerender(reason);
      return;
    }
    features.bindings?.renderBindings();
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

  function createTargetIcon(option) {
    return features.targets?.createTargetIcon?.(option) || document.createElement("span");
  }

  function closeConnectionsPanel() {
    if (!connectionsPanel) {
      return;
    }
    connectionsPanel.classList.add("hidden");
  }

  const pluginsTabs = createPluginsTabs({
    invoke,
    i18n: { t },
    getPluginHost,
    reloadPlugins: () => features.connections?.reloadPlugins?.(),
    showConfirm: (options = {}) => alertsController.showConfirm(options),
  });

  features.connections = createConnectionsPanelController({
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
    setPluginHost: (next) => features.plugins?.setPluginHost?.(next),
    startPluginHostIfNeeded,
  });

  const mountConnectionsTabs = (...args) => features.connections?.mountConnectionsTabs?.(...args);
  const openConnectionsPanel = (...args) => features.connections?.openConnectionsPanel?.(...args);

  function showUpdateAvailableDialog(info = {}, { standaloneIfMainHidden = false } = {}) {
    const latest = String(info.latestVersion || info.version || "").trim();
    const current = String(info.currentVersion || info.current_version || "").trim();
    if (!latest) return Promise.resolve("close");

    const showInlineDialog = () =>
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
            localStorage.setItem("updaterSkippedVersion", latest);
          } catch {
            // ignore storage failures
          }
          return choice;
        }
        if (choice === "install") {
          features.settings?.installAvailableUpdate?.();
        }
        return choice;
      });

    if (!standaloneIfMainHidden) {
      return showInlineDialog();
    }

    return invoke("show_update_notification_window_if_main_hidden", {
      currentVersion: current || null,
      latestVersion: latest,
    })
      .then((shownStandalone) => (shownStandalone ? "standalone" : showInlineDialog()))
      .catch((error) => {
        diagnosticError("update_notification_window_failed", error);
        return showInlineDialog();
      });
  }

  features.connections?.bindUi?.();

  appNavItems.forEach((item) => {
    lifetime.listen(item, "click", async () => {
      const page = item.dataset.page || "bindings";
      await switchAppPage(page);
    });
  });

  lifetime.listen(window, "resize", scheduleSidebarNavIndicatorSync);
  lifetime.listen(appShell, "transitionend", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (
      target === appShell ||
      target.closest(".app-sidebar") ||
      target.classList.contains("sidebar-nav-item")
    ) {
      scheduleSidebarNavIndicatorSync();
    }
  });
  scheduleSidebarNavIndicatorSync();

  alertsController.bindUi();

  // Connections panel opens via openConnectionsPanel()

  if (resetAppDataButton) {
    lifetime.listen(resetAppDataButton, "click", async () => {
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

  async function saveBindingsForProfile() {
    if (features.profiles && typeof features.profiles.saveBindingsForProfile === "function") {
      return features.profiles.saveBindingsForProfile();
    }
  }

  function scheduleBindingsSave(reason = "binding update") {
    saveBindingsForProfile()?.catch((error) => {
      console.error(`Failed to save profile after ${reason}:`, error);
    });
  }

  function syncPluginHostBindings() {
    try {
      getPluginHost()?.setBindings?.(profileState.bindings);
    } catch {}
  }

  lifetime.listen(document, "pointermove", (event) => {
    features.bindings?.updateBindingDrag(event);
  });

  lifetime.listen(document, "pointerup", () => {
    features.bindings?.endBindingDrag();
  });

  lifetime.listen(document, "pointercancel", () => {
    features.bindings?.cancelBindingDrag();
  });

  async function startMidimasterApp() {
    await startup.init();
  }

  let disposal = null;
  function dispose() {
    if (disposal) return disposal;
    lifetime.dispose();
    features.bindings?.dispose?.();
    features.midi?.dispose?.();
    features.targets?.dispose?.();
    features.settings?.dispose?.();
    features.profiles?.dispose?.().catch((error) => diagnosticError("profile_shutdown_save_failed", error));
    midiInventoryController.dispose();
    midiEventDispatch.clearPerformance();
    invoke("stop_midi_device").catch(() => {});
    disposal = Promise.allSettled([eventSubscriptions.dispose(), features.plugins?.dispose?.()]);
    return disposal;
  }
  lifetime.listen(window, "beforeunload", dispose);

  return { start: startMidimasterApp, dispose };
}

import { createUiLifetime } from "../../app/ui_lifetime.js";
import { createConnect } from "./controllers/connect.js";
import { createLearning } from "./controllers/learning.js";
import { createAvailability } from "./controllers/availability.js";
import { createConnection } from "./controllers/connection.js";
import { createInventory } from "./controllers/inventory.js";
import { createRouteEditor } from "./controllers/route_editor.js";
import { createDeviceOptions } from "./controllers/device_options.js";
import { createRoutePopover } from "./controllers/route_popover.js";
import { createRouteState } from "./controllers/route_state.js";

import { createMidiRouteDraftController } from "./device_preferences.js";
import { createMidiRoutePolicy } from "./route_policy.js";
import { createSessionRefreshScheduler } from "./session_refresh_scheduler.js";

function routeDeviceLabel(route, kind) {
  if (!route) return "";
  if (kind === "input") {
    return route.inputDeviceName || route.inputDeviceId || "";
  }
  return route.outputDeviceName || route.outputDeviceId || "";
}

export function resolveMidiDeviceStatusPresentation({
  routes,
  kind,
  loading = false,
  translate = (key) => key,
} = {}) {
  const activeRoutes = (Array.isArray(routes) ? routes : []).filter((route) => route?.enabled !== false);
  const first = activeRoutes[0] || null;
  const isLoading = Boolean(loading && !first);
  const label = isLoading
    ? translate("midi.loadingDevices")
    : first
      ? routeDeviceLabel(first, kind)
      : translate("midi.noActiveDevice");
  const additionalDevices = activeRoutes
    .slice(1)
    .map((route) => routeDeviceLabel(route, kind))
    .filter(Boolean);
  return {
    activeRoutes,
    isLoading,
    label,
    additionalDevices,
    title: isLoading
      ? translate("midi.loadingDevices")
      : activeRoutes.length > 0
        ? activeRoutes
            .map((route) => routeDeviceLabel(route, kind))
            .filter(Boolean)
            .join(", ")
        : translate("midi.noActiveDevice"),
  };
}

export function createMidiFeature({
  invoke,
  dom,
  showMain,
  refreshSessions,
  onConnected,
  onDisconnected,
  addBindingFromLearn,
  getSavedMidiDeviceIds,
  clearSavedMidiDeviceIds,
  onProfileDeviceSelected,
  onDeviceInventoryChanged,
  i18n,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createMidiFeature: invoke is required");
  }
  const lifetime = createUiLifetime();
  const elements = dom && typeof dom === "object" ? dom : {};
  const t = (key, params = {}) =>
    i18n && typeof i18n.t === "function" ? i18n.t(key, params) : String(key || "");
  const MIDI_ENUM_MIN_INTERVAL_MS = 5000;
  const MIDI_ENUM_STALE_MS = 3000;
  const MIDI_AVAILABILITY_DISCONNECTED_INTERVAL_MS = 3000;
  const MIDI_AVAILABILITY_CONNECTED_INTERVAL_MS = 10000;
  const MIDI_AUTO_REFRESH_INTERVAL_MS = 3000;
  const MIDI_OUTPUT_ENUM_DELAY_MS = 250;
  const LEARN_POLL_MS = 50;

  const discovery = {
    disposed: false,
    autoRefreshTimer: null,
    availabilityTimer: null,
    availabilityCheckInFlight: false,
    deviceRefreshInFlight: null,
    lastDeviceRefreshAt: 0,
    lastDeviceSnapshot: { inputs: [], outputs: [] },
    lastDeviceInventorySignature: "",
    initialDeviceLoadPending: true,
  };
  const learning = {
    learnTimer: null,
  };

  let uiBound = false;

  const connection = {
    suspendProfileAutoReconnect: false,
    applyInFlight: false,
    queuedApply: null,
    connectedInputId: "",
    connectedOutputId: "",
    connectedInputName: "",
    connectedOutputName: "",
    connectedRoutes: [],
    currentProfilePreference: null,
  };

  const routeEditor = createMidiRouteDraftController();
  const routeView = {
    routeEditorApplyInFlight: false,
    inputStatusEl: null,
    inputStatusDisplayEl: null,
    outputStatusEl: null,
    outputStatusDisplayEl: null,
    outputRouteShellEl: null,
    routesButtonEl: null,
    routesPopoverEl: null,
    deviceDocClickBound: false,
  };

  const routePolicy = createMidiRoutePolicy();
  const sessionRefreshScheduler = createSessionRefreshScheduler();

  function bindUi() {
    if (uiBound) return;
    uiBound = true;
    startAvailabilityMonitor();
    ensureDeviceDropdowns();
    renderDeviceDropdowns();
    if (elements.learnPanel) {
      lifetime.listen(elements.learnPanel, "click", (event) => {
        if (event.target === elements.learnPanel) {
          cancelLearnPanel();
        }
      });
    }
    if (elements.learnPanelClose) {
      lifetime.listen(elements.learnPanelClose, "click", cancelLearnPanel);
    }

    if (elements.refreshMidiButton) {
      lifetime.listen(elements.refreshMidiButton, "click", async () => {
        await refreshMidiDevices({ force: true, reason: "manual_refresh" });
      });
    }
    if (elements.learnBindingButton) {
      lifetime.listen(elements.learnBindingButton, "click", () => {
        startLearnBinding();
      });
    }
    if (elements.bindingAddFooterButton) {
      lifetime.listen(elements.bindingAddFooterButton, "click", () => {
        startLearnBinding();
      });
    }
    lifetime.listen(window, "midimaster:locale-changed", () => {
      renderDeviceDropdowns();
      if (
        elements.learnPanel &&
        !elements.learnPanel.classList.contains("hidden") &&
        elements.learnPanelTitle
      ) {
        elements.learnPanelTitle.textContent = t("bindings.waitingMidiTitle");
      }
    });
  }

  function completeInitialDeviceLoad() {
    if (!discovery.initialDeviceLoadPending) return;
    discovery.initialDeviceLoadPending = false;
    renderDeviceDropdowns();
  }

  const {
    setConnectedState,
    setConnectedRoutes,
    getDesiredMidiPreference,
    currentRoutesForSave,
    desiredRoutes,
    preserveUnavailableRouteDrafts,
    resolveDesiredRouteSet,
    unresolvedRouteStatus,
    markSelectedPairUnavailable,
    clearUnavailableDeviceSelections,
    ensureUnavailableRouteOptions,
  } = createRouteState({
    connection,
    elements,
    findDeviceBySavedIdentity: (...args) => findDeviceBySavedIdentity(...args),
    renderDeviceDropdowns: (...args) => renderDeviceDropdowns(...args),
    routeEditor,
    routePolicy,
    t,
  });

  const {
    discardRouteDrafts,
    closeRoutesPopover,
    setIconButton,
    syncRoutesPopoverPosition,
    ensureDeviceDropdowns,
    renderDeviceDropdowns,
  } = createRoutePopover({
    lifetime,
    connection,
    currentRoutesForSave,
    elements,
    desiredRoutes,
    discovery,
    refreshMidiDevices: (...args) => refreshMidiDevices(...args),
    renderRoutesPopover: (...args) => renderRoutesPopover(...args),
    resolveDesiredRouteSet,
    resolveMidiDeviceStatusPresentation,
    routeEditor,
    routeView,
    t,
  });

  const { findDeviceBySavedIdentity, routeWithResolvedNames, buildRouteSelect } = createDeviceOptions({
    currentRoutesForSave,
    discovery,
    routeView,
    t,
    updateRouteFromSelect: (...args) => updateRouteFromSelect(...args),
  });

  const { updateRouteFromSelect, renderRoutesPopover } = createRouteEditor({
    applyRoutes: (...args) => applyRoutes(...args),
    buildRouteSelect,
    closeRoutesPopover,
    currentRoutesForSave,
    elements,
    desiredRoutes,
    discardRouteDrafts,
    discovery,
    refreshMidiDevices: (...args) => refreshMidiDevices(...args),
    resolveDesiredRouteSet,
    routeEditor,
    routeView,
    routeWithResolvedNames,
    setIconButton,
    syncRoutesPopoverPosition,
    t,
    unresolvedRouteStatus,
  });

  const { hasPreference, enumerateMidiDevices } = createInventory({
    MIDI_ENUM_MIN_INTERVAL_MS,
    MIDI_OUTPUT_ENUM_DELAY_MS,
    discovery,
    invoke,
    onDeviceInventoryChanged,
  });

  const {
    getMidiRouteHealth,
    routeHealthNeedsRecovery,
    startWithResolvedDevice,
    routesEquivalent,
    applyRoutes,
  } = createConnection({
    cancelLearnPanel: (...args) => cancelLearnPanel(...args),
    clearUnavailableDeviceSelections,
    connection,
    elements,
    discovery,
    ensureUnavailableRouteOptions,
    invoke,
    onConnected,
    onDisconnected,
    onProfileDeviceSelected,
    refreshSessions,
    renderDeviceDropdowns,
    resolveDesiredRouteSet,
    routeWithResolvedNames,
    setConnectedRoutes,
    showMain,
    startSessionRefresh: (...args) => startSessionRefresh(...args),
    stopSessionRefresh: (...args) => stopSessionRefresh(...args),
    t,
  });

  const { checkAvailabilityLoop, startAvailabilityMonitor, startAutoRefresh, stopAutoRefresh } =
    createAvailability({
      MIDI_AUTO_REFRESH_INTERVAL_MS,
      MIDI_AVAILABILITY_CONNECTED_INTERVAL_MS,
      MIDI_AVAILABILITY_DISCONNECTED_INTERVAL_MS,
      applyRoutes,
      connection,
      elements,
      desiredRoutes,
      discovery,
      enumerateMidiDevices,
      getMidiRouteHealth,
      hasPreference,
      invoke,
      markSelectedPairUnavailable,
      onDisconnected,
      onProfileDeviceSelected,
      preserveUnavailableRouteDrafts,
      refreshMidiDevices: (...args) => refreshMidiDevices(...args),
      renderDeviceDropdowns,
      resolveDesiredRouteSet,
      routeHealthNeedsRecovery,
      routeWithResolvedNames,
      routesEquivalent,
      setConnectedRoutes,
      showMain,
      stopSessionRefresh: (...args) => stopSessionRefresh(...args),
      t,
      unresolvedRouteStatus,
    });

  const { startSessionRefresh, stopSessionRefresh, closeLearnPanel, openLearnPanel, cancelLearnPanel } =
    createLearning({
      elements,
      learning,
      sessionRefreshScheduler,
      t,
    });

  const {
    refreshMidiDevices,
    connectSelected,
    disconnect,
    startLearnBinding,
    loadMidiDevicesWithRetry,
    attemptAutoConnect,
    syncToProfileDevice,
  } = createConnect({
    LEARN_POLL_MS,
    addBindingFromLearn,
    applyRoutes,
    cancelLearnPanel,
    clearSavedMidiDeviceIds,
    clearUnavailableDeviceSelections,
    closeLearnPanel,
    closeRoutesPopover,
    connection,
    elements,
    desiredRoutes,
    discardRouteDrafts,
    discovery,
    ensureUnavailableRouteOptions,
    enumerateMidiDevices,
    getSavedMidiDeviceIds,
    invoke,
    learning,
    onDisconnected,
    onProfileDeviceSelected,
    openLearnPanel,
    renderDeviceDropdowns,
    resolveDesiredRouteSet,
    routeView,
    routesEquivalent,
    setConnectedState,
    showMain,
    startAutoRefresh,
    startWithResolvedDevice,
    stopAutoRefresh,
    stopSessionRefresh,
    t,
    unresolvedRouteStatus,
  });

  function dispose() {
    discovery.disposed = true;
    lifetime.dispose();
    stopSessionRefresh();
    stopAutoRefresh();
    clearTimeout(discovery.availabilityTimer);
    discovery.availabilityTimer = null;
    closeLearnPanel();
    closeRoutesPopover();
  }

  return {
    dispose,
    bindUi,
    refreshMidiDevices,
    loadMidiDevicesWithRetry,
    attemptAutoConnect,
    startSessionRefresh: () => startSessionRefresh(refreshSessions || (async () => {}), elements.mainScreen),
    stopSessionRefresh,
    startLearnBinding,
    openLearnPanel,
    closeLearnPanel,
    cancelLearnPanel,
    connectSelected,
    disconnect,
    syncToProfileDevice,
    completeInitialDeviceLoad,
    getDesiredMidiPreference,
    checkAvailabilityNow: checkAvailabilityLoop,
  };
}

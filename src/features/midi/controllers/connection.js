import {
  normalizeMidiPreference,
  normalizeMidiRoutes,
  hasDuplicateInputRoute,
  findPreferredDevice,
  buildPersistedMidiRoutes,
  orderMidiRoutesByPreference,
} from "../device_preferences.js";
import { routesFromResolvedPreferences } from "../route_policy.js";

/** connection workflow. */
export function createConnection({
  cancelLearnPanel,
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
  startSessionRefresh,
  stopSessionRefresh,
  t,
}) {
  async function getMidiConnectionHealth() {
    try {
      return await invoke("get_midi_connection_health");
    } catch {
      return null;
    }
  }

  async function getMidiRouteHealth() {
    try {
      const health = await invoke("get_midi_route_health");
      return Array.isArray(health) ? health : [];
    } catch {
      const fallback = await getMidiConnectionHealth();
      return fallback ? [fallback] : [];
    }
  }

  function routeHealthNeedsRecovery(health) {
    return Boolean(
      health?.connected === false ||
        health?.suspect ||
        health?.inputSuspect ||
        health?.inputNameMismatch ||
        health?.outputSuspect ||
        health?.outputNameMismatch,
    );
  }

  async function startWithResolvedDevice(input, output, options = {}) {
    return applyRoutes(
      [
        {
          inputDeviceId: input.id,
          outputDeviceId: output.id,
          inputDeviceName: input.name || options.inputName || "",
          outputDeviceName: output.name || options.outputName || "",
          enabled: true,
        },
      ],
      {
        source: options.fromProfile ? "profile" : options.auto ? "auto" : "manual",
        auto: Boolean(options.auto),
        fromProfile: Boolean(options.fromProfile),
      },
    );
  }

  function routesEquivalent(left, right) {
    const a = normalizeMidiRoutes({ routes: left });
    const b = normalizeMidiRoutes({ routes: right });
    if (a.length !== b.length) return false;
    return a.every((route, index) => {
      const other = b[index];
      return (
        other &&
        route.inputDeviceId === other.inputDeviceId &&
        route.outputDeviceId === other.outputDeviceId &&
        (route.enabled !== false) === (other.enabled !== false)
      );
    });
  }

  async function applyRoutes(routes, options = {}) {
    const rawRoutes = Array.isArray(routes) ? routes : [];
    for (let index = 0; index < rawRoutes.length; index += 1) {
      const route = rawRoutes[index];
      const inputDeviceId = route?.inputDeviceId || route?.input_device_id || "";
      if (hasDuplicateInputRoute(rawRoutes, inputDeviceId, index)) {
        if (elements.midiStatus) elements.midiStatus.textContent = t("midi.duplicateInputRoute");
        renderDeviceDropdowns();
        return { connected: false, reason: "duplicate_input_route" };
      }
    }

    const requested = normalizeMidiRoutes({ routes });
    const normalized = routesFromResolvedPreferences(
      resolveDesiredRouteSet(
        discovery.lastDeviceSnapshot,
        { routes: requested, configured: true },
        options.source || "apply",
      ),
    );
    const enabledRoutes = normalized.filter((route) => route.enabled !== false);
    const previousConnectedRoutes = connection.connectedRoutes.slice();

    if (enabledRoutes.length === 0) {
      stopSessionRefresh();
      cancelLearnPanel();
      connection.currentProfilePreference = normalizeMidiPreference({ routes: normalized, configured: true });
      setConnectedRoutes([]);
      if (elements.midiStatus) elements.midiStatus.textContent = t("midi.notConnected");
      if (typeof onDisconnected === "function") onDisconnected();
      renderDeviceDropdowns();
      await invoke("stop_midi_device").catch(() => {});
      if (typeof onProfileDeviceSelected === "function") {
        await onProfileDeviceSelected(connection.currentProfilePreference);
      }
      return { connected: false, reason: "no_enabled_routes" };
    }

    const availableRoutes = enabledRoutes.filter((route) => {
      const inputAvailable = findPreferredDevice(
        discovery.lastDeviceSnapshot.inputs,
        route.inputDeviceId,
        route.inputDeviceName,
      );
      const outputAvailable = findPreferredDevice(
        discovery.lastDeviceSnapshot.outputs,
        route.outputDeviceId,
        route.outputDeviceName,
      );
      return Boolean(inputAvailable && outputAvailable);
    });
    const hasUnavailableRoutes = availableRoutes.length < enabledRoutes.length;
    const routesToStart =
      hasUnavailableRoutes && options.allowPartialUnavailable ? availableRoutes : enabledRoutes;
    if (hasUnavailableRoutes && (!options.allowPartialUnavailable || routesToStart.length === 0)) {
      if (elements.midiStatus) {
        elements.midiStatus.textContent = options.partialUnavailableStatus || t("midi.unavailablePair");
      }
      if (options.allowPartialUnavailable) {
        ensureUnavailableRouteOptions(
          discovery.lastDeviceSnapshot.inputs || [],
          discovery.lastDeviceSnapshot.outputs || [],
        );
        connection.currentProfilePreference = normalizeMidiPreference({
          routes: normalized,
          configured: true,
        });
        if (routesToStart.length === 0 && connection.connectedRoutes.length > 0) {
          await invoke("stop_midi_device").catch(() => {});
          setConnectedRoutes([]);
          if (typeof onDisconnected === "function") onDisconnected();
        }
        if (typeof onProfileDeviceSelected === "function") {
          await onProfileDeviceSelected(connection.currentProfilePreference);
        }
      }
      renderDeviceDropdowns();
      return {
        connected: connection.connectedRoutes.length > 0,
        partial: Boolean(options.allowPartialUnavailable),
        reason: "unavailable_selection",
        routes: connection.connectedRoutes.slice(),
      };
    }

    // Recovery must reach the backend even when the saved device IDs are unchanged.
    // Keep force separate: the backend should preserve other healthy connections.
    if (!options.force && !options.recover && routesEquivalent(routesToStart, connection.connectedRoutes)) {
      if (hasUnavailableRoutes && elements.midiStatus) {
        elements.midiStatus.textContent = options.partialUnavailableStatus || t("midi.savedUnavailable");
      }
      renderDeviceDropdowns();
      connection.currentProfilePreference = normalizeMidiPreference({ routes: normalized });
      if (typeof onProfileDeviceSelected === "function") {
        await onProfileDeviceSelected(connection.currentProfilePreference);
      }
      return {
        connected: routesToStart.length > 0 || connection.connectedRoutes.length > 0,
        unchanged: true,
        partial: hasUnavailableRoutes,
        routes: connection.connectedRoutes.slice(),
      };
    }

    if (elements.midiStatus) elements.midiStatus.textContent = t("midi.applyingChange");
    const first = routesToStart[0] || enabledRoutes[0] || {};
    if (elements.midiSelect) elements.midiSelect.value = first.inputDeviceId || "";
    if (elements.midiOutputSelect) elements.midiOutputSelect.value = first.outputDeviceId || "";

    stopSessionRefresh();
    let applyResult = null;
    try {
      applyResult = await invoke("start_midi_device_routes", {
        routes: buildPersistedMidiRoutes(routesToStart),
        force: Boolean(options.force),
      });
    } catch (error) {
      setConnectedRoutes(previousConnectedRoutes);
      renderDeviceDropdowns();
      if (elements.midiStatus) elements.midiStatus.textContent = t("midi.connectFailed", { message: error });
      throw error;
    }

    const backendRoutes = normalizeMidiRoutes({
      routes: applyResult?.connectedRoutes || applyResult?.connected_routes || routesToStart,
    });
    setConnectedRoutes(orderMidiRoutesByPreference(backendRoutes.map(routeWithResolvedNames), normalized));
    const backendFailures = Array.isArray(applyResult?.failedRoutes)
      ? applyResult.failedRoutes
      : Array.isArray(applyResult?.failed_routes)
        ? applyResult.failed_routes
        : [];
    const incompleteBackendApply = applyResult?.complete === false || backendFailures.length > 0;
    if (!incompleteBackendApply) {
      connection.currentProfilePreference = normalizeMidiPreference({ routes: normalized });
      connection.suspendProfileAutoReconnect = false;
      clearUnavailableDeviceSelections();
    }
    if ((hasUnavailableRoutes || incompleteBackendApply) && elements.midiStatus) {
      elements.midiStatus.textContent = options.partialUnavailableStatus || t("midi.partialRetrying");
    }

    if (typeof showMain === "function") {
      const count = connection.connectedRoutes.length;
      showMain(connection.connectedInputName, connection.connectedOutputName, {
        connected: count > 0,
        routeCount: count,
        routes: connection.connectedRoutes.slice(),
      });
    }
    if (typeof refreshSessions === "function") {
      await refreshSessions();
    }
    if (connection.connectedRoutes.length > 0) {
      startSessionRefresh(refreshSessions || (async () => {}), elements.mainScreen);
    } else if (typeof onDisconnected === "function") {
      onDisconnected();
    }
    if (connection.connectedRoutes.length > 0 && typeof onConnected === "function") {
      onConnected({
        inputId: connection.connectedInputId,
        outputId: connection.connectedOutputId,
        routes: connection.connectedRoutes.slice(),
        source: options.source || "manual",
        auto: Boolean(options.auto),
        fromProfile: Boolean(options.fromProfile),
      });
    }
    if (!incompleteBackendApply && typeof onProfileDeviceSelected === "function") {
      await onProfileDeviceSelected(connection.currentProfilePreference);
    }
    renderDeviceDropdowns();

    return {
      connected: connection.connectedRoutes.length > 0,
      inputId: connection.connectedInputId,
      outputId: connection.connectedOutputId,
      inputName: connection.connectedInputName,
      outputName: connection.connectedOutputName,
      partial: hasUnavailableRoutes || incompleteBackendApply,
      routes: connection.connectedRoutes.slice(),
      failures: backendFailures,
    };
  }

  return {
    getMidiRouteHealth,
    routeHealthNeedsRecovery,
    startWithResolvedDevice,
    routesEquivalent,
    applyRoutes,
  };
}

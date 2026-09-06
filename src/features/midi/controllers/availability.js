import {
  normalizeMidiPreference,
  findConnectedAliveDevice,
  findPreferredDevice,
} from "../device_preferences.js";
import { routesFromResolvedPreferences } from "../route_policy.js";

/** availability workflow. */
export function createAvailability({
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
  refreshMidiDevices,
  renderDeviceDropdowns,
  resolveDesiredRouteSet,
  routeHealthNeedsRecovery,
  routeWithResolvedNames,
  routesEquivalent,
  setConnectedRoutes,
  showMain,
  stopSessionRefresh,
  t,
  unresolvedRouteStatus,
}) {
  async function checkAvailabilityLoop() {
    if (discovery.disposed) return;
    if (discovery.availabilityCheckInFlight) return;
    discovery.availabilityCheckInFlight = true;
    try {
      const pref = normalizeMidiPreference(connection.currentProfilePreference);
      const prefAvailable = hasPreference(pref);
      const currentlyConnected = connection.connectedRoutes.length > 0;
      if (!prefAvailable && !currentlyConnected) return;

      const deviceSnapshot = await enumerateMidiDevices({ force: true, reason: "availability" });
      const devices = deviceSnapshot.inputs;
      const outputDevices = deviceSnapshot.outputs;

      if (currentlyConnected) {
        const routeHealth = await getMidiRouteHealth();
        const suspectRoute = routeHealth.find(
          (health) =>
            routeHealthNeedsRecovery(health) &&
            connection.connectedRoutes.some(
              (route) =>
                route.inputDeviceId === health.inputDeviceId &&
                route.outputDeviceId === health.outputDeviceId,
            ),
        );
        if (suspectRoute && prefAvailable && !connection.suspendProfileAutoReconnect) {
          try {
            let resolvedRoutes = resolveDesiredRouteSet(deviceSnapshot, pref, "suspect_reconnect");
            if (!resolvedRoutes.available) {
              const refreshed = await refreshMidiDevices({ force: true, reason: "suspect_reconnect" });
              resolvedRoutes = resolveDesiredRouteSet(refreshed, pref, "suspect_reconnect_retry");
            }
            const anyRouteAvailable = resolvedRoutes.routes.some(
              (route) => route.preference.enabled !== false && route.inputMatch && route.outputMatch,
            );
            if (resolvedRoutes.available || anyRouteAvailable) {
              const result = await applyRoutes(routesFromResolvedPreferences(resolvedRoutes), {
                recover: true,
                auto: true,
                fromProfile: true,
                allowPartialUnavailable: !resolvedRoutes.available,
                partialUnavailableStatus: unresolvedRouteStatus(resolvedRoutes),
              });
              if (elements.midiStatus) {
                elements.midiStatus.textContent = result?.partial || !result?.connected
                  ? unresolvedRouteStatus(resolvedRoutes)
                  : t("midi.reconnectedProfile");
              }
              return;
            }
          } catch {
            const route =
              connection.connectedRoutes.find(
                (candidate) =>
                  candidate.inputDeviceId === suspectRoute.inputDeviceId &&
                  candidate.outputDeviceId === suspectRoute.outputDeviceId,
              ) || {};
            markSelectedPairUnavailable(
              suspectRoute.inputDeviceId,
              suspectRoute.outputDeviceId,
              route.inputDeviceName || suspectRoute.inputDeviceId,
              route.outputDeviceName || suspectRoute.outputDeviceId,
            );
            return;
          }
        }

        const aliveRoutes = [];
        const missingRoutes = [];
        connection.connectedRoutes.forEach((route) => {
          const inputAlive = findConnectedAliveDevice(devices, route.inputDeviceId, route.inputDeviceName);
          const outputAlive = findConnectedAliveDevice(
            outputDevices,
            route.outputDeviceId,
            route.outputDeviceName,
          );
          if (inputAlive && outputAlive) {
            aliveRoutes.push(route);
          } else {
            missingRoutes.push(route);
          }
        });

        if (missingRoutes.length > 0) {
          const preservedDrafts = preserveUnavailableRouteDrafts(aliveRoutes, missingRoutes);
          for (const route of missingRoutes) {
            await invoke("stop_midi_route", { inputDeviceId: route.inputDeviceId }).catch(() => {});
          }
          setConnectedRoutes(aliveRoutes.map(routeWithResolvedNames));
          connection.currentProfilePreference = normalizeMidiPreference({
            routes: preservedDrafts,
            configured: true,
          });
          if (typeof showMain === "function") {
            const displayRoute = aliveRoutes[0] || missingRoutes[0] || {};
            showMain(
              displayRoute.inputDeviceName || displayRoute.inputDeviceId || pref.inputDeviceName,
              displayRoute.outputDeviceName || displayRoute.outputDeviceId || pref.outputDeviceName,
              {
                connected: aliveRoutes.length > 0,
                routeCount: aliveRoutes.length,
                routes: connection.connectedRoutes.slice(),
              },
            );
          }
          if (elements.midiStatus) {
            elements.midiStatus.textContent = t("midi.partialRetrying");
          }
          if (aliveRoutes.length === 0) {
            stopSessionRefresh();
            if (typeof onDisconnected === "function") onDisconnected();
          }
          await refreshMidiDevices({ snapshot: deviceSnapshot, reason: "disconnect" });
        }
      }

      if (prefAvailable && !connection.suspendProfileAutoReconnect) {
        let resolvedRoutes = resolveDesiredRouteSet(deviceSnapshot, pref, "availability");
        if (!resolvedRoutes.available) {
          const refreshed = await refreshMidiDevices({
            snapshot: deviceSnapshot,
            reason: "reconnect_available",
          });
          resolvedRoutes = resolveDesiredRouteSet(refreshed, pref, "availability_retry");
        }
        const anyRouteAvailable = resolvedRoutes.routes.some(
          (route) => route.preference.enabled !== false && route.inputMatch && route.outputMatch,
        );
        if (!resolvedRoutes.available && !anyRouteAvailable) {
          if (elements.midiStatus) elements.midiStatus.textContent = unresolvedRouteStatus(resolvedRoutes);
          return;
        }
        const routes = routesFromResolvedPreferences(resolvedRoutes);
        const availableEnabledRoutes = routes.filter(
          (route) =>
            route.enabled !== false &&
            findPreferredDevice(
              discovery.lastDeviceSnapshot.inputs,
              route.inputDeviceId,
              route.inputDeviceName,
            ) &&
            findPreferredDevice(
              discovery.lastDeviceSnapshot.outputs,
              route.outputDeviceId,
              route.outputDeviceName,
            ),
        );
        if (routesEquivalent(availableEnabledRoutes, connection.connectedRoutes)) {
          connection.currentProfilePreference = normalizeMidiPreference({ routes });
          if (typeof onProfileDeviceSelected === "function") {
            await onProfileDeviceSelected(connection.currentProfilePreference);
          }
          renderDeviceDropdowns();
          return;
        }
        try {
          const result = await applyRoutes(routes, {
            auto: true,
            fromProfile: true,
            allowPartialUnavailable: !resolvedRoutes.available,
            partialUnavailableStatus: unresolvedRouteStatus(resolvedRoutes),
          });
          if (elements.midiStatus) {
            elements.midiStatus.textContent = resolvedRoutes.available && result?.connected && !result?.partial
              ? t("midi.reconnectedProfile")
              : unresolvedRouteStatus(resolvedRoutes);
          }
        } catch {
          // Ignore transient reconnect failures; watcher will retry.
        }
      }
    } finally {
      discovery.availabilityCheckInFlight = false;
    }
  }

  function startAvailabilityMonitor() {
    if (discovery.disposed) return;
    if (discovery.availabilityTimer) return;
    const enabledDesired = desiredRoutes().filter((route) => route.enabled !== false);
    const hasMissingDesiredRoute =
      enabledDesired.length > connection.connectedRoutes.length ||
      !routesEquivalent(enabledDesired, connection.connectedRoutes);
    const delay =
      !hasMissingDesiredRoute && connection.connectedInputId && connection.connectedOutputId
        ? MIDI_AVAILABILITY_CONNECTED_INTERVAL_MS
        : MIDI_AVAILABILITY_DISCONNECTED_INTERVAL_MS;
    discovery.availabilityTimer = setTimeout(async () => {
      discovery.availabilityTimer = null;
      await checkAvailabilityLoop().catch(() => {});
      startAvailabilityMonitor();
    }, delay);
  }

  function startAutoRefresh(refreshFn) {
    if (discovery.disposed) return;
    if (discovery.autoRefreshTimer) {
      return;
    }
    discovery.autoRefreshTimer = setInterval(async () => {
      const devices = await refreshFn();
      if (devices.inputs.length > 0 && devices.outputs.length > 0) {
        await checkAvailabilityLoop().catch(() => {});
      }
      if (connection.connectedInputId && connection.connectedOutputId) {
        stopAutoRefresh();
      }
    }, MIDI_AUTO_REFRESH_INTERVAL_MS);
  }

  function stopAutoRefresh() {
    if (discovery.autoRefreshTimer) {
      clearInterval(discovery.autoRefreshTimer);
      discovery.autoRefreshTimer = null;
    }
  }

  return { checkAvailabilityLoop, startAvailabilityMonitor, startAutoRefresh, stopAutoRefresh };
}

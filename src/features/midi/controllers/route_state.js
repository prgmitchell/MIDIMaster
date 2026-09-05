import {
  normalizeMidiRoutes,
  normalizeMidiPreference,
  unavailableDeviceLabel,
} from "../device_preferences.js";
import { preserveUnavailableRouteDrafts as mergeUnavailableRouteDrafts } from "../route_policy.js";

/** route state workflow. */
export function createRouteState({
  connection,
  elements,
  findDeviceBySavedIdentity,
  renderDeviceDropdowns,
  routeEditor,
  routePolicy,
  t,
}) {
  function setConnectedState(inputId, outputId, inputName = "", outputName = "") {
    setConnectedRoutes(
      inputId && outputId
        ? [
            {
              inputDeviceId: inputId,
              outputDeviceId: outputId,
              inputDeviceName: inputName,
              outputDeviceName: outputName,
              enabled: true,
            },
          ]
        : [],
    );
  }

  function setConnectedRoutes(routes) {
    connection.connectedRoutes = normalizeMidiRoutes({ routes }).filter((route) => route.enabled !== false);
    const first = connection.connectedRoutes[0] || {};
    connection.connectedInputId = String(first.inputDeviceId || "");
    connection.connectedOutputId = String(first.outputDeviceId || "");
    connection.connectedInputName = String(first.inputDeviceName || "");
    connection.connectedOutputName = String(first.outputDeviceName || "");
  }

  function getDesiredMidiPreference() {
    return normalizeMidiPreference(connection.currentProfilePreference);
  }

  function currentRoutesForSave() {
    const profileRoutes = normalizeMidiPreference(connection.currentProfilePreference).routes;
    return routeEditor.current(profileRoutes.length ? profileRoutes : connection.connectedRoutes);
  }

  function desiredRoutes() {
    return normalizeMidiPreference(connection.currentProfilePreference).routes;
  }

  function preserveUnavailableRouteDrafts(aliveRoutes, missingRoutes) {
    return mergeUnavailableRouteDrafts(
      aliveRoutes,
      missingRoutes,
      connection.currentProfilePreference,
      connection.connectedRoutes,
    );
  }

  function resolveDesiredRouteSet(snapshot, preference, context = "unknown") {
    return routePolicy.resolveDesiredRouteSet(snapshot, preference, context);
  }

  function unresolvedRouteStatus(resolved, fallbackKey = "midi.partialRetrying") {
    return routePolicy.unresolvedRouteStatus(resolved, t, fallbackKey);
  }

  function markSelectedPairUnavailable(inputId, outputId, inputName, outputName) {
    const nextInputId = String(inputId || "").trim();
    const nextOutputId = String(outputId || "").trim();
    if (nextInputId && elements.midiSelect) {
      ensureOption(
        elements.midiSelect,
        nextInputId,
        unavailableDeviceLabel(inputName, nextInputId, "Input"),
        true,
      );
      elements.midiSelect.value = nextInputId;
    }
    if (nextOutputId && elements.midiOutputSelect) {
      ensureOption(
        elements.midiOutputSelect,
        nextOutputId,
        unavailableDeviceLabel(outputName, nextOutputId, "Output"),
        true,
      );
      elements.midiOutputSelect.value = nextOutputId;
    }
    renderDeviceDropdowns();
  }

  function ensureOption(selectEl, value, label, unavailable = false) {
    if (!selectEl || !value) return;
    const existing = Array.from(selectEl.options || []).find((opt) => opt.value === value);
    if (existing) {
      if (label) existing.textContent = label;
      if (unavailable) existing.dataset.unavailable = "true";
      return;
    }
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label || value;
    if (unavailable) option.dataset.unavailable = "true";
    selectEl.appendChild(option);
  }

  function clearUnavailableOptions(selectEl, keepValue = "") {
    if (!selectEl) return;
    const keep = String(keepValue || "").trim();
    Array.from(selectEl.options || []).forEach((opt) => {
      if (opt.dataset?.unavailable === "true" && String(opt.value || "") !== keep) {
        opt.remove();
      }
    });
  }

  function clearUnavailableDeviceSelections() {
    const keepInput = elements.midiSelect ? elements.midiSelect.value : "";
    const keepOutput = elements.midiOutputSelect ? elements.midiOutputSelect.value : "";
    clearUnavailableOptions(elements.midiSelect, keepInput);
    clearUnavailableOptions(elements.midiOutputSelect, keepOutput);
  }

  function routesForUnavailableOptions() {
    const routes = [];
    const seen = new Set();
    [
      normalizeMidiPreference(connection.currentProfilePreference).routes,
      normalizeMidiRoutes({ routes: routeEditor.draft() || [] }),
      normalizeMidiRoutes({ routes: connection.connectedRoutes }),
    ].forEach((list) => {
      list.forEach((route) => {
        const key = `${route.inputDeviceId}\u0000${route.outputDeviceId}`;
        if (seen.has(key)) return;
        seen.add(key);
        routes.push(route);
      });
    });
    return routes;
  }

  function ensureUnavailableRouteOptions(inputDevices, outputDevices) {
    routesForUnavailableOptions().forEach((route) => {
      if (
        route.inputDeviceId &&
        !findDeviceBySavedIdentity(inputDevices, route.inputDeviceId, route.inputDeviceName)
      ) {
        ensureOption(
          elements.midiSelect,
          route.inputDeviceId,
          unavailableDeviceLabel(route.inputDeviceName, route.inputDeviceId, "Input"),
          true,
        );
      }
      if (
        route.outputDeviceId &&
        !findDeviceBySavedIdentity(outputDevices, route.outputDeviceId, route.outputDeviceName)
      ) {
        ensureOption(
          elements.midiOutputSelect,
          route.outputDeviceId,
          unavailableDeviceLabel(route.outputDeviceName, route.outputDeviceId, "Output"),
          true,
        );
      }
    });
  }

  return {
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
  };
}

import { normalizeMidiPreference } from "../device_preferences.js";
import { routesFromResolvedPreferences } from "../route_policy.js";

/** connect workflow. */
export function createConnect({
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
}) {
  async function refreshMidiDevices(options = {}) {
    try {
      const snapshot =
        options.snapshot && typeof options.snapshot === "object"
          ? options.snapshot
          : await enumerateMidiDevices({
              force: Boolean(options.force),
              reason: options.reason || "refresh",
            });
      const devices = snapshot.inputs;
      const outputDevices = snapshot.outputs;

      const pref = normalizeMidiPreference(connection.currentProfilePreference);
      const previousSelection = elements.midiSelect
        ? elements.midiSelect.value || pref.inputDeviceId || connection.connectedInputId
        : pref.inputDeviceId || connection.connectedInputId;
      const previousOutputSelection = elements.midiOutputSelect
        ? elements.midiOutputSelect.value || pref.outputDeviceId || connection.connectedOutputId
        : pref.outputDeviceId || connection.connectedOutputId;

      if (elements.midiSelect) {
        elements.midiSelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = t("midi.selectInputDevice");
        elements.midiSelect.appendChild(placeholder);
      }

      if (elements.midiOutputSelect) {
        elements.midiOutputSelect.innerHTML = "";
        const outPlaceholder = document.createElement("option");
        outPlaceholder.value = "";
        outPlaceholder.textContent = t("midi.selectOutputDevice");
        elements.midiOutputSelect.appendChild(outPlaceholder);
      }

      if ((!devices || devices.length === 0) && (!outputDevices || outputDevices.length === 0)) {
        ensureUnavailableRouteOptions([], []);
        if (elements.midiSelect && pref.inputDeviceId) elements.midiSelect.value = pref.inputDeviceId;
        if (elements.midiOutputSelect && pref.outputDeviceId)
          elements.midiOutputSelect.value = pref.outputDeviceId;
        if (elements.midiStatus) {
          elements.midiStatus.textContent = t("midi.searchingDevices");
        }
        renderDeviceDropdowns();
        startAutoRefresh(refreshMidiDevices);
        return { inputs: [], outputs: [] };
      }

      (Array.isArray(devices) ? devices : []).forEach((device) => {
        if (!elements.midiSelect) return;
        const option = document.createElement("option");
        option.value = device.id;
        option.textContent = device.name;
        elements.midiSelect.appendChild(option);
      });

      (Array.isArray(outputDevices) ? outputDevices : []).forEach((device) => {
        if (!elements.midiOutputSelect) return;
        const option = document.createElement("option");
        option.value = device.id;
        option.textContent = device.name;
        elements.midiOutputSelect.appendChild(option);
      });

      ensureUnavailableRouteOptions(devices, outputDevices);

      if (elements.midiSelect && previousSelection) {
        elements.midiSelect.value = previousSelection;
      }
      if (elements.midiOutputSelect && previousOutputSelection) {
        elements.midiOutputSelect.value = previousOutputSelection;
      }

      if (elements.midiStatus && !connection.connectedInputId && !connection.connectedOutputId) {
        elements.midiStatus.textContent = t("midi.foundDevices", {
          inputs: (devices || []).length,
          outputs: (outputDevices || []).length,
        });
      }
      renderDeviceDropdowns();
      if (
        pref.inputDeviceId &&
        pref.outputDeviceId &&
        !connection.connectedInputId &&
        !connection.connectedOutputId
      ) {
        startAutoRefresh(refreshMidiDevices);
      } else {
        stopAutoRefresh();
      }
      return {
        inputs: Array.isArray(devices) ? devices : [],
        outputs: Array.isArray(outputDevices) ? outputDevices : [],
      };
    } catch (error) {
      if (elements.midiStatus) {
        elements.midiStatus.textContent = t("midi.error", { message: error });
      }
      renderDeviceDropdowns();
      startAutoRefresh(refreshMidiDevices);
      return { inputs: [], outputs: [] };
    }
  }

  async function connectSelected() {
    const inputId = elements.midiSelect ? elements.midiSelect.value : "";
    const outputId = elements.midiOutputSelect ? elements.midiOutputSelect.value : "";
    if (!inputId || !outputId) {
      if (elements.midiStatus) {
        elements.midiStatus.textContent = t("bindings.selectBothDevices");
      }
      renderDeviceDropdowns();
      return;
    }
    const inputs = discovery.lastDeviceSnapshot.inputs || [];
    const outputs = discovery.lastDeviceSnapshot.outputs || [];
    const input = inputs.find((device) => device.id === inputId);
    const output = outputs.find((device) => device.id === outputId);
    const routes = desiredRoutes();
    routes[0] = {
      inputDeviceId: inputId,
      outputDeviceId: outputId,
      inputDeviceName: input?.name || connection.connectedInputName || inputId,
      outputDeviceName: output?.name || connection.connectedOutputName || outputId,
      enabled: true,
    };
    await applyRoutes(routes, { source: "manual" });
  }

  async function disconnect() {
    stopSessionRefresh();
    stopAutoRefresh();
    cancelLearnPanel();
    const displayInputName = connection.connectedInputName;
    const displayOutputName = connection.connectedOutputName;
    await invoke("stop_midi_device").catch(() => {});
    setConnectedState("", "", "", "");
    if (typeof showMain === "function") {
      showMain(displayInputName, displayOutputName, { connected: false });
    }
    // User intentionally entered manual selection flow; do not auto-reconnect
    // to the profile's preferred device until they explicitly connect or a profile sync occurs.
    connection.suspendProfileAutoReconnect = true;
    if (typeof clearSavedMidiDeviceIds === "function") {
      await clearSavedMidiDeviceIds();
    }
    connection.currentProfilePreference = normalizeMidiPreference({ routes: [], configured: true });
    discardRouteDrafts();
    if (typeof onProfileDeviceSelected === "function") {
      await onProfileDeviceSelected(connection.currentProfilePreference);
    }
    if (elements.midiStatus) elements.midiStatus.textContent = t("midi.notConnected");
    await refreshMidiDevices();
    if (typeof onDisconnected === "function") {
      onDisconnected();
    }
  }

  async function startLearnBinding() {
    try {
      await invoke("start_midi_learn");
      openLearnPanel(t("bindings.learnMessage"));
      if (learning.learnTimer) {
        clearInterval(learning.learnTimer);
      }
      learning.learnTimer = setInterval(async () => {
        const learned = await invoke("consume_learned_control");
        if (!learned) {
          return;
        }
        clearInterval(learning.learnTimer);
        learning.learnTimer = null;
        if (typeof addBindingFromLearn === "function") {
          await addBindingFromLearn(learned);
        }
      }, LEARN_POLL_MS);
    } catch (error) {
      closeLearnPanel();
      if (
        elements.learnPanelMessage &&
        elements.learnPanel &&
        !elements.learnPanel.classList.contains("hidden")
      ) {
        elements.learnPanelMessage.textContent = t("midi.learnFailed", { message: error });
      }
    }
  }

  async function loadMidiDevicesWithRetry() {
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const devices = await refreshMidiDevices({ force: true, reason: `startup_attempt_${attempt + 1}` });
      if (devices.inputs.length > 0 && devices.outputs.length > 0) {
        return devices;
      }
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
    startAutoRefresh(refreshMidiDevices);
    return { inputs: [], outputs: [] };
  }

  async function attemptAutoConnect(deviceData) {
    const saved = typeof getSavedMidiDeviceIds === "function" ? getSavedMidiDeviceIds() : {};
    const savedInputId = saved?.inputId || "";
    const savedOutputId = saved?.outputId || "";
    const savedInputName = saved?.inputName || "";
    const savedOutputName = saved?.outputName || "";

    connection.currentProfilePreference = normalizeMidiPreference({
      inputDeviceId: savedInputId,
      outputDeviceId: savedOutputId,
      inputDeviceName: savedInputName,
      outputDeviceName: savedOutputName,
      routes: saved?.routes || [],
    });

    const inputs = Array.isArray(deviceData?.inputs) ? deviceData.inputs : [];
    const outputs = Array.isArray(deviceData?.outputs) ? deviceData.outputs : [];
    const savedRoutes = connection.currentProfilePreference.routes;

    if (savedRoutes.length === 0) {
      // First-run heuristic:
      // - if exactly one input exists, assume it
      // - prefer output with identical name; otherwise prefer a non-GS output
      if (inputs.length === 1 && outputs.length > 0) {
        const inputMatch = inputs[0];
        const outputMatch =
          outputs.find((o) => o?.name === inputMatch?.name) ||
          outputs.find(
            (o) =>
              !String(o?.name || "")
                .toLowerCase()
                .includes("microsoft gs wavetable"),
          ) ||
          outputs[0];

        if (inputMatch && outputMatch) {
          try {
            if (elements.midiSelect) elements.midiSelect.value = inputMatch.id;
            if (elements.midiOutputSelect) elements.midiOutputSelect.value = outputMatch.id;
            await startWithResolvedDevice(inputMatch, outputMatch, {
              inputName: inputMatch?.name || "",
              outputName: outputMatch?.name || "",
              auto: true,
            });
            if (elements.midiStatus) elements.midiStatus.textContent = t("midi.autoConnected");
            return { connected: true, autoSelected: true };
          } catch (error) {
            if (elements.midiStatus)
              elements.midiStatus.textContent = t("midi.connectFailed", { message: error });
            renderDeviceDropdowns();
            return { connected: false, reason: "auto_select_connect_failed" };
          }
        }
      }

      if (elements.midiStatus) elements.midiStatus.textContent = t("bindings.selectDevicesSentence");
      renderDeviceDropdowns();
      return { connected: false, reason: "missing_saved" };
    }

    let resolvedRoutes = resolveDesiredRouteSet(
      { inputs, outputs },
      connection.currentProfilePreference,
      "startup",
    );

    if (!resolvedRoutes.available) {
      const refreshed = await refreshMidiDevices();
      resolvedRoutes = resolveDesiredRouteSet(
        refreshed,
        connection.currentProfilePreference,
        "startup_retry",
      );
    }

    const missingRoute = resolvedRoutes.routes.find(
      (route) => route.preference.enabled !== false && (!route.inputMatch || !route.outputMatch),
    );
    if (missingRoute) {
      if (elements.midiStatus) {
        elements.midiStatus.textContent = unresolvedRouteStatus(resolvedRoutes, "midi.savedUnavailable");
      }
      try {
        const result = await applyRoutes(routesFromResolvedPreferences(resolvedRoutes), {
          source: "auto",
          auto: true,
          allowPartialUnavailable: true,
          partialUnavailableStatus: unresolvedRouteStatus(resolvedRoutes, "midi.savedUnavailable"),
        });
        return {
          connected: Boolean(result?.connected),
          partial: true,
          reason: result?.connected ? "saved_missing_partial" : "saved_missing",
        };
      } catch (error) {
        if (elements.midiStatus) {
          elements.midiStatus.textContent = t("midi.connectFailed", { message: error });
        }
        renderDeviceDropdowns();
        return { connected: false, reason: "saved_missing_connect_failed" };
      }
    }

    try {
      const routes = routesFromResolvedPreferences(resolvedRoutes);
      const first = routes.find((route) => route.enabled !== false) || routes[0] || {};
      if (elements.midiSelect) elements.midiSelect.value = first.inputDeviceId || "";
      if (elements.midiOutputSelect) elements.midiOutputSelect.value = first.outputDeviceId || "";
      await applyRoutes(routes, { source: "auto", auto: true });
      return { connected: true };
    } catch (error) {
      setConnectedState("", "", "", "");
      if (elements.midiStatus) {
        elements.midiStatus.textContent = t("midi.connectFailed", { message: error });
      }
      renderDeviceDropdowns();
      return { connected: false };
    }
  }

  async function syncToProfileDevice(profilePreference) {
    const pref = normalizeMidiPreference(profilePreference);
    discardRouteDrafts();
    if (routeView.routesPopoverEl && !routeView.routesPopoverEl.classList.contains("hidden")) {
      closeRoutesPopover({ discard: false });
    }
    connection.currentProfilePreference = pref;
    connection.suspendProfileAutoReconnect = false;
    if (pref.routes.length === 0) {
      if (pref.configured) {
        await applyRoutes([], { source: "profile", fromProfile: true });
        return { handled: true, connected: false, reason: "no_profile_routes" };
      }
      return { handled: false, connected: false };
    }

    if (
      routesEquivalent(
        pref.routes.filter((route) => route.enabled !== false),
        connection.connectedRoutes,
      )
    ) {
      // Profile switch can leave the visible dropdown on a previously selected
      // unavailable device even when the active connection already matches this profile.
      // Force UI selection back to the profile's connected pair.
      if (elements.midiSelect) elements.midiSelect.value = pref.inputDeviceId;
      if (elements.midiOutputSelect) elements.midiOutputSelect.value = pref.outputDeviceId;
      clearUnavailableDeviceSelections();
      renderDeviceDropdowns();
      return { handled: true, connected: true, unchanged: true };
    }

    const devices = await refreshMidiDevices({ force: true, reason: "profile_sync" });
    let resolvedRoutes = resolveDesiredRouteSet(devices, pref, "profile_sync");

    if (!resolvedRoutes.available) {
      const refreshed = await refreshMidiDevices({ force: true, reason: "profile_sync_retry" });
      resolvedRoutes = resolveDesiredRouteSet(refreshed, pref, "profile_sync_retry");
    }

    const missingRoute = resolvedRoutes.routes.find(
      (route) => route.preference.enabled !== false && (!route.inputMatch || !route.outputMatch),
    );
    if (missingRoute) {
      const partialStatus = unresolvedRouteStatus(resolvedRoutes);
      if (elements.midiStatus) {
        elements.midiStatus.textContent = partialStatus;
      }
      try {
        const result = await applyRoutes(routesFromResolvedPreferences(resolvedRoutes), {
          source: "profile",
          auto: true,
          fromProfile: true,
          allowPartialUnavailable: true,
          partialUnavailableStatus: partialStatus,
        });
        return {
          handled: true,
          connected: Boolean(result?.connected),
          partial: true,
          reason: "missing",
        };
      } catch (error) {
        if (elements.midiStatus)
          elements.midiStatus.textContent = t("midi.connectFailed", { message: error });
        renderDeviceDropdowns();
        return { handled: true, connected: false, reason: "connect_failed" };
      }
    }

    try {
      const routes = routesFromResolvedPreferences(resolvedRoutes);
      await applyRoutes(routes, { source: "profile", auto: true, fromProfile: true });
      return { handled: true, connected: true };
    } catch (error) {
      if (elements.midiStatus) elements.midiStatus.textContent = t("midi.connectFailed", { message: error });
      renderDeviceDropdowns();
      return { handled: true, connected: false, reason: "connect_failed" };
    }
  }

  return {
    refreshMidiDevices,
    connectSelected,
    disconnect,
    startLearnBinding,
    loadMidiDevicesWithRetry,
    attemptAutoConnect,
    syncToProfileDevice,
  };
}

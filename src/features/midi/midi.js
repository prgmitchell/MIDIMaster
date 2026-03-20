export function createMidiFeature({
  invoke,
  dom,
  showSetup,
  showMain,
  refreshSessions,
  onConnected,
  onDisconnected,
  addBindingFromLearn,
  getSavedMidiDeviceIds,
  saveMidiDeviceIds,
  clearSavedMidiDeviceIds,
  onProfileDeviceSelected,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createMidiFeature: invoke is required");
  }
  const d = (dom && typeof dom === "object") ? dom : {};

  let autoRefreshTimer = null;
  let sessionRefreshTimer = null;
  let learnTimer = null;
  let availabilityTimer = null;
  let availabilityCheckInFlight = false;
  let suspendProfileAutoReconnect = false;
  let connectedInputId = "";
  let connectedOutputId = "";
  let connectedInputName = "";
  let connectedOutputName = "";
  let currentProfilePreference = null;

  function normalizeMidiPreference(source) {
    const current = (source && typeof source === "object") ? source : {};
    return {
      inputDeviceId: String(current.inputDeviceId || current.input_device_id || "").trim(),
      outputDeviceId: String(current.outputDeviceId || current.output_device_id || "").trim(),
      inputDeviceName: String(current.inputDeviceName || current.input_device_name || "").trim(),
      outputDeviceName: String(current.outputDeviceName || current.output_device_name || "").trim(),
    };
  }

  function setConnectedState(inputId, outputId, inputName = "", outputName = "") {
    connectedInputId = String(inputId || "");
    connectedOutputId = String(outputId || "");
    connectedInputName = String(inputName || "");
    connectedOutputName = String(outputName || "");
  }

  function getCurrentConnectedPreference() {
    return {
      inputDeviceId: connectedInputId,
      outputDeviceId: connectedOutputId,
      inputDeviceName: connectedInputName,
      outputDeviceName: connectedOutputName,
    };
  }

  function findDeviceMatch(devices, deviceId, deviceName) {
    const list = Array.isArray(devices) ? devices : [];
    const byId = deviceId ? list.find((device) => device.id === deviceId) : null;
    if (byId) return byId;
    if (!deviceName) return null;
    return list.find((device) => device.name === deviceName) || null;
  }

  // MIDI IDs can be index-based and may shift after unplug/replug.
  // Prefer an exact id+name match when both are known; otherwise use name fallback
  // and DO NOT fall back to id-only when a saved name is present (can bind to wrong device).
  function findPreferredDevice(devices, deviceId, deviceName) {
    const list = Array.isArray(devices) ? devices : [];
    const hasId = Boolean(deviceId);
    const hasName = Boolean(deviceName);
    const byId = hasId ? list.find((device) => device.id === deviceId) : null;
    const byName = hasName ? list.find((device) => device.name === deviceName) : null;

    if (hasId && hasName) {
      const exact = list.find((device) => device.id === deviceId && device.name === deviceName);
      if (exact) return exact;
      if (byName) return byName;
      return null;
    }

    return byId || byName || null;
  }

  function findConnectedAliveDevice(devices, expectedId, expectedName) {
    const list = Array.isArray(devices) ? devices : [];
    if (!expectedId && !expectedName) return null;
    if (expectedId && expectedName) {
      return list.find((device) => device.id === expectedId && device.name === expectedName) || null;
    }
    return findDeviceMatch(list, expectedId, expectedName);
  }

  function unavailableDeviceLabel(name, id, kind) {
    const base = String(name || id || `${kind} device`).trim();
    return `${base} (Unavailable)`;
  }

  function hasPreference(pref) {
    const normalized = normalizeMidiPreference(pref);
    return Boolean(normalized.inputDeviceId && normalized.outputDeviceId);
  }

  function matchesConnectedPreference(pref) {
    const normalized = normalizeMidiPreference(pref);
    if (!normalized.inputDeviceId || !normalized.outputDeviceId) {
      return false;
    }
    if (connectedInputId !== normalized.inputDeviceId || connectedOutputId !== normalized.outputDeviceId) {
      return false;
    }
    // If profile stored names, require those to match as well to avoid false positives
    // when hot-plugging causes id/index reuse.
    if (normalized.inputDeviceName && connectedInputName && connectedInputName !== normalized.inputDeviceName) {
      return false;
    }
    if (normalized.outputDeviceName && connectedOutputName && connectedOutputName !== normalized.outputDeviceName) {
      return false;
    }
    return true;
  }

  async function startWithResolvedDevice(input, output, options = {}) {
    const resolvedInputId = input.id;
    const resolvedOutputId = output.id;
    const resolvedInputName = input.name || options.inputName || "";
    const resolvedOutputName = output.name || options.outputName || "";

    await invoke("stop_midi_device").catch(() => { });
    if (d.midiSelect) {
      d.midiSelect.value = resolvedInputId;
    }
    if (d.midiOutputSelect) {
      d.midiOutputSelect.value = resolvedOutputId;
    }

    await invoke("start_midi_device", { inputDeviceId: resolvedInputId, outputDeviceId: resolvedOutputId });
    if (typeof saveMidiDeviceIds === "function") {
      await saveMidiDeviceIds(
        resolvedInputId,
        resolvedOutputId,
        resolvedInputName,
        resolvedOutputName
      );
    }
    setConnectedState(
      resolvedInputId,
      resolvedOutputId,
      resolvedInputName,
      resolvedOutputName
    );
    if (typeof showMain === "function") {
      showMain(resolvedInputName, resolvedOutputName);
    }
    if (typeof refreshSessions === "function") {
      await refreshSessions();
    }
    startSessionRefresh(refreshSessions || (async () => { }), d.mainScreen);
    if (typeof onConnected === "function") {
      onConnected({
        inputId: resolvedInputId,
        outputId: resolvedOutputId,
        auto: Boolean(options.auto),
        fromProfile: Boolean(options.fromProfile),
      });
    }
    return {
      inputId: resolvedInputId,
      outputId: resolvedOutputId,
      inputName: resolvedInputName,
      outputName: resolvedOutputName,
    };
  }

  function getPreferredUnavailableLabels() {
    const pref = normalizeMidiPreference(currentProfilePreference);
    return {
      input: unavailableDeviceLabel(pref.inputDeviceName, pref.inputDeviceId, "Input"),
      output: unavailableDeviceLabel(pref.outputDeviceName, pref.outputDeviceId, "Output"),
    };
  }

  async function checkAvailabilityLoop() {
    if (availabilityCheckInFlight) return;
    availabilityCheckInFlight = true;
    try {
      const pref = normalizeMidiPreference(currentProfilePreference);
      const prefAvailable = hasPreference(pref);
      const currentlyConnected = Boolean(connectedInputId && connectedOutputId);
      if (!prefAvailable && !currentlyConnected) return;

      const devices = await invoke("list_midi_devices").catch(() => []);
      const outputDevices = await invoke("list_midi_output_devices").catch(() => []);
      const inputMatch = prefAvailable
        ? findPreferredDevice(devices, pref.inputDeviceId, pref.inputDeviceName)
        : null;
      const outputMatch = prefAvailable
        ? findPreferredDevice(outputDevices, pref.outputDeviceId, pref.outputDeviceName)
        : null;
      const preferredNowAvailable = Boolean(inputMatch && outputMatch);

      if (currentlyConnected) {
        const activeInputAlive = findConnectedAliveDevice(devices, connectedInputId, connectedInputName);
        const activeOutputAlive = findConnectedAliveDevice(outputDevices, connectedOutputId, connectedOutputName);
        if (!activeInputAlive || !activeOutputAlive) {
          stopSessionRefresh();
          await invoke("stop_midi_device").catch(() => { });
          setConnectedState("", "", "", "");
          const unavailable = prefAvailable
            ? getPreferredUnavailableLabels()
            : {
              input: unavailableDeviceLabel(connectedInputName, connectedInputId, "Input"),
              output: unavailableDeviceLabel(connectedOutputName, connectedOutputId, "Output"),
            };
          if (typeof showMain === "function") {
            showMain(unavailable.input, unavailable.output);
          }
          if (d.midiStatus) {
            d.midiStatus.textContent = "Current profile MIDI device became unavailable.";
          }
          return;
        }
      }

      if (prefAvailable && !currentlyConnected && preferredNowAvailable && !suspendProfileAutoReconnect) {
        try {
          await startWithResolvedDevice(inputMatch, outputMatch, {
            inputName: pref.inputDeviceName,
            outputName: pref.outputDeviceName,
            auto: true,
            fromProfile: true,
          });
          if (d.midiStatus) {
            d.midiStatus.textContent = "Reconnected to profile MIDI device.";
          }
        } catch {
          // Ignore transient reconnect failures; watcher will retry.
        }
      }
    } finally {
      availabilityCheckInFlight = false;
    }
  }

  function startAvailabilityMonitor() {
    if (availabilityTimer) return;
    availabilityTimer = setInterval(() => {
      checkAvailabilityLoop().catch(() => { });
    }, 1500);
  }

  function startAutoRefresh(refreshFn) {
    if (autoRefreshTimer) {
      return;
    }
    autoRefreshTimer = setInterval(async () => {
      const devices = await refreshFn();
      if (devices.inputs.length > 0) {
        stopAutoRefresh();
      }
    }, 1500);
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  function startSessionRefresh(refreshFn, mainScreenEl) {
    if (sessionRefreshTimer) {
      return;
    }
    sessionRefreshTimer = setInterval(async () => {
      if (mainScreenEl && mainScreenEl.classList.contains("hidden")) {
        return;
      }
      await refreshFn();
    }, 2000);
  }

  function stopSessionRefresh() {
    if (sessionRefreshTimer) {
      clearInterval(sessionRefreshTimer);
      sessionRefreshTimer = null;
    }
  }

  function closeLearnPanel() {
    if (!d.learnPanel) {
      return;
    }
    d.learnPanel.classList.add("hidden");
  }

  function openLearnPanel(message) {
    if (!d.learnPanel) {
      return;
    }
    if (d.learnPanelMessage && message) {
      d.learnPanelMessage.textContent = message;
    }
    d.learnPanel.classList.remove("hidden");
  }

  function cancelLearnPanel() {
    if (learnTimer) {
      clearInterval(learnTimer);
      learnTimer = null;
    }
    closeLearnPanel();
  }

  async function refreshMidiDevices() {
    try {
      const devices = await invoke("list_midi_devices");
      const outputDevices = await invoke("list_midi_output_devices");

      const previousSelection = d.midiSelect ? d.midiSelect.value : "";
      const previousOutputSelection = d.midiOutputSelect ? d.midiOutputSelect.value : "";

      if (d.midiSelect) {
        d.midiSelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Select input device";
        d.midiSelect.appendChild(placeholder);
      }

      if (d.midiOutputSelect) {
        d.midiOutputSelect.innerHTML = "";
        const outPlaceholder = document.createElement("option");
        outPlaceholder.value = "";
        outPlaceholder.textContent = "Select output device";
        d.midiOutputSelect.appendChild(outPlaceholder);
      }

      if ((!devices || devices.length === 0) && (!outputDevices || outputDevices.length === 0)) {
        if (d.midiStatus) {
          d.midiStatus.textContent = "Searching for devices...";
        }
        startAutoRefresh(refreshMidiDevices);
        return { inputs: [], outputs: [] };
      }

      (Array.isArray(devices) ? devices : []).forEach((device) => {
        if (!d.midiSelect) return;
        const option = document.createElement("option");
        option.value = device.id;
        option.textContent = device.name;
        d.midiSelect.appendChild(option);
      });

      (Array.isArray(outputDevices) ? outputDevices : []).forEach((device) => {
        if (!d.midiOutputSelect) return;
        const option = document.createElement("option");
        option.value = device.id;
        option.textContent = device.name;
        d.midiOutputSelect.appendChild(option);
      });

      if (d.midiSelect && previousSelection) {
        d.midiSelect.value = previousSelection;
      }
      if (d.midiOutputSelect && previousOutputSelection) {
        d.midiOutputSelect.value = previousOutputSelection;
      }

      stopAutoRefresh();
      if (d.midiStatus) {
        d.midiStatus.textContent = `Found ${(devices || []).length} inputs, ${(outputDevices || []).length} outputs`;
      }
      return { inputs: Array.isArray(devices) ? devices : [], outputs: Array.isArray(outputDevices) ? outputDevices : [] };
    } catch (error) {
      if (d.midiStatus) {
        d.midiStatus.textContent = `MIDI error: ${error}`;
      }
      startAutoRefresh(refreshMidiDevices);
      return { inputs: [], outputs: [] };
    }
  }

  async function connectSelected() {
    const inputId = d.midiSelect ? d.midiSelect.value : "";
    const outputId = d.midiOutputSelect ? d.midiOutputSelect.value : "";
    if (!inputId || !outputId) {
      if (d.midiStatus) {
        d.midiStatus.textContent = "Select both input and output devices";
      }
      return;
    }
    try {
      await invoke("start_midi_device", { inputDeviceId: inputId, outputDeviceId: outputId });
      suspendProfileAutoReconnect = false;
      if (typeof saveMidiDeviceIds === "function") {
        const inputName = d.midiSelect?.options?.[d.midiSelect.selectedIndex]?.textContent || "";
        const outputName = d.midiOutputSelect?.options?.[d.midiOutputSelect.selectedIndex]?.textContent || "";
        await saveMidiDeviceIds(inputId, outputId, inputName, outputName);
      }

      const inputName = d.midiSelect?.options?.[d.midiSelect.selectedIndex]?.textContent;
      const outputName = d.midiOutputSelect?.options?.[d.midiOutputSelect.selectedIndex]?.textContent;
      setConnectedState(inputId, outputId, inputName || "", outputName || "");
      currentProfilePreference = getCurrentConnectedPreference();
      if (typeof showMain === "function") {
        showMain(inputName, outputName);
      }

      if (typeof refreshSessions === "function") {
        await refreshSessions();
      }
      startSessionRefresh(refreshSessions || (async () => { }), d.mainScreen);
      if (typeof onConnected === "function") {
        onConnected({ inputId, outputId });
      }
      if (typeof onProfileDeviceSelected === "function") {
        await onProfileDeviceSelected(getCurrentConnectedPreference());
      }
    } catch (error) {
      if (d.midiStatus) {
        d.midiStatus.textContent = `Connect failed: ${error}`;
      }
    }
  }

  async function disconnect() {
    stopSessionRefresh();
    stopAutoRefresh();
    cancelLearnPanel();
    await invoke("stop_midi_device").catch(() => { });
    setConnectedState("", "", "", "");
    // User intentionally entered manual selection flow; do not auto-reconnect
    // to the profile's preferred device until they explicitly connect or a profile sync occurs.
    suspendProfileAutoReconnect = true;
    if (typeof clearSavedMidiDeviceIds === "function") {
      await clearSavedMidiDeviceIds();
    }
    if (typeof showSetup === "function") {
      showSetup("Not connected");
    }
    await refreshMidiDevices();
    if (typeof onDisconnected === "function") {
      onDisconnected();
    }
  }

  async function startLearnBinding() {
    try {
      await invoke("start_midi_learn");
      openLearnPanel("Move a control on your MIDI device to create a binding.");
      if (learnTimer) {
        clearInterval(learnTimer);
      }
      learnTimer = setInterval(async () => {
        const learned = await invoke("consume_learned_control");
        if (!learned) {
          return;
        }
        clearInterval(learnTimer);
        learnTimer = null;
        closeLearnPanel();
        if (typeof addBindingFromLearn === "function") {
          await addBindingFromLearn(learned);
        }
      }, 200);
    } catch (error) {
      closeLearnPanel();
      if (d.learnPanelMessage && d.learnPanel && !d.learnPanel.classList.contains("hidden")) {
        d.learnPanelMessage.textContent = `Learn failed: ${error}`;
      }
    }
  }

  async function loadMidiDevicesWithRetry() {
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const devices = await refreshMidiDevices();
      if (devices.inputs.length > 0) {
        return devices;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    startAutoRefresh(refreshMidiDevices);
    return { inputs: [], outputs: [] };
  }

  async function attemptAutoConnect(deviceData) {
    const saved = (typeof getSavedMidiDeviceIds === "function")
      ? getSavedMidiDeviceIds()
      : {};
    const savedInputId = saved?.inputId || "";
    const savedOutputId = saved?.outputId || "";
    const savedInputName = saved?.inputName || "";
    const savedOutputName = saved?.outputName || "";

    if (!savedInputId) {
      if (typeof showSetup === "function") {
        showSetup();
      }
      return;
    }

    const inputs = Array.isArray(deviceData?.inputs) ? deviceData.inputs : [];
    const outputs = Array.isArray(deviceData?.outputs) ? deviceData.outputs : [];

    let inputMatch = findPreferredDevice(inputs, savedInputId, savedInputName);
    let outputMatch = savedOutputId ? findPreferredDevice(outputs, savedOutputId, savedOutputName) : null;

    if (!inputMatch) {
      const refreshed = await refreshMidiDevices();
      inputMatch = findPreferredDevice(refreshed.inputs, savedInputId, savedInputName);
      outputMatch = savedOutputId ? findPreferredDevice(refreshed.outputs, savedOutputId, savedOutputName) : null;
    }

    if (!inputMatch) {
      if (typeof showSetup === "function") {
        showSetup("Saved input device not found.");
      }
      return;
    }

    if (savedOutputId && !outputMatch) {
      if (typeof showSetup === "function") {
        showSetup("Saved output device not found.");
      }
      return;
    }

    if (!savedOutputId) {
      if (typeof showSetup === "function") {
        showSetup("Saved output device missing.");
      }
      return;
    }

    const resolvedInputId = inputMatch?.id || savedInputId;
    const resolvedOutputId = outputMatch?.id || savedOutputId;
    if (d.midiSelect) {
      d.midiSelect.value = resolvedInputId;
    }
    if (d.midiOutputSelect) {
      d.midiOutputSelect.value = resolvedOutputId;
    }

    try {
      await invoke("start_midi_device", { inputDeviceId: resolvedInputId, outputDeviceId: resolvedOutputId });
      if (typeof saveMidiDeviceIds === "function") {
        await saveMidiDeviceIds(
          resolvedInputId,
          resolvedOutputId,
          inputMatch?.name || savedInputName,
          outputMatch?.name || savedOutputName
        );
      }
      if (typeof showMain === "function") {
        showMain(inputMatch.name, outputMatch ? outputMatch.name : "Unknown");
      }
      setConnectedState(
        resolvedInputId,
        resolvedOutputId,
        inputMatch?.name || savedInputName,
        outputMatch?.name || savedOutputName
      );
      currentProfilePreference = getCurrentConnectedPreference();
      if (typeof refreshSessions === "function") {
        await refreshSessions();
      }
      startSessionRefresh(refreshSessions || (async () => { }), d.mainScreen);
      if (typeof onConnected === "function") {
        onConnected({ inputId: resolvedInputId, outputId: resolvedOutputId, auto: true });
      }
      return { connected: true };
    } catch (error) {
      setConnectedState("", "", "", "");
      if (typeof showSetup === "function") {
        showSetup();
      }
      if (d.midiStatus) {
        d.midiStatus.textContent = `Connect failed: ${error}`;
      }
      return { connected: false };
    }
  }

  async function syncToProfileDevice(profilePreference) {
    const pref = normalizeMidiPreference(profilePreference);
    currentProfilePreference = pref;
    suspendProfileAutoReconnect = false;
    if (!pref.inputDeviceId || !pref.outputDeviceId) {
      return { handled: false, connected: false };
    }

    if (matchesConnectedPreference(pref)) {
      return { handled: true, connected: true, unchanged: true };
    }

    const devices = await refreshMidiDevices();
    let inputMatch = findPreferredDevice(devices.inputs, pref.inputDeviceId, pref.inputDeviceName);
    let outputMatch = findPreferredDevice(devices.outputs, pref.outputDeviceId, pref.outputDeviceName);

    if (!inputMatch || !outputMatch) {
      const refreshed = await refreshMidiDevices();
      inputMatch = findPreferredDevice(refreshed.inputs, pref.inputDeviceId, pref.inputDeviceName);
      outputMatch = findPreferredDevice(refreshed.outputs, pref.outputDeviceId, pref.outputDeviceName);
    }

    if (!inputMatch || !outputMatch) {
      stopSessionRefresh();
      await invoke("stop_midi_device").catch(() => { });
      setConnectedState("", "", "", "");
      if (typeof showMain === "function") {
        showMain(
          unavailableDeviceLabel(pref.inputDeviceName, pref.inputDeviceId, "Input"),
          unavailableDeviceLabel(pref.outputDeviceName, pref.outputDeviceId, "Output")
        );
      }
      if (d.midiStatus) {
        d.midiStatus.textContent = "Saved profile MIDI device(s) not found.";
      }
      return { handled: true, connected: false, reason: "missing" };
    }

    try {
      await startWithResolvedDevice(inputMatch, outputMatch, {
        inputName: pref.inputDeviceName,
        outputName: pref.outputDeviceName,
        auto: true,
        fromProfile: true,
      });
      return { handled: true, connected: true };
    } catch (error) {
      setConnectedState("", "", "", "");
      if (typeof showSetup === "function") {
        showSetup(`Connect failed: ${error}`);
      }
      return { handled: true, connected: false, reason: "connect_failed" };
    }
  }

  function bindUi() {
    startAvailabilityMonitor();
    if (d.learnPanel) {
      d.learnPanel.addEventListener("click", (event) => {
        if (event.target === d.learnPanel) {
          cancelLearnPanel();
        }
      });
    }
    if (d.learnPanelClose) {
      d.learnPanelClose.addEventListener("click", cancelLearnPanel);
    }

    if (d.refreshMidiButton) {
      d.refreshMidiButton.addEventListener("click", async () => {
        await refreshMidiDevices();
      });
    }
    if (d.connectMidiButton) {
      d.connectMidiButton.addEventListener("click", async () => {
        await connectSelected();
      });
    }
    if (d.disconnectMidiButton) {
      d.disconnectMidiButton.addEventListener("click", async () => {
        await disconnect();
      });
    }
    if (d.learnBindingButton) {
      d.learnBindingButton.addEventListener("click", () => {
        startLearnBinding();
      });
    }
    if (d.bindingAddFooterButton) {
      d.bindingAddFooterButton.addEventListener("click", () => {
        startLearnBinding();
      });
    }
  }

  return {
    bindUi,
    refreshMidiDevices,
    loadMidiDevicesWithRetry,
    attemptAutoConnect,
    startSessionRefresh: () => startSessionRefresh(refreshSessions || (async () => { }), d.mainScreen),
    stopSessionRefresh,
    startLearnBinding,
    openLearnPanel,
    closeLearnPanel,
    cancelLearnPanel,
    connectSelected,
    disconnect,
    syncToProfileDevice,
    getCurrentConnectedPreference,
  };
}

export function createMidiFeature({
  invoke,
  dom,
  showSetup,
  showMain,
  refreshSessions,
  onConnected,
  onDisconnected,
  addBindingFromLearn,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createMidiFeature: invoke is required");
  }
  const d = (dom && typeof dom === "object") ? dom : {};

  let autoRefreshTimer = null;
  let sessionRefreshTimer = null;
  let learnTimer = null;

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
      localStorage.setItem("midiDeviceId", inputId);
      localStorage.setItem("midiOutputDeviceId", outputId);

      const inputName = d.midiSelect?.options?.[d.midiSelect.selectedIndex]?.textContent;
      const outputName = d.midiOutputSelect?.options?.[d.midiOutputSelect.selectedIndex]?.textContent;
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
    localStorage.removeItem("midiDeviceId");
    localStorage.removeItem("midiOutputDeviceId");
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
    const savedInputId = localStorage.getItem("midiDeviceId");
    const savedOutputId = localStorage.getItem("midiOutputDeviceId");

    if (!savedInputId) {
      if (typeof showSetup === "function") {
        showSetup();
      }
      return;
    }

    const inputs = Array.isArray(deviceData?.inputs) ? deviceData.inputs : [];
    const outputs = Array.isArray(deviceData?.outputs) ? deviceData.outputs : [];

    let inputMatch = inputs.find((device) => device.id === savedInputId);
    let outputMatch = savedOutputId ? outputs.find((device) => device.id === savedOutputId) : null;

    if (!inputMatch) {
      const refreshed = await refreshMidiDevices();
      inputMatch = refreshed.inputs.find((device) => device.id === savedInputId);
      if (savedOutputId) {
        outputMatch = refreshed.outputs.find((device) => device.id === savedOutputId);
      }
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

    if (d.midiSelect) {
      d.midiSelect.value = savedInputId;
    }
    if (d.midiOutputSelect) {
      d.midiOutputSelect.value = savedOutputId;
    }

    try {
      await invoke("start_midi_device", { inputDeviceId: savedInputId, outputDeviceId: savedOutputId });
      if (typeof showMain === "function") {
        showMain(inputMatch.name, outputMatch ? outputMatch.name : "Unknown");
      }
      if (typeof refreshSessions === "function") {
        await refreshSessions();
      }
      startSessionRefresh(refreshSessions || (async () => { }), d.mainScreen);
      if (typeof onConnected === "function") {
        onConnected({ inputId: savedInputId, outputId: savedOutputId, auto: true });
      }
    } catch (error) {
      if (typeof showSetup === "function") {
        showSetup();
      }
      if (d.midiStatus) {
        d.midiStatus.textContent = `Connect failed: ${error}`;
      }
    }
  }

  function bindUi() {
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
  };
}

import {
  closeOpenDropdowns,
} from "../ui/dropdown_badges.js";
import {
  createSelectDropdownShell,
  renderNativeSelectDropdown,
} from "../ui/dropdown_select.js";
import {
  findConnectedAliveDevice,
  findPreferredDevice,
  normalizeMidiPreference,
  resolveMidiDeviceDropdownState,
  resolvePreferredMidiDevicePair,
  shouldRecoverSuspectMidiPair,
  stripUnavailableSuffix,
  unavailableDeviceLabel,
} from "./device_preferences.js";

export function createMidiFeature({
  invoke,
  dom,
  showMain,
  refreshSessions,
  onConnected,
  onDisconnected,
  addBindingFromLearn,
  getSavedMidiDeviceIds,
  saveMidiDeviceIds,
  clearSavedMidiDeviceIds,
  onProfileDeviceSelected,
  i18n,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createMidiFeature: invoke is required");
  }
  const d = (dom && typeof dom === "object") ? dom : {};
  const t = (key, params = {}) => (i18n && typeof i18n.t === "function") ? i18n.t(key, params) : String(key || "");
  const MIDI_ENUM_MIN_INTERVAL_MS = 5000;
  const MIDI_ENUM_STALE_MS = 3000;
  const MIDI_AVAILABILITY_DISCONNECTED_INTERVAL_MS = 3000;
  const MIDI_AVAILABILITY_CONNECTED_INTERVAL_MS = 10000;
  const MIDI_AUTO_REFRESH_INTERVAL_MS = 3000;
  const MIDI_OUTPUT_ENUM_DELAY_MS = 250;
  const LEARN_POLL_MS = 50;
  const SESSION_REFRESH_VISIBLE_INTERVAL_MS = 3000;
  const SESSION_REFRESH_HIDDEN_INTERVAL_MS = 15000;

  let autoRefreshTimer = null;
  let sessionRefreshTimer = null;
  let sessionRefreshFn = null;
  let sessionRefreshMainScreenEl = null;
  let sessionVisibilityListenerBound = false;
  let learnTimer = null;
  let availabilityTimer = null;
  let availabilityCheckInFlight = false;
  let deviceRefreshInFlight = null;
  let lastDeviceRefreshAt = 0;
  let lastDeviceSnapshot = { inputs: [], outputs: [] };
  let suspendProfileAutoReconnect = false;
  let applyInFlight = false;
  let queuedApply = null;
  let connectedInputId = "";
  let connectedOutputId = "";
  let connectedInputName = "";
  let connectedOutputName = "";
  let currentProfilePreference = null;
  let inputDropdownEl = null;
  let inputMenuEl = null;
  let inputDisplayEl = null;
  let outputDropdownEl = null;
  let outputMenuEl = null;
  let outputDisplayEl = null;
  let deviceDocClickBound = false;

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

  function markSelectedPairUnavailable(inputId, outputId, inputName, outputName) {
    const nextInputId = String(inputId || "").trim();
    const nextOutputId = String(outputId || "").trim();
    if (nextInputId && d.midiSelect) {
      ensureOption(
        d.midiSelect,
        nextInputId,
        unavailableDeviceLabel(inputName, nextInputId, "Input"),
        true,
      );
      d.midiSelect.value = nextInputId;
    }
    if (nextOutputId && d.midiOutputSelect) {
      ensureOption(
        d.midiOutputSelect,
        nextOutputId,
        unavailableDeviceLabel(outputName, nextOutputId, "Output"),
        true,
      );
      d.midiOutputSelect.value = nextOutputId;
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
    const keepInput = d.midiSelect ? d.midiSelect.value : "";
    const keepOutput = d.midiOutputSelect ? d.midiOutputSelect.value : "";
    clearUnavailableOptions(d.midiSelect, keepInput);
    clearUnavailableOptions(d.midiOutputSelect, keepOutput);
  }

  function closeDeviceDropdowns() {
    closeOpenDropdowns({ except: null });
  }

  function ensureDeviceDropdowns() {
    const attachDropdown = (selectEl, kind) => {
      if (!selectEl) return;

      let existingRoot = kind === "input" ? inputDropdownEl : outputDropdownEl;
      if (existingRoot && existingRoot.isConnected) return;

      selectEl.classList.add("hidden");
      const entry = createSelectDropdownShell({
        selectEl,
        rootClass: "midi-device-dropdown",
        title: kind === "input" ? t("topbar.inputDevice") : t("topbar.outputDevice"),
      });
      if (!entry) return;

      const refreshReason = kind === "input" ? "input_dropdown" : "output_dropdown";
      entry.root.addEventListener("pointerdown", () => {
        refreshDevicesIfStale(refreshReason);
      });
      entry.root.addEventListener("focusin", () => {
        refreshDevicesIfStale(refreshReason);
      });

      if (kind === "input") {
        inputDropdownEl = entry.root;
        inputMenuEl = entry.menu;
        inputDisplayEl = entry.display;
      } else {
        outputDropdownEl = entry.root;
        outputMenuEl = entry.menu;
        outputDisplayEl = entry.display;
      }
    };

    attachDropdown(d.midiSelect, "input");
    attachDropdown(d.midiOutputSelect, "output");

    if (!deviceDocClickBound) {
      deviceDocClickBound = true;
      document.addEventListener("click", (event) => {
        if (inputDropdownEl && inputDropdownEl.contains(event.target)) return;
        if (outputDropdownEl && outputDropdownEl.contains(event.target)) return;
        closeDeviceDropdowns();
      });
    }
  }

  function renderDeviceDropdownForSelect(selectEl, menuEl, displayEl, fallbackText, connectedDeviceId = "") {
    if (!selectEl || !menuEl || !displayEl) return;
    renderNativeSelectDropdown({
      entry: { menu: menuEl, display: displayEl },
      selectEl,
      fallbackText,
      closeDropdowns: closeDeviceDropdowns,
      formatOptionText: (opt) => stripUnavailableSuffix(opt.textContent || ""),
      getOptionBadges: (opt) => (opt.dataset.unavailable === "true"
        ? [{ text: t("targets.unavailable"), kind: "state" }]
        : []),
      getDisplayBadges: () => [],
      truncateMenuLabels: false,
      truncateDisplayLabel: true,
    });

    const root = menuEl.closest(".midi-device-dropdown");
    const selected = selectEl.selectedOptions?.[0] || null;
    const state = resolveMidiDeviceDropdownState({
      selectedValue: selectEl.value,
      selectedUnavailable: selected?.dataset?.unavailable === "true",
      connectedDeviceId,
    });
    root?.classList.toggle("device-connected", state.connected);
    root?.classList.toggle("device-unavailable", state.unavailable);
    root?.classList.toggle("device-empty", state.empty);
  }

  function renderDeviceDropdowns() {
    ensureDeviceDropdowns();
    renderDeviceDropdownForSelect(
      d.midiSelect,
      inputMenuEl,
      inputDisplayEl,
      t("midi.selectInputDevice"),
      connectedInputId,
    );
    renderDeviceDropdownForSelect(
      d.midiOutputSelect,
      outputMenuEl,
      outputDisplayEl,
      t("midi.selectOutputDevice"),
      connectedOutputId,
    );
  }

  function hasPreference(pref) {
    const normalized = normalizeMidiPreference(pref);
    return Boolean(normalized.inputDeviceId && normalized.outputDeviceId);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function enumerateMidiDevices({ force = false, reason = "unknown" } = {}) {
    const now = Date.now();
    if (!force && now - lastDeviceRefreshAt < MIDI_ENUM_MIN_INTERVAL_MS) {
      return lastDeviceSnapshot;
    }
    if (deviceRefreshInFlight) {
      return deviceRefreshInFlight;
    }

    deviceRefreshInFlight = (async () => {
      try {
        const inputs = await invoke("list_midi_devices").catch((error) => {
          console.warn(`Failed to list MIDI inputs (${reason}):`, error);
          return lastDeviceSnapshot.inputs || [];
        });
        await sleep(MIDI_OUTPUT_ENUM_DELAY_MS);
        const outputs = await invoke("list_midi_output_devices").catch((error) => {
          console.warn(`Failed to list MIDI outputs (${reason}):`, error);
          return lastDeviceSnapshot.outputs || [];
        });
        lastDeviceSnapshot = {
          inputs: Array.isArray(inputs) ? inputs : [],
          outputs: Array.isArray(outputs) ? outputs : [],
        };
        lastDeviceRefreshAt = Date.now();
        return lastDeviceSnapshot;
      } finally {
        deviceRefreshInFlight = null;
      }
    })();

    return deviceRefreshInFlight;
  }

  async function getMidiConnectionHealth() {
    try {
      return await invoke("get_midi_connection_health");
    } catch {
      return null;
    }
  }

  function refreshDevicesIfStale(reason) {
    if (Date.now() - lastDeviceRefreshAt < MIDI_ENUM_STALE_MS) return;
    refreshMidiDevices({ force: true, reason }).catch(() => { });
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
    return applySelectedDevices({
      inputId: input.id,
      outputId: output.id,
      inputName: input.name || options.inputName || "",
      outputName: output.name || options.outputName || "",
      source: options.fromProfile ? "profile" : (options.auto ? "auto" : "manual"),
      auto: Boolean(options.auto),
      fromProfile: Boolean(options.fromProfile),
    });
  }

  async function applySelectedDevices({
    inputId,
    outputId,
    inputName = "",
    outputName = "",
    source = "manual",
    auto = false,
    fromProfile = false,
  } = {}) {
    const nextInputId = String(inputId || "").trim();
    const nextOutputId = String(outputId || "").trim();
    if (!nextInputId || !nextOutputId) {
      if (d.midiStatus) d.midiStatus.textContent = t("bindings.selectBothDevices");
      renderDeviceDropdowns();
      return { connected: false, reason: "invalid_selection" };
    }
    const inputUnavailable = Boolean(
      d.midiSelect?.selectedOptions?.[0]?.dataset?.unavailable === "true"
      && d.midiSelect?.value === nextInputId,
    );
    const outputUnavailable = Boolean(
      d.midiOutputSelect?.selectedOptions?.[0]?.dataset?.unavailable === "true"
      && d.midiOutputSelect?.value === nextOutputId,
    );
    if (inputUnavailable || outputUnavailable) {
      if (d.midiStatus) {
        d.midiStatus.textContent = t("midi.unavailablePair");
      }
      renderDeviceDropdowns();
      return { connected: false, reason: "unavailable_selection" };
    }

    if (nextInputId === connectedInputId && nextOutputId === connectedOutputId) {
      if (d.midiSelect) d.midiSelect.value = nextInputId;
      if (d.midiOutputSelect) d.midiOutputSelect.value = nextOutputId;
      clearUnavailableDeviceSelections();
      if (typeof showMain === "function") {
        showMain(connectedInputName || inputName, connectedOutputName || outputName);
      }
      renderDeviceDropdowns();
      return {
        connected: true,
        unchanged: true,
        inputId: connectedInputId,
        outputId: connectedOutputId,
        inputName: connectedInputName || inputName,
        outputName: connectedOutputName || outputName,
      };
    }

    if (d.midiStatus) d.midiStatus.textContent = t("midi.applyingChange");
    if (d.midiSelect) d.midiSelect.value = nextInputId;
    if (d.midiOutputSelect) d.midiOutputSelect.value = nextOutputId;

    stopSessionRefresh();
    await invoke("stop_midi_device").catch(() => { });
    setConnectedState("", "", "", "");
    renderDeviceDropdowns();
    await invoke("start_midi_device", { inputDeviceId: nextInputId, outputDeviceId: nextOutputId });

    const resolvedInputName = inputName
      || d.midiSelect?.options?.[d.midiSelect.selectedIndex]?.textContent
      || nextInputId;
    const resolvedOutputName = outputName
      || d.midiOutputSelect?.options?.[d.midiOutputSelect.selectedIndex]?.textContent
      || nextOutputId;

    if (typeof saveMidiDeviceIds === "function") {
      await saveMidiDeviceIds(nextInputId, nextOutputId, resolvedInputName, resolvedOutputName);
    }

    setConnectedState(nextInputId, nextOutputId, resolvedInputName, resolvedOutputName);
    currentProfilePreference = getCurrentConnectedPreference();
    suspendProfileAutoReconnect = false;
    clearUnavailableDeviceSelections();

    if (typeof showMain === "function") {
      showMain(resolvedInputName, resolvedOutputName);
    }
    if (typeof refreshSessions === "function") {
      await refreshSessions();
    }
    startSessionRefresh(refreshSessions || (async () => { }), d.mainScreen);
    if (typeof onConnected === "function") {
      onConnected({
        inputId: nextInputId,
        outputId: nextOutputId,
        source,
        auto: Boolean(auto),
        fromProfile: Boolean(fromProfile),
      });
    }
    if (typeof onProfileDeviceSelected === "function") {
      await onProfileDeviceSelected(getCurrentConnectedPreference());
    }
    renderDeviceDropdowns();

    return {
      connected: true,
      inputId: nextInputId,
      outputId: nextOutputId,
      inputName: resolvedInputName,
      outputName: resolvedOutputName,
    };
  }

  function queueApplySelectedDevices(payload) {
    queuedApply = payload;
    processApplyQueue().catch(() => { });
  }

  async function processApplyQueue() {
    if (applyInFlight) return;
    applyInFlight = true;
    try {
      while (queuedApply) {
        const next = queuedApply;
        queuedApply = null;
        try {
          await applySelectedDevices(next);
        } catch (error) {
          if (d.midiStatus) {
            d.midiStatus.textContent = t("midi.connectFailed", { message: error });
          }
        }
      }
    } finally {
      applyInFlight = false;
    }
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

      const deviceSnapshot = await enumerateMidiDevices({ force: true, reason: "availability" });
      const devices = deviceSnapshot.inputs;
      const outputDevices = deviceSnapshot.outputs;
      const preferredPair = resolvePreferredMidiDevicePair(deviceSnapshot, pref);
      let inputMatch = preferredPair.inputMatch;
      let outputMatch = preferredPair.outputMatch;
      let preferredNowAvailable = preferredPair.available;

      if (currentlyConnected) {
        const health = await getMidiConnectionHealth();
        if (shouldRecoverSuspectMidiPair(health, getCurrentConnectedPreference())) {
          const staleInputId = connectedInputId;
          const staleOutputId = connectedOutputId;
          const displayInputName = connectedInputName || pref.inputDeviceName || staleInputId;
          const displayOutputName = connectedOutputName || pref.outputDeviceName || staleOutputId;
          stopSessionRefresh();
          await invoke("stop_midi_device").catch(() => { });
          setConnectedState("", "", "", "");
          if (typeof showMain === "function") {
            showMain(displayInputName, displayOutputName, { connected: false });
          }
          if (d.midiStatus) {
            d.midiStatus.textContent = t("midi.disconnected");
          }
          markSelectedPairUnavailable(staleInputId, staleOutputId, displayInputName, displayOutputName);

          if (!prefAvailable || suspendProfileAutoReconnect) {
            return;
          }

          const refreshed = await refreshMidiDevices({ snapshot: deviceSnapshot, reason: "suspect_reconnect_available" });
          const refreshedPair = resolvePreferredMidiDevicePair(refreshed, pref);
          inputMatch = refreshedPair.inputMatch;
          outputMatch = refreshedPair.outputMatch;
          preferredNowAvailable = refreshedPair.available;
          if (!preferredNowAvailable) {
            return;
          }

          try {
            await startWithResolvedDevice(inputMatch, outputMatch, {
              inputName: pref.inputDeviceName,
              outputName: pref.outputDeviceName,
              auto: true,
              fromProfile: true,
            });
            if (d.midiStatus) {
              d.midiStatus.textContent = t("midi.reconnectedProfile");
            }
          } catch {
            markSelectedPairUnavailable(staleInputId, staleOutputId, displayInputName, displayOutputName);
          }
          return;
        }

        const activeInputAlive = findConnectedAliveDevice(devices, connectedInputId, connectedInputName);
        const activeOutputAlive = findConnectedAliveDevice(outputDevices, connectedOutputId, connectedOutputName);
        if (!activeInputAlive || !activeOutputAlive) {
          stopSessionRefresh();
          await invoke("stop_midi_device").catch(() => { });
          const displayInputName = connectedInputName || pref.inputDeviceName || connectedInputId;
          const displayOutputName = connectedOutputName || pref.outputDeviceName || connectedOutputId;
          setConnectedState("", "", "", "");
          if (typeof showMain === "function") {
            showMain(displayInputName, displayOutputName, { connected: false });
          }
          if (d.midiStatus) {
            d.midiStatus.textContent = t("midi.disconnected");
          }
          await refreshMidiDevices({ snapshot: deviceSnapshot, reason: "disconnect" });
          return;
        }
      }

      if (prefAvailable && !currentlyConnected && preferredNowAvailable && !suspendProfileAutoReconnect) {
        const refreshed = await refreshMidiDevices({ snapshot: deviceSnapshot, reason: "reconnect_available" });
        const refreshedPair = resolvePreferredMidiDevicePair(refreshed, pref);
        inputMatch = refreshedPair.inputMatch;
        outputMatch = refreshedPair.outputMatch;
        preferredNowAvailable = refreshedPair.available;
        if (!preferredNowAvailable) {
          return;
        }
        try {
          await startWithResolvedDevice(inputMatch, outputMatch, {
            inputName: pref.inputDeviceName,
            outputName: pref.outputDeviceName,
            auto: true,
            fromProfile: true,
          });
          if (d.midiStatus) {
            d.midiStatus.textContent = t("midi.reconnectedProfile");
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
    const delay = (connectedInputId && connectedOutputId)
      ? MIDI_AVAILABILITY_CONNECTED_INTERVAL_MS
      : MIDI_AVAILABILITY_DISCONNECTED_INTERVAL_MS;
    availabilityTimer = setTimeout(async () => {
      availabilityTimer = null;
      await checkAvailabilityLoop().catch(() => { });
      startAvailabilityMonitor();
    }, delay);
  }

  function startAutoRefresh(refreshFn) {
    if (autoRefreshTimer) {
      return;
    }
    autoRefreshTimer = setInterval(async () => {
      const devices = await refreshFn();
      if (devices.inputs.length > 0 && devices.outputs.length > 0) {
        await checkAvailabilityLoop().catch(() => { });
      }
      if (connectedInputId && connectedOutputId) {
        stopAutoRefresh();
      }
    }, MIDI_AUTO_REFRESH_INTERVAL_MS);
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  function sessionRefreshIsHidden(mainScreenEl) {
    return Boolean(document.hidden || (mainScreenEl && mainScreenEl.classList.contains("hidden")));
  }

  function sessionRefreshDelay(mainScreenEl) {
    return sessionRefreshIsHidden(mainScreenEl)
      ? SESSION_REFRESH_HIDDEN_INTERVAL_MS
      : SESSION_REFRESH_VISIBLE_INTERVAL_MS;
  }

  function scheduleSessionRefresh(delayMs) {
    if (!sessionRefreshFn) return;
    sessionRefreshTimer = setTimeout(async () => {
      sessionRefreshTimer = null;
      if (!sessionRefreshIsHidden(sessionRefreshMainScreenEl)) {
        await sessionRefreshFn();
      }
      scheduleSessionRefresh(sessionRefreshDelay(sessionRefreshMainScreenEl));
    }, delayMs);
  }

  function restartSessionRefresh(delayMs = 0) {
    if (!sessionRefreshFn) return;
    if (sessionRefreshTimer) {
      clearTimeout(sessionRefreshTimer);
      sessionRefreshTimer = null;
    }
    scheduleSessionRefresh(delayMs);
  }

  function ensureSessionVisibilityListener() {
    if (sessionVisibilityListenerBound) return;
    sessionVisibilityListenerBound = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        restartSessionRefresh(0);
      }
    });
  }

  function startSessionRefresh(refreshFn, mainScreenEl) {
    sessionRefreshFn = refreshFn;
    sessionRefreshMainScreenEl = mainScreenEl;
    ensureSessionVisibilityListener();
    if (sessionRefreshTimer) return;
    scheduleSessionRefresh(sessionRefreshDelay(mainScreenEl));
  }

  function stopSessionRefresh() {
    if (sessionRefreshTimer) {
      clearTimeout(sessionRefreshTimer);
      sessionRefreshTimer = null;
    }
    sessionRefreshFn = null;
    sessionRefreshMainScreenEl = null;
  }

  function closeLearnPanel() {
    if (!d.learnPanel) {
      return;
    }
    d.learnPanel.classList.add("hidden");
    if (d.learnPanelTitle) {
      d.learnPanelTitle.textContent = t("bindings.waitingMidiTitle");
    }
    if (d.learnPanelSpinner) {
      d.learnPanelSpinner.classList.remove("hidden");
    }
    if (d.learnPanelActions) {
      d.learnPanelActions.classList.add("hidden");
    }
  }

  function openLearnPanel(message) {
    if (!d.learnPanel) {
      return;
    }
    if (d.learnPanelTitle) {
      d.learnPanelTitle.textContent = t("bindings.waitingMidiTitle");
    }
    if (d.learnPanelSpinner) {
      d.learnPanelSpinner.classList.remove("hidden");
    }
    if (d.learnPanelActions) {
      d.learnPanelActions.classList.add("hidden");
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

  async function refreshMidiDevices(options = {}) {
    try {
      const snapshot = options.snapshot && typeof options.snapshot === "object"
        ? options.snapshot
        : await enumerateMidiDevices({
          force: Boolean(options.force),
          reason: options.reason || "refresh",
        });
      const devices = snapshot.inputs;
      const outputDevices = snapshot.outputs;

      const pref = normalizeMidiPreference(currentProfilePreference);
      const previousSelection = d.midiSelect
        ? (d.midiSelect.value || pref.inputDeviceId || connectedInputId)
        : (pref.inputDeviceId || connectedInputId);
      const previousOutputSelection = d.midiOutputSelect
        ? (d.midiOutputSelect.value || pref.outputDeviceId || connectedOutputId)
        : (pref.outputDeviceId || connectedOutputId);

      if (d.midiSelect) {
        d.midiSelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = t("midi.selectInputDevice");
        d.midiSelect.appendChild(placeholder);
      }

      if (d.midiOutputSelect) {
        d.midiOutputSelect.innerHTML = "";
        const outPlaceholder = document.createElement("option");
        outPlaceholder.value = "";
        outPlaceholder.textContent = t("midi.selectOutputDevice");
        d.midiOutputSelect.appendChild(outPlaceholder);
      }

      if ((!devices || devices.length === 0) && (!outputDevices || outputDevices.length === 0)) {
        if (pref.inputDeviceId) {
          ensureOption(
            d.midiSelect,
            pref.inputDeviceId,
            unavailableDeviceLabel(pref.inputDeviceName, pref.inputDeviceId, "Input"),
            true,
          );
        }
        if (pref.outputDeviceId) {
          ensureOption(
            d.midiOutputSelect,
            pref.outputDeviceId,
            unavailableDeviceLabel(pref.outputDeviceName, pref.outputDeviceId, "Output"),
            true,
          );
        }
        if (d.midiSelect && pref.inputDeviceId) d.midiSelect.value = pref.inputDeviceId;
        if (d.midiOutputSelect && pref.outputDeviceId) d.midiOutputSelect.value = pref.outputDeviceId;
        if (d.midiStatus) {
          d.midiStatus.textContent = t("midi.searchingDevices");
        }
        renderDeviceDropdowns();
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

      if (pref.inputDeviceId && !(Array.isArray(devices) && devices.some((dvc) => dvc.id === pref.inputDeviceId))) {
        ensureOption(
          d.midiSelect,
          pref.inputDeviceId,
          unavailableDeviceLabel(pref.inputDeviceName, pref.inputDeviceId, "Input"),
          true,
        );
      }
      if (pref.outputDeviceId && !(Array.isArray(outputDevices) && outputDevices.some((dvc) => dvc.id === pref.outputDeviceId))) {
        ensureOption(
          d.midiOutputSelect,
          pref.outputDeviceId,
          unavailableDeviceLabel(pref.outputDeviceName, pref.outputDeviceId, "Output"),
          true,
        );
      }
      if (connectedInputId && !(Array.isArray(devices) && devices.some((dvc) => dvc.id === connectedInputId))) {
        ensureOption(
          d.midiSelect,
          connectedInputId,
          unavailableDeviceLabel(connectedInputName, connectedInputId, "Input"),
          true,
        );
      }
      if (connectedOutputId && !(Array.isArray(outputDevices) && outputDevices.some((dvc) => dvc.id === connectedOutputId))) {
        ensureOption(
          d.midiOutputSelect,
          connectedOutputId,
          unavailableDeviceLabel(connectedOutputName, connectedOutputId, "Output"),
          true,
        );
      }

      if (d.midiSelect && previousSelection) {
        d.midiSelect.value = previousSelection;
      }
      if (d.midiOutputSelect && previousOutputSelection) {
        d.midiOutputSelect.value = previousOutputSelection;
      }

      if (d.midiStatus && !connectedInputId && !connectedOutputId) {
        d.midiStatus.textContent = t("midi.foundDevices", {
          inputs: (devices || []).length,
          outputs: (outputDevices || []).length,
        });
      }
      renderDeviceDropdowns();
      if (pref.inputDeviceId && pref.outputDeviceId && !connectedInputId && !connectedOutputId) {
        startAutoRefresh(refreshMidiDevices);
      } else {
        stopAutoRefresh();
      }
      return { inputs: Array.isArray(devices) ? devices : [], outputs: Array.isArray(outputDevices) ? outputDevices : [] };
    } catch (error) {
      if (d.midiStatus) {
        d.midiStatus.textContent = t("midi.error", { message: error });
      }
      renderDeviceDropdowns();
      startAutoRefresh(refreshMidiDevices);
      return { inputs: [], outputs: [] };
    }
  }

  async function connectSelected() {
    const inputId = d.midiSelect ? d.midiSelect.value : "";
    const outputId = d.midiOutputSelect ? d.midiOutputSelect.value : "";
    if (!inputId || !outputId) {
      if (d.midiStatus) {
        d.midiStatus.textContent = t("bindings.selectBothDevices");
      }
      renderDeviceDropdowns();
      return;
    }
    queueApplySelectedDevices({ inputId, outputId, source: "manual" });
  }

  async function disconnect() {
    stopSessionRefresh();
    stopAutoRefresh();
    cancelLearnPanel();
    const displayInputName = connectedInputName;
    const displayOutputName = connectedOutputName;
    await invoke("stop_midi_device").catch(() => { });
    setConnectedState("", "", "", "");
    if (typeof showMain === "function") {
      showMain(displayInputName, displayOutputName, { connected: false });
    }
    // User intentionally entered manual selection flow; do not auto-reconnect
    // to the profile's preferred device until they explicitly connect or a profile sync occurs.
    suspendProfileAutoReconnect = true;
    if (typeof clearSavedMidiDeviceIds === "function") {
      await clearSavedMidiDeviceIds();
    }
    if (d.midiStatus) d.midiStatus.textContent = t("midi.notConnected");
    await refreshMidiDevices();
    if (typeof onDisconnected === "function") {
      onDisconnected();
    }
  }

  async function startLearnBinding() {
    try {
      await invoke("start_midi_learn");
      openLearnPanel(t("bindings.learnMessage"));
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
        if (typeof addBindingFromLearn === "function") {
          await addBindingFromLearn(learned);
        }
      }, LEARN_POLL_MS);
    } catch (error) {
      closeLearnPanel();
      if (d.learnPanelMessage && d.learnPanel && !d.learnPanel.classList.contains("hidden")) {
        d.learnPanelMessage.textContent = t("midi.learnFailed", { message: error });
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

    currentProfilePreference = normalizeMidiPreference({
      inputDeviceId: savedInputId,
      outputDeviceId: savedOutputId,
      inputDeviceName: savedInputName,
      outputDeviceName: savedOutputName,
    });

    const inputs = Array.isArray(deviceData?.inputs) ? deviceData.inputs : [];
    const outputs = Array.isArray(deviceData?.outputs) ? deviceData.outputs : [];

    if (!savedInputId || !savedOutputId) {
      // First-run heuristic:
      // - if exactly one input exists, assume it
      // - prefer output with identical name; otherwise prefer a non-GS output
      if (inputs.length === 1 && outputs.length > 0) {
        const inputMatch = inputs[0];
        const outputMatch = outputs.find((o) => o?.name === inputMatch?.name)
          || outputs.find((o) => !String(o?.name || "").toLowerCase().includes("microsoft gs wavetable"))
          || outputs[0];

        if (inputMatch && outputMatch) {
          try {
            if (d.midiSelect) d.midiSelect.value = inputMatch.id;
            if (d.midiOutputSelect) d.midiOutputSelect.value = outputMatch.id;
            await startWithResolvedDevice(inputMatch, outputMatch, {
              inputName: inputMatch?.name || "",
              outputName: outputMatch?.name || "",
              auto: true,
            });
            if (d.midiStatus) d.midiStatus.textContent = t("midi.autoConnected");
            return { connected: true, autoSelected: true };
          } catch (error) {
            if (d.midiStatus) d.midiStatus.textContent = t("midi.connectFailed", { message: error });
            renderDeviceDropdowns();
            return { connected: false, reason: "auto_select_connect_failed" };
          }
        }
      }

      if (d.midiStatus) d.midiStatus.textContent = t("bindings.selectDevicesSentence");
      renderDeviceDropdowns();
      return { connected: false, reason: "missing_saved" };
    }

    let inputMatch = findPreferredDevice(inputs, savedInputId, savedInputName);
    let outputMatch = savedOutputId ? findPreferredDevice(outputs, savedOutputId, savedOutputName) : null;

    if (!inputMatch) {
      const refreshed = await refreshMidiDevices();
      inputMatch = findPreferredDevice(refreshed.inputs, savedInputId, savedInputName);
      outputMatch = savedOutputId ? findPreferredDevice(refreshed.outputs, savedOutputId, savedOutputName) : null;
    }

    if (!inputMatch || !outputMatch) {
      if (d.midiStatus) {
        d.midiStatus.textContent = t("midi.savedUnavailable");
      }
      ensureOption(
        d.midiSelect,
        savedInputId,
        unavailableDeviceLabel(savedInputName, savedInputId, "Input"),
        true,
      );
      ensureOption(
        d.midiOutputSelect,
        savedOutputId,
        unavailableDeviceLabel(savedOutputName, savedOutputId, "Output"),
        true,
      );
      if (d.midiSelect) d.midiSelect.value = savedInputId;
      if (d.midiOutputSelect) d.midiOutputSelect.value = savedOutputId;
      renderDeviceDropdowns();
      if (connectedInputId && connectedOutputId) {
        return { connected: true, preserved: true, reason: "saved_missing_preserved" };
      }
      return { connected: false, reason: "saved_missing" };
    }

    try {
      if (d.midiSelect) d.midiSelect.value = inputMatch?.id || savedInputId;
      if (d.midiOutputSelect) d.midiOutputSelect.value = outputMatch?.id || savedOutputId;
      await startWithResolvedDevice(inputMatch, outputMatch, {
        inputName: inputMatch?.name || savedInputName,
        outputName: outputMatch?.name || savedOutputName,
        auto: true,
      });
      return { connected: true };
    } catch (error) {
      setConnectedState("", "", "", "");
      if (d.midiStatus) {
        d.midiStatus.textContent = t("midi.connectFailed", { message: error });
      }
      renderDeviceDropdowns();
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
      // Profile switch can leave the visible dropdown on a previously selected
      // unavailable device even when the active connection already matches this profile.
      // Force UI selection back to the profile's connected pair.
      if (d.midiSelect) d.midiSelect.value = pref.inputDeviceId;
      if (d.midiOutputSelect) d.midiOutputSelect.value = pref.outputDeviceId;
      clearUnavailableDeviceSelections();
      renderDeviceDropdowns();
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
      ensureOption(
        d.midiSelect,
        pref.inputDeviceId,
        unavailableDeviceLabel(pref.inputDeviceName, pref.inputDeviceId, "Input"),
        true,
      );
      ensureOption(
        d.midiOutputSelect,
        pref.outputDeviceId,
        unavailableDeviceLabel(pref.outputDeviceName, pref.outputDeviceId, "Output"),
        true,
      );
      if (d.midiSelect) d.midiSelect.value = pref.inputDeviceId;
      if (d.midiOutputSelect) d.midiOutputSelect.value = pref.outputDeviceId;

      if (d.midiStatus) {
        d.midiStatus.textContent = connectedInputId && connectedOutputId
          ? t("midi.profileUnavailableKeepingCurrent")
          : t("midi.savedProfileDevicesNotFound");
      }
      renderDeviceDropdowns();
      return {
        handled: true,
        connected: Boolean(connectedInputId && connectedOutputId),
        reason: "missing",
      };
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
      if (d.midiStatus) d.midiStatus.textContent = t("midi.connectFailed", { message: error });
      renderDeviceDropdowns();
      return { handled: true, connected: false, reason: "connect_failed" };
    }
  }

  function bindUi() {
    startAvailabilityMonitor();
    ensureDeviceDropdowns();
    renderDeviceDropdowns();
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
        await refreshMidiDevices({ force: true, reason: "manual_refresh" });
      });
    }
    if (d.midiSelect) {
      d.midiSelect.addEventListener("pointerdown", () => {
        refreshDevicesIfStale("input_dropdown");
      });
      d.midiSelect.addEventListener("change", async () => {
        await connectSelected();
      });
    }
    if (d.midiOutputSelect) {
      d.midiOutputSelect.addEventListener("pointerdown", () => {
        refreshDevicesIfStale("output_dropdown");
      });
      d.midiOutputSelect.addEventListener("change", async () => {
        await connectSelected();
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
    window.addEventListener("midimaster:locale-changed", () => {
      renderDeviceDropdowns();
      if (d.learnPanel && !d.learnPanel.classList.contains("hidden") && d.learnPanelTitle) {
        d.learnPanelTitle.textContent = t("bindings.waitingMidiTitle");
      }
    });
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

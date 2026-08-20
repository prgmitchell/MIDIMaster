const INSTALL_STATES = new Set([
  "not_installed",
  "installing",
  "restart_required",
  "ready",
  "blocked_unsafe_version",
  "blocked_unknown_version",
  "service_error",
]);

const POST_ACTION_STATUS_REFRESH_MS = 250;
const POST_ACTION_STATUS_TIMEOUT_MS = 10_000;

export const defaultVirtualAudioSettings = Object.freeze({
  enabled: false,
  follow_default_input: true,
  input_device_id: null,
  microphone_gain_db: 0,
  soundboard_gain_db: -6,
});

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function firstDefined(source, keys, fallback = undefined) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source[key] !== null) return source[key];
  }
  return fallback;
}

export function normalizeVirtualAudioSettings(raw = {}) {
  const inputDeviceId = String(firstDefined(raw, ["input_device_id", "physical_input_device_id"], "") || "").trim();
  const followDefault = firstDefined(raw, ["follow_default_input", "follow_default_microphone"], !inputDeviceId);
  return {
    enabled: Boolean(raw?.enabled),
    follow_default_input: Boolean(followDefault),
    input_device_id: inputDeviceId || null,
    microphone_gain_db: clamp(firstDefined(raw, ["microphone_gain_db", "mic_gain_db"]), -24, 24, 0),
    soundboard_gain_db: clamp(firstDefined(raw, ["soundboard_gain_db", "soundboard_bus_gain_db"]), -24, 12, -6),
  };
}

export function normalizeVirtualAudioStatus(raw = {}) {
  let installState = String(firstDefined(raw, ["install_state", "state"], "not_installed") || "not_installed").trim();
  if (!INSTALL_STATES.has(installState)) installState = "service_error";
  if (raw?.restart_required) installState = "restart_required";
  return {
    install_state: installState,
    usbip_version: String(firstDefined(raw, ["usbip_version", "driver_version"], "") || "").trim(),
    service_running: Boolean(firstDefined(raw, ["service_running", "service_ready"], false)),
    endpoint_present: Boolean(firstDefined(raw, ["endpoint_present", "virtual_endpoint_present"], false)),
    attached_port_count: Math.max(0, Math.round(Number(raw?.attached_port_count) || 0)),
    routing_running: Boolean(firstDefined(raw, ["routing_running", "route_running"], false)),
    service_update_available: Boolean(firstDefined(raw, ["service_update_available", "service_update_required"], false)),
    restart_required: Boolean(raw?.restart_required || installState === "restart_required"),
    mic_level: clamp(firstDefined(raw, ["mic_level", "microphone_level", "mic_peak"]), 0, 1, 0),
    soundboard_level: clamp(firstDefined(raw, ["soundboard_level", "soundboard_peak"]), 0, 1, 0),
    output_level: clamp(firstDefined(raw, ["output_level", "final_output_level", "output_peak"]), 0, 1, 0),
    limiter_reduction_db: clamp(raw?.limiter_reduction_db, 0, 60, 0),
    underruns: Math.max(0, Math.round(Number(raw?.underruns) || 0)),
    overruns: Math.max(0, Math.round(Number(raw?.overruns) || 0)),
    error: String(firstDefined(raw, ["error", "message"], "") || "").trim(),
  };
}

export function virtualAudioViewForStatus(status) {
  const state = normalizeVirtualAudioStatus(status).install_state;
  if (state === "not_installed") return "not-installed";
  if (state === "installing") return "installing";
  if (state === "restart_required") return "restart-required";
  if (state === "ready") return "ready";
  return "problem";
}

export function virtualAudioMeterPercent(value) {
  const level = clamp(value, 0, 1, 0);
  if (level <= 0) return 0;
  const decibels = 20 * Math.log10(level);
  return Math.round(clamp((decibels + 60) / 60, 0, 1, 0) * 100);
}

export function virtualAudioStatusRefreshInterval(status) {
  return normalizeVirtualAudioStatus(status).install_state === "ready" ? 250 : 1000;
}

export function createVirtualAudioSettingsController({ invoke, dom, i18n, showAlert, renderSelectDropdown }) {
  if (typeof invoke !== "function") throw new Error("createVirtualAudioSettingsController: invoke is required");
  const d = dom && typeof dom === "object" ? dom : {};
  const t = (key, params = {}) => i18n?.t?.(key, params) ?? String(key || "");
  let settings = normalizeVirtualAudioSettings();
  let status = normalizeVirtualAudioStatus();
  let devices = [];
  let loaded = false;
  let busy = false;
  let loadPromise = null;
  let active = false;
  let meterTimer = 0;
  let meterRefreshPending = false;
  let lastStatusRefreshAt = 0;
  let renderedDevicesSignature = "";

  function setText(target, value) {
    if (target) target.textContent = String(value ?? "");
  }

  function statusSummary(current) {
    if (current.install_state === "blocked_unsafe_version") return t("virtualAudio.blockedUnsafeVersion");
    if (current.install_state === "blocked_unknown_version") return t("virtualAudio.blockedUnknownVersion");
    return current.error || t("virtualAudio.serviceError");
  }

  function renderMeter(element, value, logarithmic = true) {
    if (!element) return;
    const percent = logarithmic
      ? virtualAudioMeterPercent(value)
      : Math.round(clamp(value, 0, 1, 0) * 100);
    element.style.setProperty("--meter-level", `${percent}%`);
    element.setAttribute("aria-valuenow", String(percent));
  }

  function renderInputDevices() {
    const select = d.virtualAudioInputDevice;
    if (!select) return;
    const selectedId = settings.follow_default_input ? "__default__" : (settings.input_device_id || "__default__");
    const signature = JSON.stringify({
      selectedId,
      defaultLabel: t("virtualAudio.followSystemDefault"),
      localizedDeviceLabels: [
        t("virtualAudio.defaultDevice", { device: "_" }),
        t("virtualAudio.unavailableDevice", { device: "_" }),
      ],
      devices: devices.map((device) => [device?.id, device?.display, Boolean(device?.is_default)]),
      disabled: Boolean(select.disabled),
    });
    if (signature === renderedDevicesSignature) return;
    renderedDevicesSignature = signature;
    select.replaceChildren();
    const defaultOption = document.createElement("option");
    defaultOption.value = "__default__";
    defaultOption.textContent = t("virtualAudio.followSystemDefault");
    select.append(defaultOption);
    devices.forEach((device) => {
      const id = String(device?.id || "").trim();
      if (!id) return;
      const option = document.createElement("option");
      option.value = id;
      option.textContent = device?.is_default
        ? t("virtualAudio.defaultDevice", { device: device.display || id })
        : String(device.display || id);
      select.append(option);
    });
    if (selectedId !== "__default__" && !devices.some((device) => String(device?.id || "") === selectedId)) {
      const unavailable = document.createElement("option");
      unavailable.value = selectedId;
      unavailable.textContent = t("virtualAudio.unavailableDevice", { device: selectedId });
      select.append(unavailable);
    }
    select.value = selectedId;
    renderSelectDropdown?.(select);
  }

  function render() {
    const view = loaded ? virtualAudioViewForStatus(status) : "loading";
    if (d.virtualAudioPanel) d.virtualAudioPanel.dataset.virtualAudioState = view;
    d.virtualAudioPanel?.querySelectorAll?.("[data-virtual-audio-view]").forEach((element) => {
      element.classList.toggle("hidden", element.dataset.virtualAudioView !== view);
    });
    if (d.virtualAudioInstall) d.virtualAudioInstall.disabled = busy;
    if (d.virtualAudioRepair) d.virtualAudioRepair.disabled = busy;
    if (d.virtualAudioUpdate) d.virtualAudioUpdate.disabled = busy;
    d.virtualAudioUpdateNotice?.classList.toggle("hidden", !status.service_update_available);
    if (d.virtualAudioProblemRepair) {
      d.virtualAudioProblemRepair.disabled = busy || status.install_state.startsWith("blocked_");
      d.virtualAudioProblemRepair.classList.toggle("hidden", status.install_state.startsWith("blocked_"));
    }
    if (d.virtualAudioRemove) d.virtualAudioRemove.disabled = busy;
    if (d.virtualAudioEnabled) {
      d.virtualAudioEnabled.checked = settings.enabled;
      d.virtualAudioEnabled.disabled = busy;
    }
    const routingError = settings.enabled && !status.routing_running
      ? (status.error || t("virtualAudio.routingUnavailable"))
      : "";
    setText(d.virtualAudioRoutingError, routingError);
    d.virtualAudioRoutingError?.classList.toggle("hidden", !routingError);
    if (d.virtualAudioInputDevice) d.virtualAudioInputDevice.disabled = busy;
    if (d.virtualAudioMicrophoneGain) {
      d.virtualAudioMicrophoneGain.value = String(settings.microphone_gain_db);
      d.virtualAudioMicrophoneGain.disabled = busy;
      d.virtualAudioMicrophoneGain.style.setProperty("--range-fill", `${((settings.microphone_gain_db + 24) / 48) * 100}%`);
    }
    if (d.virtualAudioSoundboardGain) {
      d.virtualAudioSoundboardGain.value = String(settings.soundboard_gain_db);
      d.virtualAudioSoundboardGain.disabled = busy;
      d.virtualAudioSoundboardGain.style.setProperty("--range-fill", `${((settings.soundboard_gain_db + 24) / 36) * 100}%`);
    }
    setText(d.virtualAudioMicrophoneGainValue, `${settings.microphone_gain_db > 0 ? "+" : ""}${settings.microphone_gain_db} dB`);
    setText(d.virtualAudioSoundboardGainValue, `${settings.soundboard_gain_db > 0 ? "+" : ""}${settings.soundboard_gain_db} dB`);
    setText(d.virtualAudioDriverVersion, status.usbip_version || t("common.notAvailable"));
    setText(d.virtualAudioServiceStatus, status.service_running ? t("virtualAudio.running") : t("virtualAudio.stopped"));
    setText(d.virtualAudioEndpointStatus, status.endpoint_present ? t("virtualAudio.available") : t("virtualAudio.unavailable"));
    setText(d.virtualAudioProblemMessage, statusSummary(status));
    setText(d.virtualAudioLimiterValue, `${status.limiter_reduction_db.toFixed(1)} dB`);
    renderMeter(d.virtualAudioMicrophoneMeter, status.mic_level);
    renderMeter(d.virtualAudioSoundboardMeter, status.soundboard_level);
    renderMeter(d.virtualAudioOutputMeter, status.output_level);
    renderMeter(d.virtualAudioLimiterMeter, Math.min(1, status.limiter_reduction_db / 12), false);
    renderInputDevices();
  }

  async function fetchStatus({ force = false } = {}) {
    return normalizeVirtualAudioStatus(await invoke("get_virtual_audio_status", { force: Boolean(force) }));
  }

  async function refreshStatus({ force = false, renderResult = true } = {}) {
    try {
      status = await fetchStatus({ force });
    } catch (error) {
      status = normalizeVirtualAudioStatus({ install_state: "service_error", error: String(error || "") });
    }
    if (renderResult) render();
    return status;
  }

  function actionStatusIsSettled(command, current) {
    if (command === "remove_virtual_audio") return current.install_state === "not_installed";
    return current.install_state === "ready"
      || current.install_state === "restart_required"
      || current.install_state.startsWith("blocked_");
  }

  async function settleStatusAfterAction(command) {
    const deadline = Date.now() + POST_ACTION_STATUS_TIMEOUT_MS;
    do {
      await refreshStatus({ force: true, renderResult: false });
      if (actionStatusIsSettled(command, status) || Date.now() >= deadline) return status;
      await new Promise((resolve) => window.setTimeout(resolve, POST_ACTION_STATUS_REFRESH_MS));
    } while (true);
  }

  function stopMeterPolling() {
    if (meterTimer) window.clearInterval(meterTimer);
    meterTimer = 0;
  }

  function startMeterPolling() {
    stopMeterPolling();
    lastStatusRefreshAt = 0;
    meterTimer = window.setInterval(async () => {
      if (!active || busy || loadPromise || meterRefreshPending) return;
      const now = Date.now();
      if (lastStatusRefreshAt && now - lastStatusRefreshAt < virtualAudioStatusRefreshInterval(status)) return;
      lastStatusRefreshAt = now;
      meterRefreshPending = true;
      try {
        status = await fetchStatus({ force: status.install_state !== "ready" });
        render();
      } catch {
        // A manual refresh shows connection errors; a transient meter miss should stay quiet.
      } finally {
        meterRefreshPending = false;
      }
    }, 250);
  }

  function setActive(nextActive) {
    active = Boolean(nextActive);
    if (!active) {
      stopMeterPolling();
      return Promise.resolve();
    }
    startMeterPolling();
    return loaded ? refreshStatus({ force: status.install_state !== "ready" }) : load();
  }

  async function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const [nextStatus, nextSettings, nextDevices] = await Promise.allSettled([
        invoke("get_virtual_audio_status"),
        invoke("get_virtual_audio_settings"),
        invoke("list_virtual_audio_input_devices"),
      ]);
      status = nextStatus.status === "fulfilled"
        ? normalizeVirtualAudioStatus(nextStatus.value)
        : normalizeVirtualAudioStatus({ install_state: "service_error", error: String(nextStatus.reason || "") });
      if (nextSettings.status === "fulfilled") settings = normalizeVirtualAudioSettings(nextSettings.value);
      devices = nextDevices.status === "fulfilled" && Array.isArray(nextDevices.value) ? nextDevices.value : [];
      loaded = true;
      render();
      return { settings, status, devices };
    })().finally(() => { loadPromise = null; });
    return loadPromise;
  }

  async function persistSettings(patch) {
    const previous = settings;
    settings = normalizeVirtualAudioSettings({ ...settings, ...patch });
    render();
    try {
      const saved = await invoke("set_virtual_audio_settings", { settings });
      if (saved && typeof saved === "object") settings = normalizeVirtualAudioSettings(saved);
      render();
    } catch (error) {
      settings = previous;
      render();
      showAlert?.(t("dialogs.actionFailedTitle"), String(error || t("dialogs.actionFailedMessage")));
    }
  }

  async function runAction(command) {
    if (busy) return;
    busy = true;
    status = normalizeVirtualAudioStatus({ ...status, install_state: "installing" });
    render();
    try {
      const result = await invoke(command);
      if (result && typeof result === "object") status = normalizeVirtualAudioStatus(result);
      await settleStatusAfterAction(command);
      if (status.install_state === "ready") {
        const nextDevices = await invoke("list_virtual_audio_input_devices").catch(() => []);
        devices = Array.isArray(nextDevices) ? nextDevices : [];
      }
    } catch (error) {
      status = normalizeVirtualAudioStatus({ install_state: "service_error", error: String(error || "") });
      showAlert?.(t("dialogs.actionFailedTitle"), String(error || t("dialogs.actionFailedMessage")));
    } finally {
      busy = false;
      render();
    }
  }

  function bindUi() {
    d.virtualAudioInstall?.addEventListener("click", () => runAction("install_virtual_audio"));
    d.virtualAudioUpdate?.addEventListener("click", () => runAction("repair_virtual_audio"));
    d.virtualAudioRepair?.addEventListener("click", () => runAction("repair_virtual_audio"));
    d.virtualAudioProblemRepair?.addEventListener("click", () => runAction("repair_virtual_audio"));
    d.virtualAudioRemove?.addEventListener("click", () => runAction("remove_virtual_audio"));
    d.virtualAudioRestart?.addEventListener("click", () => invoke("restart_system").catch((error) => {
      showAlert?.(t("dialogs.actionFailedTitle"), String(error || t("dialogs.actionFailedMessage")));
    }));
    d.virtualAudioRestartLater?.addEventListener("click", () => {
      d.settingsPanel?.querySelector?.('[data-settings-section="startup"]')?.click?.();
    });
    d.virtualAudioCopyDiagnostics?.addEventListener("click", async () => {
      try {
        await invoke("copy_virtual_audio_diagnostics");
        setText(d.virtualAudioCopyDiagnostics, t("virtualAudio.diagnosticsCopied"));
      } catch (error) {
        showAlert?.(t("dialogs.actionFailedTitle"), String(error || t("dialogs.actionFailedMessage")));
      }
    });
    d.virtualAudioEnabled?.addEventListener("change", () => persistSettings({ enabled: d.virtualAudioEnabled.checked }));
    d.virtualAudioInputDevice?.addEventListener("change", () => {
      const value = String(d.virtualAudioInputDevice.value || "__default__");
      persistSettings({
        follow_default_input: value === "__default__",
        input_device_id: value === "__default__" ? null : value,
      });
    });
    d.virtualAudioMicrophoneGain?.addEventListener("input", () => {
      settings = normalizeVirtualAudioSettings({ ...settings, microphone_gain_db: d.virtualAudioMicrophoneGain.value });
      render();
    });
    d.virtualAudioMicrophoneGain?.addEventListener("change", () => persistSettings({ microphone_gain_db: d.virtualAudioMicrophoneGain.value }));
    d.virtualAudioSoundboardGain?.addEventListener("input", () => {
      settings = normalizeVirtualAudioSettings({ ...settings, soundboard_gain_db: d.virtualAudioSoundboardGain.value });
      render();
    });
    d.virtualAudioSoundboardGain?.addEventListener("change", () => persistSettings({ soundboard_gain_db: d.virtualAudioSoundboardGain.value }));
    window.addEventListener("midimaster:locale-changed", render);
    render();
  }

  return {
    bindUi,
    load,
    refreshStatus,
    render,
    activate: () => setActive(true),
    setActive,
    getState: () => ({ settings, status, devices: [...devices] }),
  };
}

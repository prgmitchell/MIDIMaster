const ORIGIN = "streamdeck://";
const HOST = "127.0.0.1";
const CONNECT_TIMEOUT_MS = 2000;
const APP_INFO_TIMEOUT_MS = 1500;

// Wave Link (and the websocket bridge) can get overwhelmed if we send a JSON-RPC
// message for every tiny fader tick. Coalesce rapid volume updates and only send
// the latest value at a steady rate.
const VOLUME_WRITE_INTERVAL_MS = 16;
const VOLUME_WRITE_EPSILON = 0.002;
const STATE_REFRESH_DEBOUNCE_MS = 120;
const LOCAL_WRITE_QUIET_MS = 1200;
const FEEDBACK_INTENT_HOLD_MS = 1200;
const FEEDBACK_INTENT_MATCH_EPSILON = 0.02;
const RPC_TIMEOUT_MS = 1200;
const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const RECONNECT_IDLE_DELAY_MS = 5000;
let rpcSequence = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function boolFromUnknown(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "on", "enabled", "active", "1"].includes(text)) return true;
    if (["false", "off", "disabled", "inactive", "0"].includes(text)) return false;
  }
  return null;
}

function pickFirstString(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys) {
    const value = obj[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

const MAIN_OUTPUT_CYCLE_LABEL = "Cycle Main Output";

function outputDeviceName(device) {
  return String(
    device?.name
    || device?.displayName
    || device?.display_name
    || device?.output_device_name
    || outputDeviceId(device)
    || "Output Device",
  );
}

function outputDeviceId(deviceOrData) {
  return pickFirstString(deviceOrData, [
    "output_device_id",
    "outputDeviceId",
    "device_id",
    "deviceId",
    "id",
  ]);
}

function outputId(deviceOrData) {
  const direct = pickFirstString(deviceOrData, ["output_id", "outputId"]);
  if (direct) return direct;
  const firstOutputId = deviceOrData?.outputs?.[0]?.id;
  if (firstOutputId != null && String(firstOutputId).trim()) return String(firstOutputId).trim();
  return outputDeviceId(deviceOrData);
}

function normalizeOutputDevice(device) {
  const deviceId = outputDeviceId(device);
  if (!deviceId) return null;
  const nextOutputId = outputId(device) || deviceId;
  if (!nextOutputId) return null;
  return {
    output_device_id: deviceId,
    output_id: nextOutputId,
    output_device_name: outputDeviceName(device),
    device_type: String(device?.deviceType || device?.device_type || device?.type || ""),
  };
}

function validOutputDevices(outputDevices) {
  if (!Array.isArray(outputDevices)) return [];
  return outputDevices.map(normalizeOutputDevice).filter(Boolean);
}

function outputDeviceMatchesMainOutput(deviceOrData, mainOutput) {
  const deviceId = outputDeviceId(deviceOrData);
  const deviceOutputId = outputId(deviceOrData);
  const mainDeviceId = outputDeviceId(mainOutput);
  const mainOutputId = outputId(mainOutput);
  return Boolean(
    (deviceId && mainDeviceId && deviceId === mainDeviceId)
    || (deviceOutputId && mainOutputId && deviceOutputId === mainOutputId)
    || (deviceId && mainOutputId && deviceId === mainOutputId)
  );
}

function nextMainOutputDevice(outputDevicesState) {
  const devices = validOutputDevices(outputDevicesState?.outputDevices);
  if (devices.length < 2) return null;
  const currentIndex = devices.findIndex((device) => (
    outputDeviceMatchesMainOutput(device, outputDevicesState?.mainOutput)
  ));
  return devices[currentIndex >= 0 ? ((currentIndex + 1) % devices.length) : 0] || null;
}

function createMainOutputCycleOption(outputDevices, iconDataUrl = null) {
  if (validOutputDevices(outputDevices).length < 2) return null;
  return {
    label: MAIN_OUTPUT_CYCLE_LABEL,
    icon_data: iconDataUrl || null,
    buttonActions: [
      { label: MAIN_OUTPUT_CYCLE_LABEL, value: "SetMainOutputDevice", behavior: "momentary" },
    ],
    target: {
      Integration: {
        integration_id: "wavelink",
        kind: "main_output_cycle",
        data: {
          label: MAIN_OUTPUT_CYCLE_LABEL,
          action_label: MAIN_OUTPUT_CYCLE_LABEL,
          action_kind: "momentary",
        },
      },
    },
  };
}

export const wavelinkTestUtils = {
  outputDeviceName,
  outputDeviceId,
  outputId,
  normalizeOutputDevice,
  validOutputDevices,
  outputDeviceMatchesMainOutput,
  nextMainOutputDevice,
  createMainOutputCycleOption,
};

// Connection UI refs (mounted by the plugin).
const ui = {
  statusText: null,
  statusDot: null,
  connectBtn: null,
  appInfoText: null,
  autoConnectInput: null,
  invalidateBindingsUI: null,
};
let lastUiSig = "";
const lastStatus = { connected: false, connecting: false, detail: "Not connected" };

function setStatus(connected, detail = "", opts = null) {
  lastStatus.connected = Boolean(connected);
  lastStatus.connecting = (opts && typeof opts === "object") ? Boolean(opts.connecting) : false;
  lastStatus.detail = detail || "";
  const disconnectedByUser = (opts && typeof opts === "object") ? Boolean(opts.disconnectedByUser) : false;
  if (ui.statusText) {
    ui.statusText.textContent = connected ? (detail || "Connected") : (detail || "Not connected");
  }
  if (ui.statusDot) {
    ui.statusDot.classList.toggle("connected", Boolean(connected));
    ui.statusDot.classList.toggle("connecting", !connected && lastStatus.connecting);
    ui.statusDot.classList.toggle("error", !connected && !lastStatus.connecting && !disconnectedByUser);
  }

  if (ui.connectBtn) {
    if (lastStatus.connecting) {
      ui.connectBtn.disabled = true;
      ui.connectBtn.classList.add("disabled");
      ui.connectBtn.classList.remove("danger");
      ui.connectBtn.textContent = "Connecting...";
      return;
    }

    ui.connectBtn.disabled = false;
    ui.connectBtn.classList.remove("disabled");
    ui.connectBtn.classList.toggle("danger", Boolean(connected));
    ui.connectBtn.textContent = connected ? "Disconnect" : "Connect";
  }
  const sig = `${Boolean(connected)}:${Boolean(lastStatus.connecting)}:${Boolean(disconnectedByUser)}`;
  if (sig !== lastUiSig) {
    lastUiSig = sig;
    try { ui.invalidateBindingsUI?.(); } catch { }
  }
}

function normalizeEndpoint(target) {
  const t = target?.Integration || target?.integration;
  if (!t || t.integration_id !== "wavelink") {
    return null;
  }
  const data = t.data || {};
  const identifier = String(
    data.identifier
    ?? data.channel_id
    ?? data.channelId
    ?? data.id
    ?? "",
  );
  const mixerId = String(
    data.mixer_id
    ?? data.mix_id
    ?? data.mixId
    ?? "",
  );

  // New shapes
  if (t.kind === "mix") {
    return { identifier: "", mixer_id: mixerId };
  }
  if (t.kind === "channel") {
    return { identifier, mixer_id: "" };
  }
  if (t.kind === "channel_mix") {
    return { identifier, mixer_id: mixerId };
  }

  // Back-compat
  if (t.kind === "endpoint") {
    return {
      identifier,
      mixer_id: mixerId,
    };
  }

  return null;
}

export async function activate(ctx) {
  let iconDataUrl = null;
  try {
    iconDataUrl = await ctx.assets?.readDataUrl?.("WaveLinkLogo.png", "image/png");
  } catch {
    iconDataUrl = null;
  }

  // Allow status changes to refresh the bindings list even if the Connections
  // tab UI was never opened.
  ui.invalidateBindingsUI = ctx.app?.invalidateBindingsUI;
  let wsId = null;
  let connectedPort = null;
  let connecting = false;
  let wasConnected = false;
  let offlineFeedbackSent = false;
  let disposed = false;

  const DEFAULT_AUTO_CONNECT = true;
  let autoConnect = DEFAULT_AUTO_CONNECT;
  let manualConnectRequested = false;
  let disconnectedByUser = false;
  let reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;

  function resetReconnectBackoff() {
    reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
  }

  function growReconnectBackoff() {
    reconnectDelayMs = Math.min(RECONNECT_MAX_DELAY_MS, reconnectDelayMs * 2);
  }

  function applyProfileSettings(settings) {
    const next = (settings && typeof settings === "object" && ("auto_connect" in settings))
      ? Boolean(settings.auto_connect)
      : DEFAULT_AUTO_CONNECT;
    autoConnect = next;
    if (!next) {
      manualConnectRequested = false;
      disconnectedByUser = true;
    }
    if (ui.autoConnectInput) {
      ui.autoConnectInput.checked = next;
    }
    if (next && !wsId && !connecting) {
      manualConnectRequested = true;
      disconnectedByUser = false;
      resetReconnectBackoff();
    }
  }

  try {
    applyProfileSettings(ctx.profile?.get?.());
    ctx.profile?.onChanged?.((ev) => {
      if (disposed) return;
      applyProfileSettings(ev?.settings || ev);
    });
  } catch {
    // ignore
  }
  let applicationInfo = null;
  let mixes = [];
  let channels = [];
  let outputDevicesState = { mainOutput: null, outputDevices: [] };

  let bindings = [];

  const pendingVolumeWrites = new Map();
  const lastSentVolumeByEndpoint = new Map();
  let volumeFlushTimer = null;
  let volumeFlushInFlight = false;
  let channelsRefreshTimer = null;
  let mixesRefreshTimer = null;
  let postLocalWriteRefreshTimer = null;
  let lastLocalVolumeWriteAt = 0;
  const primaryFeedbackIntentByBinding = new Map(); // binding_id -> { value, at, source, endpoint_key }
  const localVolumeIntentByEndpoint = new Map(); // endpoint_key -> { value, at, source, endpoint_key }
  const pendingAppInfoByWsId = new Map();
  const pendingRpcById = new Map();

  function clearRuntimeTimers() {
    if (volumeFlushTimer) {
      clearTimeout(volumeFlushTimer);
      volumeFlushTimer = null;
    }
    if (channelsRefreshTimer) {
      clearTimeout(channelsRefreshTimer);
      channelsRefreshTimer = null;
    }
    if (mixesRefreshTimer) {
      clearTimeout(mixesRefreshTimer);
      mixesRefreshTimer = null;
    }
    if (postLocalWriteRefreshTimer) {
      clearTimeout(postLocalWriteRefreshTimer);
      postLocalWriteRefreshTimer = null;
    }
  }

  function disposeWaveLinkRuntime() {
    disposed = true;
    connecting = false;
    manualConnectRequested = false;
    clearRuntimeTimers();
    clearAllPendingAppInfo();
    clearAllPendingRpc();
    const currentWsId = wsId;
    wsId = null;
    connectedPort = null;
    if (currentWsId) {
      ctx.ws.close(currentWsId).catch(() => {});
    }
    pendingVolumeWrites.clear();
    lastSentVolumeByEndpoint.clear();
    primaryFeedbackIntentByBinding.clear();
    localVolumeIntentByEndpoint.clear();
    mixes = [];
    channels = [];
    outputDevicesState = { mainOutput: null, outputDevices: [] };
    pendingAppInfoByWsId.clear();
    pendingRpcById.clear();
  }

  ctx.lifecycle?.onDispose?.(disposeWaveLinkRuntime);

  function endpointKey(endpoint) {
    if (!endpoint) return "";
    return `${String(endpoint.identifier || "")}::${String(endpoint.mixer_id || "")}`;
  }

  function rememberLocalVolumeIntent(endpoint, level, source) {
    const key = endpointKey(endpoint);
    if (!key) return;
    localVolumeIntentByEndpoint.set(key, {
      value: level,
      at: Date.now(),
      source: source || "local",
      endpoint_key: key,
    });
  }

  function getFreshLocalVolumeIntent(endpoint) {
    const key = endpointKey(endpoint);
    if (!key) return null;
    const intent = localVolumeIntentByEndpoint.get(key);
    if (!intent) return null;
    if (Date.now() - intent.at >= FEEDBACK_INTENT_HOLD_MS) {
      localVolumeIntentByEndpoint.delete(key);
      return null;
    }
    return intent;
  }

  function shouldIgnoreStaleLocalVolume(endpoint, confirmedValue) {
    const intent = getFreshLocalVolumeIntent(endpoint);
    if (!intent) return false;
    const delta = Math.abs(Number(confirmedValue) - Number(intent.value));
    if (delta <= FEEDBACK_INTENT_MATCH_EPSILON) {
      localVolumeIntentByEndpoint.delete(endpointKey(endpoint));
      return false;
    }
    return true;
  }

  function schedulePostLocalWriteRefresh() {
    if (postLocalWriteRefreshTimer) return;
    postLocalWriteRefreshTimer = setTimeout(() => {
      postLocalWriteRefreshTimer = null;
      if (!wsId) return;
      requestFullState().catch(() => {});
    }, LOCAL_WRITE_QUIET_MS + STATE_REFRESH_DEBOUNCE_MS);
  }

  function scheduleVolumeFlush() {
    if (volumeFlushTimer) return;
    volumeFlushTimer = setTimeout(() => {
      volumeFlushTimer = null;
      flushVolumeWrites().catch(() => {});
    }, VOLUME_WRITE_INTERVAL_MS);
  }

  async function flushVolumeWrites() {
    if (volumeFlushInFlight) return;
    if (!wsId) {
      pendingVolumeWrites.clear();
      return;
    }
    volumeFlushInFlight = true;
    try {
      // Drain current queue.
      const writes = Array.from(pendingVolumeWrites.values());
      pendingVolumeWrites.clear();
      for (const w of writes) {
        if (!wsId) break;
        const { endpoint, level } = w;
        if (!endpoint) continue;
        if (!endpoint.identifier) {
          await sendJsonRpc("setMix", { id: endpoint.mixer_id, level }, 201);
        } else if (!endpoint.mixer_id) {
          await sendJsonRpc("setChannel", { id: endpoint.identifier, level }, 101);
        } else {
          await sendJsonRpc(
            "setChannel",
            { id: endpoint.identifier, mixes: [{ id: endpoint.mixer_id, level }] },
            101,
          );
        }
        lastLocalVolumeWriteAt = Date.now();
        lastSentVolumeByEndpoint.set(endpointKey(endpoint), level);
        schedulePostLocalWriteRefresh();
      }
    } catch {
      // If send failed, force reconnect.
      wsId = null;
      connectedPort = null;
      mixes = [];
      channels = [];
      outputDevicesState = { mainOutput: null, outputDevices: [] };
      localVolumeIntentByEndpoint.clear();
      offlineFeedbackSent = false;
      syncOfflineFeedback().catch(() => {});
      wasConnected = false;
      setStatus(false, "Disconnected");
    } finally {
      volumeFlushInFlight = false;
      if (pendingVolumeWrites.size > 0) {
        scheduleVolumeFlush();
      }
    }
  }

  function queueVolumeWrite(endpoint, level) {
    if (!endpoint) return;
    const key = endpointKey(endpoint);
    const prev = pendingVolumeWrites.get(key);
    if (prev && Math.abs(prev.level - level) < VOLUME_WRITE_EPSILON) {
      return;
    }
    const lastSent = lastSentVolumeByEndpoint.get(key);
    if (typeof lastSent === "number" && Math.abs(lastSent - level) < VOLUME_WRITE_EPSILON) {
      return;
    }
    pendingVolumeWrites.set(key, { endpoint, level });
    scheduleVolumeFlush();
  }

  function shouldIgnoreStaleFeedbackIntent(intent, endpoint, confirmedValue) {
    if (!intent) return false;
    const age = Date.now() - intent.at;
    const delta = Math.abs(Number(confirmedValue) - Number(intent.value));
    if (delta <= FEEDBACK_INTENT_MATCH_EPSILON) return false;

    const key = endpointKey(endpoint);
    const sameEndpoint = !intent.endpoint_key || intent.endpoint_key === key;
    return sameEndpoint && age < FEEDBACK_INTENT_HOLD_MS;
  }

  function scheduleChannelsRefresh() {
    if (channelsRefreshTimer) return;
    channelsRefreshTimer = setTimeout(() => {
      channelsRefreshTimer = null;
      if (!wsId) return;
      sendJsonRpc("getChannels", {}, 3).catch(() => {});
    }, STATE_REFRESH_DEBOUNCE_MS);
  }

  function scheduleMixesRefresh() {
    if (mixesRefreshTimer) return;
    mixesRefreshTimer = setTimeout(() => {
      mixesRefreshTimer = null;
      if (!wsId) return;
      sendJsonRpc("getMixes", {}, 2).catch(() => {});
    }, STATE_REFRESH_DEBOUNCE_MS);
  }

  function scheduleOutputDevicesRefresh() {
    if (!wsId) return;
    sendJsonRpc("getOutputDevices", {}, 4).catch(() => {});
  }

  function readBindings() {
    try {
      const all = ctx.bindings?.getAll?.();
      return Array.isArray(all) ? all : [];
    } catch {
      return [];
    }
  }

  function setBindings(next) {
    bindings = Array.isArray(next) ? next : [];
  }

  function formatApplicationInfo() {
    if (!applicationInfo || typeof applicationInfo !== "object") {
      return "Wave Link app info unavailable.";
    }
    const name = String(applicationInfo.name || "Wave Link");
    const version = String(applicationInfo.version || "").trim();
    const build = applicationInfo.build != null ? String(applicationInfo.build) : "";
    const os = String(applicationInfo.operatingSystem || "").trim();
    const revision = applicationInfo.interfaceRevision != null ? String(applicationInfo.interfaceRevision) : "";
    const parts = [];
    if (version) parts.push(`v${version}`);
    if (build) parts.push(`build ${build}`);
    if (revision) parts.push(`API ${revision}`);
    if (os) parts.push(os);
    return `${name}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  }

  function updateAppInfoUi() {
    if (ui.appInfoText) {
      ui.appInfoText.textContent = formatApplicationInfo();
    }
  }

  function integrationFromBindingTarget(target) {
    if (!target || typeof target !== "object") return null;
    const t = target.Integration || target.integration;
    if (t && typeof t === "object" && t.integration_id) return t;
    return null;
  }

  async function syncOfflineFeedback() {
    // If Wave Link is disconnected, drive bound controls to 0.
    // This keeps motor faders from staying at a stale value.
    if (offlineFeedbackSent) return;

    const current = bindings;
    if (!Array.isArray(current) || current.length === 0) {
      offlineFeedbackSent = true;
      return;
    }

    for (const b of current) {
      const t = integrationFromBindingTarget(b?.target);
      if (!t || t.integration_id !== "wavelink") continue;
      const action = b?.action || "Volume";
      try {
        if (action === "Volume") {
          await ctx.feedback.set(b.id, 0.0, "Volume", { silent: true });
        } else if (action === "ToggleMute" || action === "ToggleEffect" || action === "SetMainOutputDevice") {
          await ctx.feedback.set(b.id, 0.0, action, { silent: true });
        }
      } catch {
        // ignore
      }
    }

    offlineFeedbackSent = true;
  }

  function getLevelFromMix(mix) {
    if (!mix || typeof mix !== "object") return null;
    const v = mix.level ?? mix.volume ?? mix.value;
    const n = Number(v);
    return Number.isFinite(n) ? clamp01(n) : null;
  }

  function getMutedFromMix(mix) {
    if (!mix || typeof mix !== "object") return null;
    if (typeof mix.isMuted === "boolean") return mix.isMuted;
    if (typeof mix.muted === "boolean") return mix.muted;
    return null;
  }

  function getLevelFromChannel(ch) {
    if (!ch || typeof ch !== "object") return null;
    const v = ch.level ?? ch.volume ?? ch.value;
    const n = Number(v);
    return Number.isFinite(n) ? clamp01(n) : null;
  }

  function getMutedFromChannel(ch) {
    if (!ch || typeof ch !== "object") return null;
    if (typeof ch.isMuted === "boolean") return ch.isMuted;
    if (typeof ch.muted === "boolean") return ch.muted;
    return null;
  }

  function getMixEntry(ch, mixerId) {
    const list = ch?.mixes;
    if (!Array.isArray(list)) return null;
    return list.find((m) => m && String(m.id) === String(mixerId)) || null;
  }

  function getLevelFromMixEntry(entry) {
    const v = entry?.level ?? entry?.volume ?? entry?.value;
    const n = Number(v);
    return Number.isFinite(n) ? clamp01(n) : null;
  }

  function getMutedFromMixEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.isMuted === "boolean") return entry.isMuted;
    if (typeof entry.muted === "boolean") return entry.muted;
    return null;
  }

  function normalizeEffectState(raw) {
    if (!raw || typeof raw !== "object") return null;
    const directKeys = ["isEnabled", "enabled", "isActive", "active", "on"];
    for (const key of directKeys) {
      const value = boolFromUnknown(raw[key]);
      if (value != null) return { enabled: value, key, inverted: false };
    }
    const invertedKeys = ["isBypassed", "bypassed", "disabled", "isDisabled"];
    for (const key of invertedKeys) {
      const value = boolFromUnknown(raw[key]);
      if (value != null) return { enabled: !value, key, inverted: true };
    }
    return null;
  }

  function channelEffectCollections(ch) {
    if (!ch || typeof ch !== "object") return [];
    const fields = [
      "effects",
      "audioEffects",
      "audio_effects",
      "channelEffects",
      "channel_effects",
      "plugins",
      "filters",
      "vstEffects",
      "vst_effects",
    ];
    return fields
      .filter((field) => Array.isArray(ch[field]))
      .map((field) => ({ field, items: ch[field] }));
  }

  function getChannelEffects(ch) {
    const out = [];
    for (const collection of channelEffectCollections(ch)) {
      for (const raw of collection.items) {
        if (!raw || typeof raw !== "object") continue;
        const state = normalizeEffectState(raw);
        if (!state) continue;
        const id = pickFirstString(raw, [
          "id",
          "identifier",
          "effect_id",
          "effectId",
          "plugin_id",
          "pluginId",
          "uuid",
          "name",
        ]);
        if (!id) continue;
        out.push({
          id,
          name: pickFirstString(raw, ["name", "displayName", "display_name", "title"]) || id,
          enabled: state.enabled,
          enabled_key: state.key,
          enabled_inverted: state.inverted,
          collection_field: collection.field,
        });
      }
    }
    return out;
  }

  function findChannelById(channelId) {
    return Array.isArray(channels)
      ? channels.find((c) => c && String(c.id) === String(channelId)) || null
      : null;
  }

  function findEffectState(data) {
    const ch = findChannelById(data.identifier || data.channel_id);
    if (!ch) return null;
    if (data.effect_id) {
      return getChannelEffects(ch).find((effect) => String(effect.id) === String(data.effect_id)) || null;
    }
    return null;
  }

  function targetIsMainOutputDevice(data) {
    return outputDeviceMatchesMainOutput(data, outputDevicesState?.mainOutput);
  }

  async function setChannelEffectEnabled(data, enabled) {
    const channelId = String(data.identifier || data.channel_id || "");
    const effectId = String(data.effect_id || "");
    if (!channelId || !effectId) return false;
    const collectionField = String(data.collection_field || "effects");
    const enabledKey = String(data.enabled_key || "isEnabled");
    const inverted = Boolean(data.enabled_inverted);
    const entry = {
      id: effectId,
      [enabledKey]: inverted ? !enabled : enabled,
    };
    await sendJsonRpc(
      "setChannel",
      { id: channelId, [collectionField]: [entry] },
      401,
    );
    scheduleChannelsRefresh();
    return true;
  }

  async function setMainOutputDevice(data) {
    const deviceId = outputDeviceId(data);
    const nextOutputId = outputId(data) || deviceId;
    if (!deviceId || !nextOutputId) return false;
    const response = await requestJsonRpc("setOutputDevice", {
      mainOutput: {
        outputDeviceId: deviceId,
        outputId: nextOutputId,
      },
    });
    if (response?.ok) {
      outputDevicesState = {
        ...outputDevicesState,
        mainOutput: { outputDeviceId: deviceId, outputId: nextOutputId },
      };
      scheduleOutputDevicesRefresh();
      return true;
    }
    const message = response?.error?.message || (response?.timeout ? "timed out" : "unknown error");
    throw new Error(`Wave Link rejected main output change: ${String(message)}`);
  }

  async function cycleMainOutputDevice() {
    const nextDevice = nextMainOutputDevice(outputDevicesState);
    if (!nextDevice) return false;
    return setMainOutputDevice(nextDevice);
  }

  async function syncAllFeedback() {
    const current = bindings;
    if (!Array.isArray(current) || current.length === 0) return;

    for (const b of current) {
      const t = integrationFromBindingTarget(b?.target);
      if (!t || t.integration_id !== "wavelink") continue;
      const action = b?.action || "Volume";
      const data = t.data || {};

      try {
        if (action === "Volume") {
          let value = null;
          if (t.kind === "mix") {
            const mix = mixes.find((m) => m && String(m.id) === String(data.mixer_id));
            value = getLevelFromMix(mix);
          } else if (t.kind === "channel") {
            const ch = channels.find((c) => c && String(c.id) === String(data.identifier));
            value = getLevelFromChannel(ch);
          } else if (t.kind === "channel_mix") {
            const ch = channels.find((c) => c && String(c.id) === String(data.identifier));
            const entry = getMixEntry(ch, data.mixer_id);
            value = getLevelFromMixEntry(entry);
          } else if (t.kind === "endpoint") {
            // Legacy
            const identifier = data.identifier || "";
            const mixerId = data.mixer_id || "";
            if (!identifier) {
              const mix = mixes.find((m) => m && String(m.id) === String(mixerId));
              value = getLevelFromMix(mix);
            } else if (!mixerId) {
              const ch = channels.find((c) => c && String(c.id) === String(identifier));
              value = getLevelFromChannel(ch);
            } else {
              const ch = channels.find((c) => c && String(c.id) === String(identifier));
              const entry = getMixEntry(ch, mixerId);
              value = getLevelFromMixEntry(entry);
            }
          }
          if (value != null) {
            const intent = primaryFeedbackIntentByBinding.get(b.id);
            const endpoint = normalizeEndpoint({ Integration: t });
            if (
              shouldIgnoreStaleLocalVolume(endpoint, value)
              || shouldIgnoreStaleFeedbackIntent(intent, endpoint, value)
            ) {
              // Ignore stale echo while local intent settles.
              continue;
            }
            if (intent) {
              primaryFeedbackIntentByBinding.delete(b.id);
            }
            await ctx.feedback.set(b.id, value, "Volume", { silent: true });
          }
        } else if (action === "ToggleMute") {
          let muted = null;
          if (t.kind === "mix") {
            const mix = mixes.find((m) => m && String(m.id) === String(data.mixer_id));
            muted = getMutedFromMix(mix);
          } else if (t.kind === "channel") {
            const ch = channels.find((c) => c && String(c.id) === String(data.identifier));
            muted = getMutedFromChannel(ch);
          } else if (t.kind === "channel_mix") {
            const ch = channels.find((c) => c && String(c.id) === String(data.identifier));
            const entry = getMixEntry(ch, data.mixer_id);
            muted = getMutedFromMixEntry(entry);
          } else if (t.kind === "endpoint") {
            const identifier = data.identifier || "";
            const mixerId = data.mixer_id || "";
            if (!identifier) {
              const mix = mixes.find((m) => m && String(m.id) === String(mixerId));
              muted = getMutedFromMix(mix);
            } else if (!mixerId) {
              const ch = channels.find((c) => c && String(c.id) === String(identifier));
              muted = getMutedFromChannel(ch);
            } else {
              const ch = channels.find((c) => c && String(c.id) === String(identifier));
              const entry = getMixEntry(ch, mixerId);
              muted = getMutedFromMixEntry(entry);
            }
          }
          if (typeof muted === "boolean") {
            await ctx.feedback.set(b.id, muted ? 1.0 : 0.0, "ToggleMute", { silent: true });
          }
        } else if (action === "ToggleEffect") {
          const state = findEffectState(data);
          if (state && typeof state.enabled === "boolean") {
            await ctx.feedback.set(b.id, state.enabled ? 1.0 : 0.0, action, { silent: true });
          }
        } else if (action === "SetMainOutputDevice" && t.kind === "main_output_device") {
          await ctx.feedback.set(b.id, targetIsMainOutputDevice(data) ? 1.0 : 0.0, action, { silent: true });
        } else if (action === "SetMainOutputDevice" && t.kind === "main_output_cycle") {
          await ctx.feedback.set(b.id, 0.0, action, { silent: true });
        }
      } catch {
        // ignore
      }
    }
  }

  function describeFromCache(endpoint) {
    if (!endpoint) return null;
    const { identifier, mixer_id } = endpoint;

    // Mix master
    if (!identifier && mixer_id) {
      const mix = Array.isArray(mixes) ? mixes.find((m) => m && String(m.id) === String(mixer_id)) : null;
      const label = mix?.name ? String(mix.name) : `Wave Link Mix ${mixer_id}`;
      return { label, icon_data: iconDataUrl || null };
    }

    // Channel global / channel-in-mix
    if (identifier) {
      const ch = Array.isArray(channels) ? channels.find((c) => c && String(c.id) === String(identifier)) : null;
      let label = ch?.name ? String(ch.name) : `Wave Link Channel ${identifier}`;
      if (mixer_id) {
        const mix = Array.isArray(mixes) ? mixes.find((m) => m && String(m.id) === String(mixer_id)) : null;
        const mixName = mix?.name ? String(mix.name) : String(mixer_id);
        label = `${label} (${mixName})`;
      }
      return { label, icon_data: iconDataUrl || null };
    }

    return { label: "Wave Link", icon_data: iconDataUrl || null };
  }

  async function sendJsonRpc(method, params, id) {
    if (!wsId || disposed) {
      throw new Error("Wave Link not connected");
    }
    // Keep state query ids stable (1/2/3/4), but use unique ids for rapid write
    // traffic so Wave Link bridge responses cannot collide under high frequency.
    let requestId = id;
    if (id !== 1 && id !== 2 && id !== 3 && id !== 4) {
      rpcSequence += 1;
      if (rpcSequence > 2_000_000_000) rpcSequence = 10;
      requestId = rpcSequence;
    }
    const req = { jsonrpc: "2.0", method, id: requestId };
    if (params && typeof params === "object" && Object.keys(params).length > 0) {
      req.params = params;
    }
    const payload = JSON.stringify(req);
    await ctx.ws.send(wsId, payload);
    return requestId;
  }

  function clearPendingRpc(id) {
    const pending = pendingRpcById.get(id);
    if (!pending) return;
    try { clearTimeout(pending.timer); } catch { }
    pendingRpcById.delete(id);
  }

  function clearAllPendingRpc() {
    for (const [id, pending] of pendingRpcById.entries()) {
      try { clearTimeout(pending.timer); } catch { }
      try { pending.resolve?.({ ok: false, disposed: true }); } catch {}
      pendingRpcById.delete(id);
    }
  }

  async function requestJsonRpc(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    if (!wsId || disposed) throw new Error("Wave Link not connected");
    rpcSequence += 1;
    if (rpcSequence > 2_000_000_000) rpcSequence = 10;
    const requestId = rpcSequence;
    const wait = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRpcById.delete(requestId);
        resolve({ ok: false, timeout: true });
      }, timeoutMs);
      pendingRpcById.set(requestId, { resolve, timer });
    });
    const req = { jsonrpc: "2.0", method, id: requestId };
    if (params && typeof params === "object" && Object.keys(params).length > 0) {
      req.params = params;
    }
    try {
      await ctx.ws.send(wsId, JSON.stringify(req));
    } catch (err) {
      clearPendingRpc(requestId);
      throw err;
    }
    return wait;
  }

  async function requestFullState() {
    if (disposed || !wsId) return;
    try {
      await ctx.ws.send(wsId, JSON.stringify({ jsonrpc: "2.0", method: "getMixes", id: 2 }));
      await ctx.ws.send(wsId, JSON.stringify({ jsonrpc: "2.0", method: "getChannels", id: 3 }));
      await ctx.ws.send(wsId, JSON.stringify({ jsonrpc: "2.0", method: "getOutputDevices", id: 4 }));
    } catch (e) {
      // ignore
    }
  }

  function clearPendingAppInfo(wsKey) {
    const pending = pendingAppInfoByWsId.get(wsKey);
    if (!pending) return;
    try { clearTimeout(pending.timer); } catch { }
    pendingAppInfoByWsId.delete(wsKey);
  }

  function clearAllPendingAppInfo() {
    for (const [wsKey, pending] of pendingAppInfoByWsId.entries()) {
      try { clearTimeout(pending.timer); } catch { }
      try { pending.resolve?.(null); } catch {}
      pendingAppInfoByWsId.delete(wsKey);
    }
  }

  function waitForApplicationInfo(wsKey, timeoutMs = APP_INFO_TIMEOUT_MS) {
    clearPendingAppInfo(wsKey);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingAppInfoByWsId.delete(wsKey);
        resolve(null);
      }, timeoutMs);
      pendingAppInfoByWsId.set(wsKey, { resolve, timer });
    });
  }

  async function verifyApplicationInfo(wsKey) {
    try {
      const wait = waitForApplicationInfo(wsKey, APP_INFO_TIMEOUT_MS);
      await ctx.ws.send(wsKey, JSON.stringify({ jsonrpc: "2.0", method: "getApplicationInfo", id: 1 }));
      const result = await wait;
      return result && typeof result === "object";
    } catch {
      clearPendingAppInfo(wsKey);
      return false;
    }
  }

  function handleWsText(text, sourceWsId = null) {
    if (disposed) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    if (!json || typeof json !== "object") return;

    const id = json.id;
    if (id != null && pendingRpcById.has(id)) {
      const pending = pendingRpcById.get(id);
      try { clearTimeout(pending.timer); } catch { }
      pendingRpcById.delete(id);
      pending.resolve({
        ok: !json.error,
        result: json.result ?? null,
        error: json.error ?? null,
      });
      return;
    }
    if (id === 1) {
      const key = sourceWsId || wsId;
      if (key) {
        const pending = pendingAppInfoByWsId.get(key);
        if (pending && typeof pending.resolve === "function") {
          try { clearTimeout(pending.timer); } catch { }
          pendingAppInfoByWsId.delete(key);
          applicationInfo = json.result || null;
          updateAppInfoUi();
          pending.resolve(applicationInfo);
        }
      }
      return;
    }
    if (id === 2) {
      const result = json.result;
      const payload = result?.mixes ?? result;
      if (Array.isArray(payload)) {
        mixes = payload;
        syncAllFeedback().catch(() => {});
      }
      return;
    }
    if (id === 3) {
      const result = json.result;
      const payload = result?.channels ?? result;
      if (Array.isArray(payload)) {
        channels = payload;
        syncAllFeedback().catch(() => {});
      }
      return;
    }
    if (id === 4) {
      const result = json.result;
      if (result && typeof result === "object") {
        outputDevicesState = {
          mainOutput: result.mainOutput || null,
          outputDevices: Array.isArray(result.outputDevices) ? result.outputDevices : [],
        };
        syncAllFeedback().catch(() => {});
      }
      return;
    }

    // Notifications (no id)
    if (json.method) {
      if (json.method === "channelsChanged" || json.method === "channelChanged") {
        if (Date.now() - lastLocalVolumeWriteAt >= LOCAL_WRITE_QUIET_MS) {
          scheduleChannelsRefresh();
        }
      }
      if (json.method === "mixesChanged" || json.method === "mixChanged") {
        if (Date.now() - lastLocalVolumeWriteAt >= LOCAL_WRITE_QUIET_MS) {
          scheduleMixesRefresh();
        }
      }
      if (
        json.method === "outputDevicesChanged"
        || json.method === "outputDeviceChanged"
        || json.method === "mainOutputChanged"
        || json.method === "outputsChanged"
      ) {
        scheduleOutputDevicesRefresh();
      }
    }
  }

  async function openWsCandidate(port) {
    if (disposed) return null;
    const url = `ws://${HOST}:${port}`;
    try {
      const id = await ctx.ws.open(url, { Origin: ORIGIN }, CONNECT_TIMEOUT_MS);
      if (disposed) {
        try { await ctx.ws.close(id); } catch {}
        return null;
      }
      return { id, port };
    } catch {
      // ignore
    }
    return null;
  }

  async function getPortCandidates() {
    const out = [];
    try {
      const port = await ctx.tauri?.invoke?.("get_wavelink_ws_port");
      const n = Number(port);
      if (Number.isFinite(n) && n > 0 && n <= 65535) {
        out.push(Math.trunc(n));
      }
    } catch {
      // ignore
    }
    return out;
  }

  async function connectOnce() {
    if (disposed) return false;
    connecting = true;
    setStatus(false, "Scanning...", { connecting: true, disconnectedByUser });

    let connected = null;
    const ports = await getPortCandidates();
    if (disposed) {
      connecting = false;
      return false;
    }

    if (ports.length === 0) {
      connecting = false;
      setStatus(false, "Not connected", { disconnectedByUser });
      return false;
    }

    for (const port of ports) {
      const candidate = await openWsCandidate(port);
      if (disposed) {
        if (candidate?.id) {
          try { await ctx.ws.close(candidate.id); } catch {}
        }
        connecting = false;
        return false;
      }
      if (!candidate) continue;

      const candidateId = candidate.id;
      ctx.ws.onMessage(candidateId, (msg) => {
        if (msg.type === "text") {
          handleWsText(msg.data, candidateId);
        }
      });

      const verified = await verifyApplicationInfo(candidateId);
      if (!verified) {
        clearPendingAppInfo(candidateId);
        try { await ctx.ws.close(candidateId); } catch { }
        continue;
      }

      connected = candidate;
      break;
    }

    if (!connected) {
      connecting = false;
      setStatus(false, "Not connected", { disconnectedByUser });
      return false;
    }

    wsId = connected.id;
    connectedPort = connected.port;
    connecting = false;
    manualConnectRequested = false;
    disconnectedByUser = false;
    wasConnected = true;
    offlineFeedbackSent = false;
    setStatus(true, `Connected (:${connectedPort})`);

    await requestFullState();
    return true;
  }

  // Track close events
  ctx.tauri.listen("ws_closed", (event) => {
    if (disposed) return;
    let payload = event?.payload;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch { payload = null; }
    }
    const closedId = payload?.id;
    if (wsId && closedId === wsId) {
      clearPendingAppInfo(closedId);
      wsId = null;
      connectedPort = null;
      connecting = false;
      pendingVolumeWrites.clear();
      mixes = [];
      channels = [];
      outputDevicesState = { mainOutput: null, outputDevices: [] };
      localVolumeIntentByEndpoint.clear();
      offlineFeedbackSent = false;
      syncOfflineFeedback().catch(() => {});
      wasConnected = false;
      setStatus(false, "Disconnected");
    }
  });

  // Connections panel tab
  ctx.connections?.registerTab?.({
    id: "wavelink",
    name: "Wave Link",
    icon_data: iconDataUrl || null,
    order: 20,
    mount: (container) => {
      container.innerHTML = `
        <div class="connection-item-header">
          <div class="connection-info">
            <img src="${iconDataUrl || ""}" alt="Wave Link" class="connection-icon" />
            <span class="connection-name">Wave Link</span>
          </div>
          <div class="connection-status">
            <span class="connection-status-dot" data-role="dot"></span>
            <span data-role="text">Not connected</span>
          </div>
        </div>
        <div class="connection-content-wrapper">
          <div class="connection-description">
            <p>Control Elgato Wave Link inputs, outputs, and monitor mix directly from your MIDI device.</p>
            <p>Ensure Wave Link is running. Use auto connect to reconnect on startup.</p>
            <p data-role="app-info">Wave Link app info unavailable.</p>
          </div>
        </div>
        <div class="connection-footer">
          <button type="button" class="connection-button" data-role="connect">Connect</button>
          <div class="connection-row checkbox-row">
            <input type="checkbox" data-role="auto" id="wavelink-auto-connect" />
            <label for="wavelink-auto-connect">Auto connect</label>
          </div>
        </div>
      `;
      ui.statusText = container.querySelector('[data-role="text"]');
      ui.statusDot = container.querySelector('[data-role="dot"]');
      ui.connectBtn = container.querySelector('[data-role="connect"]');
      ui.appInfoText = container.querySelector('[data-role="app-info"]');
      ui.autoConnectInput = container.querySelector('[data-role="auto"]');
      ui.invalidateBindingsUI = ctx.app?.invalidateBindingsUI;
      updateAppInfoUi();

      applyProfileSettings(ctx.profile?.get?.());
      if (ui.autoConnectInput) {
        ui.autoConnectInput.addEventListener("change", () => {
          const next = Boolean(ui.autoConnectInput.checked);
          applyProfileSettings({ auto_connect: next });
          try {
            const current = ctx.profile?.get?.() || {};
            ctx.profile?.set?.({ ...current, auto_connect: next });
          } catch { }
        });
      }

      if (ui.connectBtn) {
        ui.connectBtn.addEventListener("click", () => {
          if (connecting) return;
          if (wsId) {
            disconnectedByUser = true;
            manualConnectRequested = false;
            try { ctx.ws?.close?.(wsId); } catch { }
            clearPendingAppInfo(wsId);
            wsId = null;
            connectedPort = null;
            connecting = false;
            pendingVolumeWrites.clear();
            mixes = [];
            channels = [];
            outputDevicesState = { mainOutput: null, outputDevices: [] };
            localVolumeIntentByEndpoint.clear();
            offlineFeedbackSent = false;
            syncOfflineFeedback().catch(() => {});
            wasConnected = false;
            setStatus(false, "Disconnected", { disconnectedByUser: true });
            return;
          }

          disconnectedByUser = false;
          manualConnectRequested = true;
          connectOnce().catch(() => {
            if (disposed) return;
            connecting = false;
            setStatus(false, "Not connected", { disconnectedByUser });
          });
        });
      }

      setStatus(lastStatus.connected, lastStatus.detail, { connecting: lastStatus.connecting || connecting, disconnectedByUser });
    },
    unmount: () => {
      ui.statusText = null;
      ui.statusDot = null;
      ui.connectBtn = null;
      ui.appInfoText = null;
      ui.autoConnectInput = null;
    },
  });

  // Background reconnect loop
  (async () => {
    while (!disposed) {
      let delay = RECONNECT_IDLE_DELAY_MS;
      if (!wsId && !connecting && !disconnectedByUser && (autoConnect || manualConnectRequested)) {
        try {
          const connectedNow = await connectOnce();
          if (connectedNow || wsId) {
            resetReconnectBackoff();
          } else {
            growReconnectBackoff();
          }
        } catch {
          if (disposed) return;
          connecting = false;
          // ignore
          growReconnectBackoff();
        }
        delay = reconnectDelayMs;
      } else {
        resetReconnectBackoff();
      }
      await sleep(delay);
    }
  })();

  ctx.registerIntegration({
    id: "wavelink",
    name: "Wave Link",
    icon_data: iconDataUrl || null,
    buttonActions: [
      { label: "Toggle Mute", value: "ToggleMute" },
    ],
    describeTarget: (target) => {
      const t = target?.Integration || target?.integration;
      const data = t?.data || {};
      if (t?.integration_id !== "wavelink") {
        return { label: "Wave Link", icon_data: iconDataUrl || null };
      }

      const icon_data = (typeof data.icon_data === "string" && data.icon_data.trim())
        ? data.icon_data
        : (iconDataUrl || null);

      let label = (typeof data.label === "string" && data.label.trim()) ? data.label : "";

      // If we previously stored a status suffix in label, strip it.
      if (label.endsWith(" (Unavailable)")) label = label.slice(0, -" (Unavailable)".length);
      if (label.endsWith(" (Connecting...)")) label = label.slice(0, -" (Connecting...)".length);
      if (label.endsWith(" (Disconnected)")) label = label.slice(0, -" (Disconnected)".length);

      if (t.kind === "channel_mix") {
        const channelName = String(data.channel_name || data.name || data.identifier || "").trim();
        const mixName = String(data.mix_name || data.mixer_name || data.mixer_id || "").trim();
        if (channelName && mixName && (!label || !label.includes("("))) {
          label = `${channelName} (${mixName})`;
        }
      } else if (t.kind === "channel_effect") {
        const channelName = String(data.channel_name || data.identifier || "").trim();
        const effectName = String(data.effect_name || data.effect_id || "").trim();
        if (channelName && effectName && (!label || !label.includes(":"))) {
          label = `${channelName}: ${effectName}`;
        }
      } else if (t.kind === "main_output_device") {
        const deviceName = String(data.output_device_name || data.name || data.output_device_id || "").trim();
        if (deviceName && !label) {
          label = `Main Output: ${deviceName}`;
        }
      } else if (t.kind === "main_output_cycle") {
        if (!label) {
          label = MAIN_OUTPUT_CYCLE_LABEL;
        }
      }

      // Back-compat: reconstruct label if older targets didn't store it.
      if (!label) {
        if (t.kind === "mix") {
          label = String(data.mix_name || data.mixer_name || data.mixer_id || "Wave Link");
        } else if (t.kind === "channel") {
          label = String(data.channel_name || data.name || data.identifier || "Wave Link");
        } else if (t.kind === "channel_mix") {
          const ch = data.channel_name || data.identifier;
          const mix = data.mix_name || data.mixer_id;
          label = (ch && mix) ? `${ch} (${mix})` : "Wave Link";
        } else if (t.kind === "channel_effect") {
          const ch = data.channel_name || data.identifier;
          const effect = data.effect_name || data.effect_id;
          label = (ch && effect) ? `${ch}: ${effect}` : "Wave Link Effect";
        } else if (t.kind === "main_output_device") {
          const deviceName = data.output_device_name || data.name || data.output_device_id;
          label = deviceName ? `Main Output: ${deviceName}` : "Wave Link Main Output";
        } else if (t.kind === "main_output_cycle") {
          label = MAIN_OUTPUT_CYCLE_LABEL;
        } else {
          const endpoint = normalizeEndpoint(target);
          const fromCache = describeFromCache(endpoint);
          if (fromCache?.label) label = String(fromCache.label);
          else label = "Wave Link";
        }
      }

      const isConnected = Boolean(wsId) && Boolean(lastStatus.connected);
      return { label: String(label), icon_data, ghost: !isConnected };
    },
    getTargetOptions: ({ controlType, nav } = {}) => {
      const isButton = controlType === "button";
      const section = String(nav?.section || "");
      const isConnected = Boolean(wsId) && Boolean(lastStatus.connected);

      const placeholder = (label) => [{
        label,
        kind: "placeholder",
        ghost: true,
        icon_data: iconDataUrl || null,
        suppressUnavailableTag: true,
      }];

      if (!isConnected) {
        return [];
      }

      const levelOptions = () => {
        const opts = [];
        if (Array.isArray(mixes)) {
          for (const mix of mixes) {
            if (!mix || !mix.id) continue;
            const mixName = mix.name ? String(mix.name) : String(mix.id);
            opts.push({
              label: mix.name ? String(mix.name) : `Mix ${mix.id}`,
              icon_data: iconDataUrl || null,
              target: {
                Integration: {
                  integration_id: "wavelink",
                  kind: "mix",
                  data: { mixer_id: String(mix.id), mix_name: mixName },
                },
              },
            });
          }
        }
        if (Array.isArray(channels)) {
          for (const ch of channels) {
            if (!ch || !ch.id) continue;
            const channelName = ch.name ? String(ch.name) : String(ch.id);
            opts.push({
              label: ch.name ? String(ch.name) : `Channel ${ch.id}`,
              icon_data: iconDataUrl || null,
              target: {
                Integration: {
                  integration_id: "wavelink",
                  kind: "channel",
                  data: { identifier: String(ch.id), channel_name: channelName },
                },
              },
            });

            if (Array.isArray(ch.mixes)) {
              for (const entry of ch.mixes) {
                const mixId = entry?.id;
                if (!mixId) continue;
                const mix = Array.isArray(mixes)
                  ? mixes.find((m) => m && String(m.id) === String(mixId))
                  : null;
                const mixName = mix?.name ? String(mix.name) : String(mixId);
                opts.push({
                  label: `${channelName} (${mixName})`,
                  icon_data: iconDataUrl || null,
                  target: {
                    Integration: {
                      integration_id: "wavelink",
                      kind: "channel_mix",
                      data: {
                        identifier: String(ch.id),
                        mixer_id: String(mixId),
                        channel_name: channelName,
                        mix_name: mixName,
                      },
                    },
                  },
                });
              }
            }
          }
        }
        return opts;
      };

      const effectOptions = () => {
        const opts = [];
        if (!isButton || !Array.isArray(channels)) return opts;
        for (const ch of channels) {
          if (!ch || !ch.id) continue;
          const channelName = ch.name ? String(ch.name) : String(ch.id);
          for (const effect of getChannelEffects(ch)) {
            opts.push({
              label: `${channelName}: ${effect.name}`,
              icon_data: iconDataUrl || null,
              buttonActions: [
                { label: "Toggle Effect", value: "ToggleEffect", behavior: "stateful" },
              ],
              target: {
                Integration: {
                  integration_id: "wavelink",
                  kind: "channel_effect",
                  data: {
                    identifier: String(ch.id),
                    channel_name: channelName,
                    effect_id: String(effect.id),
                    effect_name: String(effect.name),
                    collection_field: effect.collection_field,
                    enabled_key: effect.enabled_key,
                    enabled_inverted: Boolean(effect.enabled_inverted),
                  },
                },
              },
            });
          }
        }
        return opts;
      };

      const outputDeviceOptions = () => {
        const opts = [];
        if (!isButton || !Array.isArray(outputDevicesState.outputDevices)) return opts;
        const cycleOption = createMainOutputCycleOption(outputDevicesState.outputDevices, iconDataUrl);
        if (cycleOption) {
          opts.push(cycleOption);
        }
        for (const device of validOutputDevices(outputDevicesState.outputDevices)) {
          const id = outputDeviceId(device);
          const name = outputDeviceName(device);
          const nextOutputId = outputId(device) || id;
          opts.push({
            label: `Main Output: ${name}`,
            icon_data: iconDataUrl || null,
            buttonActions: [
              { label: "Set Main Output", value: "SetMainOutputDevice", behavior: "momentary" },
            ],
            target: {
              Integration: {
                integration_id: "wavelink",
                kind: "main_output_device",
                data: {
                  output_device_id: id,
                  output_id: nextOutputId,
                  output_device_name: name,
                  device_type: String(device.deviceType || device.type || ""),
                },
              },
            },
          });
        }
        return opts;
      };

      if (section === "levels") {
        const opts = levelOptions();
        return opts.length > 0 ? opts : placeholder("No Wave Link level targets exposed");
      }
      if (section === "effects") {
        const opts = effectOptions();
        return opts.length > 0 ? opts : placeholder("No Wave Link effects exposed");
      }
      if (section === "outputs") {
        const opts = outputDeviceOptions();
        return opts.length > 0 ? opts : placeholder("No Wave Link output devices exposed");
      }

      const groups = [
        {
          label: "Levels",
          nav: { section: "levels" },
          description: "Channels, mixes, and channel-in-mix levels.",
          tags: [String(levelOptions().length)],
          icon_data: iconDataUrl || null,
        },
      ];
      if (isButton) {
        groups.push(
          {
            label: "Effects",
            nav: { section: "effects" },
            description: "Channel audio effects.",
            tags: [String(effectOptions().length)],
            icon_data: iconDataUrl || null,
          },
          {
            label: "Output Devices",
            nav: { section: "outputs" },
            description: "Set the Wave Link main output device.",
            tags: [String(outputDeviceOptions().length)],
            icon_data: iconDataUrl || null,
          },
        );
      }

      if (groups.length === 0) {
        return placeholder("No compatible Wave Link targets exposed");
      }
      return groups;
    },
    onBindingTriggered: async (payload) => {
      const bindingId = payload?.binding_id;
      const action = payload?.action;
      const value = payload?.value;
      const source = String(payload?.source || "");
      const isPrimaryTarget = payload?.is_primary_target !== false;
      const targetIndex = Number(payload?.target_index ?? 0);
      const targetCount = Number(payload?.target_count ?? 1);
      const target = payload?.target || {};
      const targetData = target?.data || {};
      if (action === "ToggleEffect") {
        const enabled = clamp01(value) > 0.5;
        if (!wsId) return;
        try {
          const applied = await setChannelEffectEnabled(targetData, enabled);
          if (applied && bindingId && isPrimaryTarget) {
            await ctx.feedback.set(bindingId, enabled ? 1.0 : 0.0, action);
          }
        } catch {
          wsId = null;
          connectedPort = null;
          pendingVolumeWrites.clear();
          mixes = [];
          channels = [];
          localVolumeIntentByEndpoint.clear();
          offlineFeedbackSent = false;
          syncOfflineFeedback().catch(() => {});
          wasConnected = false;
          setStatus(false, "Disconnected");
        }
        return;
      }
      if (action === "SetMainOutputDevice") {
        if (!wsId) return;
        try {
          const applied = target?.kind === "main_output_cycle"
            ? await cycleMainOutputDevice()
            : await setMainOutputDevice(targetData);
          if (applied && bindingId && isPrimaryTarget) {
            await ctx.feedback.set(bindingId, 1.0, action);
          }
        } catch {
          wsId = null;
          connectedPort = null;
          pendingVolumeWrites.clear();
          mixes = [];
          channels = [];
          outputDevicesState = { mainOutput: null, outputDevices: [] };
          localVolumeIntentByEndpoint.clear();
          offlineFeedbackSent = false;
          syncOfflineFeedback().catch(() => {});
          wasConnected = false;
          setStatus(false, "Disconnected");
        }
        return;
      }
      const endpoint = normalizeEndpoint({ Integration: payload?.target });
      if (!endpoint) return;

      const level = clamp01(value);
      try {
        if (action === "Volume") {
          // Update UI/OSD and internal state immediately (optimistic), then coalesce
          // websocket writes to keep rapid fader motion smooth.
          // Latch user intent so background sync doesn't snap the motorized fader
          // back to stale levels right after release.
          rememberLocalVolumeIntent(endpoint, level, source);
          if (bindingId && isPrimaryTarget) {
            primaryFeedbackIntentByBinding.set(bindingId, {
              value: level,
              at: Date.now(),
              source,
              endpoint_key: endpointKey(endpoint),
            });
          }

          if (!wsId) {
            return;
          }

          queueVolumeWrite(endpoint, level);
          // For multi-target bindings, Rust emits one event per target in order.
          // Flush immediately after the last target event for the current tick so
          // grouped targets update in real time while preserving anti-jitter logic.
          if (Number.isFinite(targetCount) && targetCount > 1 && targetIndex >= targetCount - 1) {
            flushVolumeWrites().catch(() => {});
          }
          return;
        } else if (action === "ToggleMute") {
          const muted = level > 0.5;
          if (!wsId) {
            return;
          }
          if (!endpoint.identifier) {
            await sendJsonRpc("setMix", { id: endpoint.mixer_id, isMuted: muted }, 202);
          } else if (!endpoint.mixer_id) {
            await sendJsonRpc("setChannel", { id: endpoint.identifier, isMuted: muted }, 102);
          } else {
            await sendJsonRpc(
              "setChannel",
              { id: endpoint.identifier, mixes: [{ id: endpoint.mixer_id, isMuted: muted }] },
              102,
            );
          }
        }

        if (bindingId && isPrimaryTarget && action !== "Volume") {
          await ctx.feedback.set(
            bindingId,
            action === "ToggleMute" ? (level > 0.5 ? 1.0 : 0.0) : level,
            action,
          );
        }
      } catch (e) {
        // If send failed, force reconnect.
        wsId = null;
        connectedPort = null;
        pendingVolumeWrites.clear();
        mixes = [];
        channels = [];
        outputDevicesState = { mainOutput: null, outputDevices: [] };
        localVolumeIntentByEndpoint.clear();
        offlineFeedbackSent = false;
        syncOfflineFeedback().catch(() => {});
        wasConnected = false;
        setStatus(false, "Disconnected");
      }
    },
  });

  setBindings(readBindings());
  ctx.bindings?.onChanged?.((next) => {
    if (disposed) return;
    setBindings(next);
    syncAllFeedback().catch(() => {});
  });
}

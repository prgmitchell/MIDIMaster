import { createConnectionTab } from "./connection_tab.js";
import { createIntegration } from "./integration.js";
import { createReconnectController } from "../../../plugin_sources/shared/runtime.js";
import { createConnection } from "./connection.js";
import { createFeedback } from "./feedback.js";
import { createVolume } from "./volume.js";
import {
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_IDLE_DELAY_MS,
  ui,
  setStatus,
} from "./protocol.js";
export { wavelinkTestUtils } from "./protocol.js";

export async function activate(ctx) {
  const DEFAULT_AUTO_CONNECT = true;
  let iconDataUrl = null;
  try {
    iconDataUrl = await ctx.assets?.readDataUrl?.("WaveLinkLogo.png", "image/png");
  } catch {
    iconDataUrl = null;
  }

  // Allow status changes to refresh the bindings list even if the Connections
  // tab UI was never opened.
  ui.invalidateBindingsUI = ctx.app?.invalidateBindingsUI;
  const state = {
    wsId: null,
    connectedPort: null,
    connecting: false,
    wasConnected: false,
    offlineFeedbackSent: false,
    disposed: false,
    autoConnect: DEFAULT_AUTO_CONNECT,
    manualConnectRequested: false,
    disconnectedByUser: false,
    reconnectDelayMs: RECONNECT_INITIAL_DELAY_MS,
    applicationInfo: null,
    mixes: [],
    channels: [],
    outputDevicesState: { mainOutput: null, outputDevices: [] },
    bindings: [],
    volumeFlushTimer: null,
    volumeFlushInFlight: false,
    channelsRefreshTimer: null,
    mixesRefreshTimer: null,
    postLocalWriteRefreshTimer: null,
  };
  const reconnect = createReconnectController({
    state,
    initialDelay: RECONNECT_INITIAL_DELAY_MS,
    maximumDelay: RECONNECT_MAX_DELAY_MS,
    idleDelay: RECONNECT_IDLE_DELAY_MS,
    hasConnection: () => Boolean(state.wsId),
    connect: () => connectOnce(),
  });
  const resetReconnectBackoff = reconnect.reset;

  function applyProfileSettings(settings) {
    const next =
      settings && typeof settings === "object" && "auto_connect" in settings
        ? Boolean(settings.auto_connect)
        : DEFAULT_AUTO_CONNECT;
    state.autoConnect = next;
    if (!next) {
      state.manualConnectRequested = false;
      state.disconnectedByUser = true;
    }
    if (ui.autoConnectInput) {
      ui.autoConnectInput.checked = next;
    }
    if (next && !state.wsId && !state.connecting) {
      state.manualConnectRequested = true;
      state.disconnectedByUser = false;
      resetReconnectBackoff();
    }
  }

  try {
    applyProfileSettings(ctx.profile?.get?.());
    ctx.profile?.onChanged?.((ev) => {
      if (state.disposed) return;
      applyProfileSettings(ev?.settings || ev);
    });
  } catch {
    // ignore
  }

  const pendingVolumeWrites = new Map();
  const lastSentVolumeByEndpoint = new Map();

  const primaryFeedbackIntentByBinding = new Map(); // binding_id -> { value, at, source, endpoint_key }
  const localVolumeIntentByEndpoint = new Map(); // endpoint_key -> { value, at, source, endpoint_key }
  const pendingAppInfoByWsId = new Map();
  const pendingRpcById = new Map();

  function clearRuntimeTimers() {
    if (state.volumeFlushTimer) {
      clearTimeout(state.volumeFlushTimer);
      state.volumeFlushTimer = null;
    }
    if (state.channelsRefreshTimer) {
      clearTimeout(state.channelsRefreshTimer);
      state.channelsRefreshTimer = null;
    }
    if (state.mixesRefreshTimer) {
      clearTimeout(state.mixesRefreshTimer);
      state.mixesRefreshTimer = null;
    }
    if (state.postLocalWriteRefreshTimer) {
      clearTimeout(state.postLocalWriteRefreshTimer);
      state.postLocalWriteRefreshTimer = null;
    }
  }

  function disposeWaveLinkRuntime() {
    state.disposed = true;
    state.connecting = false;
    state.manualConnectRequested = false;
    clearRuntimeTimers();
    clearAllPendingAppInfo();
    clearAllPendingRpc();
    const currentWsId = state.wsId;
    state.wsId = null;
    state.connectedPort = null;
    if (currentWsId) {
      ctx.ws.close(currentWsId).catch(() => {});
    }
    pendingVolumeWrites.clear();
    lastSentVolumeByEndpoint.clear();
    primaryFeedbackIntentByBinding.clear();
    localVolumeIntentByEndpoint.clear();
    state.mixes = [];
    state.channels = [];
    state.outputDevicesState = { mainOutput: null, outputDevices: [] };
    pendingAppInfoByWsId.clear();
    pendingRpcById.clear();
  }

  const {
    endpointKey,
    rememberLocalVolumeIntent,
    shouldIgnoreStaleLocalVolume,
    flushVolumeWrites,
    queueVolumeWrite,
    shouldIgnoreStaleFeedbackIntent,
    scheduleChannelsRefresh,
    scheduleMixesRefresh,
    scheduleOutputDevicesRefresh,
  } = createVolume({
    lastSentVolumeByEndpoint,
    localVolumeIntentByEndpoint,
    pendingVolumeWrites,
    requestFullState: (...args) => requestFullState(...args),
    sendJsonRpc: (...args) => sendJsonRpc(...args),
    state,
    syncOfflineFeedback: (...args) => syncOfflineFeedback(...args),
  });

  const {
    readBindings,
    setBindings,
    updateAppInfoUi,
    syncOfflineFeedback,
    getChannelEffects,
    setChannelEffectEnabled,
    setMainOutputDevice,
    cycleMainOutputDevice,
    syncAllFeedback,
    invalidateFeedback,
  } = createFeedback({
    ctx,
    primaryFeedbackIntentByBinding,
    requestJsonRpc: (...args) => requestJsonRpc(...args),
    scheduleChannelsRefresh,
    scheduleOutputDevicesRefresh,
    sendJsonRpc: (...args) => sendJsonRpc(...args),
    shouldIgnoreStaleFeedbackIntent,
    shouldIgnoreStaleLocalVolume,
    state,
  });

  const {
    describeFromCache,
    sendJsonRpc,
    clearAllPendingRpc,
    requestJsonRpc,
    requestFullState,
    clearPendingAppInfo,
    clearAllPendingAppInfo,
    connectOnce,
  } = createConnection({
    ctx,
    iconDataUrl,
    invalidateFeedback,
    pendingAppInfoByWsId,
    pendingRpcById,
    scheduleChannelsRefresh,
    scheduleMixesRefresh,
    scheduleOutputDevicesRefresh,
    state,
    syncAllFeedback,
    updateAppInfoUi,
  });

  ctx.lifecycle?.onDispose?.(disposeWaveLinkRuntime);

  // Track close events
  ctx.tauri.listen("ws_closed", (event) => {
    if (state.disposed) return;
    let payload = event?.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    const closedId = payload?.id;
    if (state.wsId && closedId === state.wsId) {
      clearPendingAppInfo(closedId);
      state.wsId = null;
      state.connectedPort = null;
      state.connecting = false;
      pendingVolumeWrites.clear();
      state.mixes = [];
      state.channels = [];
      state.outputDevicesState = { mainOutput: null, outputDevices: [] };
      localVolumeIntentByEndpoint.clear();
      state.offlineFeedbackSent = false;
      syncOfflineFeedback().catch(() => {});
      state.wasConnected = false;
      setStatus(false, "Disconnected");
    }
  });

  // Connections panel tab
  const { registerConnectionTab } = createConnectionTab({
    applyProfileSettings,
    clearPendingAppInfo,
    connectOnce,
    ctx,
    iconDataUrl,
    localVolumeIntentByEndpoint,
    pendingVolumeWrites,
    state,
    syncOfflineFeedback,
    updateAppInfoUi,
  });

  registerConnectionTab();

  // Background reconnect loop
  reconnect.run();

  const { registerPluginIntegration } = createIntegration({
    ctx,
    cycleMainOutputDevice,
    describeFromCache,
    endpointKey,
    flushVolumeWrites,
    getChannelEffects,
    iconDataUrl,
    invalidateFeedback,
    localVolumeIntentByEndpoint,
    pendingVolumeWrites,
    primaryFeedbackIntentByBinding,
    queueVolumeWrite,
    rememberLocalVolumeIntent,
    sendJsonRpc,
    setChannelEffectEnabled,
    setMainOutputDevice,
    state,
    syncOfflineFeedback,
  });

  registerPluginIntegration();

  setBindings(readBindings());
  ctx.bindings?.onChanged?.((next) => {
    if (state.disposed) return;
    setBindings(next);
    syncAllFeedback().catch(() => {});
  });
}

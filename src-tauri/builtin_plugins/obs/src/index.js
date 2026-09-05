import { createConnectionTab } from "./connection_tab.js";
import { createIntegration } from "./integration.js";
import { createReconnectController } from "../../../plugin_sources/shared/runtime.js";
import { createActions } from "./actions.js";
import { createConnection } from "./connection.js";
import { createFeedback } from "./feedback.js";
import { createVolume } from "./volume.js";
import { createTargets } from "./targets.js";
import { createBindings } from "./bindings.js";
import {
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_IDLE_DELAY_MS,
  obsDisconnectedFeedbackUpdates,
  isOsdWindow,
  ui,
  setStatus,
} from "./protocol.js";
export { obsTestUtils } from "./protocol.js";

export async function activate(ctx) {
  const DEFAULT_AUTO_CONNECT = true;
  let iconDataUrl = null;
  try {
    iconDataUrl = await ctx.assets?.readDataUrl?.("OBSLogo.png", "image/png");
  } catch {
    iconDataUrl = null;
  }

  // OBS integration is only needed in the main window.
  if (isOsdWindow()) {
    ctx.registerIntegration({
      id: "obs",
      describeTarget: (target) => {
        const t = target?.Integration || target?.integration;
        const data = t?.data || {};
        if (t?.kind === "input") {
          return { label: data.input_name || "OBS Input", icon_data: iconDataUrl || null };
        }
        if (t?.kind === "scene") {
          return { label: data.scene_name || "OBS Scene", icon_data: iconDataUrl || null };
        }
        return { label: "OBS Studio", icon_data: iconDataUrl || null };
      },
      getTargetOptions: () => [],
      onBindingTriggeredBatch: async () => {},
      onBindingTriggered: async () => {},
    });
    return;
  }

  // Allow status changes to refresh the bindings list even if the Connections
  // tab UI was never opened.
  ui.invalidateBindingsUI = ctx.app?.invalidateBindingsUI;

  const state = {
    ws: null,
    connected: false,
    connecting: false,
    disposed: false,
    requestId: 1,
    inputList: [],
    sceneList: [],
    listRefreshTimer: null,
    knownVolumes: new Map(),
    knownMutes: new Map(),
    currentScene: null,
    audioInputs: new Set(),
    audioInputsReady: false,
    audioInputsDiscovering: false,
    bindings: [],
    bindingsByInputVolume: new Map(),
    bindingsByInputMute: new Map(),
    bindingsBySourceVisibility: new Map(),
    bindingsBySourceFilter: new Map(),
    volumeFlushTimer: null,
    volumeFlushInFlight: false,
    disconnectedFeedbackPromise: Promise.resolve(),
    autoConnect: DEFAULT_AUTO_CONNECT,
    manualConnectRequested: false,
    disconnectedByUser: false,
    reconnectDelayMs: RECONNECT_INITIAL_DELAY_MS,
  };
  const reconnect = createReconnectController({
    state,
    initialDelay: RECONNECT_INITIAL_DELAY_MS,
    maximumDelay: RECONNECT_MAX_DELAY_MS,
    idleDelay: RECONNECT_IDLE_DELAY_MS,
    hasConnection: () => Boolean(state.connected),
    connect: () => connectOnce(),
    onFailure: () => setStatus(false, "Not connected", { disconnectedByUser: state.disconnectedByUser }),
  });
  const resetReconnectBackoff = reconnect.reset;

  const pending = new Map();

  // ui is module-scoped so setStatus() can access it.

  // inputName -> Set(bindingId)

  // sceneName\0sourceName -> Set(bindingId)
  // sourceName\0filterName -> Map(bindingId, action)
  const statefulActionFeedback = new Map(); // bindingId -> last latched value fallback
  const lastLocalWriteAt = new Map(); // inputName -> ms for volume writes
  const localMuteIntentByInput = new Map(); // inputName -> { muted, at }
  const localVolumeIntentByBinding = new Map(); // bindingId -> { value, at }
  const pendingVolumeWrites = new Map(); // inputName -> volume
  const lastSentVolumeByInput = new Map(); // inputName -> volume

  function publishConnectionState(nextConnected) {
    try {
      return Promise.resolve(ctx.integration?.setConnected?.("obs", Boolean(nextConnected)));
    } catch {
      return Promise.resolve();
    }
  }

  function queueDisconnectedFeedbackClear() {
    statefulActionFeedback.clear();
    state.disconnectedFeedbackPromise = state.disconnectedFeedbackPromise
      .catch(() => {})
      .then(async () => {
        if (state.connected) return;
        await publishConnectionState(false);
        if (state.connected) return;
        const updates = obsDisconnectedFeedbackUpdates(state.bindings);
        await Promise.allSettled(
          updates.map(({ bindingId, action }) =>
            ctx.feedback.set(bindingId, 0.0, action, {
              silent: true,
              forceHardwareFeedback: true,
            }),
          ),
        );
      });
    return state.disconnectedFeedbackPromise;
  }

  function clearPendingRequests(errorMessage = null) {
    for (const entry of pending.values()) {
      if (entry?.timer) clearTimeout(entry.timer);
      if (errorMessage && typeof entry?.reject === "function") {
        try {
          entry.reject(new Error(errorMessage));
        } catch {}
      }
    }
    pending.clear();
  }

  function clearRuntimeTimers() {
    if (state.listRefreshTimer) {
      clearTimeout(state.listRefreshTimer);
      state.listRefreshTimer = null;
    }
    if (state.volumeFlushTimer) {
      clearTimeout(state.volumeFlushTimer);
      state.volumeFlushTimer = null;
    }
  }

  function closeSocketForDispose() {
    const current = state.ws;
    state.ws = null;
    if (!current) return;
    try {
      current.onopen = null;
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
      current.close();
    } catch {}
  }

  function disposeObsRuntime() {
    state.disposed = true;
    state.connected = false;
    state.connecting = false;
    state.manualConnectRequested = false;
    clearRuntimeTimers();
    closeSocketForDispose();
    clearPendingRequests("OBS plugin disposed");
    pendingVolumeWrites.clear();
    lastSentVolumeByInput.clear();
    state.knownVolumes.clear();
    state.knownMutes.clear();
    statefulActionFeedback.clear();
    lastLocalWriteAt.clear();
    localMuteIntentByInput.clear();
    localVolumeIntentByBinding.clear();
    resetAudioInputDiscovery();
    return queueDisconnectedFeedbackClear();
  }

  const {
    readBindings,
    setBindings,
    notifyTargetOptionsChanged,
    resetAudioInputDiscovery,
    scheduleListRefresh,
  } = createBindings({
    ctx,
    discoverAudioInputs: (...args) => discoverAudioInputs(...args),
    queueDisconnectedFeedbackClear,
    refreshLists: (...args) => refreshLists(...args),
    sourceVisibilityKey: (...args) => sourceVisibilityKey(...args),
    state,
    syncAllFeedback: (...args) => syncAllFeedback(...args),
  });

  const {
    titleCaseAction,
    momentaryAction,
    statefulAction,
    obsActionKind,
    makeActionTarget,
    makeSceneTarget,
    makeSourceToggleTarget,
    sourceVisibilityKey,
  } = createTargets({});

  const { shouldIgnoreEcho, shouldIgnoreBindingVolumeEcho, normalizeBatchTargets, applyObsVolumeBatch } =
    createVolume({
      ctx,
      lastLocalWriteAt,
      lastSentVolumeByInput,
      localVolumeIntentByBinding,
      pendingVolumeWrites,
      request: (...args) => request(...args),
      state,
    });

  const {
    buttonEvent,
    setMomentaryFeedback,
    readStatefulActionValue,
    syncAllFeedback,
    syncSourceVisibilityForScene,
    loadSourceFilterButtonActions,
  } = createFeedback({
    ctx,
    iconDataUrl,
    request: (...args) => request(...args),
    sourceVisibilityKey,
    state,
  });

  const {
    saveObsSettingsToStorage,
    loadObsSettingsFromStorage,
    request,
    refreshLists,
    discoverAudioInputs,
    connectOnce,
  } = createConnection({
    clearPendingRequests,
    ctx,
    lastSentVolumeByInput,
    localMuteIntentByInput,
    notifyTargetOptionsChanged,
    pending,
    pendingVolumeWrites,
    publishConnectionState,
    queueDisconnectedFeedbackClear,
    resetAudioInputDiscovery,
    scheduleListRefresh,
    shouldIgnoreBindingVolumeEcho,
    shouldIgnoreEcho,
    state,
    syncAllFeedback,
    syncSourceVisibilityForScene,
  });

  const { handleObsBindingTrigger } = createActions({
    applyObsVolumeBatch,
    buttonEvent,
    ctx,
    localMuteIntentByInput,
    obsActionKind,
    readStatefulActionValue,
    request,
    setMomentaryFeedback,
    state,
    statefulActionFeedback,
  });

  ctx.lifecycle?.onDispose?.(disposeObsRuntime);

  function applyProfileSettings(settings) {
    const next =
      settings && typeof settings === "object" && "auto_connect" in settings
        ? Boolean(settings.auto_connect)
        : DEFAULT_AUTO_CONNECT;
    state.autoConnect = next;
    if (!next) {
      state.manualConnectRequested = false;
      // If user turned off auto-connect, treat it as an intentional disconnect.
      state.disconnectedByUser = true;
    }
    if (ui.autoConnectInput) {
      ui.autoConnectInput.checked = next;
    }
    // If auto-connect was enabled and we're disconnected, try soon.
    if (next && !state.connected && !state.connecting) {
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

  // Reconnect loop (auto-connect or manual connect)
  reconnect.run();

  const { registerPluginIntegration } = createIntegration({
    applyObsVolumeBatch,
    ctx,
    discoverAudioInputs,
    handleObsBindingTrigger,
    iconDataUrl,
    loadSourceFilterButtonActions,
    makeActionTarget,
    makeSceneTarget,
    makeSourceToggleTarget,
    momentaryAction,
    normalizeBatchTargets,
    obsActionKind,
    pendingVolumeWrites,
    refreshLists,
    request,
    resetAudioInputDiscovery,
    state,
    statefulAction,
    titleCaseAction,
  });

  registerPluginIntegration();

  // Bindings feed for two-way sync
  setBindings(readBindings());
  ctx.bindings?.onChanged?.((next) => {
    if (state.disposed) return;
    setBindings(next);
    syncAllFeedback({ silent: true }).catch(() => {});
  });

  // Connections panel tab
  const { registerConnectionTab } = createConnectionTab({
    applyProfileSettings,
    connectOnce,
    ctx,
    iconDataUrl,
    loadObsSettingsFromStorage,
    queueDisconnectedFeedbackClear,
    saveObsSettingsToStorage,
    state,
  });

  registerConnectionTab();
}

import { createConnectionTab } from "./connection_tab.js";
import { createIntegration } from "./integration.js";
import { createActions } from "./actions.js";
import { createPairing } from "./pairing.js";
import { createFeedback } from "./feedback.js";
import { createDiscovery } from "./discovery.js";
import { createTargetState } from "./target_state.js";
import {
  sleep,
  POLL_INTERVAL_MS,
  IDLE_POLL_INTERVAL_MS,
  RECONNECT_MAX_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  LOCAL_WRITE_QUIET_MS,
  DEFAULT_AUTO_CONNECT,
  POST_WRITE_REFRESH_DEBOUNCE_MS,
  MAX_TRANSIENT_WRITE_FAILURES,
  GROUP_FANOUT_MAX_LIGHTS,
  createHueWriteScheduler,
  ui,
  hueErrorFromResult,
} from "./protocol.js";
export { createHueWriteSchedulerForTests, hueTestUtils } from "./protocol.js";

export async function activate(ctx) {
  let iconDataUrl = null;
  try {
    iconDataUrl = await ctx.assets?.readDataUrl?.("HueLogo.svg", "image/svg+xml");
  } catch {
    iconDataUrl = null;
  }

  ui.invalidateBindingsUI = ctx.app?.invalidateBindingsUI;

  const state = {
    bridgeIp: "",
    username: "",
    connected: false,
    connecting: false,
    pairing: false,
    autoConnect: DEFAULT_AUTO_CONNECT,
    manualConnectRequested: false,
    disconnectedByUser: false,
    disposed: false,
    reconnectDelayMs: POLL_INTERVAL_MS,
    discovering: false,
    discoveredBridges: [],
    selectedBridgeIp: "",
    hasAutoDiscovered: false,
    pairingCancelToken: null,
    bridgeInputMode: "discovery",
    bindings: [],
    postWriteRefreshTimer: null,
    transientWriteFailures: 0,
  };

  const stateByKey = new Map();
  const lastLocalWriteAt = new Map();
  const localIntentByKey = new Map();
  const lastNonzeroBriByKey = new Map();
  const lastQueuedVolumeByKey = new Map();
  const groupLightIdsByKey = new Map();
  const groupWriteGenerationByKey = new Map();

  function resetReconnectBackoff() {
    state.reconnectDelayMs = POLL_INTERVAL_MS;
  }

  function growReconnectBackoff() {
    state.reconnectDelayMs = Math.min(RECONNECT_MAX_DELAY_MS, state.reconnectDelayMs * 2);
  }

  function ensurePairPanel() {
    let panel = document.getElementById("hue-pair-panel");
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = "hue-pair-panel";
    panel.className = "target-panel hidden";
    panel.innerHTML = `
      <div class="target-panel-content learn-panel-content">
        <div class="target-panel-header">
          <span>Waiting for Hue Bridge Button</span>
          <button type="button" class="target-panel-close" data-role="close">×</button>
        </div>
        <div class="learn-panel-body">
          <div class="learn-panel-spinner" aria-hidden="true"></div>
          <p data-role="message">Press the physical button on your Hue Bridge.</p>
          <div class="alert-panel-actions" style="margin-top:6px;">
            <button type="button" data-role="cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    return panel;
  }

  function openPairPanel(message) {
    const panel = ensurePairPanel();
    const msg = panel.querySelector('[data-role="message"]');
    if (msg) msg.textContent = String(message || "Press the physical button on your Hue Bridge.");
    panel.classList.remove("hidden");
  }

  function setPairPanelMessage(message) {
    const panel = document.getElementById("hue-pair-panel");
    if (!panel) return;
    const msg = panel.querySelector('[data-role="message"]');
    if (msg) msg.textContent = String(message || "");
  }

  function closePairPanel() {
    const panel = document.getElementById("hue-pair-panel");
    if (!panel) return;
    panel.classList.add("hidden");
  }

  async function invokeWithTimeout(command, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return Promise.race([
      ctx.tauri.invoke(command, args),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), timeoutMs)),
    ]);
  }

  async function hueGet(path) {
    const ip = String(state.bridgeIp || "").trim();
    const user = String(state.username || "").trim();
    if (!ip || !user) {
      throw new Error("Missing bridge IP or app key");
    }
    const json = await invokeWithTimeout("hue_api_get", {
      bridgeIp: ip,
      username: user,
      path,
      bridge_ip: ip,
    });
    const hueErr = hueErrorFromResult(json);
    if (hueErr) {
      throw new Error(hueErr.description);
    }
    return json;
  }

  async function huePut(kind, id, body) {
    const ip = String(state.bridgeIp || "").trim();
    const user = String(state.username || "").trim();
    if (!ip || !user) {
      throw new Error("Missing bridge IP or app key");
    }
    const route = kind === "group" ? `/groups/${id}/action` : `/lights/${id}/state`;
    const json = await invokeWithTimeout("hue_api_put", {
      bridgeIp: ip,
      username: user,
      path: route,
      body: body || {},
      bridge_ip: ip,
    });
    const hueErr = hueErrorFromResult(json);
    if (hueErr) {
      throw new Error(hueErr.description);
    }
    return json;
  }

  function schedulePostWriteRefresh() {
    if (state.disposed) return;
    if (state.postWriteRefreshTimer) return;
    state.postWriteRefreshTimer = setTimeout(async () => {
      state.postWriteRefreshTimer = null;
      if (state.disposed) return;
      try {
        await writeScheduler.whenIdle(30000);
      } catch {
        // A long-running fader move should not block refresh forever.
      }
      if (state.disposed || !state.connected || state.connecting) return;
      refreshHueState({ silent: true }).catch(() => {
        if (state.disposed) return;
        markDisconnected("Disconnected");
      });
    }, LOCAL_WRITE_QUIET_MS + POST_WRITE_REFRESH_DEBOUNCE_MS);
  }

  const writeScheduler = createHueWriteScheduler({
    put: huePut,
    onWriteSuccess: () => {
      if (state.disposed) return;
      state.transientWriteFailures = 0;
      schedulePostWriteRefresh();
    },
    onWriteFailure: (_err, failedWrite) => {
      if (state.disposed) return;
      state.transientWriteFailures += 1;
      if (state.transientWriteFailures >= MAX_TRANSIENT_WRITE_FAILURES) {
        markDisconnected("Disconnected");
        return;
      }
      if (!failedWrite?.hasNewerPending && failedWrite?.kind && failedWrite?.id) {
        writeScheduler.enqueue(failedWrite.kind, failedWrite.id, failedWrite.body || {});
      }
    },
  });

  function disposeHueRuntime() {
    state.disposed = true;
    state.connected = false;
    state.connecting = false;
    state.pairing = false;
    state.discovering = false;
    state.manualConnectRequested = false;
    state.transientWriteFailures = 0;
    if (state.pairingCancelToken) state.pairingCancelToken.cancelled = true;
    if (state.postWriteRefreshTimer) {
      clearTimeout(state.postWriteRefreshTimer);
      state.postWriteRefreshTimer = null;
    }
    writeScheduler.clear();
    stateByKey.clear();
    lastLocalWriteAt.clear();
    localIntentByKey.clear();
    lastNonzeroBriByKey.clear();
    lastQueuedVolumeByKey.clear();
    groupLightIdsByKey.clear();
    groupWriteGenerationByKey.clear();
    state.discoveredBridges = [];
    closePairPanel();
  }

  const {
    targetKey,
    rememberNonzeroBri,
    savedBriForKey,
    rememberLocalIntent,
    freshLocalIntent,
    mergeIncomingStateWithLocalIntent,
    normalizeIntegrationTarget,
    parseLightState,
    parseGroupState,
  } = createTargetState({
    iconDataUrl,
    lastLocalWriteAt,
    lastNonzeroBriByKey,
    localIntentByKey,
    stateByKey,
  });

  const {
    persistProfilePatch,
    effectiveBridgeIp,
    renderDiscoveryState,
    renderBridgeList,
    renderPairActionButton,
    renderBridgeInputMode,
    setBridgeInputMode,
    renderPairedUiState,
    applyProfileSettings,
  } = createDiscovery({
    ctx,
    resetReconnectBackoff,
    state,
  });

  const { setBindings, syncFeedbackForKey, refreshHueState } = createFeedback({
    ctx,
    freshLocalIntent,
    groupLightIdsByKey,
    hueGet,
    lastLocalWriteAt,
    mergeIncomingStateWithLocalIntent,
    normalizeIntegrationTarget,
    parseGroupState,
    parseLightState,
    rememberNonzeroBri,
    state,
    stateByKey,
    targetKey,
  });

  const { markDisconnected, connectOnce, discoverBridges, startPairing, unpairBridge, cancelPairing } =
    createPairing({
      closePairPanel,
      effectiveBridgeIp,
      invokeWithTimeout,
      openPairPanel,
      persistProfilePatch,
      refreshHueState,
      renderBridgeList,
      renderDiscoveryState,
      renderPairActionButton,
      renderPairedUiState,
      setPairPanelMessage,
      state,
      writeScheduler,
    });

  const { normalizeBatchTargets, handleHueToggle, handleHuePowerAction, handleHueVolumeTargets } =
    createActions({
      ctx,
      groupLightIdsByKey,
      lastQueuedVolumeByKey,
      normalizeIntegrationTarget,
      queueHueWrite,
      rememberLocalIntent,
      rememberNonzeroBri,
      savedBriForKey,
      state,
      stateByKey,
      syncFeedbackForKey,
      targetKey,
    });

  ctx.lifecycle?.onDispose?.(disposeHueRuntime);

  function incrementGroupGeneration(key) {
    const next = (groupWriteGenerationByKey.get(key) || 0) + 1;
    groupWriteGenerationByKey.set(key, next);
    return next;
  }

  function currentGroupGeneration(key) {
    return groupWriteGenerationByKey.get(key) || 0;
  }

  function queueHueWrite(kind, id, body, options = null) {
    const targetKind = String(kind || "");
    const targetId = String(id || "");
    if (!targetKind || !targetId) return;

    const key = targetKey(targetKind, targetId);
    const fanoutGroup = Boolean(options?.fanoutGroup);
    if (targetKind === "group" && fanoutGroup && body?.on === true && typeof body?.bri === "number") {
      const lightIds = groupLightIdsByKey.get(key) || [];
      if (lightIds.length > 0 && lightIds.length <= GROUP_FANOUT_MAX_LIGHTS) {
        const generation = currentGroupGeneration(key);
        for (const lightId of lightIds) {
          writeScheduler.enqueue("light", lightId, body, {
            shouldSend: () => currentGroupGeneration(key) === generation,
          });
        }
        return;
      }
    }

    if (targetKind === "group") {
      incrementGroupGeneration(key);
      const lightIds = groupLightIdsByKey.get(key) || [];
      for (const lightId of lightIds) {
        writeScheduler.cancel("light", lightId);
      }
    }
    writeScheduler.enqueue(targetKind, targetId, body);
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

  setBindings(ctx.bindings?.getAll?.() || []);
  ctx.bindings?.onChanged?.((next) => {
    if (state.disposed) return;
    setBindings(next);
  });

  (async () => {
    while (!state.disposed) {
      let delay = IDLE_POLL_INTERVAL_MS;
      if (
        !state.connected &&
        !state.connecting &&
        !state.pairing &&
        !state.disconnectedByUser &&
        (state.autoConnect || state.manualConnectRequested)
      ) {
        if (effectiveBridgeIp() && state.username) {
          const connectedNow = await connectOnce();
          if (connectedNow) {
            resetReconnectBackoff();
          } else {
            growReconnectBackoff();
          }
          delay = state.reconnectDelayMs;
        }
      } else if (state.connected && !state.connecting) {
        try {
          await refreshHueState({ silent: true });
          resetReconnectBackoff();
          delay = POLL_INTERVAL_MS;
        } catch {
          if (state.disposed) return;
          markDisconnected("Disconnected");
          growReconnectBackoff();
          delay = state.reconnectDelayMs;
        }
      } else {
        resetReconnectBackoff();
      }
      await sleep(delay);
    }
  })();

  const { registerPluginIntegration } = createIntegration({
    ctx,
    handleHuePowerAction,
    handleHueToggle,
    handleHueVolumeTargets,
    iconDataUrl,
    markDisconnected,
    normalizeBatchTargets,
    normalizeIntegrationTarget,
    state,
    stateByKey,
    targetKey,
  });

  registerPluginIntegration();

  const { registerConnectionTab } = createConnectionTab({
    applyProfileSettings,
    cancelPairing,
    closePairPanel,
    ctx,
    discoverBridges,
    ensurePairPanel,
    iconDataUrl,
    persistProfilePatch,
    renderBridgeInputMode,
    renderBridgeList,
    renderDiscoveryState,
    renderPairActionButton,
    renderPairedUiState,
    setBridgeInputMode,
    startPairing,
    state,
    unpairBridge,
  });

  registerConnectionTab();
}

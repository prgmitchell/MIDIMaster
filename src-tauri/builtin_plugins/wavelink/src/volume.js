import {
  FEEDBACK_INTENT_HOLD_MS,
  FEEDBACK_INTENT_MATCH_EPSILON,
  LOCAL_WRITE_QUIET_MS,
  STATE_REFRESH_DEBOUNCE_MS,
  VOLUME_WRITE_INTERVAL_MS,
  setStatus,
  VOLUME_WRITE_EPSILON,
} from "./protocol.js";

/** volume workflow. */
export function createVolume({
  lastSentVolumeByEndpoint,
  localVolumeIntentByEndpoint,
  pendingVolumeWrites,
  requestFullState,
  sendJsonRpc,
  state,
  syncOfflineFeedback,
}) {
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
    if (state.postLocalWriteRefreshTimer) return;
    state.postLocalWriteRefreshTimer = setTimeout(() => {
      state.postLocalWriteRefreshTimer = null;
      if (!state.wsId) return;
      requestFullState().catch(() => {});
    }, LOCAL_WRITE_QUIET_MS + STATE_REFRESH_DEBOUNCE_MS);
  }

  function scheduleVolumeFlush() {
    if (state.volumeFlushTimer) return;
    state.volumeFlushTimer = setTimeout(() => {
      state.volumeFlushTimer = null;
      flushVolumeWrites().catch(() => {});
    }, VOLUME_WRITE_INTERVAL_MS);
  }

  async function flushVolumeWrites() {
    if (state.volumeFlushInFlight) return;
    if (!state.wsId) {
      pendingVolumeWrites.clear();
      return;
    }
    state.volumeFlushInFlight = true;
    try {
      // Drain current queue.
      const writes = Array.from(pendingVolumeWrites.values());
      pendingVolumeWrites.clear();
      for (const w of writes) {
        if (!state.wsId) break;
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
        lastSentVolumeByEndpoint.set(endpointKey(endpoint), level);
        schedulePostLocalWriteRefresh();
      }
    } catch {
      // If send failed, force reconnect.
      state.wsId = null;
      state.connectedPort = null;
      state.mixes = [];
      state.channels = [];
      state.outputDevicesState = { mainOutput: null, outputDevices: [] };
      localVolumeIntentByEndpoint.clear();
      state.offlineFeedbackSent = false;
      syncOfflineFeedback().catch(() => {});
      state.wasConnected = false;
      setStatus(false, "Disconnected");
    } finally {
      state.volumeFlushInFlight = false;
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
    if (state.channelsRefreshTimer) return;
    state.channelsRefreshTimer = setTimeout(() => {
      state.channelsRefreshTimer = null;
      if (!state.wsId) return;
      sendJsonRpc("getChannels", {}, 3).catch(() => {});
    }, STATE_REFRESH_DEBOUNCE_MS);
  }

  function scheduleMixesRefresh() {
    if (state.mixesRefreshTimer) return;
    state.mixesRefreshTimer = setTimeout(() => {
      state.mixesRefreshTimer = null;
      if (!state.wsId) return;
      sendJsonRpc("getMixes", {}, 2).catch(() => {});
    }, STATE_REFRESH_DEBOUNCE_MS);
  }

  function scheduleOutputDevicesRefresh() {
    if (!state.wsId) return;
    sendJsonRpc("getOutputDevices", {}, 4).catch(() => {});
  }

  return {
    endpointKey,
    rememberLocalVolumeIntent,
    shouldIgnoreStaleLocalVolume,
    flushVolumeWrites,
    queueVolumeWrite,
    shouldIgnoreStaleFeedbackIntent,
    scheduleChannelsRefresh,
    scheduleMixesRefresh,
    scheduleOutputDevicesRefresh,
  };
}

import {
  nextRequestId,
  RPC_TIMEOUT_MS,
  APP_INFO_TIMEOUT_MS,
  HOST,
  ORIGIN,
  CONNECT_TIMEOUT_MS,
  setStatus,
} from "./protocol.js";

/** connection workflow. */
export function createConnection({
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
}) {
  function describeFromCache(endpoint) {
    if (!endpoint) return null;
    const { identifier, mixer_id } = endpoint;

    // Mix master
    if (!identifier && mixer_id) {
      const mix = Array.isArray(state.mixes)
        ? state.mixes.find((m) => m && String(m.id) === String(mixer_id))
        : null;
      const label = mix?.name ? String(mix.name) : `Wave Link Mix ${mixer_id}`;
      return { label, icon_data: iconDataUrl || null };
    }

    // Channel global / channel-in-mix
    if (identifier) {
      const ch = Array.isArray(state.channels)
        ? state.channels.find((c) => c && String(c.id) === String(identifier))
        : null;
      let label = ch?.name ? String(ch.name) : `Wave Link Channel ${identifier}`;
      if (mixer_id) {
        const mix = Array.isArray(state.mixes)
          ? state.mixes.find((m) => m && String(m.id) === String(mixer_id))
          : null;
        const mixName = mix?.name ? String(mix.name) : String(mixer_id);
        label = `${label} (${mixName})`;
      }
      return { label, icon_data: iconDataUrl || null };
    }

    return { label: "Wave Link", icon_data: iconDataUrl || null };
  }

  async function sendJsonRpc(method, params, id) {
    if (!state.wsId || state.disposed) {
      throw new Error("Wave Link not connected");
    }
    // Keep state query ids stable (1/2/3/4), but use unique ids for rapid write
    // traffic so Wave Link bridge responses cannot collide under high frequency.
    let requestId = id;
    if (id !== 1 && id !== 2 && id !== 3 && id !== 4) {
      requestId = nextRequestId();
    }
    const req = { jsonrpc: "2.0", method, id: requestId };
    if (params && typeof params === "object" && Object.keys(params).length > 0) {
      req.params = params;
    }
    const payload = JSON.stringify(req);
    await ctx.ws.send(state.wsId, payload);
    return requestId;
  }

  function clearPendingRpc(id) {
    const pending = pendingRpcById.get(id);
    if (!pending) return;
    try {
      clearTimeout(pending.timer);
    } catch {}
    pendingRpcById.delete(id);
  }

  function clearAllPendingRpc() {
    for (const [id, pending] of pendingRpcById.entries()) {
      try {
        clearTimeout(pending.timer);
      } catch {}
      try {
        pending.resolve?.({ ok: false, disposed: true });
      } catch {}
      pendingRpcById.delete(id);
    }
  }

  async function requestJsonRpc(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    if (!state.wsId || state.disposed) throw new Error("Wave Link not connected");
    const requestId = nextRequestId();
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
      await ctx.ws.send(state.wsId, JSON.stringify(req));
    } catch (err) {
      clearPendingRpc(requestId);
      throw err;
    }
    return wait;
  }

  async function requestFullState() {
    if (state.disposed || !state.wsId) return;
    try {
      await ctx.ws.send(state.wsId, JSON.stringify({ jsonrpc: "2.0", method: "getMixes", id: 2 }));
      await ctx.ws.send(state.wsId, JSON.stringify({ jsonrpc: "2.0", method: "getChannels", id: 3 }));
      await ctx.ws.send(state.wsId, JSON.stringify({ jsonrpc: "2.0", method: "getOutputDevices", id: 4 }));
    } catch (e) {
      // ignore
    }
  }

  function clearPendingAppInfo(wsKey) {
    const pending = pendingAppInfoByWsId.get(wsKey);
    if (!pending) return;
    try {
      clearTimeout(pending.timer);
    } catch {}
    pendingAppInfoByWsId.delete(wsKey);
  }

  function clearAllPendingAppInfo() {
    for (const [wsKey, pending] of pendingAppInfoByWsId.entries()) {
      try {
        clearTimeout(pending.timer);
      } catch {}
      try {
        pending.resolve?.(null);
      } catch {}
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
    if (state.disposed) return;
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
      try {
        clearTimeout(pending.timer);
      } catch {}
      pendingRpcById.delete(id);
      pending.resolve({
        ok: !json.error,
        result: json.result ?? null,
        error: json.error ?? null,
      });
      return;
    }
    if (id === 1) {
      const key = sourceWsId || state.wsId;
      if (key) {
        const pending = pendingAppInfoByWsId.get(key);
        if (pending && typeof pending.resolve === "function") {
          try {
            clearTimeout(pending.timer);
          } catch {}
          pendingAppInfoByWsId.delete(key);
          state.applicationInfo = json.result || null;
          updateAppInfoUi();
          pending.resolve(state.applicationInfo);
        }
      }
      return;
    }
    if (id === 2) {
      const result = json.result;
      const payload = result?.mixes ?? result;
      if (Array.isArray(payload)) {
        state.mixes = payload;
        syncAllFeedback("mixes").catch(() => {});
      }
      return;
    }
    if (id === 3) {
      const result = json.result;
      const payload = result?.channels ?? result;
      if (Array.isArray(payload)) {
        state.channels = payload;
        syncAllFeedback("channels").catch(() => {});
      }
      return;
    }
    if (id === 4) {
      const result = json.result;
      if (result && typeof result === "object") {
        state.outputDevicesState = {
          mainOutput: result.mainOutput || null,
          outputDevices: Array.isArray(result.outputDevices) ? result.outputDevices : [],
        };
        syncAllFeedback("outputs").catch(() => {});
      }
      return;
    }

    // Notifications (no id)
    if (json.method) {
      if (json.method === "channelsChanged" || json.method === "channelChanged") {
        scheduleChannelsRefresh();
      }
      if (json.method === "mixesChanged" || json.method === "mixChanged") {
        scheduleMixesRefresh();
      }
      if (
        json.method === "outputDevicesChanged" ||
        json.method === "outputDeviceChanged" ||
        json.method === "mainOutputChanged" ||
        json.method === "outputsChanged"
      ) {
        scheduleOutputDevicesRefresh();
      }
    }
  }

  async function openWsCandidate(port) {
    if (state.disposed) return null;
    const url = `ws://${HOST}:${port}`;
    try {
      const id = await ctx.ws.open(url, { Origin: ORIGIN }, CONNECT_TIMEOUT_MS);
      if (state.disposed) {
        try {
          await ctx.ws.close(id);
        } catch {}
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
    if (state.disposed) return false;
    state.connecting = true;
    setStatus(false, "Scanning...", { connecting: true, disconnectedByUser: state.disconnectedByUser });

    let connected = null;
    const ports = await getPortCandidates();
    if (state.disposed) {
      state.connecting = false;
      return false;
    }

    if (ports.length === 0) {
      state.connecting = false;
      setStatus(false, "Not connected", { disconnectedByUser: state.disconnectedByUser });
      return false;
    }

    for (const port of ports) {
      const candidate = await openWsCandidate(port);
      if (state.disposed) {
        if (candidate?.id) {
          try {
            await ctx.ws.close(candidate.id);
          } catch {}
        }
        state.connecting = false;
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
        try {
          await ctx.ws.close(candidateId);
        } catch {}
        continue;
      }

      connected = candidate;
      break;
    }

    if (!connected) {
      state.connecting = false;
      setStatus(false, "Not connected", { disconnectedByUser: state.disconnectedByUser });
      return false;
    }

    state.wsId = connected.id;
    state.connectedPort = connected.port;
    state.connecting = false;
    state.manualConnectRequested = false;
    state.disconnectedByUser = false;
    state.wasConnected = true;
    state.offlineFeedbackSent = false;
    invalidateFeedback();
    setStatus(true, `Connected (:${state.connectedPort})`);

    await requestFullState();
    return true;
  }

  return {
    describeFromCache,
    sendJsonRpc,
    clearAllPendingRpc,
    requestJsonRpc,
    requestFullState,
    clearPendingAppInfo,
    clearAllPendingAppInfo,
    connectOnce,
  };
}

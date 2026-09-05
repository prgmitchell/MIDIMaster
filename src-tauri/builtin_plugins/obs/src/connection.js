import {
  ui,
  setStatus,
  obsAuth,
  clamp01,
  shouldIgnoreLocalMuteEcho,
  inputMuteFeedbackBindingIds,
  sourceFilterKey,
  sleep,
} from "./protocol.js";

/** connection workflow. */
export function createConnection({
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
}) {
  function nextRequestId() {
    state.requestId += 1;
    if (state.requestId > 1000000) state.requestId = 1;
    return state.requestId;
  }

  function getSettings() {
    // Reuse existing UI/localStorage config.
    let host = "localhost";
    let port = 4455;
    let password = "";
    try {
      const stored = localStorage.getItem("obsSettings");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.host) host = String(parsed.host);
        if (parsed.port) port = Number(parsed.port);
        if (parsed.password != null) password = String(parsed.password);
      }
    } catch {}

    const hostEl = ui.hostInput;
    const portEl = ui.portInput;
    const passEl = ui.passwordInput;
    if (hostEl && hostEl.value) host = hostEl.value;
    if (portEl && portEl.value) port = Number(portEl.value);
    if (passEl && passEl.value != null) password = passEl.value;

    return { host, port, password };
  }

  function saveObsSettingsToStorage() {
    const current = getSettings();
    try {
      localStorage.setItem("obsSettings", JSON.stringify(current));
    } catch {}
  }

  function loadObsSettingsFromStorage() {
    let host = "localhost";
    let port = 4455;
    let password = "";
    try {
      const stored = localStorage.getItem("obsSettings");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.host) host = String(parsed.host);
        if (parsed.port) port = Number(parsed.port);
        if (parsed.password != null) password = String(parsed.password);
      }
    } catch {}

    if (ui.hostInput) ui.hostInput.value = host;
    if (ui.portInput) ui.portInput.value = String(port);
    if (ui.passwordInput) ui.passwordInput.value = password;
  }

  async function send(msg) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OBS WebSocket not open");
    }
    state.ws.send(JSON.stringify(msg));
  }

  async function request(requestType, requestData = {}) {
    const id = String(nextRequestId());
    const payload = {
      op: 6,
      d: {
        requestType,
        requestId: id,
        requestData,
      },
    };
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          const entry = pending.get(id);
          pending.delete(id);
          if (entry?.timer) clearTimeout(entry.timer);
          reject(new Error(`OBS request timed out: ${requestType}`));
        }
      }, 4000);
      pending.set(id, { resolve, reject, timer });
    });
    await send(payload);
    return p;
  }

  async function refreshLists() {
    const previousInputs = state.inputList
      .map((i) => i?.inputName)
      .filter(Boolean)
      .map(String)
      .sort()
      .join("\n");
    const previousScenes = state.sceneList
      .map((s) => s?.sceneName)
      .filter(Boolean)
      .map(String)
      .sort()
      .join("\n");

    try {
      const inputs = await request("GetInputList");
      state.inputList = Array.isArray(inputs?.inputs) ? inputs.inputs : [];
    } catch {}
    try {
      const scenes = await request("GetSceneList");
      state.sceneList = Array.isArray(scenes?.scenes) ? scenes.scenes : [];
    } catch {}
    try {
      const cur = await request("GetCurrentProgramScene");
      state.currentScene = cur?.currentProgramSceneName || null;
    } catch {}

    const nextInputs = state.inputList
      .map((i) => i?.inputName)
      .filter(Boolean)
      .map(String)
      .sort()
      .join("\n");
    const nextScenes = state.sceneList
      .map((s) => s?.sceneName)
      .filter(Boolean)
      .map(String)
      .sort()
      .join("\n");
    return previousInputs !== nextInputs || previousScenes !== nextScenes;
  }

  async function discoverAudioInputs() {
    if (!state.connected) return;
    if (state.audioInputsDiscovering || state.audioInputsReady) return;
    state.audioInputsDiscovering = true;
    state.audioInputs = new Set();

    // Limit concurrency so OBS doesn't time out on large setups.
    const names = state.inputList
      .map((i) => i?.inputName)
      .filter(Boolean)
      .map((n) => String(n));

    const limit = 6;
    let idx = 0;
    const workers = new Array(limit).fill(0).map(async () => {
      while (idx < names.length) {
        const name = names[idx++];
        try {
          // Volume support is the fader capability gate. Some valid OBS audio
          // inputs do not expose monitor type reliably, so do not require it.
          await request("GetInputVolume", { inputName: name });
          state.audioInputs.add(name);
        } catch {
          // not audio controllable
        }
      }
    });
    try {
      await Promise.all(workers);
    } catch {
      // ignore
    }
    state.audioInputsReady = true;
    state.audioInputsDiscovering = false;
  }

  async function connectOnce() {
    if (state.disposed) return;
    const { host, port, password } = getSettings();
    const url = `ws://${host}:${port}`;
    state.connecting = true;
    setStatus(false, "Connecting...", { connecting: true });

    state.ws = new WebSocket(url);
    state.connected = false;

    state.ws.onmessage = async (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.op === 0) {
        // Hello
        const auth = msg.d?.authentication;
        const identify = {
          op: 1,
          d: {
            rpcVersion: 1,
            // Subscribe to all events so input volume/mute changes propagate.
            eventSubscriptions: 0xffffffff,
          },
        };
        if (auth && auth.challenge && auth.salt && password) {
          identify.d.authentication = await obsAuth(password, auth.salt, auth.challenge);
        }
        await send(identify);
        return;
      }

      if (msg.op === 2) {
        // Identified
        state.connected = true;
        state.connecting = false;
        state.manualConnectRequested = false;
        setStatus(true, "Connected");
        await state.disconnectedFeedbackPromise.catch(() => {});
        await publishConnectionState(true);
        await refreshLists();
        resetAudioInputDiscovery();
        notifyTargetOptionsChanged();
        await discoverAudioInputs();
        notifyTargetOptionsChanged();
        await syncAllFeedback({ silent: true });
        return;
      }

      if (msg.op === 5) {
        // Event
        const type = msg.d?.eventType;
        const data = msg.d?.eventData || {};
        if (type === "InputVolumeChanged") {
          if (data.inputName != null && data.inputVolumeMul != null) {
            const inputName = String(data.inputName);
            const vol = clamp01(data.inputVolumeMul);
            state.knownVolumes.set(inputName, vol);
            state.audioInputs.add(inputName);

            if (!shouldIgnoreEcho(inputName)) {
              const set = state.bindingsByInputVolume.get(inputName);
              if (set) {
                set.forEach((bid) => {
                  if (shouldIgnoreBindingVolumeEcho(bid, vol)) return;
                  ctx.feedback.set(bid, vol, "Volume", { silent: true }).catch(() => {});
                });
              }
            }
          }
        }
        if (type === "InputMuteStateChanged") {
          if (data.inputName != null && data.inputMuted != null) {
            const inputName = String(data.inputName);
            const muted = Boolean(data.inputMuted);
            const ignoreLocalEcho = shouldIgnoreLocalMuteEcho(localMuteIntentByInput, inputName, muted);
            state.knownMutes.set(inputName, muted);

            if (!ignoreLocalEcho) {
              const muteFeedbackBindings = inputMuteFeedbackBindingIds(
                state.bindingsByInputVolume,
                state.bindingsByInputMute,
                inputName,
              );
              muteFeedbackBindings.forEach((bid) => {
                ctx.feedback.set(bid, muted ? 1.0 : 0.0, "ToggleMute", { silent: true }).catch(() => {});
              });
            }
          }
        }
        if (type === "CurrentProgramSceneChanged") {
          if (data.sceneName != null) state.currentScene = String(data.sceneName);
        }
        if (type === "SceneItemEnableStateChanged" && data.sceneName != null) {
          syncSourceVisibilityForScene(String(data.sceneName), { silent: true }).catch(() => {});
        }
        if (type === "SourceFilterEnableStateChanged" && data.sourceName != null && data.filterName != null) {
          const sourceName = String(data.sourceName);
          const filterName = String(data.filterName);
          const set = state.bindingsBySourceFilter.get(sourceFilterKey(sourceName, filterName));
          if (set) {
            const enabled = Boolean(data.filterEnabled);
            set.forEach((action, bid) => {
              ctx.feedback.set(bid, enabled ? 1.0 : 0.0, action, { silent: true }).catch(() => {});
            });
          }
        }
        if (
          type === "InputCreated" ||
          type === "InputRemoved" ||
          type === "InputNameChanged" ||
          type === "SceneCreated" ||
          type === "SceneRemoved" ||
          type === "SceneNameChanged" ||
          type === "SceneItemCreated" ||
          type === "SceneItemRemoved"
        ) {
          scheduleListRefresh(type);
        }
        if (
          type === "SourceFilterCreated" ||
          type === "SourceFilterRemoved" ||
          type === "SourceFilterNameChanged" ||
          type === "SourceFilterListReindexed"
        ) {
          notifyTargetOptionsChanged();
        }
        return;
      }

      if (msg.op === 7) {
        // Response
        const id = msg.d?.requestId;
        const entry = pending.get(id);
        if (!entry) return;
        if (entry?.timer) clearTimeout(entry.timer);
        pending.delete(id);

        const ok = msg.d?.requestStatus?.result;
        if (!ok) {
          entry.reject(new Error(msg.d?.requestStatus?.comment || "OBS request failed"));
          return;
        }
        entry.resolve(msg.d?.responseData || {});
      }
    };

    state.ws.onclose = () => {
      if (state.disposed) return;
      state.connected = false;
      state.connecting = false;
      setStatus(false, "Disconnected");
      state.ws = null;
      clearPendingRequests();
      pendingVolumeWrites.clear();
      lastSentVolumeByInput.clear();
      resetAudioInputDiscovery();
      notifyTargetOptionsChanged();
      queueDisconnectedFeedbackClear().catch(() => {});
    };

    state.ws.onerror = () => {
      // onclose will follow
    };

    // Wait briefly for identify.
    await sleep(250);
  }

  return {
    saveObsSettingsToStorage,
    loadObsSettingsFromStorage,
    request,
    refreshLists,
    discoverAudioInputs,
    connectOnce,
  };
}

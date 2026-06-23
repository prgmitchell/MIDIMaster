function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

const LOCAL_WRITE_QUIET_MS = 1200;
const FEEDBACK_INTENT_HOLD_MS = 1200;
const FEEDBACK_INTENT_MATCH_EPSILON = 0.02;
const VOLUME_WRITE_INTERVAL_MS = 16;
const VOLUME_WRITE_EPSILON = 0.002;
const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const RECONNECT_IDLE_DELAY_MS = 5000;

function rememberLocalMuteIntent(intents, inputName, muted, now = Date.now()) {
  if (!intents || !inputName) return;
  intents.set(String(inputName), {
    muted: Boolean(muted),
    at: now,
  });
}

function forgetLocalMuteIntent(intents, inputName) {
  if (!intents || !inputName) return;
  intents.delete(String(inputName));
}

function shouldIgnoreLocalMuteEcho(intents, inputName, muted, now = Date.now()) {
  if (!intents || !inputName) return false;
  const key = String(inputName);
  const intent = intents.get(key);
  if (!intent) return false;
  if ((now - Number(intent.at || 0)) >= LOCAL_WRITE_QUIET_MS) {
    intents.delete(key);
    return false;
  }
  if (Boolean(intent.muted) !== Boolean(muted)) {
    intents.delete(key);
    return false;
  }
  return true;
}

export const obsTestUtils = {
  LOCAL_WRITE_QUIET_MS,
  rememberLocalMuteIntent,
  forgetLocalMuteIntent,
  shouldIgnoreLocalMuteEcho,
};

function isOsdWindow() {
  try {
    return new URLSearchParams(window.location.search).get("osd") === "1";
  } catch {
    return false;
  }
}

// Connection UI refs (mounted by the plugin).
const ui = {
  statusText: null,
  statusDot: null,
  connectBtn: null,
  autoConnectInput: null,
  hostInput: null,
  portInput: null,
  passwordInput: null,
};

function setStatus(connected, detail = "", opts = null) {
  const textEl = ui.statusText;
  const dotEl = ui.statusDot;
  const btn = ui.connectBtn;
  const connecting = (opts && typeof opts === "object") ? Boolean(opts.connecting) : false;
  const disconnectedByUser = (opts && typeof opts === "object") ? Boolean(opts.disconnectedByUser) : false;
  if (textEl) {
    textEl.textContent = connected ? (detail || "Connected") : (detail || "Not connected");
  }
  if (dotEl) {
    dotEl.classList.toggle("connected", Boolean(connected));
    dotEl.classList.toggle("connecting", !connected && connecting);
    dotEl.classList.toggle("error", !connected && !connecting && !disconnectedByUser);
  }

  if (btn) {
    if (connecting) {
      btn.disabled = true;
      btn.classList.add("disabled");
      btn.classList.remove("danger");
      btn.textContent = "Connecting...";
      return;
    }

    btn.disabled = false;
    btn.classList.remove("disabled");
    btn.classList.toggle("danger", Boolean(connected));
    btn.textContent = connected ? "Disconnect" : "Connect";
  }
}

async function sha256Base64(text) {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(hash));
  const bin = String.fromCharCode(...arr);
  return btoa(bin);
}

async function obsAuth(password, salt, challenge) {
  const secret = await sha256Base64(password + salt);
  return sha256Base64(secret + challenge);
}

export async function activate(ctx) {
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

  let ws = null;
  let connected = false;
  let connecting = false;
  let disposed = false;
  let requestId = 1;
  const pending = new Map();

  let inputList = [];
  let sceneList = [];
  let listRefreshTimer = null;

  let knownVolumes = new Map();
  let knownMutes = new Map();
  let currentScene = null;

  // ui is module-scoped so setStatus() can access it.

  let audioInputs = new Set();
  let audioInputsReady = false;
  let audioInputsDiscovering = false;

  let bindings = [];
  let bindingsByInputVolume = new Map(); // inputName -> Set(bindingId)
  let bindingsByInputMute = new Map();
  let bindingsBySourceVisibility = new Map(); // sceneName\0sourceName -> Set(bindingId)
  const statefulActionFeedback = new Map(); // bindingId -> last latched value fallback
  const lastLocalWriteAt = new Map(); // inputName -> ms for volume writes
  const localMuteIntentByInput = new Map(); // inputName -> { muted, at }
  const localVolumeIntentByBinding = new Map(); // bindingId -> { value, at }
  const pendingVolumeWrites = new Map(); // inputName -> volume
  const lastSentVolumeByInput = new Map(); // inputName -> volume
  let volumeFlushTimer = null;
  let volumeFlushInFlight = false;

  function clearPendingRequests(errorMessage = null) {
    for (const entry of pending.values()) {
      if (entry?.timer) clearTimeout(entry.timer);
      if (errorMessage && typeof entry?.reject === "function") {
        try { entry.reject(new Error(errorMessage)); } catch {}
      }
    }
    pending.clear();
  }

  function clearRuntimeTimers() {
    if (listRefreshTimer) {
      clearTimeout(listRefreshTimer);
      listRefreshTimer = null;
    }
    if (volumeFlushTimer) {
      clearTimeout(volumeFlushTimer);
      volumeFlushTimer = null;
    }
  }

  function closeSocketForDispose() {
    const current = ws;
    ws = null;
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
    disposed = true;
    connected = false;
    connecting = false;
    manualConnectRequested = false;
    clearRuntimeTimers();
    closeSocketForDispose();
    clearPendingRequests("OBS plugin disposed");
    pendingVolumeWrites.clear();
    lastSentVolumeByInput.clear();
    knownVolumes.clear();
    knownMutes.clear();
    statefulActionFeedback.clear();
    lastLocalWriteAt.clear();
    localMuteIntentByInput.clear();
    localVolumeIntentByBinding.clear();
    resetAudioInputDiscovery();
  }

  ctx.lifecycle?.onDispose?.(disposeObsRuntime);

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
    rebuildBindingIndex();
  }

  function notifyTargetOptionsChanged() {
    try {
      ctx.app?.invalidateBindingsUI?.();
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent("midimaster:integration-targets-changed", {
        detail: { integrationId: "obs" },
      }));
    } catch {}
  }

  function resetAudioInputDiscovery() {
    audioInputs = new Set();
    audioInputsReady = false;
    audioInputsDiscovering = false;
  }

  function scheduleListRefresh(reason = "") {
    if (!connected) return;
    if (listRefreshTimer) {
      clearTimeout(listRefreshTimer);
    }
    listRefreshTimer = setTimeout(() => {
      listRefreshTimer = null;
      (async () => {
        await refreshLists();
        resetAudioInputDiscovery();
        notifyTargetOptionsChanged();
        await discoverAudioInputs();
        notifyTargetOptionsChanged();
        await syncAllFeedback({ silent: true });
      })().catch(() => {});
    }, reason === "connected" ? 0 : 250);
  }

  function rebuildBindingIndex() {
    bindingsByInputVolume = new Map();
    bindingsByInputMute = new Map();
    bindingsBySourceVisibility = new Map();

    for (const b of bindings) {
      const t = b?.target?.Integration || b?.target?.integration;
      if (!t || t.integration_id !== "obs") continue;

      const action = b.action || "Volume";
      if (t.kind === "input") {
        const inputName = t.data?.input_name;
        if (!inputName) continue;
        if (action === "Volume") {
          if (!bindingsByInputVolume.has(inputName)) bindingsByInputVolume.set(inputName, new Set());
          bindingsByInputVolume.get(inputName).add(b.id);
        }
        if (action === "ToggleMute") {
          if (!bindingsByInputMute.has(inputName)) bindingsByInputMute.set(inputName, new Set());
          bindingsByInputMute.get(inputName).add(b.id);
        }
      }
      if (t.kind === "source" && action === "ToggleMute") {
        const sceneName = t.data?.scene_name;
        const sourceName = t.data?.source_name;
        if (!sceneName || !sourceName) continue;
        const key = sourceVisibilityKey(sceneName, sourceName);
        if (!bindingsBySourceVisibility.has(key)) bindingsBySourceVisibility.set(key, new Set());
        bindingsBySourceVisibility.get(key).add(b.id);
      }
    }
  }

  function titleCaseAction(a) {
    const map = {
      ToggleRecord: "Toggle Recording",
      StartRecord: "Start Recording",
      StopRecord: "Stop Recording",
      ToggleStream: "Toggle Streaming",
      ToggleVirtualCam: "Toggle Virtual Camera",
      ToggleReplayBuffer: "Toggle Replay Buffer",
      ToggleStudioMode: "Toggle Studio Mode",
    };
    return map[a] || a;
  }

  function momentaryAction(label, value = "Volume") {
    return { label, value, behavior: "momentary" };
  }

  function statefulAction(label, value = "ToggleMute") {
    return { label, value, behavior: "stateful" };
  }

  function obsActionKind(action) {
    return String(action || "").startsWith("Toggle") ? "stateful" : "momentary";
  }

  function makeActionTarget(action) {
    return { Integration: { integration_id: "obs", kind: "action", data: { action, action_kind: obsActionKind(action) } } };
  }

  function makeSceneTarget(sceneName) {
    return { Integration: { integration_id: "obs", kind: "scene", data: { scene_name: String(sceneName), action_kind: "momentary" } } };
  }

  function makeSourceToggleTarget(sceneName, sourceName) {
    return {
      Integration: {
        integration_id: "obs",
        kind: "source",
        data: {
          scene_name: String(sceneName),
          source_name: String(sourceName),
          action_kind: "stateful",
        },
      },
    };
  }

  function sourceVisibilityKey(sceneName, sourceName) {
    return `${String(sceneName || "")}\u0000${String(sourceName || "")}`;
  }

  function shouldIgnoreEcho(inputName) {
    const t = lastLocalWriteAt.get(String(inputName)) || 0;
    return t > 0 && (Date.now() - t) < LOCAL_WRITE_QUIET_MS;
  }

  function rememberLocalVolumeIntent(bindingId, value) {
    if (!bindingId) return;
    localVolumeIntentByBinding.set(String(bindingId), {
      value: clamp01(value),
      at: Date.now(),
    });
  }

  function shouldIgnoreBindingVolumeEcho(bindingId, confirmedValue) {
    if (!bindingId) return false;
    const key = String(bindingId);
    const intent = localVolumeIntentByBinding.get(key);
    if (!intent) return false;
    if (Date.now() - intent.at >= FEEDBACK_INTENT_HOLD_MS) {
      localVolumeIntentByBinding.delete(key);
      return false;
    }
    const delta = Math.abs(Number(confirmedValue) - Number(intent.value));
    return delta > FEEDBACK_INTENT_MATCH_EPSILON;
  }

  function normalizeBatchTargets(payload) {
    const rawTargets = Array.isArray(payload?.targets) ? payload.targets : [];
    return rawTargets
      .map((entry, index) => {
        const target = entry?.target || entry;
        if (!target || typeof target !== "object") return null;
        return {
          target,
          targetIndex: Number(entry?.target_index ?? index),
          targetCount: Number(entry?.target_count ?? rawTargets.length),
          isPrimaryTarget: entry?.is_primary_target === true,
          originalTargetIndex: Number(entry?.original_target_index ?? entry?.target_index ?? index),
          momentaryTrigger: entry?.momentary_trigger,
          buttonEvent: entry?.button_event,
          buttonActionKind: entry?.button_action_kind,
          buttonInputActive: entry?.button_input_active,
        };
      })
      .filter(Boolean);
  }

  function scheduleVolumeFlush() {
    if (volumeFlushTimer) return;
    volumeFlushTimer = setTimeout(() => {
      volumeFlushTimer = null;
      flushVolumeWrites().catch(() => {});
    }, VOLUME_WRITE_INTERVAL_MS);
  }

  function queueVolumeWrite(inputName, volume) {
    const name = String(inputName || "");
    if (!name) return;
    const level = clamp01(volume);
    const pendingLevel = pendingVolumeWrites.get(name);
    if (typeof pendingLevel === "number" && Math.abs(pendingLevel - level) < VOLUME_WRITE_EPSILON) {
      return;
    }
    const lastSent = lastSentVolumeByInput.get(name);
    if (
      typeof lastSent === "number"
      && Math.abs(lastSent - level) < VOLUME_WRITE_EPSILON
      && !pendingVolumeWrites.has(name)
    ) {
      return;
    }
    pendingVolumeWrites.set(name, level);
    scheduleVolumeFlush();
  }

  async function flushVolumeWrites() {
    if (volumeFlushInFlight) return;
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      pendingVolumeWrites.clear();
      return;
    }

    volumeFlushInFlight = true;
    try {
      const writes = Array.from(pendingVolumeWrites.entries());
      pendingVolumeWrites.clear();
      if (!connected || !ws || ws.readyState !== WebSocket.OPEN || writes.length === 0) {
        return;
      }

      const sentAt = Date.now();
      for (const [inputName, level] of writes) {
        lastLocalWriteAt.set(String(inputName), sentAt);
        lastSentVolumeByInput.set(String(inputName), level);
      }

      await Promise.all(
        writes.map(([inputName, level]) => request("SetInputVolume", {
          inputName,
          inputVolumeMul: level,
        })),
      );
    } finally {
      volumeFlushInFlight = false;
      if (pendingVolumeWrites.size > 0) {
        scheduleVolumeFlush();
      }
    }
  }

  function applyObsVolumeBatch(payload) {
    const bindingId = payload?.binding_id;
    const value = payload?.value;
    const batchTargets = normalizeBatchTargets(payload);
    if (batchTargets.length === 0) return false;

    const vol = clamp01(value);
    let queuedAny = false;

    if (bindingId && batchTargets.some((entry) => entry.isPrimaryTarget)) {
      rememberLocalVolumeIntent(bindingId, vol);
      ctx.feedback.set(bindingId, vol, "Volume", { silent: false }).catch(() => {});
    }

    for (const entry of batchTargets) {
      const target = entry.target;
      if (target.kind !== "input") continue;
      const inputName = target.data?.input_name;
      if (!inputName) continue;
      knownVolumes.set(String(inputName), vol);
      queueVolumeWrite(inputName, vol);
      queuedAny = true;
    }

    if (queuedAny) {
      flushVolumeWrites().catch(() => {});
    }

    return queuedAny;
  }

  function buttonEvent(payload) {
    const explicit = String(payload?.button_event || "").toLowerCase();
    if (explicit === "press" || explicit === "release") return explicit;
    if (payload?.momentary_trigger === false) return "release";
    if (payload?.momentary_trigger === true) return "press";
    return clamp01(payload?.value) > 0.0 ? "press" : "release";
  }

  async function setMomentaryFeedback(bindingId, action, active) {
    if (!bindingId) return;
    const value = active ? 1.0 : 0.0;
    await ctx.feedback.set(bindingId, value, action, { inputValue: value });
  }

  async function readStatefulActionValue(action) {
    try {
      if (action === "ToggleRecord") {
        const status = await request("GetRecordStatus");
        return Boolean(status?.outputActive);
      }
      if (action === "ToggleStream") {
        const status = await request("GetStreamStatus");
        return Boolean(status?.outputActive);
      }
      if (action === "ToggleVirtualCam") {
        const status = await request("GetVirtualCamStatus");
        return Boolean(status?.outputActive);
      }
      if (action === "ToggleReplayBuffer") {
        const status = await request("GetReplayBufferStatus");
        return Boolean(status?.outputActive);
      }
      if (action === "ToggleStudioMode") {
        const status = await request("GetStudioModeEnabled");
        return Boolean(status?.studioModeEnabled);
      }
    } catch {
      return null;
    }
    return null;
  }

  async function syncAllFeedback(opts = null) {
    if (!connected) return;
    const silent = opts && typeof opts === "object" ? Boolean(opts.silent) : true;

    // Only sync inputs that are bound in the active profile.
    const inputNames = new Set([
      ...Array.from(bindingsByInputVolume.keys()),
      ...Array.from(bindingsByInputMute.keys()),
    ]);

    for (const inputName of inputNames) {
      try {
        const [volRes, muteRes] = await Promise.all([
          request("GetInputVolume", { inputName }),
          request("GetInputMute", { inputName }),
        ]);
        const vol = clamp01(volRes?.inputVolumeMul);
        const muted = Boolean(muteRes?.inputMuted);
        knownVolumes.set(String(inputName), vol);
        knownMutes.set(String(inputName), muted);

        const volBindings = bindingsByInputVolume.get(inputName);
        if (volBindings) {
          for (const bid of volBindings) {
            await ctx.feedback.set(bid, vol, "Volume", { silent });
          }
        }
        const muteBindings = bindingsByInputMute.get(inputName);
        if (muteBindings) {
          for (const bid of muteBindings) {
            await ctx.feedback.set(bid, muted ? 1.0 : 0.0, "ToggleMute", { silent });
          }
        }
      } catch {
        // ignore
      }
    }

    const scenesWithVisibilityBindings = new Set(
      Array.from(bindingsBySourceVisibility.keys()).map((key) => key.split("\u0000")[0]).filter(Boolean),
    );
    for (const sceneName of scenesWithVisibilityBindings) {
      await syncSourceVisibilityForScene(sceneName, { silent });
    }
  }

  async function syncSourceVisibilityForScene(sceneName, opts = null) {
    if (!connected || !sceneName) return;
    const silent = opts && typeof opts === "object" ? Boolean(opts.silent) : true;
    try {
      const list = await request("GetSceneItemList", { sceneName });
      const items = Array.isArray(list.sceneItems) ? list.sceneItems : [];
      for (const item of items) {
        const sourceName = item?.sourceName;
        if (!sourceName) continue;
        const set = bindingsBySourceVisibility.get(sourceVisibilityKey(sceneName, sourceName));
        if (!set) continue;
        const enabled = Boolean(item.sceneItemEnabled);
        for (const bid of set) {
          await ctx.feedback.set(bid, enabled ? 1.0 : 0.0, "ToggleMute", { silent });
        }
      }
    } catch {
      // ignore
    }
  }

  function nextRequestId() {
    requestId += 1;
    if (requestId > 1000000) requestId = 1;
    return requestId;
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
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("OBS WebSocket not open");
    }
    ws.send(JSON.stringify(msg));
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
    const previousInputs = inputList
      .map((i) => i?.inputName)
      .filter(Boolean)
      .map(String)
      .sort()
      .join("\n");
    const previousScenes = sceneList
      .map((s) => s?.sceneName)
      .filter(Boolean)
      .map(String)
      .sort()
      .join("\n");

    try {
      const inputs = await request("GetInputList");
      inputList = Array.isArray(inputs?.inputs) ? inputs.inputs : [];
    } catch {}
    try {
      const scenes = await request("GetSceneList");
      sceneList = Array.isArray(scenes?.scenes) ? scenes.scenes : [];
    } catch {}
    try {
      const cur = await request("GetCurrentProgramScene");
      currentScene = cur?.currentProgramSceneName || null;
    } catch {}

    const nextInputs = inputList
      .map((i) => i?.inputName)
      .filter(Boolean)
      .map(String)
      .sort()
      .join("\n");
    const nextScenes = sceneList
      .map((s) => s?.sceneName)
      .filter(Boolean)
      .map(String)
      .sort()
      .join("\n");
    return previousInputs !== nextInputs || previousScenes !== nextScenes;
  }

  async function discoverAudioInputs() {
    if (!connected) return;
    if (audioInputsDiscovering || audioInputsReady) return;
    audioInputsDiscovering = true;
    audioInputs = new Set();

    // Limit concurrency so OBS doesn't time out on large setups.
    const names = inputList
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
          audioInputs.add(name);
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
    audioInputsReady = true;
    audioInputsDiscovering = false;
  }

  async function connectOnce() {
    if (disposed) return;
    const { host, port, password } = getSettings();
    const url = `ws://${host}:${port}`;
    connecting = true;
    setStatus(false, "Connecting...", { connecting: true });

    ws = new WebSocket(url);
    connected = false;

    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== "object") return;

      if (msg.op === 0) {
        // Hello
        const auth = msg.d?.authentication;
        const identify = {
          op: 1,
          d: {
            rpcVersion: 1,
            // Subscribe to all events so input volume/mute changes propagate.
            eventSubscriptions: 0xFFFFFFFF,
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
        connected = true;
        connecting = false;
        manualConnectRequested = false;
        setStatus(true, "Connected");
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
            knownVolumes.set(inputName, vol);
            audioInputs.add(inputName);

            if (!shouldIgnoreEcho(inputName)) {
              const set = bindingsByInputVolume.get(inputName);
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
            knownMutes.set(inputName, muted);

            if (!ignoreLocalEcho) {
              const set = bindingsByInputMute.get(inputName);
              if (set) {
                set.forEach((bid) => {
                  ctx.feedback.set(bid, muted ? 1.0 : 0.0, "ToggleMute", { silent: true }).catch(() => {});
                });
              }
            }
          }
        }
        if (type === "CurrentProgramSceneChanged") {
          if (data.sceneName != null) currentScene = String(data.sceneName);
        }
        if (type === "SceneItemEnableStateChanged" && data.sceneName != null) {
          syncSourceVisibilityForScene(String(data.sceneName), { silent: true }).catch(() => {});
        }
        if (
          type === "InputCreated"
          || type === "InputRemoved"
          || type === "InputNameChanged"
          || type === "SceneCreated"
          || type === "SceneRemoved"
          || type === "SceneNameChanged"
          || type === "SceneItemCreated"
          || type === "SceneItemRemoved"
        ) {
          scheduleListRefresh(type);
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

    ws.onclose = () => {
      if (disposed) return;
      connected = false;
      connecting = false;
      setStatus(false, "Disconnected");
      ws = null;
      clearPendingRequests();
      pendingVolumeWrites.clear();
      lastSentVolumeByInput.clear();
      resetAudioInputDiscovery();
      notifyTargetOptionsChanged();
    };

    ws.onerror = () => {
      // onclose will follow
    };

    // Wait briefly for identify.
    await sleep(250);
  }

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
      // If user turned off auto-connect, treat it as an intentional disconnect.
      disconnectedByUser = true;
    }
    if (ui.autoConnectInput) {
      ui.autoConnectInput.checked = next;
    }
    // If auto-connect was enabled and we're disconnected, try soon.
    if (next && !connected && !connecting) {
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

  // Reconnect loop (auto-connect or manual connect)
  (async () => {
    while (!disposed) {
      let delay = RECONNECT_IDLE_DELAY_MS;
      if (!connected && !connecting && !disconnectedByUser && (autoConnect || manualConnectRequested)) {
        try {
          await connectOnce();
          if (connected) {
            resetReconnectBackoff();
          } else {
            growReconnectBackoff();
          }
        } catch {
          if (disposed) return;
          connecting = false;
          setStatus(false, "Not connected", { disconnectedByUser });
          growReconnectBackoff();
        }
        delay = reconnectDelayMs;
      } else {
        resetReconnectBackoff();
      }
      await sleep(delay);
    }
  })();

  async function handleObsBindingTrigger(payload) {
    const bindingId = payload?.binding_id;
    const action = payload?.action;
    const value = payload?.value;
    const isPrimaryTarget = payload?.is_primary_target !== false;
    const targetIndex = Number(payload?.target_index ?? 0);
    const targetCount = Number(payload?.target_count ?? 1);
    const target = payload?.target || {};
    const kind = target.kind;
    const data = target.data || {};

    if (!connected) return;

    if (kind === "input") {
      const inputName = data.input_name;
      if (!inputName) return;
      if (action === "Volume") {
        applyObsVolumeBatch({
          binding_id: bindingId,
          action,
          value,
          targets: [{
            target,
            target_index: targetIndex,
            target_count: targetCount,
            is_primary_target: isPrimaryTarget,
          }],
        });
      } else if (action === "ToggleMute") {
        const muted = clamp01(value) > 0.5;
        rememberLocalMuteIntent(localMuteIntentByInput, inputName, muted);
        try {
          await request("SetInputMute", { inputName, inputMuted: muted });
        } catch (err) {
          forgetLocalMuteIntent(localMuteIntentByInput, inputName);
          throw err;
        }
        knownMutes.set(String(inputName), muted);
        if (bindingId) await ctx.feedback.set(bindingId, muted ? 1.0 : 0.0, action);
      }
      return;
    }

    if (kind === "action") {
      const a = data.action;
      if (!a) return;
      const stateful = String(data.action_kind || "").toLowerCase() === "stateful"
        || String(payload?.button_action_kind || "").toLowerCase() === "stateful"
        || obsActionKind(a) === "stateful";
      const eventKind = buttonEvent(payload);
      if (stateful) {
        if (eventKind !== "press") return;
      } else {
        if (eventKind === "release") {
          await setMomentaryFeedback(bindingId, action, false);
          return;
        }
        await setMomentaryFeedback(bindingId, action, true);
      }
      const map = {
        StartRecord: "StartRecord",
        StopRecord: "StopRecord",
        ToggleRecord: "ToggleRecord",
        ToggleStream: "ToggleStream",
        ToggleVirtualCam: "ToggleVirtualCam",
        ToggleReplayBuffer: "ToggleReplayBuffer",
      };
      let actionResponse = null;
      let expectedState = null;
      if (a === "ToggleStudioMode") {
        const cur = await request("GetStudioModeEnabled");
        expectedState = !Boolean(cur.studioModeEnabled);
        await request("SetStudioModeEnabled", { studioModeEnabled: expectedState });
      } else if (map[a]) {
        actionResponse = await request(map[a]);
      }
      if (stateful) {
        if (actionResponse && typeof actionResponse.outputActive === "boolean") {
          expectedState = actionResponse.outputActive;
        }
        if (expectedState == null) {
          await sleep(120);
        }
        const active = expectedState == null ? await readStatefulActionValue(a) : expectedState;
        const previous = bindingId ? statefulActionFeedback.get(bindingId) : undefined;
        const feedbackValue = active == null ? !Boolean(previous) : active;
        if (bindingId) statefulActionFeedback.set(bindingId, feedbackValue);
        if (bindingId) await ctx.feedback.set(bindingId, feedbackValue ? 1.0 : 0.0, action);
      }
      return;
    }

    if (kind === "scene") {
      const eventKind = buttonEvent(payload);
      if (eventKind === "release") {
        await setMomentaryFeedback(bindingId, action, false);
        return;
      }
      await setMomentaryFeedback(bindingId, action, true);
      const sceneName = data.scene_name;
      if (!sceneName) return;
      await request("SetCurrentProgramScene", { sceneName });
      currentScene = String(sceneName);
      return;
    }

    if (kind === "source") {
      const sceneName = data.scene_name;
      const sourceName = data.source_name;
      if (!sceneName || !sourceName) return;

      const list = await request("GetSceneItemList", { sceneName });
      const items = Array.isArray(list.sceneItems) ? list.sceneItems : [];
      const item = items.find((i) => i && i.sourceName === sourceName);
      if (!item) return;
      const enabled = clamp01(value) > 0.5;
      await request("SetSceneItemEnabled", {
        sceneName,
        sceneItemId: item.sceneItemId,
        sceneItemEnabled: enabled,
      });
      if (bindingId) await ctx.feedback.set(bindingId, enabled ? 1.0 : 0.0, action);
      return;
    }

    if (kind === "media") {
      const eventKind = buttonEvent(payload);
      if (eventKind === "release") {
        await setMomentaryFeedback(bindingId, action, false);
        return;
      }
      await setMomentaryFeedback(bindingId, action, true);
      const inputName = data.source_name;
      const mediaAction = data.action;
      if (!inputName || !mediaAction) return;
      await request("TriggerMediaInputAction", { inputName, mediaAction });
    }
  }

  ctx.registerIntegration({
    id: "obs",
    name: "OBS Studio",
    icon_data: iconDataUrl || null,
    buttonActions: [
      momentaryAction("Trigger", "Volume"),
      statefulAction("Toggle Mute", "ToggleMute"),
    ],
    describeTarget: (target) => {
      const t = target?.Integration || target?.integration;
      const data = t?.data || {};
      const icon_data = (typeof data.icon_data === "string" && data.icon_data.trim())
        ? data.icon_data
        : (iconDataUrl || null);

      let label = (typeof data.label === "string" && data.label.trim()) ? data.label : "";
      if (!label) {
        if (t?.kind === "input") label = String(data.input_name || "OBS Input");
        else if (t?.kind === "source") label = String(data.source_name || "Source");
        else if (t?.kind === "scene") label = String(data.scene_name || "OBS Scene");
        else if (t?.kind === "action") label = titleCaseAction(data.action || "Action");
        else label = "OBS Studio";
      }

      return { label: String(label), icon_data, ghost: !connected };
    },
    getTargetOptions: async (ctx2 = null) => {
      if (!connected) return [];
      const listChanged = await refreshLists();
      if (listChanged) {
        resetAudioInputDiscovery();
      }
      const controlType = ctx2 && typeof ctx2 === "object" ? ctx2.controlType : null;
      const nav = ctx2 && typeof ctx2 === "object" ? ctx2.nav : null;
      const opts = [];

      // Faders should only see volume-capable targets.
      if (controlType === "fader") {
        if (!audioInputsReady) {
          await discoverAudioInputs();
        }
        for (const input of inputList) {
          const name = input?.inputName;
          if (!name) continue;
          if (audioInputsReady && !audioInputs.has(String(name))) {
            continue;
          }
          opts.push({
            label: String(name),
            icon_data: iconDataUrl || null,
            target: { Integration: { integration_id: "obs", kind: "input", data: { input_name: String(name) } } },
          });
        }
        if (opts.length === 0) {
          return [{
            label: "No compatible targets found for this control.",
            kind: "placeholder",
            ghost: true,
            icon_data: iconDataUrl || null,
            category: "integrations",
            suppressUnavailableTag: true,
          }];
        }
        return opts;
      }

      // Button navigation: Scenes -> Scene Items
      if (nav && nav.screen === "scene" && nav.sceneName) {
        const sceneName = String(nav.sceneName);

        opts.push({
          label: String(sceneName),
          icon_data: iconDataUrl || null,
          target: makeSceneTarget(sceneName),
          buttonActions: [momentaryAction("Switch Scene", "Volume")],
        });

        // Fetch scene items live so the list matches OBS state.
        // This is only used during target selection, so latency is OK.
        try {
          const list = await request("GetSceneItemList", { sceneName });
          const items = Array.isArray(list.sceneItems) ? list.sceneItems : [];
          for (const item of items) {
            const sourceName = item?.sourceName;
            if (!sourceName) continue;
            opts.push({
              label: String(sourceName),
              icon_data: iconDataUrl || null,
              target: makeSourceToggleTarget(sceneName, sourceName),
              buttonActions: [statefulAction("Toggle Visibility", "ToggleMute")],
            });
          }
        } catch {
          // ignore
        }

        return opts;
      }

      opts.push({ kind: "divider", label: "Actions" });

      // Common actions
      const actions = [
        "ToggleRecord",
        "StartRecord",
        "StopRecord",
        "ToggleStream",
        "ToggleVirtualCam",
        "ToggleReplayBuffer",
        "ToggleStudioMode",
      ];
      for (const a of actions) {
        const actionKind = obsActionKind(a);
        opts.push({
          label: titleCaseAction(a),
          icon_data: iconDataUrl || null,
          target: makeActionTarget(a),
          buttonActions: [
            actionKind === "stateful"
              ? statefulAction(titleCaseAction(a), "Volume")
              : momentaryAction(titleCaseAction(a), "Volume"),
          ],
        });
      }

      opts.push({ kind: "divider", label: "Scenes" });

      // Scenes as a navigation list
      for (const scene of sceneList) {
        const name = scene?.sceneName;
        if (!name) continue;
        opts.push({
          label: String(name),
          icon_data: iconDataUrl || null,
          nav: { screen: "scene", sceneName: String(name) },
        });
      }

      opts.push({ kind: "divider", label: "Audio Sources (Mute)" });

      // Inputs
      for (const input of inputList) {
        const name = input?.inputName;
        if (!name) continue;
        opts.push({
          label: String(name),
          icon_data: iconDataUrl || null,
          target: { Integration: { integration_id: "obs", kind: "input", data: { input_name: String(name) } } },
          buttonActions: [statefulAction("Toggle Mute", "ToggleMute")],
        });
      }

      // Scenes
      // (Scene switching now lives under scene navigation)

      return opts;
    },
    onBindingTriggeredBatch: async (payload) => {
      if (!connected) return;
      if (payload?.action !== "Volume") return;
      try {
        const batchTargets = normalizeBatchTargets(payload);
        const inputTargets = batchTargets.filter((entry) => entry.target?.kind === "input");
        const otherTargets = batchTargets.filter((entry) => entry.target?.kind !== "input");
        if (inputTargets.length > 0) {
          applyObsVolumeBatch({
            ...payload,
            targets: inputTargets.map((entry) => ({
              target: entry.target,
              target_index: entry.targetIndex,
              target_count: entry.targetCount,
              is_primary_target: entry.isPrimaryTarget,
              original_target_index: entry.originalTargetIndex,
            })),
          });
        }
        for (const entry of otherTargets) {
          await handleObsBindingTrigger({
            ...payload,
            target: entry.target,
            target_index: entry.targetIndex,
            target_count: entry.targetCount,
            is_primary_target: entry.isPrimaryTarget,
            original_target_index: entry.originalTargetIndex,
            momentary_trigger: entry.momentaryTrigger,
            button_event: entry.buttonEvent,
            button_action_kind: entry.buttonActionKind,
            button_input_active: entry.buttonInputActive,
          });
        }
      } catch {
        pendingVolumeWrites.clear();
      }
    },
    onBindingTriggered: async (payload) => {
      try {
        await handleObsBindingTrigger(payload);
      } catch (e) {
        // ignore
        pendingVolumeWrites.clear();
      }
    },
  });

  // Bindings feed for two-way sync
  setBindings(readBindings());
  ctx.bindings?.onChanged?.((next) => {
    if (disposed) return;
    setBindings(next);
    syncAllFeedback({ silent: true }).catch(() => {});
  });

  // Connections panel tab
  ctx.connections?.registerTab?.({
    id: "obs",
    name: "OBS Studio",
    icon_data: iconDataUrl || null,
    order: 10,
    mount: (container) => {
      container.innerHTML = `
        <div class="connection-item-header">
          <div class="connection-info">
            <img src="${iconDataUrl || ""}" alt="OBS" class="connection-icon" />
            <span class="connection-name">OBS Studio</span>
          </div>
          <div class="connection-status">
            <span class="connection-status-dot" data-role="dot"></span>
            <span data-role="text">Not connected</span>
          </div>
        </div>
        <div class="connection-content-wrapper">
          <div class="connection-grid">
            <div class="connection-row">
              <label>Host</label>
              <input data-role="host" type="text" placeholder="localhost" />
            </div>
            <div class="connection-row">
              <label>Password</label>
              <input data-role="password" type="password" placeholder="Optional" />
            </div>
            <div class="connection-row">
              <label>Port</label>
              <input data-role="port" type="number" value="4455" placeholder="4455" />
            </div>
          </div>
          <div class="connection-description">
            <p>Bind faders to OBS audio sources. Bind buttons to recording/stream actions, scene switching, and source visibility.</p>
          </div>
        </div>
        <div class="connection-footer">
          <button type="button" class="connection-button" data-role="connect">Connect</button>
          <div class="connection-row checkbox-row">
            <input type="checkbox" data-role="auto" id="obs-auto-connect" />
            <label for="obs-auto-connect">Auto connect</label>
          </div>
        </div>
      `;

      ui.statusText = container.querySelector('[data-role="text"]');
      ui.statusDot = container.querySelector('[data-role="dot"]');
      ui.hostInput = container.querySelector('[data-role="host"]');
      ui.portInput = container.querySelector('[data-role="port"]');
      ui.passwordInput = container.querySelector('[data-role="password"]');
      ui.connectBtn = container.querySelector('[data-role="connect"]');
      ui.autoConnectInput = container.querySelector('[data-role="auto"]');

      loadObsSettingsFromStorage();
      [ui.hostInput, ui.portInput, ui.passwordInput].forEach((el) => {
        el?.addEventListener("change", saveObsSettingsToStorage);
        el?.addEventListener("input", saveObsSettingsToStorage);
      });

      // Auto-connect (profile-scoped)
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
          if (connected) {
            disconnectedByUser = true;
            manualConnectRequested = false;
            try { ws?.close(); } catch { }
            ws = null;
            connected = false;
            connecting = false;
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

      // Apply current status
      setStatus(connected, connected ? "Connected" : "Not connected", { connecting, disconnectedByUser });
    },
    unmount: () => {
      ui.statusText = null;
      ui.statusDot = null;
      ui.connectBtn = null;
      ui.autoConnectInput = null;
      ui.hostInput = null;
      ui.portInput = null;
      ui.passwordInput = null;
    },
  });
}

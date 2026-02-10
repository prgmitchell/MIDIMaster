function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

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
  let requestId = 1;
  const pending = new Map();

  let inputList = [];
  let sceneList = [];

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
  const lastLocalWriteAt = new Map(); // inputName -> ms

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

  function rebuildBindingIndex() {
    bindingsByInputVolume = new Map();
    bindingsByInputMute = new Map();

    for (const b of bindings) {
      const t = b?.target?.Integration || b?.target?.integration;
      if (!t || t.integration_id !== "obs") continue;
      if (t.kind !== "input") continue;
      const inputName = t.data?.input_name;
      if (!inputName) continue;

      const action = b.action || "Volume";
      if (action === "Volume") {
        if (!bindingsByInputVolume.has(inputName)) bindingsByInputVolume.set(inputName, new Set());
        bindingsByInputVolume.get(inputName).add(b.id);
      }
      if (action === "ToggleMute") {
        if (!bindingsByInputMute.has(inputName)) bindingsByInputMute.set(inputName, new Set());
        bindingsByInputMute.get(inputName).add(b.id);
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

  function makeActionTarget(action) {
    return { Integration: { integration_id: "obs", kind: "action", data: { action } } };
  }

  function makeSceneTarget(sceneName) {
    return { Integration: { integration_id: "obs", kind: "scene", data: { scene_name: String(sceneName) } } };
  }

  function makeSourceToggleTarget(sceneName, sourceName) {
    return {
      Integration: {
        integration_id: "obs",
        kind: "source",
        data: {
          scene_name: String(sceneName),
          source_name: String(sourceName),
        },
      },
    };
  }

  function shouldIgnoreEcho(inputName) {
    const t = lastLocalWriteAt.get(String(inputName)) || 0;
    return t > 0 && (Date.now() - t) < 350;
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
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`OBS request timed out: ${requestType}`));
        }
      }, 4000);
    });
    await send(payload);
    return p;
  }

  async function refreshLists() {
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
          // Require that the input both supports volume AND has an audio monitor type.
          // This helps filter inputs that exist but aren't audio-controllable.
          await request("GetInputVolume", { inputName: name });
          await request("GetInputAudioMonitorType", { inputName: name });
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
        await discoverAudioInputs();
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
            knownMutes.set(inputName, muted);

            if (!shouldIgnoreEcho(inputName)) {
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
        return;
      }

      if (msg.op === 7) {
        // Response
        const id = msg.d?.requestId;
        const entry = pending.get(id);
        if (!entry) return;
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
      connected = false;
      connecting = false;
      setStatus(false, "Disconnected");
      ws = null;
      pending.clear();
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
    }
  }

  try {
    applyProfileSettings(ctx.profile?.get?.());
    ctx.profile?.onChanged?.((ev) => applyProfileSettings(ev?.settings || ev));
  } catch {
    // ignore
  }

  // Reconnect loop (auto-connect or manual connect)
  (async () => {
    while (true) {
      if (!connected && !connecting && !disconnectedByUser && (autoConnect || manualConnectRequested)) {
        try {
          await connectOnce();
        } catch {
          connecting = false;
          setStatus(false, "Not connected", { disconnectedByUser });
        }
      }
      await sleep(1000);
    }
  })();

  ctx.registerIntegration({
    id: "obs",
    name: "OBS Studio",
    icon_data: iconDataUrl || null,
    describeTarget: (target) => {
      const t = target?.Integration || target?.integration;
      const data = t?.data || {};
      const icon_data = (typeof data.icon_data === "string" && data.icon_data.trim())
        ? data.icon_data
        : (iconDataUrl || null);

      let label = (typeof data.label === "string" && data.label.trim()) ? data.label : "";
      if (!label) {
        if (t?.kind === "input") label = String(data.input_name || "OBS Input");
        else if (t?.kind === "source") label = `${data.source_name || "Source"} (Toggle Visibility)`;
        else if (t?.kind === "scene") label = String(data.scene_name || "OBS Scene");
        else if (t?.kind === "action") label = titleCaseAction(data.action || "Action");
        else label = "OBS Studio";
      }

      return { label: String(label), icon_data, ghost: !connected };
    },
    getTargetOptions: async (ctx2 = null) => {
      if (!connected) return [];
      const controlType = ctx2 && typeof ctx2 === "object" ? ctx2.controlType : null;
      const nav = ctx2 && typeof ctx2 === "object" ? ctx2.nav : null;
      const opts = [];

      // Faders should only see volume-capable targets.
      if (controlType === "fader") {
        if (!audioInputsReady) {
          // Kick off discovery if needed.
          discoverAudioInputs().catch(() => {});
          return [{ label: "Discovering audio sources...", kind: "placeholder", ghost: true }];
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
        return opts;
      }

      // Button navigation: Scenes -> Scene Items
      if (nav && nav.screen === "scene" && nav.sceneName) {
        const sceneName = String(nav.sceneName);

        opts.push({
          label: `Switch to ${sceneName}`,
          icon_data: iconDataUrl || null,
          target: makeSceneTarget(sceneName),
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
              label: `${sourceName} (Toggle Visibility)`,
              icon_data: iconDataUrl || null,
              target: makeSourceToggleTarget(sceneName, sourceName),
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
        opts.push({
          label: titleCaseAction(a),
          icon_data: iconDataUrl || null,
          target: makeActionTarget(a),
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
        });
      }

      // Scenes
      // (Scene switching now lives under scene navigation)

      return opts;
    },
    onBindingTriggered: async (payload) => {
      const bindingId = payload?.binding_id;
      const action = payload?.action;
      const value = payload?.value;
      const target = payload?.target || {};
      const kind = target.kind;
      const data = target.data || {};

      if (!connected) return;

      try {
        if (kind === "input") {
          const inputName = data.input_name;
          if (!inputName) return;
          if (action === "Volume") {
            const vol = clamp01(value);
            lastLocalWriteAt.set(String(inputName), Date.now());
            await request("SetInputVolume", { inputName, inputVolumeMul: vol });
            knownVolumes.set(String(inputName), vol);
            if (bindingId) await ctx.feedback.set(bindingId, vol, action);
          } else if (action === "ToggleMute") {
            const muted = clamp01(value) > 0.5;
            lastLocalWriteAt.set(String(inputName), Date.now());
            await request("SetInputMute", { inputName, inputMuted: muted });
            knownMutes.set(String(inputName), muted);
            if (bindingId) await ctx.feedback.set(bindingId, muted ? 1.0 : 0.0, action);
          }
          return;
        }

        if (kind === "action") {
          if (clamp01(value) <= 0.0) return;
          const a = data.action;
          if (!a) return;
          // Map to request types
          const map = {
            StartRecord: "StartRecord",
            StopRecord: "StopRecord",
            ToggleRecord: "ToggleRecord",
            ToggleStream: "ToggleStream",
            ToggleVirtualCam: "ToggleVirtualCam",
            ToggleReplayBuffer: "ToggleReplayBuffer",
          };
          if (a === "ToggleStudioMode") {
            const cur = await request("GetStudioModeEnabled");
            await request("SetStudioModeEnabled", { studioModeEnabled: !cur.studioModeEnabled });
          } else if (map[a]) {
            await request(map[a]);
          }
          if (bindingId) await ctx.feedback.set(bindingId, 1.0, action);
          return;
        }

        if (kind === "scene") {
          if (clamp01(value) <= 0.0) return;
          const sceneName = data.scene_name;
          if (!sceneName) return;
          await request("SetCurrentProgramScene", { sceneName });
          currentScene = String(sceneName);
          if (bindingId) await ctx.feedback.set(bindingId, 1.0, action);
          return;
        }

        if (kind === "source") {
          if (clamp01(value) <= 0.0) return;
          const sceneName = data.scene_name;
          const sourceName = data.source_name;
          if (!sceneName || !sourceName) return;

          const list = await request("GetSceneItemList", { sceneName });
          const items = Array.isArray(list.sceneItems) ? list.sceneItems : [];
          const item = items.find((i) => i && i.sourceName === sourceName);
          if (!item) return;
          await request("SetSceneItemEnabled", {
            sceneName,
            sceneItemId: item.sceneItemId,
            sceneItemEnabled: !item.sceneItemEnabled,
          });
          if (bindingId) await ctx.feedback.set(bindingId, 1.0, action);
          return;
        }

        if (kind === "media") {
          if (clamp01(value) <= 0.0) return;
          const inputName = data.source_name;
          const mediaAction = data.action;
          if (!inputName || !mediaAction) return;
          await request("TriggerMediaInputAction", { inputName, mediaAction });
          if (bindingId) await ctx.feedback.set(bindingId, 1.0, action);
        }
      } catch (e) {
        // ignore
      }
    },
  });

  // Bindings feed for two-way sync
  setBindings(readBindings());
  ctx.bindings?.onChanged?.((next) => {
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
            connecting = false;
            setStatus(false, "Not connected", { disconnectedByUser });
          });
        });
      }

      // Apply current status
      setStatus(connected, connected ? "Connected" : "Not connected", { connecting, disconnectedByUser });
    },
  });
}

const ORIGIN = "streamdeck://";
const HOST = "127.0.0.1";
const PORT_START = 1884;
const PORT_END = 1893;

// Wave Link (and the websocket bridge) can get overwhelmed if we send a JSON-RPC
// message for every tiny fader tick. Coalesce rapid volume updates and only send
// the latest value at a steady rate.
const VOLUME_WRITE_INTERVAL_MS = 16;
const VOLUME_WRITE_EPSILON = 0.002;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Connection UI refs (mounted by the plugin).
const ui = {
  statusText: null,
  statusDot: null,
  connectBtn: null,
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

  // New shapes
  if (t.kind === "mix") {
    return { identifier: "", mixer_id: String(data.mixer_id || "") };
  }
  if (t.kind === "channel") {
    return { identifier: String(data.identifier || ""), mixer_id: "" };
  }
  if (t.kind === "channel_mix") {
    return { identifier: String(data.identifier || ""), mixer_id: String(data.mixer_id || "") };
  }

  // Back-compat
  if (t.kind === "endpoint") {
    return {
      identifier: String(data.identifier || ""),
      mixer_id: String(data.mixer_id || ""),
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
      disconnectedByUser = true;
    }
    if (ui.autoConnectInput) {
      ui.autoConnectInput.checked = next;
    }
    if (next && !wsId && !connecting) {
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
  let mixes = [];
  let channels = [];

  let bindings = [];

  const pendingVolumeWrites = new Map();
  const lastSentVolumeByEndpoint = new Map();
  let volumeFlushTimer = null;
  let volumeFlushInFlight = false;

  function endpointKey(endpoint) {
    if (!endpoint) return "";
    return `${String(endpoint.identifier || "")}::${String(endpoint.mixer_id || "")}`;
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
        lastSentVolumeByEndpoint.set(endpointKey(endpoint), level);
      }
    } catch {
      // If send failed, force reconnect.
      wsId = null;
      connectedPort = null;
      mixes = [];
      channels = [];
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
        } else if (action === "ToggleMute") {
          await ctx.feedback.set(b.id, 0.0, "ToggleMute", { silent: true });
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
    if (!wsId) {
      throw new Error("Wave Link not connected");
    }
    const req = { jsonrpc: "2.0", method, id };
    if (params && typeof params === "object" && Object.keys(params).length > 0) {
      req.params = params;
    }
    const payload = JSON.stringify(req);
    console.error("[wavelink] send", payload);
    await ctx.ws.send(wsId, payload);
  }

  async function requestFullState() {
    try {
      // Match the legacy Rust handshake (no params field).
      await ctx.ws.send(wsId, JSON.stringify({ jsonrpc: "2.0", method: "getApplicationInfo", id: 1 }));
      await ctx.ws.send(wsId, JSON.stringify({ jsonrpc: "2.0", method: "getMixes", id: 2 }));
      await ctx.ws.send(wsId, JSON.stringify({ jsonrpc: "2.0", method: "getChannels", id: 3 }));
    } catch (e) {
      // ignore
    }
  }

  function handleWsText(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    if (!json || typeof json !== "object") return;

    const id = json.id;
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

    // Notifications (no id)
    if (json.method) {
      if (json.method === "channelsChanged" || json.method === "channelChanged") {
        sendJsonRpc("getChannels", {}, 3).catch(() => {});
      }
      if (json.method === "mixesChanged" || json.method === "mixChanged") {
        sendJsonRpc("getMixes", {}, 2).catch(() => {});
      }
    }
  }

  async function connectOnce() {
    console.error("[wavelink] scanning ports...");
    connecting = true;
    setStatus(false, "Scanning...", { connecting: true, disconnectedByUser });

    const ports = [];
    for (let p = PORT_START; p <= PORT_END; p++) ports.push(p);

    // Try in parallel; close extras.
    const attempts = ports.map(async (port) => {
      const url = `ws://${HOST}:${port}`;
      try {
        const id = await ctx.ws.open(url, { Origin: ORIGIN }, 750);
        return { id, port };
      } catch (e) {
        if (port === PORT_START) {
          console.error("[wavelink] ws_open failed (sample)", e);
        }
        return null;
      }
    });

    const results = await Promise.all(attempts);
    const ok = results.find((r) => r && r.id);
    if (!ok) {
      console.error("[wavelink] no instance found");
      connecting = false;
      setStatus(false, "Not connected");
      return false;
    }

    // Close any extra connections.
    for (const r of results) {
      if (r && r.id && r.id !== ok.id) {
        ctx.ws.close(r.id).catch(() => {});
      }
    }

    wsId = ok.id;
    connectedPort = ok.port;
    console.error(`[wavelink] connected on port ${connectedPort} (wsId=${wsId})`);
    connecting = false;
    manualConnectRequested = false;
    disconnectedByUser = false;
    wasConnected = true;
    offlineFeedbackSent = false;
    setStatus(true, `Connected (:${connectedPort})`);

    ctx.ws.onMessage(wsId, (msg) => {
      if (msg.type === "text") {
        handleWsText(msg.data);
      }
    });

    await requestFullState();
    return true;
  }

  // Track close events
  ctx.tauri.listen("ws_closed", (event) => {
    let payload = event?.payload;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch { payload = null; }
    }
    const closedId = payload?.id;
    if (wsId && closedId === wsId) {
      wsId = null;
      connectedPort = null;
      connecting = false;
      mixes = [];
      channels = [];
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
      ui.autoConnectInput = container.querySelector('[data-role="auto"]');
      ui.invalidateBindingsUI = ctx.app?.invalidateBindingsUI;

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
            wsId = null;
            connectedPort = null;
            connecting = false;
            mixes = [];
            channels = [];
            offlineFeedbackSent = false;
            syncOfflineFeedback().catch(() => {});
            wasConnected = false;
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

      setStatus(lastStatus.connected, lastStatus.detail, { connecting: lastStatus.connecting || connecting, disconnectedByUser });
    },
  });

  // Background reconnect loop
  (async () => {
    while (true) {
      if (!wsId && !connecting && !disconnectedByUser && (autoConnect || manualConnectRequested)) {
        try {
          await connectOnce();
        } catch {
          connecting = false;
          // ignore
        }
      }
      await sleep(1000);
    }
  })();

  ctx.registerIntegration({
    id: "wavelink",
    name: "Wave Link",
    icon_data: iconDataUrl || null,
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
    getTargetOptions: () => {
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

          // Channel-in-mix targets
          // Only expose mixes that the channel actually has entries for.
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
    },
    onBindingTriggered: async (payload) => {
      const bindingId = payload?.binding_id;
      const action = payload?.action;
      const value = payload?.value;
      const endpoint = normalizeEndpoint({ Integration: payload?.target });
      if (!endpoint) return;

      console.error("[wavelink] trigger", { action, value, endpoint });

      const level = clamp01(value);
      try {
        if (action === "Volume") {
          // Update UI/OSD and internal state immediately (optimistic), then coalesce
          // websocket writes to keep rapid fader motion smooth.
          if (bindingId) {
            ctx.feedback.set(bindingId, level, "Volume").catch(() => {});
          }

          if (!wsId) {
            return;
          }

          queueVolumeWrite(endpoint, level);
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

        if (bindingId) {
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
        mixes = [];
        channels = [];
        offlineFeedbackSent = false;
        syncOfflineFeedback().catch(() => {});
        wasConnected = false;
        setStatus(false, "Disconnected");
      }
    },
  });

  setBindings(readBindings());
  ctx.bindings?.onChanged?.((next) => {
    setBindings(next);
    syncAllFeedback().catch(() => {});
  });
}

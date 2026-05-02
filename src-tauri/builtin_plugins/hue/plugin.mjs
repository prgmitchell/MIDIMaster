function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeHueGroupType(type) {
  return String(type || "").trim().toLowerCase();
}

function isHumanFriendlyHueGroupName(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  if (/^hgrp-\d+$/i.test(n)) return false;
  if (/^lumia-stream-\d+$/i.test(n)) return false;
  return true;
}

function isSelectableHueGroup(entry) {
  const type = normalizeHueGroupType(entry?.type);
  // Keep the picker focused on user-facing targets only.
  if (!(type === "room" || type === "zone" || type === "lightgroup")) {
    return false;
  }
  return isHumanFriendlyHueGroupName(entry?.name);
}

const POLL_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 4000;
const LOCAL_WRITE_QUIET_MS = 1200;
const DEFAULT_AUTO_CONNECT = true;
const PAIR_WINDOW_MS = 30000;
const FADER_WRITE_COALESCE_MS = 75;

const ui = {
  statusText: null,
  statusDot: null,
  autoConnectInput: null,
  bridgeIpInput: null,
  bridgeSetupSection: null,
  manualIpRow: null,
  modeTabsRow: null,
  modeDiscoveryBtn: null,
  modeManualBtn: null,
  bridgeList: null,
  discoveryState: null,
  discoverySection: null,
  refreshBtn: null,
  pairedSummarySection: null,
  pairedSummaryText: null,
  pairActionBtn: null,
  invalidateBindingsUI: null,
};

const lastStatus = { connected: false, connecting: false, detail: "Not connected" };

function setStatus(connected, detail = "", opts = null) {
  const connecting = (opts && typeof opts === "object") ? Boolean(opts.connecting) : false;
  const disconnectedByUser = (opts && typeof opts === "object") ? Boolean(opts.disconnectedByUser) : false;

  lastStatus.connected = Boolean(connected);
  lastStatus.connecting = connecting;
  lastStatus.detail = detail || "";

  if (ui.statusText) {
    ui.statusText.textContent = connected ? (detail || "Connected") : (detail || "Not connected");
  }

  if (ui.statusDot) {
    ui.statusDot.classList.toggle("connected", Boolean(connected));
    ui.statusDot.classList.toggle("connecting", !connected && connecting);
    ui.statusDot.classList.toggle("error", !connected && !connecting && !disconnectedByUser);
  }

  try {
    ui.invalidateBindingsUI?.();
  } catch {
    // ignore
  }
}

function hueErrorFromResult(json) {
  if (!Array.isArray(json)) return null;
  const err = json.find((item) => item && item.error);
  if (!err || !err.error) return null;
  const type = err.error.type != null ? String(err.error.type) : "unknown";
  const description = err.error.description ? String(err.error.description) : "Hue request failed";
  return { type, description };
}

export async function activate(ctx) {
  let iconDataUrl = null;
  try {
    iconDataUrl = await ctx.assets?.readDataUrl?.("HueLogo.svg", "image/svg+xml");
  } catch {
    iconDataUrl = null;
  }

  ui.invalidateBindingsUI = ctx.app?.invalidateBindingsUI;

  let bridgeIp = "";
  let username = "";
  let connected = false;
  let connecting = false;
  let pairing = false;
  let autoConnect = DEFAULT_AUTO_CONNECT;
  let manualConnectRequested = false;
  let disconnectedByUser = false;

  let discovering = false;
  let discoveredBridges = [];
  let selectedBridgeIp = "";
  let hasAutoDiscovered = false;
  let pairingCancelToken = null;
  let bridgeInputMode = "discovery";

  let bindings = [];
  const stateByKey = new Map();
  const lastLocalWriteAt = new Map();
  const pendingBrightnessWrites = new Map();

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

  function targetKey(kind, id) {
    return `${String(kind || "")}::${String(id || "")}`;
  }

  function normalizeIntegrationTarget(rawTarget) {
    const t = rawTarget?.Integration || rawTarget?.integration || rawTarget;
    if (!t || t.integration_id !== "hue") return null;
    const data = t.data || {};
    const kind = String(t.kind || "");
    const id = String(data.id || "");
    if (!id || (kind !== "light" && kind !== "group")) return null;
    return {
      kind,
      id,
      name: String(data.name || data.label || `${kind} ${id}`),
      icon_data: (typeof data.icon_data === "string" && data.icon_data.trim()) ? data.icon_data : (iconDataUrl || null),
    };
  }

  function parseLightState(entry) {
    const state = entry?.state || {};
    const briRaw = Number(state.bri);
    const bri = Number.isFinite(briRaw) ? Math.max(0, Math.min(254, Math.round(briRaw))) : 0;
    return {
      on: Boolean(state.on),
      bri,
      name: String(entry?.name || "Hue Light"),
      kind: "light",
    };
  }

  function parseGroupState(entry) {
    const action = entry?.action || {};
    const briRaw = Number(action.bri);
    const bri = Number.isFinite(briRaw) ? Math.max(0, Math.min(254, Math.round(briRaw))) : 0;
    return {
      on: Boolean(action.on),
      bri,
      name: String(entry?.name || "Hue Group"),
      group_type: String(entry?.type || ""),
      kind: "group",
    };
  }

  async function invokeWithTimeout(command, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return Promise.race([
      ctx.tauri.invoke(command, args),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), timeoutMs)),
    ]);
  }

  async function hueGet(path) {
    const ip = String(bridgeIp || "").trim();
    const user = String(username || "").trim();
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
    const ip = String(bridgeIp || "").trim();
    const user = String(username || "").trim();
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

  function queueBrightnessWrite(kind, id, value) {
    const key = targetKey(kind, id);
    const nextValue = clamp01(value);
    const existing = pendingBrightnessWrites.get(key);
    if (existing && existing.timer) {
      existing.value = nextValue;
      pendingBrightnessWrites.set(key, existing);
      return;
    }

    const entry = { kind, id, value: nextValue, timer: null };
    entry.timer = setTimeout(async () => {
      const latest = pendingBrightnessWrites.get(key);
      pendingBrightnessWrites.delete(key);
      if (!latest) return;
      const bri = Math.max(1, Math.min(254, Math.round(latest.value * 254)));
      try {
        await huePut(latest.kind, latest.id, { on: true, bri, transitiontime: 1 });
      } catch {
        markDisconnected("Disconnected");
      }
    }, FADER_WRITE_COALESCE_MS);

    pendingBrightnessWrites.set(key, entry);
  }

  async function persistProfilePatch(patch) {
    const current = ctx.profile?.get?.() || {};
    const next = { ...current, ...patch };
    applyProfileSettings(next);
    await ctx.profile?.set?.(next);
  }

  function effectiveBridgeIp() {
    const fromSelected = String(selectedBridgeIp || "").trim();
    if (fromSelected) return fromSelected;
    const fromPersisted = String(bridgeIp || "").trim();
    if (fromPersisted) return fromPersisted;
    const fromInput = String(ui.bridgeIpInput?.value || "").trim();
    if (fromInput) return fromInput;
    return "";
  }

  function renderDiscoveryState() {
    if (!ui.discoveryState) return;
    if (discovering) {
      ui.discoveryState.textContent = "Discovering bridges...";
      return;
    }
    if (discoveredBridges.length === 0) {
      ui.discoveryState.textContent = "No bridges found. Enter an IP manually.";
      return;
    }
    ui.discoveryState.textContent = `${discoveredBridges.length} bridge${discoveredBridges.length === 1 ? "" : "s"} found`;
  }

  function renderBridgeList() {
    if (!ui.bridgeList) return;
    ui.bridgeList.innerHTML = "";

    if (discovering) {
      const loading = document.createElement("div");
      loading.className = "plugins-store-empty";
      loading.textContent = "Scanning local network...";
      ui.bridgeList.appendChild(loading);
      return;
    }

    if (discoveredBridges.length === 0) {
      const empty = document.createElement("div");
      empty.className = "plugins-store-empty";
      empty.textContent = "No bridge discovered yet.";
      ui.bridgeList.appendChild(empty);
      return;
    }

    const current = effectiveBridgeIp();

    for (const ip of discoveredBridges) {
      const row = document.createElement("label");
      row.className = "plugins-manager-row hue-bridge-row";
      row.style.cursor = "pointer";
      row.style.padding = "8px 10px";
      row.innerHTML = `
        <div class="plugins-manager-row-left" style="gap:8px;">
          <input type="radio" name="hue-bridge-choice" value="${ip}" ${current === ip ? "checked" : ""} />
          <div class="plugins-manager-row-text">
            <div class="plugins-manager-row-name">${ip}</div>
          </div>
        </div>
      `;
      const radio = row.querySelector('input[type="radio"]');
      radio?.addEventListener("change", async () => {
        if (!radio.checked) return;
        selectedBridgeIp = ip;
        if (ui.bridgeIpInput) ui.bridgeIpInput.value = ip;
        await persistProfilePatch({ bridge_ip: ip });
      });
      ui.bridgeList.appendChild(row);
    }
  }

  function renderPairActionButton() {
    if (!ui.pairActionBtn) return;

    const isPaired = Boolean(username);
    ui.pairActionBtn.disabled = pairing;
    ui.pairActionBtn.classList.remove("danger");

    if (pairing) {
      ui.pairActionBtn.textContent = "Pairing...";
      return;
    }

    if (isPaired) {
      ui.pairActionBtn.textContent = "Unpair";
      ui.pairActionBtn.classList.add("danger");
    } else {
      ui.pairActionBtn.textContent = "Start pairing";
    }
  }

  function renderBridgeInputMode() {
    const isPaired = Boolean(username);
    if (ui.bridgeSetupSection) ui.bridgeSetupSection.style.display = isPaired ? "none" : "";
    if (ui.modeTabsRow) ui.modeTabsRow.style.display = isPaired ? "none" : "";
    if (ui.discoverySection) ui.discoverySection.style.display = (!isPaired && bridgeInputMode === "discovery") ? "" : "none";
    if (ui.manualIpRow) ui.manualIpRow.style.display = (!isPaired && bridgeInputMode === "manual") ? "" : "none";
    if (ui.refreshBtn) ui.refreshBtn.style.display = (!isPaired && bridgeInputMode === "discovery") ? "" : "none";

    if (ui.modeDiscoveryBtn) ui.modeDiscoveryBtn.classList.toggle("active", bridgeInputMode === "discovery");
    if (ui.modeManualBtn) ui.modeManualBtn.classList.toggle("active", bridgeInputMode === "manual");
  }

  function setBridgeInputMode(mode) {
    const next = String(mode || "").toLowerCase();
    bridgeInputMode = next === "manual" ? "manual" : "discovery";
    renderBridgeInputMode();
  }

  function renderPairedUiState() {
    const isPaired = Boolean(username);
    if (ui.bridgeIpInput) {
      ui.bridgeIpInput.disabled = isPaired;
    }
    if (ui.pairedSummarySection) {
      ui.pairedSummarySection.style.display = isPaired ? "" : "none";
    }
    if (ui.pairedSummaryText) {
      const ip = effectiveBridgeIp();
      ui.pairedSummaryText.textContent = ip
        ? `Paired with bridge ${ip}.`
        : "Paired with bridge.";
    }
    renderBridgeInputMode();
  }

  function applyProfileSettings(settings) {
    const source = (settings && typeof settings === "object") ? settings : {};
    bridgeIp = String(source.bridge_ip || source.bridgeIp || "").trim();
    username = String(source.username || "").trim();
    autoConnect = ("auto_connect" in source) ? Boolean(source.auto_connect) : DEFAULT_AUTO_CONNECT;

    if (!selectedBridgeIp && bridgeIp) selectedBridgeIp = bridgeIp;

    if (!autoConnect) {
      manualConnectRequested = false;
    }

    if (ui.bridgeIpInput) ui.bridgeIpInput.value = bridgeIp;
    if (ui.autoConnectInput) ui.autoConnectInput.checked = autoConnect;

    renderPairActionButton();
    renderPairedUiState();
    renderBridgeList();
    renderDiscoveryState();
    renderBridgeInputMode();

    if (username && autoConnect && !connected && !connecting) {
      manualConnectRequested = true;
      disconnectedByUser = false;
    }
  }

  function setBindings(nextBindings) {
    bindings = Array.isArray(nextBindings) ? nextBindings : [];
  }

  async function syncAllFeedback(opts = null) {
    const silent = (opts && typeof opts === "object") ? Boolean(opts.silent) : true;
    const allowQuietSkip = (opts && typeof opts === "object") ? Boolean(opts.allowQuietSkip) : false;
    const now = Date.now();

    for (const b of bindings) {
      const bindingId = String(b?.id || "");
      if (!bindingId) continue;

      const t = normalizeIntegrationTarget(b?.target);
      if (!t) continue;

      const key = targetKey(t.kind, t.id);
      if (allowQuietSkip) {
        const lastWrite = lastLocalWriteAt.get(key) || 0;
        if (lastWrite > 0 && (now - lastWrite) < LOCAL_WRITE_QUIET_MS) {
          continue;
        }
      }

      const entry = stateByKey.get(key);
      if (!entry) continue;

      try {
        if ((b?.action || "Volume") === "ToggleMute") {
          await ctx.feedback.set(bindingId, entry.on ? 1.0 : 0.0, "ToggleMute", { silent });
        } else {
          const vol = clamp01((Number(entry.bri) || 0) / 254);
          await ctx.feedback.set(bindingId, vol, "Volume", { silent });
        }
      } catch {
        // ignore
      }
    }
  }

  async function refreshHueState(opts = null) {
    const silent = (opts && typeof opts === "object") ? Boolean(opts.silent) : true;
    const lightsJson = await hueGet("/lights");
    const groupsJson = await hueGet("/groups");

    const nextState = new Map();

    if (lightsJson && typeof lightsJson === "object") {
      for (const [id, light] of Object.entries(lightsJson)) {
        const parsed = parseLightState(light);
        nextState.set(targetKey("light", id), { ...parsed, id: String(id) });
      }
    }

    if (groupsJson && typeof groupsJson === "object") {
      for (const [id, group] of Object.entries(groupsJson)) {
        if (!isSelectableHueGroup(group)) continue;
        const parsed = parseGroupState(group);
        nextState.set(targetKey("group", id), { ...parsed, id: String(id) });
      }
    }

    stateByKey.clear();
    nextState.forEach((value, key) => stateByKey.set(key, value));

    await syncAllFeedback({ silent, allowQuietSkip: true });
  }

  function markDisconnected(detail = "Disconnected") {
    connected = false;
    connecting = false;
    setStatus(false, detail, { disconnectedByUser });
  }

  async function connectOnce() {
    if (connecting) return false;

    const ip = effectiveBridgeIp();
    if (!ip) {
      markDisconnected("Set bridge IP first");
      return false;
    }
    if (!username) {
      markDisconnected("Start pairing first");
      return false;
    }

    connecting = true;
    setStatus(false, "Connecting...", { connecting: true, disconnectedByUser });

    try {
      if (bridgeIp !== ip) {
        bridgeIp = ip;
        await persistProfilePatch({ bridge_ip: ip });
      }
      await refreshHueState({ silent: true });
      connected = true;
      connecting = false;
      manualConnectRequested = false;
      disconnectedByUser = false;
      setStatus(true, `Connected (${ip})`);
      return true;
    } catch {
      connected = false;
      connecting = false;
      setStatus(false, "Not connected", { disconnectedByUser });
      return false;
    }
  }

  async function discoverBridges(opts = null) {
    const silent = (opts && typeof opts === "object") ? Boolean(opts.silent) : false;
    if (discovering) return;
    discovering = true;
    renderDiscoveryState();
    renderBridgeList();

    try {
      const candidateIps = Array.from(new Set([
        String(selectedBridgeIp || "").trim(),
        String(bridgeIp || "").trim(),
        String(ui.bridgeIpInput?.value || "").trim(),
      ].filter(Boolean)));
      const ips = await invokeWithTimeout("hue_discover_bridges", {
        candidateIps,
        candidate_ips: candidateIps,
      }, 12000);
      const unique = Array.from(new Set((Array.isArray(ips) ? ips : []).map((x) => String(x || "").trim()).filter(Boolean)));
      discoveredBridges = unique;
      console.debug("[hue] discovery", {
        cloudResultCount: unique.length,
        candidateIps,
      });

      const current = effectiveBridgeIp();
      if (current && unique.includes(current)) {
        selectedBridgeIp = current;
      } else if (!current && unique.length > 0) {
        selectedBridgeIp = unique[0];
        if (ui.bridgeIpInput) ui.bridgeIpInput.value = selectedBridgeIp;
      }

      if (!silent) {
        const detail = connected
          ? `Connected (${effectiveBridgeIp()})`
          : (unique.length > 0 ? "Bridge scan complete" : "No bridges found");
        setStatus(connected, detail, { disconnectedByUser });
      }
    } catch (err) {
      discoveredBridges = [];
      console.debug("[hue] discovery failed", {
        error: err?.message || String(err || ""),
        candidateIps: [
          String(selectedBridgeIp || "").trim(),
          String(bridgeIp || "").trim(),
          String(ui.bridgeIpInput?.value || "").trim(),
        ].filter(Boolean),
      });
      if (!silent) {
        setStatus(connected, connected ? `Connected (${effectiveBridgeIp()})` : "Bridge scan failed", { disconnectedByUser });
      }
    } finally {
      discovering = false;
      renderDiscoveryState();
      renderBridgeList();
    }
  }

  async function pairBridge(token) {
    const ip = effectiveBridgeIp();
    if (!ip) {
      throw new Error("Set bridge IP first");
    }

    const started = Date.now();
    let lastErr = null;

    while ((Date.now() - started) < PAIR_WINDOW_MS) {
      if (token?.cancelled) {
        throw new Error("__PAIR_CANCELLED__");
      }

      try {
        const json = await invokeWithTimeout("hue_pair_bridge", {
          bridgeIp: ip,
          devicetype: "midimaster#desktop",
          bridge_ip: ip,
        }, 3500);

        if (Array.isArray(json)) {
          const success = json.find((item) => item && item.success && item.success.username);
          if (success?.success?.username) {
            return String(success.success.username);
          }
          const err = hueErrorFromResult(json);
          if (err?.type === "101") {
            lastErr = "Press the bridge button to pair...";
            setPairPanelMessage(lastErr);
          } else if (err) {
            throw new Error(err.description);
          }
        }
      } catch (err) {
        const msg = err?.message || "Pairing failed";
        if (msg === "__PAIR_CANCELLED__") throw err;
        lastErr = msg;
      }

      await sleep(1000);
    }

    throw new Error(lastErr || "Pairing timed out");
  }

  async function startPairing() {
    if (pairing) return;

    const ip = effectiveBridgeIp();
    if (!ip) {
      setStatus(false, "Set bridge IP first", { disconnectedByUser });
      return;
    }

    pairing = true;
    pairingCancelToken = { cancelled: false };
    renderPairActionButton();
    openPairPanel("Press the physical button on your Hue Bridge.");
    setStatus(false, "Waiting for bridge button...", { connecting: true, disconnectedByUser });

    try {
      bridgeIp = ip;
      selectedBridgeIp = ip;
      await persistProfilePatch({ bridge_ip: ip });
      const pairedUsername = await pairBridge(pairingCancelToken);
      bridgeIp = ip;
      await persistProfilePatch({ bridge_ip: ip, username: pairedUsername });
      setPairPanelMessage("Pairing complete.");
      setStatus(false, "Bridge paired", { disconnectedByUser });
      disconnectedByUser = false;
      manualConnectRequested = true;
      await connectOnce();
      closePairPanel();
    } catch (err) {
      const msg = err?.message || "Pairing failed";
      if (msg === "__PAIR_CANCELLED__") {
        setStatus(false, "Pairing cancelled", { disconnectedByUser });
      } else {
        setPairPanelMessage(msg);
        setStatus(false, msg, { disconnectedByUser });
      }
      closePairPanel();
    } finally {
      pairing = false;
      pairingCancelToken = null;
      renderPairActionButton();
      renderPairedUiState();
    }
  }

  async function unpairBridge() {
    if (pairing) return;
    disconnectedByUser = true;
    manualConnectRequested = false;
    markDisconnected("Unpaired");
    await persistProfilePatch({ username: "" });
    renderPairActionButton();
    renderPairedUiState();
  }

  function cancelPairing() {
    if (!pairingCancelToken) return;
    pairingCancelToken.cancelled = true;
    closePairPanel();
  }

  try {
    applyProfileSettings(ctx.profile?.get?.());
    ctx.profile?.onChanged?.((ev) => applyProfileSettings(ev?.settings || ev));
  } catch {
    // ignore
  }

  setBindings(ctx.bindings?.getAll?.() || []);
  ctx.bindings?.onChanged?.((next) => setBindings(next));

  (async () => {
    while (true) {
      if (!connected && !connecting && !pairing && !disconnectedByUser && (autoConnect || manualConnectRequested)) {
        await connectOnce();
      } else if (connected && !connecting) {
        try {
          await refreshHueState({ silent: true });
        } catch {
          markDisconnected("Disconnected");
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
  })();

  ctx.registerIntegration({
    id: "hue",
    name: "Philips Hue",
    icon_data: iconDataUrl || null,
    buttonActions: [
      { label: "Toggle", value: "ToggleMute" },
    ],
    describeTarget: (target) => {
      const t = normalizeIntegrationTarget(target);
      if (!t) {
        return { label: "Philips Hue", icon_data: iconDataUrl || null, ghost: !connected };
      }

      const key = targetKey(t.kind, t.id);
      const state = stateByKey.get(key);
      const fallbackType = t.kind === "group" ? "Room" : "Light";
      const label = state?.name || t.name || `${fallbackType} ${t.id}`;

      return {
        label: String(label),
        icon_data: t.icon_data || iconDataUrl || null,
        ghost: !connected,
      };
    },
    getTargetOptions: async () => {
      if (!connected) {
        return [];
      }

      const opts = [];
      const groups = [];
      const lights = [];

      for (const [key, state] of stateByKey.entries()) {
        if (!state) continue;
        const [kind, id] = String(key).split("::");
        if (kind === "group" && !isHumanFriendlyHueGroupName(state.name)) {
          continue;
        }
        const entry = {
          label: String(state.name || `${kind} ${id}`),
          icon_data: iconDataUrl || null,
          target: {
            Integration: {
              integration_id: "hue",
              kind,
              data: {
                id: String(id),
                name: String(state.name || `${kind} ${id}`),
              },
            },
          },
        };
        if (kind === "group") groups.push(entry);
        if (kind === "light") lights.push(entry);
      }

      groups.sort((a, b) => a.label.localeCompare(b.label));
      lights.sort((a, b) => a.label.localeCompare(b.label));

      if (groups.length > 0) {
        opts.push({ kind: "divider", label: "Rooms / Groups" });
        opts.push(...groups);
      }
      if (lights.length > 0) {
        opts.push({ kind: "divider", label: "Lights" });
        opts.push(...lights);
      }

      if (opts.length === 0) {
        opts.push({ label: "No Hue lights or groups found", kind: "placeholder", ghost: true });
      }

      return opts;
    },
    onBindingTriggered: async (payload) => {
      const t = normalizeIntegrationTarget(payload?.target);
      if (!t || !connected) return;

      const bindingId = String(payload?.binding_id || "");
      const action = String(payload?.action || "Volume");
      const value = clamp01(payload?.value);
      const key = targetKey(t.kind, t.id);

      try {
        if (action === "ToggleMute") {
          const on = value > 0.5;
          const current = stateByKey.get(key) || { bri: 0, name: t.name, kind: t.kind };
          stateByKey.set(key, { ...current, on });
          lastLocalWriteAt.set(key, Date.now());
          if (bindingId) {
            await ctx.feedback.set(bindingId, on ? 1.0 : 0.0, "ToggleMute");
          }
          huePut(t.kind, t.id, { on, transitiontime: 1 }).catch(() => {
            markDisconnected("Disconnected");
          });
          return;
        }

        const current = stateByKey.get(key) || { on: true, name: t.name, kind: t.kind };
        const bri = Math.max(1, Math.min(254, Math.round(value * 254)));
        stateByKey.set(key, { ...current, on: true, bri });
        lastLocalWriteAt.set(key, Date.now());
        if (bindingId) {
          await ctx.feedback.set(bindingId, value, "Volume");
        }
        queueBrightnessWrite(t.kind, t.id, value);
      } catch {
        markDisconnected("Disconnected");
      }
    },
  });

  ctx.connections?.registerTab?.({
    id: "hue",
    name: "Philips Hue",
    icon_data: iconDataUrl || null,
    order: 30,
    mount: (container) => {
      container.innerHTML = `
        <div class="connection-item-header">
          <div class="connection-info">
            <img src="${iconDataUrl || ""}" alt="Philips Hue" class="connection-icon" />
            <span class="connection-name">Philips Hue</span>
          </div>
          <div class="connection-status">
            <span class="connection-status-dot" data-role="dot"></span>
            <span data-role="text">Not connected</span>
          </div>
        </div>
        <div class="connection-content-wrapper" style="flex-direction:column;gap:12px;">
          <div data-role="bridge-setup-section" class="hue-setup-card" style="padding:10px 12px;">
            <div class="connection-row" data-role="mode-tabs-row" style="margin:0 0 10px 0;">
              <div class="hue-tab-strip">
                <button type="button" class="hue-mode-btn" data-role="mode-discovery">Bridge Discovery</button>
                <button type="button" class="hue-mode-btn" data-role="mode-manual">Manual IP</button>
              </div>
            </div>
            <div class="connection-row" data-role="discovery-section" style="margin-top:0;">
              <div class="hue-discovery-heading">
                <label style="margin:0;">Discovered Bridges</label>
              </div>
              <div class="hue-discovery-field-row">
                <div data-role="bridge-list" class="plugins-manager-list" style="max-height:130px;overflow:auto;"></div>
                <button type="button" class="hue-refresh-btn" data-role="refresh">Refresh</button>
              </div>
              <div data-role="discovery-state" class="plugins-store-status" style="margin-top:6px;"></div>
            </div>
            <div class="connection-row" data-role="manual-ip-row" style="display:none;margin-top:0;">
              <label>Manual Bridge IP</label>
              <input data-role="bridge-ip" type="text" placeholder="192.168.1.20" style="max-width:320px;" />
            </div>
          </div>
          <div data-role="paired-summary" class="hue-setup-card hue-paired-summary" style="display:none;padding:10px 12px;">
            <div class="hue-summary-heading">Bridge Setup</div>
            <div data-role="paired-summary-text" class="hue-summary-text">Paired with bridge.</div>
          </div>
        </div>
        <div class="hue-actions" style="display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:8px;align-items:center;margin-top:10px;">
          <button type="button" class="connection-button" data-role="pair-action" style="min-width:0;width:100%;margin-top:0;padding:10px 12px;">Start pairing</button>
          <div class="connection-row checkbox-row" style="justify-content:flex-end;margin-top:0;">
            <input type="checkbox" data-role="auto" id="hue-auto-connect" />
            <label for="hue-auto-connect">Auto connect</label>
          </div>
        </div>
      `;

      ui.statusText = container.querySelector('[data-role="text"]');
      ui.statusDot = container.querySelector('[data-role="dot"]');
      ui.autoConnectInput = container.querySelector('[data-role="auto"]');
      ui.bridgeIpInput = container.querySelector('[data-role="bridge-ip"]');
      ui.bridgeSetupSection = container.querySelector('[data-role="bridge-setup-section"]');
      ui.manualIpRow = container.querySelector('[data-role="manual-ip-row"]');
      ui.modeTabsRow = container.querySelector('[data-role="mode-tabs-row"]');
      ui.modeDiscoveryBtn = container.querySelector('[data-role="mode-discovery"]');
      ui.modeManualBtn = container.querySelector('[data-role="mode-manual"]');
      ui.bridgeList = container.querySelector('[data-role="bridge-list"]');
      ui.discoveryState = container.querySelector('[data-role="discovery-state"]');
      ui.discoverySection = container.querySelector('[data-role="discovery-section"]');
      ui.refreshBtn = container.querySelector('[data-role="refresh"]');
      ui.pairedSummarySection = container.querySelector('[data-role="paired-summary"]');
      ui.pairedSummaryText = container.querySelector('[data-role="paired-summary-text"]');
      ui.pairActionBtn = container.querySelector('[data-role="pair-action"]');
      ui.invalidateBindingsUI = ctx.app?.invalidateBindingsUI;

      applyProfileSettings(ctx.profile?.get?.());

      const pairPanel = ensurePairPanel();
      if (!pairPanel.dataset.bound) {
        pairPanel.querySelector('[data-role="cancel"]')?.addEventListener("click", cancelPairing);
        pairPanel.querySelector('[data-role="close"]')?.addEventListener("click", cancelPairing);
        pairPanel.addEventListener("click", (event) => {
          if (event.target === pairPanel) cancelPairing();
        });
        pairPanel.dataset.bound = "1";
      }

      if (ui.bridgeIpInput) {
        ui.bridgeIpInput.addEventListener("change", async () => {
          const next = String(ui.bridgeIpInput.value || "").trim();
          selectedBridgeIp = next;
          await persistProfilePatch({ bridge_ip: next });
          renderBridgeList();
        });
      }

      ui.modeDiscoveryBtn?.addEventListener("click", () => setBridgeInputMode("discovery"));
      ui.modeManualBtn?.addEventListener("click", () => setBridgeInputMode("manual"));

      if (ui.autoConnectInput) {
        ui.autoConnectInput.addEventListener("change", async () => {
          const next = Boolean(ui.autoConnectInput.checked);
          await persistProfilePatch({ auto_connect: next });
        });
      }

      if (ui.refreshBtn) {
        ui.refreshBtn.addEventListener("click", async () => {
          await discoverBridges();
        });
      }

      if (ui.pairActionBtn) {
        ui.pairActionBtn.addEventListener("click", async () => {
          if (username) {
            await unpairBridge();
            return;
          }
          await startPairing();
        });
      }

      renderPairActionButton();
      renderPairedUiState();
      renderDiscoveryState();
      renderBridgeList();
      renderBridgeInputMode();

      if (!hasAutoDiscovered) {
        hasAutoDiscovered = true;
        discoverBridges({ silent: true }).catch(() => {});
      }

      setStatus(lastStatus.connected, lastStatus.detail, {
        connecting: lastStatus.connecting,
        disconnectedByUser,
      });
    },
    unmount: () => {
      for (const pending of pendingBrightnessWrites.values()) {
        if (pending?.timer) clearTimeout(pending.timer);
      }
      pendingBrightnessWrites.clear();
      ui.statusText = null;
      ui.statusDot = null;
      ui.autoConnectInput = null;
      ui.bridgeIpInput = null;
      ui.bridgeSetupSection = null;
      ui.manualIpRow = null;
      ui.modeTabsRow = null;
      ui.modeDiscoveryBtn = null;
      ui.modeManualBtn = null;
      ui.bridgeList = null;
      ui.discoveryState = null;
      ui.discoverySection = null;
      ui.refreshBtn = null;
      ui.pairedSummarySection = null;
      ui.pairedSummaryText = null;
      ui.pairActionBtn = null;
      closePairPanel();
    },
  });
}


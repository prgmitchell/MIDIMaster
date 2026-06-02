function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clampHueBri(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(254, Math.round(n)));
}

function volumeToHueBri(value) {
  const v = clamp01(value);
  if (v <= 0) return 0;
  return Math.max(1, Math.min(254, Math.round(v * 254)));
}

function hueVolumeFromState(entry) {
  if (!entry || !entry.on) return 0;
  return clamp01((Number(entry.bri) || 0) / 254);
}

const HUE_BUTTON_POWER_ACTIONS = [
  { button_action: "toggle", label: "Toggle On/Off", action: "ToggleMute", behavior: "stateful" },
  { button_action: "turn_on", label: "Turn On", action: "Volume", behavior: "momentary", osd_value_text: "ON" },
  { button_action: "turn_off", label: "Turn Off", action: "Volume", behavior: "momentary", osd_value_text: "OFF" },
];

function normalizeHueButtonAction(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "toggle" || normalized === "turn_on" || normalized === "turn_off") {
    return normalized;
  }
  return "";
}

function hueButtonActionDefinition(value) {
  const normalized = normalizeHueButtonAction(value) || "toggle";
  return HUE_BUTTON_POWER_ACTIONS.find((action) => action.button_action === normalized) || HUE_BUTTON_POWER_ACTIONS[0];
}

function huePowerWriteBody(buttonAction, bri = 254) {
  const normalized = normalizeHueButtonAction(buttonAction);
  if (normalized === "turn_on") {
    return { on: true, bri: savedHueBriValue(bri), transitiontime: 0 };
  }
  if (normalized === "turn_off") {
    return { on: false, transitiontime: 0 };
  }
  return null;
}

function savedHueBriValue(value) {
  return Math.max(1, Math.min(254, clampHueBri(value) || 254));
}

function createHueButtonActionOption(target, buttonAction, fallbackIconData = null) {
  const def = hueButtonActionDefinition(buttonAction);
  const kind = String(target?.kind || "");
  const id = String(target?.id || "");
  const name = String(target?.name || target?.label || `${kind} ${id}`);
  const iconData = target?.icon_data || fallbackIconData || null;
  return {
    label: def.label,
    icon_data: iconData,
    target: {
      Integration: {
        integration_id: "hue",
        kind,
        data: {
          id,
          name,
          label: name,
          ...(iconData ? { icon_data: iconData } : {}),
          button_action: def.button_action,
          action_kind: def.behavior,
          ...(def.osd_value_text ? { osd_value_text: def.osd_value_text } : {}),
        },
      },
    },
    buttonActions: [{
      label: def.label,
      value: def.action,
      behavior: def.behavior,
    }],
  };
}

function firstHueTargetFromBinding(binding) {
  const targets = Array.isArray(binding?.targets) && binding.targets.length > 0
    ? binding.targets
    : (binding?.target ? [binding.target] : []);
  for (const rawTarget of targets) {
    const target = hueTargetFromRawTarget(rawTarget);
    if (target) return target;
  }
  return null;
}

function hueTargetFromRawTarget(rawTarget) {
  const target = rawTarget?.Integration || rawTarget?.integration || rawTarget;
  if (!target || target.integration_id !== "hue") return null;
  const data = target.data || {};
  const kind = String(target.kind || "");
  const id = String(data.id || "");
  if (!id || (kind !== "light" && kind !== "group")) return null;
  return {
    kind,
    id,
    button_action: normalizeHueButtonAction(data.button_action),
  };
}

function hueTargetKey(kind, id) {
  return `${String(kind || "")}::${String(id || "")}`;
}

function hueBindingTargets(binding) {
  return Array.isArray(binding?.targets) && binding.targets.length > 0
    ? binding.targets
    : (binding?.target ? [binding.target] : []);
}

function hueBindingHasTargetKey(binding, key) {
  for (const rawTarget of hueBindingTargets(binding)) {
    const target = hueTargetFromRawTarget(rawTarget);
    if (target && hueTargetKey(target.kind, target.id) === key) return true;
  }
  return false;
}

function hueStateFeedbackForBinding(binding, entry) {
  if (!binding || !entry) return null;
  const action = String(binding?.action || "Volume");
  if (action === "ToggleMute") {
    return {
      value: entry.on ? 1.0 : 0.0,
      action: "ToggleMute",
    };
  }

  if (action !== "Volume") return null;

  const target = firstHueTargetFromBinding(binding);
  if (!target) return null;
  const buttonAction = normalizeHueButtonAction(target?.button_action);
  if (buttonAction === "turn_on" || buttonAction === "turn_off") {
    return null;
  }

  return {
    value: hueVolumeFromState(entry),
    action: "Volume",
  };
}

function hueFeedbackSetOptions(opts = null) {
  const silent = (opts && typeof opts === "object") ? Boolean(opts.silent) : true;
  const forceHardwareFeedback = Boolean(
    opts && typeof opts === "object" && (
      opts.forceHardwareFeedback ||
      opts.force_hardware_feedback ||
      opts.force === true
    )
  );
  if (!forceHardwareFeedback) return { silent };
  return {
    silent,
    forceHardwareFeedback: true,
    force_hardware_feedback: true,
  };
}

function hueFeedbackUpdatesForKey(bindings, stateByKey, key, opts = null) {
  const skipBindingId = String(opts?.skipBindingId || "");
  const entry = stateByKey?.get?.(key);
  if (!entry) return [];

  const updates = [];
  for (const b of (Array.isArray(bindings) ? bindings : [])) {
    const bindingId = String(b?.id || "");
    if (!bindingId || bindingId === skipBindingId) continue;
    if (!hueBindingHasTargetKey(b, key)) continue;

    const feedback = hueStateFeedbackForBinding(b, entry);
    if (!feedback) continue;
    updates.push({
      bindingId,
      value: feedback.value,
      action: feedback.action,
      options: hueFeedbackSetOptions(opts),
    });
  }
  return updates;
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
const LIGHT_WRITE_INTERVAL_MS = 110;
const GROUP_WRITE_INTERVAL_MS = 1050;
const BRIGHTNESS_EPSILON = 0.004;
const LOCAL_INTENT_HOLD_MS = 1800;
const POST_WRITE_REFRESH_DEBOUNCE_MS = 250;
const MAX_TRANSIENT_WRITE_FAILURES = 3;
const GROUP_FANOUT_MAX_LIGHTS = 3;

function createHueWriteScheduler({
  put,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
  lightIntervalMs = LIGHT_WRITE_INTERVAL_MS,
  groupIntervalMs = GROUP_WRITE_INTERVAL_MS,
  onWriteSuccess = null,
  onWriteFailure = null,
} = {}) {
  if (typeof put !== "function") {
    throw new Error("createHueWriteScheduler requires put(kind, id, body)");
  }

  const entries = new Map();
  const nextAllowedAtByKind = new Map([
    ["light", 0],
    ["group", 0],
  ]);
  const idleResolvers = new Set();

  function keyFor(kind, id) {
    return `${String(kind || "")}::${String(id || "")}`;
  }

  function intervalForKind(kind) {
    return kind === "group" ? groupIntervalMs : lightIntervalMs;
  }

  function entryIsIdle(entry) {
    return Boolean(entry) && !entry.pending && !entry.inFlight && !entry.timer;
  }

  function isIdle() {
    for (const entry of entries.values()) {
      if (!entryIsIdle(entry)) return false;
    }
    return true;
  }

  function notifyIdleIfNeeded() {
    if (!isIdle()) return;
    for (const resolve of idleResolvers) {
      try { resolve(); } catch {}
    }
    idleResolvers.clear();
  }

  function getOrCreateEntry(kind, id) {
    const key = keyFor(kind, id);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        kind: String(kind || ""),
        id: String(id || ""),
        pending: null,
        inFlight: false,
        timer: null,
      };
      entries.set(key, entry);
    }
    return entry;
  }

  function scheduleEntry(entry) {
    if (!entry || entry.timer || entry.inFlight || !entry.pending) return;

    const dueAt = nextAllowedAtByKind.get(entry.kind) || 0;
    const delay = Math.max(0, dueAt - now());
    entry.timer = setTimer(() => {
      entry.timer = null;
      runEntry(entry).catch(() => {});
    }, delay);
  }

  async function runEntry(entry) {
    if (!entry || entry.inFlight || !entry.pending) {
      notifyIdleIfNeeded();
      return;
    }

    const dueAt = nextAllowedAtByKind.get(entry.kind) || 0;
    const delay = dueAt - now();
    if (delay > 0) {
      scheduleEntry(entry);
      return;
    }

    const pending = entry.pending;
    entry.pending = null;
    entry.inFlight = true;
    nextAllowedAtByKind.set(entry.kind, now() + intervalForKind(entry.kind));

    try {
      if (!pending.shouldSend || pending.shouldSend()) {
        await put(entry.kind, entry.id, pending.body);
        if (typeof onWriteSuccess === "function") {
          onWriteSuccess({ kind: entry.kind, id: entry.id, body: pending.body, key: entry.key });
        }
      }
    } catch (err) {
      if (typeof onWriteFailure === "function") {
        onWriteFailure(err, {
          kind: entry.kind,
          id: entry.id,
          body: pending.body,
          key: entry.key,
          hasNewerPending: Boolean(entry.pending),
        });
      }
    } finally {
      entry.inFlight = false;
      if (entry.pending) {
        scheduleEntry(entry);
      } else {
        notifyIdleIfNeeded();
      }
    }
  }

  function enqueue(kind, id, body, options = null) {
    const entry = getOrCreateEntry(kind, id);
    entry.pending = {
      body: body || {},
      shouldSend: (options && typeof options.shouldSend === "function") ? options.shouldSend : null,
    };
    scheduleEntry(entry);
  }

  function cancel(kind, id) {
    const key = keyFor(kind, id);
    const entry = entries.get(key);
    if (!entry) return;
    entry.pending = null;
    if (entry.timer) {
      clearTimer(entry.timer);
      entry.timer = null;
    }
    notifyIdleIfNeeded();
  }

  function clear() {
    for (const entry of entries.values()) {
      if (entry.timer) clearTimer(entry.timer);
    }
    entries.clear();
    nextAllowedAtByKind.set("light", 0);
    nextAllowedAtByKind.set("group", 0);
    notifyIdleIfNeeded();
  }

  function whenIdle(timeoutMs = 2000) {
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        idleResolvers.delete(done);
        reject(new Error("Hue scheduler did not become idle"));
      }, timeoutMs);
      const done = () => {
        clearTimer(timer);
        resolve();
      };
      idleResolvers.add(done);
    });
  }

  return {
    enqueue,
    cancel,
    clear,
    whenIdle,
    isIdle,
  };
}

export function createHueWriteSchedulerForTests(options) {
  return createHueWriteScheduler(options);
}

export const hueTestUtils = {
  clampHueBri,
  volumeToHueBri,
  hueVolumeFromState,
  normalizeHueButtonAction,
  hueButtonActionDefinition,
  huePowerWriteBody,
  createHueButtonActionOption,
  hueStateFeedbackForBinding,
  hueFeedbackUpdatesForKey,
  hueTargetKey,
};

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
  let disposed = false;

  let discovering = false;
  let discoveredBridges = [];
  let selectedBridgeIp = "";
  let hasAutoDiscovered = false;
  let pairingCancelToken = null;
  let bridgeInputMode = "discovery";

  let bindings = [];
  const stateByKey = new Map();
  const lastLocalWriteAt = new Map();
  const localIntentByKey = new Map();
  const lastNonzeroBriByKey = new Map();
  const lastQueuedVolumeByKey = new Map();
  const groupLightIdsByKey = new Map();
  const groupWriteGenerationByKey = new Map();
  let postWriteRefreshTimer = null;
  let transientWriteFailures = 0;

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
    return hueTargetKey(kind, id);
  }

  function bindingTargets(binding) {
    if (Array.isArray(binding?.targets) && binding.targets.length > 0) {
      return binding.targets;
    }
    return binding?.target ? [binding.target] : [];
  }

  function rememberNonzeroBri(key, bri) {
    const next = clampHueBri(bri);
    if (next > 0) {
      lastNonzeroBriByKey.set(key, next);
    }
  }

  function savedBriForKey(key, fallback = 254) {
    const saved = clampHueBri(lastNonzeroBriByKey.get(key));
    if (saved > 0) return saved;
    const current = stateByKey.get(key);
    const currentBri = clampHueBri(current?.bri);
    if (currentBri > 0) return currentBri;
    return Math.max(1, Math.min(254, clampHueBri(fallback) || 254));
  }

  function rememberLocalIntent(key, intent) {
    const next = {
      ...(intent && typeof intent === "object" ? intent : {}),
      at: Date.now(),
    };
    localIntentByKey.set(key, next);
    lastLocalWriteAt.set(key, next.at);
  }

  function freshLocalIntent(key, now = Date.now()) {
    const intent = localIntentByKey.get(key);
    if (!intent) return null;
    if ((now - Number(intent.at || 0)) >= LOCAL_INTENT_HOLD_MS) {
      localIntentByKey.delete(key);
      return null;
    }
    return intent;
  }

  function stateMatchesIntent(state, intent) {
    if (!state || !intent) return false;
    if (typeof intent.on === "boolean" && Boolean(state.on) !== intent.on) {
      return false;
    }
    if (typeof intent.bri === "number") {
      return Math.abs(clampHueBri(state.bri) - clampHueBri(intent.bri)) <= 2;
    }
    return true;
  }

  function mergeIncomingStateWithLocalIntent(key, incoming) {
    const intent = freshLocalIntent(key);
    if (!intent) return incoming;

    if (stateMatchesIntent(incoming, intent)) {
      localIntentByKey.delete(key);
      return incoming;
    }

    const current = stateByKey.get(key);
    if (!current) return incoming;
    return {
      ...incoming,
      on: current.on,
      bri: current.bri,
    };
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
      button_action: normalizeHueButtonAction(data.button_action),
    };
  }

  function parseLightState(entry) {
    const state = entry?.state || {};
    const bri = clampHueBri(state.bri);
    return {
      on: Boolean(state.on),
      bri,
      name: String(entry?.name || "Hue Light"),
      kind: "light",
    };
  }

  function parseGroupState(entry) {
    const action = entry?.action || {};
    const groupState = entry?.state || {};
    const bri = clampHueBri(action.bri);
    const hasAggregateOn = typeof groupState.any_on === "boolean";
    return {
      on: hasAggregateOn ? Boolean(groupState.any_on) : Boolean(action.on),
      bri,
      name: String(entry?.name || "Hue Group"),
      group_type: String(entry?.type || ""),
      light_ids: Array.isArray(entry?.lights) ? entry.lights.map((id) => String(id)).filter(Boolean) : [],
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

  function schedulePostWriteRefresh() {
    if (disposed) return;
    if (postWriteRefreshTimer) return;
    postWriteRefreshTimer = setTimeout(async () => {
      postWriteRefreshTimer = null;
      if (disposed) return;
      try {
        await writeScheduler.whenIdle(30000);
      } catch {
        // A long-running fader move should not block refresh forever.
      }
      if (disposed || !connected || connecting) return;
      refreshHueState({ silent: true }).catch(() => {
        if (disposed) return;
        markDisconnected("Disconnected");
      });
    }, LOCAL_WRITE_QUIET_MS + POST_WRITE_REFRESH_DEBOUNCE_MS);
  }

  const writeScheduler = createHueWriteScheduler({
    put: huePut,
    onWriteSuccess: () => {
      if (disposed) return;
      transientWriteFailures = 0;
      schedulePostWriteRefresh();
    },
    onWriteFailure: (_err, failedWrite) => {
      if (disposed) return;
      transientWriteFailures += 1;
      if (transientWriteFailures >= MAX_TRANSIENT_WRITE_FAILURES) {
        markDisconnected("Disconnected");
        return;
      }
      if (!failedWrite?.hasNewerPending && failedWrite?.kind && failedWrite?.id) {
        writeScheduler.enqueue(failedWrite.kind, failedWrite.id, failedWrite.body || {});
      }
    },
  });

  function disposeHueRuntime() {
    disposed = true;
    connected = false;
    connecting = false;
    pairing = false;
    discovering = false;
    manualConnectRequested = false;
    transientWriteFailures = 0;
    if (pairingCancelToken) pairingCancelToken.cancelled = true;
    if (postWriteRefreshTimer) {
      clearTimeout(postWriteRefreshTimer);
      postWriteRefreshTimer = null;
    }
    writeScheduler.clear();
    stateByKey.clear();
    lastLocalWriteAt.clear();
    localIntentByKey.clear();
    lastNonzeroBriByKey.clear();
    lastQueuedVolumeByKey.clear();
    groupLightIdsByKey.clear();
    groupWriteGenerationByKey.clear();
    discoveredBridges = [];
    closePairPanel();
  }

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

  function firstHueTargetForBinding(binding) {
    for (const rawTarget of bindingTargets(binding)) {
      const target = normalizeIntegrationTarget(rawTarget);
      if (target) return target;
    }
    return null;
  }

  async function syncFeedbackForKey(key, opts = null) {
    for (const update of hueFeedbackUpdatesForKey(bindings, stateByKey, key, opts)) {
      try {
        await ctx.feedback.set(update.bindingId, update.value, update.action, update.options);
      } catch {
        // ignore
      }
    }
  }

  async function syncAllFeedback(opts = null) {
    const silent = (opts && typeof opts === "object") ? Boolean(opts.silent) : true;
    const allowQuietSkip = (opts && typeof opts === "object") ? Boolean(opts.allowQuietSkip) : false;
    const now = Date.now();

    for (const b of bindings) {
      const bindingId = String(b?.id || "");
      if (!bindingId) continue;

      const t = firstHueTargetForBinding(b);
      if (!t) continue;

      const key = targetKey(t.kind, t.id);
      if (allowQuietSkip) {
        const intent = freshLocalIntent(key, now);
        const lastWrite = lastLocalWriteAt.get(key) || 0;
        if (intent) {
          continue;
        }
        if (lastWrite > 0 && (now - lastWrite) < LOCAL_WRITE_QUIET_MS) {
          continue;
        }
      }

      const entry = stateByKey.get(key);
      if (!entry) continue;

      try {
        const feedback = hueStateFeedbackForBinding(b, entry);
        if (!feedback) continue;
        await ctx.feedback.set(bindingId, feedback.value, feedback.action, { silent });
      } catch {
        // ignore
      }
    }
  }

  async function refreshHueState(opts = null) {
    if (disposed) return;
    const silent = (opts && typeof opts === "object") ? Boolean(opts.silent) : true;
    const lightsJson = await hueGet("/lights");
    const groupsJson = await hueGet("/groups");

    const nextState = new Map();

    if (lightsJson && typeof lightsJson === "object") {
      for (const [id, light] of Object.entries(lightsJson)) {
        const parsed = parseLightState(light);
        const key = targetKey("light", id);
        rememberNonzeroBri(key, parsed.bri);
        nextState.set(key, mergeIncomingStateWithLocalIntent(key, { ...parsed, id: String(id) }));
      }
    }

    if (groupsJson && typeof groupsJson === "object") {
      for (const [id, group] of Object.entries(groupsJson)) {
        if (!isSelectableHueGroup(group)) continue;
        const parsed = parseGroupState(group);
        const key = targetKey("group", id);
        rememberNonzeroBri(key, parsed.bri);
        groupLightIdsByKey.set(key, parsed.light_ids || []);
        nextState.set(key, mergeIncomingStateWithLocalIntent(key, { ...parsed, id: String(id) }));
      }
    }

    stateByKey.clear();
    nextState.forEach((value, key) => stateByKey.set(key, value));

    await syncAllFeedback({ silent, allowQuietSkip: true });
  }

  function markDisconnected(detail = "Disconnected") {
    if (disposed) return;
    connected = false;
    connecting = false;
    transientWriteFailures = 0;
    writeScheduler.clear();
    if (postWriteRefreshTimer) {
      clearTimeout(postWriteRefreshTimer);
      postWriteRefreshTimer = null;
    }
    setStatus(false, detail, { disconnectedByUser });
  }

  async function connectOnce() {
    if (disposed) return false;
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
      if (disposed) return false;
      connected = true;
      connecting = false;
      transientWriteFailures = 0;
      manualConnectRequested = false;
      disconnectedByUser = false;
      setStatus(true, `Connected (${ip})`);
      return true;
    } catch {
      if (disposed) return false;
      connected = false;
      connecting = false;
      setStatus(false, "Not connected", { disconnectedByUser });
      return false;
    }
  }

  async function discoverBridges(opts = null) {
    if (disposed) return;
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
      if (disposed) return;
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
      if (disposed) return;
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
      if (disposed) return;
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
    if (disposed) return;
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
    ctx.profile?.onChanged?.((ev) => {
      if (disposed) return;
      applyProfileSettings(ev?.settings || ev);
    });
  } catch {
    // ignore
  }

  setBindings(ctx.bindings?.getAll?.() || []);
  ctx.bindings?.onChanged?.((next) => {
    if (disposed) return;
    setBindings(next);
  });

  (async () => {
    while (!disposed) {
      if (!connected && !connecting && !pairing && !disconnectedByUser && (autoConnect || manualConnectRequested)) {
        await connectOnce();
      } else if (connected && !connecting) {
        try {
          await refreshHueState({ silent: true });
        } catch {
          if (disposed) return;
          markDisconnected("Disconnected");
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
  })();

  function rememberIntentForTargetAndMembers(target, intent) {
    const key = targetKey(target.kind, target.id);
    rememberLocalIntent(key, intent);

    if (target.kind !== "group") return;
    const lightIds = groupLightIdsByKey.get(key) || [];
    for (const lightId of lightIds) {
      rememberLocalIntent(targetKey("light", lightId), intent);
    }
  }

  function rememberQueuedVolumeForTargetAndMembers(target, volume) {
    const next = clamp01(volume);
    const key = targetKey(target.kind, target.id);
    lastQueuedVolumeByKey.set(key, next);

    if (target.kind !== "group") return;
    const lightIds = groupLightIdsByKey.get(key) || [];
    for (const lightId of lightIds) {
      lastQueuedVolumeByKey.set(targetKey("light", lightId), next);
    }
  }

  function updateOptimisticState(target, nextState) {
    const key = targetKey(target.kind, target.id);
    const current = stateByKey.get(key) || { id: target.id, name: target.name, kind: target.kind, bri: savedBriForKey(key) };
    const bri = nextState.bri == null ? clampHueBri(current.bri) : clampHueBri(nextState.bri);
    const next = {
      ...current,
      ...nextState,
      id: String(target.id),
      name: current.name || target.name,
      kind: target.kind,
      bri,
    };
    stateByKey.set(key, next);
    rememberNonzeroBri(key, bri);

    if (target.kind !== "group") return;
    const lightIds = groupLightIdsByKey.get(key) || [];
    for (const lightId of lightIds) {
      const lightKey = targetKey("light", lightId);
      const lightCurrent = stateByKey.get(lightKey) || { id: String(lightId), name: `Hue Light ${lightId}`, kind: "light", bri };
      const lightNext = {
        ...lightCurrent,
        on: next.on,
        bri,
      };
      stateByKey.set(lightKey, lightNext);
      rememberNonzeroBri(lightKey, bri);
    }
  }

  async function syncAffectedFeedback(target, skipBindingId = "") {
    const key = targetKey(target.kind, target.id);
    await syncFeedbackForKey(key, { silent: true, skipBindingId, forceHardwareFeedback: true });

    if (target.kind !== "group") return;
    const lightIds = groupLightIdsByKey.get(key) || [];
    for (const lightId of lightIds) {
      await syncFeedbackForKey(targetKey("light", lightId), {
        silent: true,
        skipBindingId,
        forceHardwareFeedback: true,
      });
    }
  }

  function queueToggleWrite(target, on) {
    const key = targetKey(target.kind, target.id);
    const body = on
      ? { on: true, bri: savedBriForKey(key), transitiontime: 0 }
      : { on: false, transitiontime: 0 };
    queueHueWrite(target.kind, target.id, body, { fanoutGroup: false });
  }

  function queuePowerActionWrite(target, buttonAction) {
    const key = targetKey(target.kind, target.id);
    const body = huePowerWriteBody(buttonAction, savedBriForKey(key));
    if (!body) return null;
    queueHueWrite(target.kind, target.id, body, { fanoutGroup: false });
    return body;
  }

  function queueVolumeWrite(target, value, options = null) {
    const key = targetKey(target.kind, target.id);
    const volume = clamp01(value);
    const force = Boolean(options?.force);
    const previousQueued = lastQueuedVolumeByKey.get(key);
    if (!force && typeof previousQueued === "number" && Math.abs(previousQueued - volume) < BRIGHTNESS_EPSILON) {
      return;
    }

    rememberQueuedVolumeForTargetAndMembers(target, volume);
    if (volume <= 0) {
      queueHueWrite(target.kind, target.id, { on: false, transitiontime: 0 }, { fanoutGroup: false });
      return;
    }

    const bri = volumeToHueBri(volume);
    rememberNonzeroBri(key, bri);
    queueHueWrite(target.kind, target.id, { on: true, bri, transitiontime: 0 }, { fanoutGroup: true });
  }

  function normalizeBatchTargets(payload) {
    const rawTargets = Array.isArray(payload?.targets) ? payload.targets : [];
    return rawTargets.map((entry, index) => {
      const target = normalizeIntegrationTarget(entry?.target || entry);
      if (!target) return null;
      return {
        target,
        target_index: Number(entry?.target_index ?? index),
        target_count: Number(entry?.target_count ?? rawTargets.length),
        is_primary_target: entry?.is_primary_target === true,
        button_event: String(entry?.button_event || payload?.button_event || "").toLowerCase(),
      };
    }).filter(Boolean);
  }

  function hueButtonEvent(payload, entry = null) {
    const explicit = String(entry?.button_event || payload?.button_event || "").toLowerCase();
    if (explicit === "press" || explicit === "release") return explicit;
    if (payload?.momentary_trigger === false) return "release";
    if (payload?.momentary_trigger === true) return "press";
    return clamp01(payload?.value) > 0 ? "press" : "release";
  }

  async function handleHueToggle(payload) {
    const target = normalizeIntegrationTarget(payload?.target);
    if (!target || !connected) return;

    const bindingId = String(payload?.binding_id || "");
    const on = clamp01(payload?.value) > 0.5;
    const key = targetKey(target.kind, target.id);
    const bri = on ? savedBriForKey(key) : savedBriForKey(key, stateByKey.get(key)?.bri || 254);

    updateOptimisticState(target, { on, bri });
    rememberIntentForTargetAndMembers(target, on ? { on, bri } : { on: false });
    rememberQueuedVolumeForTargetAndMembers(target, on ? clamp01(bri / 254) : 0);
    queueToggleWrite(target, on);

    if (bindingId) {
      await ctx.feedback.set(bindingId, on ? 1.0 : 0.0, "ToggleMute");
    }
    await syncAffectedFeedback(target, bindingId);
  }

  async function handleHuePowerAction(payload, entry) {
    const target = entry?.target || normalizeIntegrationTarget(payload?.target);
    if (!target || !connected) return false;

    const buttonAction = normalizeHueButtonAction(target.button_action);
    if (buttonAction !== "turn_on" && buttonAction !== "turn_off") return false;

    const bindingId = String(payload?.binding_id || "");
    if (hueButtonEvent(payload, entry) === "release") {
      if (bindingId) {
        await ctx.feedback.set(bindingId, 0.0, "Volume", { silent: true, inputValue: 0.0 });
      }
      return true;
    }

    const key = targetKey(target.kind, target.id);
    const on = buttonAction === "turn_on";
    const bri = on ? savedBriForKey(key) : savedBriForKey(key, stateByKey.get(key)?.bri || 254);
    const body = queuePowerActionWrite(target, buttonAction);
    if (!body) return false;

    updateOptimisticState(target, { on, bri });
    rememberIntentForTargetAndMembers(target, on ? { on, bri } : { on: false });
    rememberQueuedVolumeForTargetAndMembers(target, on ? clamp01(bri / 254) : 0);

    if (bindingId) {
      await ctx.feedback.set(bindingId, on ? 1.0 : 0.0, "Volume", { inputValue: 1.0 });
    }
    await syncAffectedFeedback(target, bindingId);
    return true;
  }

  async function handleHueVolumeTargets(payload, targets) {
    if (!connected || targets.length === 0) return;

    const bindingId = String(payload?.binding_id || "");
    const value = clamp01(payload?.value);

    for (const entry of targets) {
      const target = entry.target;
      const key = targetKey(target.kind, target.id);
      const priorState = stateByKey.get(key);
      const nextBri = value <= 0 ? savedBriForKey(key, priorState?.bri || 254) : volumeToHueBri(value);
      const forceWrite = value <= 0
        ? Boolean(priorState?.on)
        : (!priorState?.on || Math.abs(clampHueBri(priorState?.bri) - nextBri) > 2);
      if (value <= 0) {
        const bri = nextBri;
        updateOptimisticState(target, { on: false, bri });
        rememberIntentForTargetAndMembers(target, { on: false });
      } else {
        const bri = nextBri;
        updateOptimisticState(target, { on: true, bri });
        rememberIntentForTargetAndMembers(target, { on: true, bri });
      }
      queueVolumeWrite(target, value, { force: forceWrite });
    }

    if (bindingId) {
      await ctx.feedback.set(bindingId, value, "Volume");
    }

    for (const entry of targets) {
      await syncAffectedFeedback(entry.target, bindingId);
    }
  }

  ctx.registerIntegration({
    id: "hue",
    name: "Philips Hue",
    icon_data: iconDataUrl || null,
    buttonActions: [
      { label: "Toggle On/Off", value: "ToggleMute", behavior: "stateful" },
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
    getTargetOptions: async (ctx2 = null) => {
      if (!connected) {
        return [];
      }

      const controlType = ctx2 && typeof ctx2 === "object" ? String(ctx2.controlType || "") : "";
      const nav = ctx2 && typeof ctx2 === "object" ? ctx2.nav : null;

      if (controlType === "button" && nav?.screen === "hue_power_actions") {
        const kind = String(nav.kind || "");
        const id = String(nav.id || "");
        const key = targetKey(kind, id);
        const state = stateByKey.get(key);
        if (!state || (kind !== "light" && kind !== "group")) {
          return [{ label: "Hue target not found", kind: "placeholder", ghost: true, icon_data: iconDataUrl || null }];
        }
        const name = String(state.name || `${kind} ${id}`);
        const target = { kind, id, name, icon_data: iconDataUrl || null };
        return HUE_BUTTON_POWER_ACTIONS.map((action) => (
          createHueButtonActionOption(target, action.button_action, iconDataUrl || null)
        ));
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
        const label = String(state.name || `${kind} ${id}`);
        const entry = controlType === "button" ? {
          label,
          icon_data: iconDataUrl || null,
          nav: {
            screen: "hue_power_actions",
            kind,
            id: String(id),
          },
        } : {
          label,
          icon_data: iconDataUrl || null,
          target: {
            Integration: {
              integration_id: "hue",
              kind,
              data: {
                id: String(id),
                name: label,
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
    onBindingTriggeredBatch: async (payload) => {
      if (String(payload?.action || "Volume") !== "Volume") return;
      try {
        const targets = normalizeBatchTargets(payload);
        const volumeTargets = [];
        for (const entry of targets) {
          if (entry.target.button_action === "turn_on" || entry.target.button_action === "turn_off") {
            await handleHuePowerAction(payload, entry);
          } else {
            volumeTargets.push(entry);
          }
        }
        if (volumeTargets.length > 0) {
          await handleHueVolumeTargets(payload, volumeTargets);
        }
      } catch {
        transientWriteFailures += 1;
        if (transientWriteFailures >= MAX_TRANSIENT_WRITE_FAILURES) {
          markDisconnected("Disconnected");
        }
      }
    },
    onBindingTriggered: async (payload) => {
      try {
        const action = String(payload?.action || "Volume");
        if (action === "ToggleMute") {
          await handleHueToggle(payload);
          return;
        }
        const target = normalizeIntegrationTarget(payload?.target);
        if (!target) return;
        if (target.button_action === "turn_on" || target.button_action === "turn_off") {
          await handleHuePowerAction(payload, { target });
          return;
        }
        await handleHueVolumeTargets(payload, [{
          target,
          target_index: Number(payload?.target_index ?? 0),
          target_count: Number(payload?.target_count ?? 1),
          is_primary_target: payload?.is_primary_target !== false,
        }]);
      } catch {
        transientWriteFailures += 1;
        if (transientWriteFailures >= MAX_TRANSIENT_WRITE_FAILURES) {
          markDisconnected("Disconnected");
        }
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


import { sleep, clamp01 } from "../../../plugin_sources/shared/runtime.js";
export { sleep, clamp01 };

export function clampHueBri(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(254, Math.round(n)));
}

export function volumeToHueBri(value) {
  const v = clamp01(value);
  if (v <= 0) return 0;
  return Math.max(1, Math.min(254, Math.round(v * 254)));
}

export function hueVolumeFromState(entry) {
  if (!entry || !entry.on) return 0;
  return clamp01((Number(entry.bri) || 0) / 254);
}

export const HUE_BUTTON_POWER_ACTIONS = [
  { button_action: "toggle", label: "Toggle On/Off", action: "ToggleMute", behavior: "stateful" },
  {
    button_action: "turn_on",
    label: "Turn On",
    action: "Volume",
    behavior: "momentary",
    osd_value_text: "ON",
  },
  {
    button_action: "turn_off",
    label: "Turn Off",
    action: "Volume",
    behavior: "momentary",
    osd_value_text: "OFF",
  },
];

export function normalizeHueButtonAction(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (normalized === "toggle" || normalized === "turn_on" || normalized === "turn_off") {
    return normalized;
  }
  return "";
}

export function hueButtonActionDefinition(value) {
  const normalized = normalizeHueButtonAction(value) || "toggle";
  return (
    HUE_BUTTON_POWER_ACTIONS.find((action) => action.button_action === normalized) ||
    HUE_BUTTON_POWER_ACTIONS[0]
  );
}

export function huePowerWriteBody(buttonAction, bri = 254) {
  const normalized = normalizeHueButtonAction(buttonAction);
  if (normalized === "turn_on") {
    return { on: true, bri: savedHueBriValue(bri), transitiontime: 0 };
  }
  if (normalized === "turn_off") {
    return { on: false, transitiontime: 0 };
  }
  return null;
}

export function savedHueBriValue(value) {
  return Math.max(1, Math.min(254, clampHueBri(value) || 254));
}

export function createHueButtonActionOption(target, buttonAction, fallbackIconData = null) {
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
    buttonActions: [
      {
        label: def.label,
        value: def.action,
        behavior: def.behavior,
      },
    ],
  };
}

export function firstHueTargetFromBinding(binding) {
  const targets =
    Array.isArray(binding?.targets) && binding.targets.length > 0
      ? binding.targets
      : binding?.target
        ? [binding.target]
        : [];
  for (const rawTarget of targets) {
    const target = hueTargetFromRawTarget(rawTarget);
    if (target) return target;
  }
  return null;
}

export function hueTargetFromRawTarget(rawTarget) {
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

export function hueTargetKey(kind, id) {
  return `${String(kind || "")}::${String(id || "")}`;
}

export function hueBindingTargets(binding) {
  return Array.isArray(binding?.targets) && binding.targets.length > 0
    ? binding.targets
    : binding?.target
      ? [binding.target]
      : [];
}

export function hueBindingHasTargetKey(binding, key) {
  for (const rawTarget of hueBindingTargets(binding)) {
    const target = hueTargetFromRawTarget(rawTarget);
    if (target && hueTargetKey(target.kind, target.id) === key) return true;
  }
  return false;
}

export function hueStateFeedbackForBinding(binding, entry) {
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

export function hueFeedbackSetOptions(opts = null) {
  const silent = opts && typeof opts === "object" ? Boolean(opts.silent) : true;
  const forceHardwareFeedback = Boolean(
    opts &&
      typeof opts === "object" &&
      (opts.forceHardwareFeedback || opts.force_hardware_feedback || opts.force === true),
  );
  if (!forceHardwareFeedback) return { silent };
  return {
    silent,
    forceHardwareFeedback: true,
    force_hardware_feedback: true,
  };
}

export function hueFeedbackUpdatesForKey(bindings, stateByKey, key, opts = null) {
  const skipBindingId = String(opts?.skipBindingId || "");
  const entry = stateByKey?.get?.(key);
  if (!entry) return [];

  const updates = [];
  for (const b of Array.isArray(bindings) ? bindings : []) {
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

export function normalizeHueGroupType(type) {
  return String(type || "")
    .trim()
    .toLowerCase();
}

export function isHumanFriendlyHueGroupName(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  if (/^hgrp-\d+$/i.test(n)) return false;
  if (/^lumia-stream-\d+$/i.test(n)) return false;
  return true;
}

export function isSelectableHueGroup(entry) {
  const type = normalizeHueGroupType(entry?.type);
  // Keep the picker focused on user-facing targets only.
  if (!(type === "room" || type === "zone" || type === "lightgroup")) {
    return false;
  }
  return isHumanFriendlyHueGroupName(entry?.name);
}

export const POLL_INTERVAL_MS = 5000;

export const IDLE_POLL_INTERVAL_MS = 15000;

export const RECONNECT_MAX_DELAY_MS = 30000;

export const REQUEST_TIMEOUT_MS = 4000;

export const LOCAL_WRITE_QUIET_MS = 1200;

export const DEFAULT_AUTO_CONNECT = true;

export const PAIR_WINDOW_MS = 30000;

export const LIGHT_WRITE_INTERVAL_MS = 110;

export const GROUP_WRITE_INTERVAL_MS = 1050;

export const BRIGHTNESS_EPSILON = 0.004;

export const LOCAL_INTENT_HOLD_MS = 1800;

export const POST_WRITE_REFRESH_DEBOUNCE_MS = 250;

export const MAX_TRANSIENT_WRITE_FAILURES = 3;

export const GROUP_FANOUT_MAX_LIGHTS = 3;

export function createHueWriteScheduler({
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
      try {
        resolve();
      } catch {}
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
      shouldSend: options && typeof options.shouldSend === "function" ? options.shouldSend : null,
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

export const ui = {
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

export const lastStatus = { connected: false, connecting: false, detail: "Not connected" };

export function setStatus(connected, detail = "", opts = null) {
  const connecting = opts && typeof opts === "object" ? Boolean(opts.connecting) : false;
  const disconnectedByUser = opts && typeof opts === "object" ? Boolean(opts.disconnectedByUser) : false;

  lastStatus.connected = Boolean(connected);
  lastStatus.connecting = connecting;
  lastStatus.detail = detail || "";

  if (ui.statusText) {
    ui.statusText.textContent = connected ? detail || "Connected" : detail || "Not connected";
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

export function hueErrorFromResult(json) {
  if (!Array.isArray(json)) return null;
  const err = json.find((item) => item && item.error);
  if (!err || !err.error) return null;
  const type = err.error.type != null ? String(err.error.type) : "unknown";
  const description = err.error.description ? String(err.error.description) : "Hue request failed";
  return { type, description };
}

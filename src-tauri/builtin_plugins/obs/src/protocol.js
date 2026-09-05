import { sleep, clamp01 } from "../../../plugin_sources/shared/runtime.js";
export { sleep, clamp01 };

export const LOCAL_WRITE_QUIET_MS = 1200;

export const FEEDBACK_INTENT_HOLD_MS = 1200;

export const FEEDBACK_INTENT_MATCH_EPSILON = 0.02;

export const VOLUME_WRITE_INTERVAL_MS = 16;

export const VOLUME_WRITE_EPSILON = 0.002;

export const RECONNECT_INITIAL_DELAY_MS = 1000;

export const RECONNECT_MAX_DELAY_MS = 15000;

export const RECONNECT_IDLE_DELAY_MS = 5000;

export function rememberLocalMuteIntent(intents, inputName, muted, now = Date.now()) {
  if (!intents || !inputName) return;
  intents.set(String(inputName), {
    muted: Boolean(muted),
    at: now,
  });
}

export function forgetLocalMuteIntent(intents, inputName) {
  if (!intents || !inputName) return;
  intents.delete(String(inputName));
}

export function shouldIgnoreLocalMuteEcho(intents, inputName, muted, now = Date.now()) {
  if (!intents || !inputName) return false;
  const key = String(inputName);
  const intent = intents.get(key);
  if (!intent) return false;
  if (now - Number(intent.at || 0) >= LOCAL_WRITE_QUIET_MS) {
    intents.delete(key);
    return false;
  }
  if (Boolean(intent.muted) !== Boolean(muted)) {
    intents.delete(key);
    return false;
  }
  return true;
}

export function inputMuteFeedbackBindingIds(volumeBindings, muteBindings, inputName) {
  return new Set([...(volumeBindings?.get(inputName) || []), ...(muteBindings?.get(inputName) || [])]);
}

export function bindingIntegrationTargets(binding) {
  const targets = Array.isArray(binding?.targets) ? [...binding.targets] : [];
  if (binding?.target != null) targets.push(binding.target);
  return targets
    .map((target) => target?.Integration || target?.integration)
    .filter((target) => target && typeof target === "object");
}

export function obsDisconnectedFeedbackUpdates(bindings) {
  const updates = new Map();
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const bindingId = String(binding?.id || "").trim();
    if (!bindingId) continue;
    const obsTargets = bindingIntegrationTargets(binding).filter((target) => target.integration_id === "obs");
    if (obsTargets.length === 0) continue;

    const action = String(binding?.action || "Volume");
    if (action === "ToggleMute" || action === "ToggleEffect") {
      updates.set(`${bindingId}\u0000${action}`, { bindingId, action });
    }
    if (obsTargets.some((target) => target.kind === "input")) {
      updates.set(`${bindingId}\u0000ToggleMute`, { bindingId, action: "ToggleMute" });
    }
  }
  return Array.from(updates.values());
}

export function sourceFilterKey(sourceName, filterName) {
  return `${String(sourceName || "")}\u0000${String(filterName || "")}`;
}

export function normalizeSourceFilters(filters) {
  if (!Array.isArray(filters)) return [];
  return filters
    .map((filter) => {
      const filterName = String(filter?.filterName || "").trim();
      if (!filterName) return null;
      return {
        filterName,
        filterKind: String(filter?.filterKind || "").trim(),
        filterEnabled: Boolean(filter?.filterEnabled),
      };
    })
    .filter(Boolean);
}

export function makeSourceFilterToggleTarget(sourceName, filterName) {
  return {
    Integration: {
      integration_id: "obs",
      kind: "source_filter",
      data: {
        source_name: String(sourceName),
        filter_name: String(filterName),
        action_kind: "stateful",
      },
    },
  };
}

export function makeSourceFilterTargetOption(sourceName, filterName, iconDataUrl = null) {
  return {
    label: `${String(sourceName)} - ${String(filterName)}`,
    icon_data: iconDataUrl || null,
    kind: "integration-target",
    category: "integrations",
    target: makeSourceFilterToggleTarget(sourceName, filterName),
    description: "OBS source filter.",
  };
}

export function makeSourceFilterButtonAction(sourceName, filterName, iconDataUrl = null) {
  return {
    label: `Toggle ${String(filterName)}`,
    value: "ToggleEffect",
    behavior: "stateful",
    targetOption: makeSourceFilterTargetOption(sourceName, filterName, iconDataUrl),
  };
}

export const obsTestUtils = {
  LOCAL_WRITE_QUIET_MS,
  rememberLocalMuteIntent,
  forgetLocalMuteIntent,
  shouldIgnoreLocalMuteEcho,
  inputMuteFeedbackBindingIds,
  obsDisconnectedFeedbackUpdates,
  sourceFilterKey,
  normalizeSourceFilters,
  makeSourceFilterToggleTarget,
  makeSourceFilterButtonAction,
};

export function isOsdWindow() {
  try {
    return new URLSearchParams(window.location.search).get("osd") === "1";
  } catch {
    return false;
  }
}

export const ui = {
  statusText: null,
  statusDot: null,
  connectBtn: null,
  autoConnectInput: null,
  hostInput: null,
  portInput: null,
  passwordInput: null,
};

export function setStatus(connected, detail = "", opts = null) {
  const textEl = ui.statusText;
  const dotEl = ui.statusDot;
  const btn = ui.connectBtn;
  const connecting = opts && typeof opts === "object" ? Boolean(opts.connecting) : false;
  const disconnectedByUser = opts && typeof opts === "object" ? Boolean(opts.disconnectedByUser) : false;
  if (textEl) {
    textEl.textContent = connected ? detail || "Connected" : detail || "Not connected";
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

export async function sha256Base64(text) {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(hash));
  const bin = String.fromCharCode(...arr);
  return btoa(bin);
}

export async function obsAuth(password, salt, challenge) {
  const secret = await sha256Base64(password + salt);
  return sha256Base64(secret + challenge);
}

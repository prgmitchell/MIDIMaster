import { hueTargetKey, clampHueBri, LOCAL_INTENT_HOLD_MS, hueTargetFromRawTarget } from "./protocol.js";

/** target state workflow. */
export function createTargetState({
  iconDataUrl,
  lastLocalWriteAt,
  lastNonzeroBriByKey,
  localIntentByKey,
  stateByKey,
}) {
  function targetKey(kind, id) {
    return hueTargetKey(kind, id);
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
    if (now - Number(intent.at || 0) >= LOCAL_INTENT_HOLD_MS) {
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
    const normalized = hueTargetFromRawTarget(rawTarget);
    if (!normalized) return null;
    const t = rawTarget?.Integration || rawTarget?.integration || rawTarget;
    const data = t.data || {};
    return {
      ...normalized,
      name: String(data.name || data.label || `${normalized.kind} ${normalized.id}`),
      icon_data:
        typeof data.icon_data === "string" && data.icon_data.trim() ? data.icon_data : iconDataUrl || null,
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

  return {
    targetKey,
    rememberNonzeroBri,
    savedBriForKey,
    rememberLocalIntent,
    freshLocalIntent,
    mergeIncomingStateWithLocalIntent,
    normalizeIntegrationTarget,
    parseLightState,
    parseGroupState,
  };
}

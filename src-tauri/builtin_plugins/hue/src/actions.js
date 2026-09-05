import {
  clamp01,
  clampHueBri,
  huePowerWriteBody,
  BRIGHTNESS_EPSILON,
  volumeToHueBri,
  normalizeHueButtonAction,
} from "./protocol.js";

/** actions workflow. */
export function createActions({
  ctx,
  groupLightIdsByKey,
  lastQueuedVolumeByKey,
  normalizeIntegrationTarget,
  queueHueWrite,
  rememberLocalIntent,
  rememberNonzeroBri,
  savedBriForKey,
  state,
  stateByKey,
  syncFeedbackForKey,
  targetKey,
}) {
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
    const current = stateByKey.get(key) || {
      id: target.id,
      name: target.name,
      kind: target.kind,
      bri: savedBriForKey(key),
    };
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
      const lightCurrent = stateByKey.get(lightKey) || {
        id: String(lightId),
        name: `Hue Light ${lightId}`,
        kind: "light",
        bri,
      };
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
    if (
      !force &&
      typeof previousQueued === "number" &&
      Math.abs(previousQueued - volume) < BRIGHTNESS_EPSILON
    ) {
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
    return rawTargets
      .map((entry, index) => {
        const target = normalizeIntegrationTarget(entry?.target || entry);
        if (!target) return null;
        return {
          target,
          target_index: Number(entry?.target_index ?? index),
          target_count: Number(entry?.target_count ?? rawTargets.length),
          is_primary_target: entry?.is_primary_target === true,
          button_event: String(entry?.button_event || payload?.button_event || "").toLowerCase(),
        };
      })
      .filter(Boolean);
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
    if (!target || !state.connected) return;

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
    if (!target || !state.connected) return false;

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
    if (!state.connected || targets.length === 0) return;

    const bindingId = String(payload?.binding_id || "");
    const value = clamp01(payload?.value);

    for (const entry of targets) {
      const target = entry.target;
      const key = targetKey(target.kind, target.id);
      const priorState = stateByKey.get(key);
      const nextBri = value <= 0 ? savedBriForKey(key, priorState?.bri || 254) : volumeToHueBri(value);
      const forceWrite =
        value <= 0
          ? Boolean(priorState?.on)
          : !priorState?.on || Math.abs(clampHueBri(priorState?.bri) - nextBri) > 2;
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

  return { normalizeBatchTargets, handleHueToggle, handleHuePowerAction, handleHueVolumeTargets };
}

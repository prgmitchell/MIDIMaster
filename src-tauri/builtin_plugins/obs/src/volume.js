import {
  LOCAL_WRITE_QUIET_MS,
  clamp01,
  FEEDBACK_INTENT_HOLD_MS,
  FEEDBACK_INTENT_MATCH_EPSILON,
  VOLUME_WRITE_INTERVAL_MS,
  VOLUME_WRITE_EPSILON,
} from "./protocol.js";

/** volume workflow. */
export function createVolume({
  ctx,
  lastLocalWriteAt,
  lastSentVolumeByInput,
  localVolumeIntentByBinding,
  pendingVolumeWrites,
  request,
  state,
}) {
  function shouldIgnoreEcho(inputName) {
    const t = lastLocalWriteAt.get(String(inputName)) || 0;
    return t > 0 && Date.now() - t < LOCAL_WRITE_QUIET_MS;
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
    if (state.volumeFlushTimer) return;
    state.volumeFlushTimer = setTimeout(() => {
      state.volumeFlushTimer = null;
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
      typeof lastSent === "number" &&
      Math.abs(lastSent - level) < VOLUME_WRITE_EPSILON &&
      !pendingVolumeWrites.has(name)
    ) {
      return;
    }
    pendingVolumeWrites.set(name, level);
    scheduleVolumeFlush();
  }

  async function flushVolumeWrites() {
    if (state.volumeFlushInFlight) return;
    if (!state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
      pendingVolumeWrites.clear();
      return;
    }

    state.volumeFlushInFlight = true;
    try {
      const writes = Array.from(pendingVolumeWrites.entries());
      pendingVolumeWrites.clear();
      if (!state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN || writes.length === 0) {
        return;
      }

      const sentAt = Date.now();
      for (const [inputName, level] of writes) {
        lastLocalWriteAt.set(String(inputName), sentAt);
        lastSentVolumeByInput.set(String(inputName), level);
      }

      await Promise.all(
        writes.map(([inputName, level]) =>
          request("SetInputVolume", {
            inputName,
            inputVolumeMul: level,
          }),
        ),
      );
    } finally {
      state.volumeFlushInFlight = false;
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
      state.knownVolumes.set(String(inputName), vol);
      queueVolumeWrite(inputName, vol);
      queuedAny = true;
    }

    if (queuedAny) {
      flushVolumeWrites().catch(() => {});
    }

    return queuedAny;
  }

  return { shouldIgnoreEcho, shouldIgnoreBindingVolumeEcho, normalizeBatchTargets, applyObsVolumeBatch };
}

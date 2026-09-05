import { integrationTargetKey as canonicalIntegrationTargetKey } from "../../core/target_core.js";

/** integration state workflow. */
export function createIntegrationState({ liveState }) {
  function integrationStateKeyForTarget(target) {
    if (!target || typeof target !== "object") return "";
    const integration = target.Integration || target.integration;
    return canonicalIntegrationTargetKey(integration);
  }

  function getIntegrationStateForTarget(target) {
    const key = integrationStateKeyForTarget(target);
    if (!key) return null;
    return liveState.integrationTargetStateByKey.get(key) || null;
  }

  function updateIntegrationStateFromEventPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    const key = integrationStateKeyForTarget(payload.target);
    if (!key) return;
    const prev = liveState.integrationTargetStateByKey.get(key) || {};
    const next = { ...prev };
    if (typeof payload.volume === "number") {
      next.volume = payload.volume;
    }
    if (typeof payload.muted === "boolean") {
      next.muted = payload.muted;
    }
    liveState.integrationTargetStateByKey.set(key, next);
  }

  return {
    integrationStateKeyForTarget,
    getIntegrationStateForTarget,
    updateIntegrationStateFromEventPayload,
  };
}

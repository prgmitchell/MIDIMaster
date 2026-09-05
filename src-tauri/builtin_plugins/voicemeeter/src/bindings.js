import {
  INTEGRATION_ID,
  isOneShotVoicemeeterTarget,
  targetUsesPersistentFeedback,
  parameterKey,
} from "./protocol.js";

/** bindings workflow. */
export function createBindings({ ctx, state }) {
  function integrationTargets(binding) {
    const targets =
      Array.isArray(binding?.targets) && binding.targets.length ? binding.targets : [binding?.target];
    return targets
      .map((target) => target?.Integration || target?.integration)
      .filter((target) => target?.integration_id === INTEGRATION_ID);
  }

  function bindingContainsOnlyOneShotVoicemeeterTargets(bindingId, fallbackTargetCount = 1) {
    const binding = (ctx.bindings.getAll() || []).find((entry) => entry?.id === bindingId);
    if (!binding) return Number(fallbackTargetCount) === 1;
    const rawTargets =
      Array.isArray(binding.targets) && binding.targets.length ? binding.targets : [binding.target];
    const targets = integrationTargets(binding);
    return (
      targets.length > 0 && rawTargets.length === targets.length && targets.every(isOneShotVoicemeeterTarget)
    );
  }

  async function resetLegacyOneShotFeedback(payload) {
    if (!payload?.binding_id || !["ToggleEffect", "ToggleMute"].includes(payload.action)) return;
    if (!bindingContainsOnlyOneShotVoicemeeterTargets(payload.binding_id, payload.target_count)) return;
    await ctx.feedback
      .set(payload.binding_id, 0, payload.action, { forceHardwareFeedback: true })
      .catch(() => {});
  }

  function rebuildBindingCache() {
    const seen = new Map();
    const feedback = new Map();
    for (const binding of ctx.bindings.getAll() || []) {
      for (const target of integrationTargets(binding)) {
        const data = target.data || {};
        if (target.kind === "parameter" && data.scope && data.property != null) {
          if (!targetUsesPersistentFeedback(target)) continue;
          const parameter = { scope: data.scope, index: Number(data.index), property: data.property };
          const key = parameterKey(parameter);
          seen.set(key, parameter);
          if (!feedback.has(key)) feedback.set(key, []);
          feedback.get(key).push({ id: binding.id, action: binding.action || "Volume", data });
        }
      }
    }
    state.parameterCache = Array.from(seen.values());
    state.feedbackCache = feedback;
  }

  return { resetLegacyOneShotFeedback, rebuildBindingCache };
}

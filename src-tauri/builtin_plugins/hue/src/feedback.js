import {
  hueBindingTargets,
  hueFeedbackUpdatesForKey,
  LOCAL_WRITE_QUIET_MS,
  hueStateFeedbackForBinding,
  isSelectableHueGroup,
} from "./protocol.js";

/** feedback workflow. */
export function createFeedback({
  ctx,
  freshLocalIntent,
  groupLightIdsByKey,
  hueGet,
  lastLocalWriteAt,
  mergeIncomingStateWithLocalIntent,
  normalizeIntegrationTarget,
  parseGroupState,
  parseLightState,
  rememberNonzeroBri,
  state,
  stateByKey,
  targetKey,
}) {
  function setBindings(nextBindings) {
    state.bindings = Array.isArray(nextBindings) ? nextBindings : [];
  }

  function firstHueTargetForBinding(binding) {
    for (const rawTarget of hueBindingTargets(binding)) {
      const target = normalizeIntegrationTarget(rawTarget);
      if (target) return target;
    }
    return null;
  }

  async function syncFeedbackForKey(key, opts = null) {
    for (const update of hueFeedbackUpdatesForKey(state.bindings, stateByKey, key, opts)) {
      try {
        await ctx.feedback.set(update.bindingId, update.value, update.action, update.options);
      } catch {
        // ignore
      }
    }
  }

  async function syncAllFeedback(opts = null) {
    const silent = opts && typeof opts === "object" ? Boolean(opts.silent) : true;
    const allowQuietSkip = opts && typeof opts === "object" ? Boolean(opts.allowQuietSkip) : false;
    const now = Date.now();

    for (const b of state.bindings) {
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
        if (lastWrite > 0 && now - lastWrite < LOCAL_WRITE_QUIET_MS) {
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
    if (state.disposed) return;
    const silent = opts && typeof opts === "object" ? Boolean(opts.silent) : true;
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

  return { setBindings, syncFeedbackForKey, refreshHueState };
}

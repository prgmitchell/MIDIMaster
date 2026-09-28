import { normalizeEndpoint } from "./protocol.js";

export function meterAddress(target) {
  const endpoint = normalizeEndpoint(target);
  if (!endpoint) return null;
  const { identifier, mixer_id: mix } = endpoint;
  if (!identifier && !mix) return null;
  return {
    type: identifier ? "channel" : "mix",
    id: identifier || mix,
    subId: identifier ? mix : "",
  };
}

const keyFor = ({ type, id, subId = "" }) => JSON.stringify([type, id, subId]);

export function stereoMeterLevel(meter) {
  const values = [
    meter?.levelLeftPercentage,
    meter?.levelRightPercentage,
  ].filter(Number.isFinite);
  return values.length ? Math.max(0, Math.min(1, Math.max(...values))) : null;
}

export function targetMeterLevel(address, level, state) {
  if (level == null || !state.wsId) return null;
  const mix =
    address.type === "mix" || address.subId
      ? state.mixes.find((m) => String(m.id) === (address.subId || address.id))
      : null;
  if ((address.type === "mix" || address.subId) && !mix) return null;
  if (mix?.isMuted) return 0;
  if (address.type === "channel") {
    const channel = state.channels.find((c) => String(c.id) === address.id);
    if (!channel) return null;
    if (channel.isMuted) return 0;
    if (address.subId) {
      const route = channel.mixes?.find((m) => String(m.id) === address.subId);
      if (!route) return null;
      if (route.isMuted) return 0;
    }
  }
  return level;
}

/** A subscription per requested source; all sources share the existing socket. */
export function createMeters({ ctx, state, requestJsonRpc }) {
  let generation = -1;
  let wanted = new Map();
  const subscribed = new Map();
  const levels = new Map();
  let reconciling = null;
  let publishTimer = null;
  let publishing = null;
  let dirty = false;
  let disposed = false;

  async function publish() {
    publishTimer = null;
    if (disposed || publishing || !dirty || generation < 0) return;
    dirty = false;
    const samples = [...wanted.values()].flatMap(({ address, targets }) =>
      targets.map((target) => ({
        target,
        level: targetMeterLevel(address, levels.get(keyFor(address)), state),
      })),
    );
    publishing = ctx.feedback.setAudioLevels(samples, generation);
    try {
      await publishing;
    } catch (error) {
      console.warn("Wave Link meter feedback failed", error);
    } finally {
      publishing = null;
      if (dirty) refresh();
    }
  }

  function refresh(scope) {
    // Only the refreshed scope is authoritative: initial meter notifications can
    // arrive before the other topology response on a new connection.
    for (const [key, { address }] of wanted) {
      const channel = state.channels.find((c) => String(c.id) === address.id);
      const mixId = address.type === "mix" ? address.id : address.subId;
      if (
        (scope === "channels" &&
          address.type === "channel" &&
          (!channel ||
            (address.subId &&
              !channel.mixes?.some((m) => String(m.id) === address.subId)))) ||
        (scope === "mixes" &&
          mixId &&
          !state.mixes.some((m) => String(m.id) === mixId))
      )
        levels.delete(key);
    }
    dirty = true;
    if (!disposed && !publishTimer && !publishing)
      publishTimer = setTimeout(publish, 40);
  }

  function reconcile() {
    if (disposed || reconciling || !state.wsId) return reconciling;
    const socket = state.wsId;
    const revision = generation;
    reconciling = (async () => {
      for (const [key, { address, generation: subscribedGeneration }] of [
        ...subscribed,
      ]) {
        if (wanted.has(key) && subscribedGeneration === generation) continue;
        await requestJsonRpc("setSubscription", {
          levelMeterChanged: { ...address, isEnabled: false },
        });
        if (state.wsId !== socket) return;
        subscribed.delete(key);
        levels.delete(key);
      }
      for (const [key, { address }] of wanted) {
        if (disposed || subscribed.has(key)) continue;
        const response = await requestJsonRpc("setSubscription", {
          levelMeterChanged: { ...address, isEnabled: true },
        });
        if (state.wsId !== socket) return;
        if (response?.ok)
          subscribed.set(key, { address, generation: revision });
      }
    })()
      .catch((error) => {
        if (state.wsId === socket)
          console.warn("Wave Link meter subscription failed", error);
      })
      .finally(() => {
        reconciling = null;
        refresh();
        // A reconnect or new demand can arrive while awaiting an acknowledgement.
        if (
          !disposed &&
          state.wsId &&
          (state.wsId !== socket ||
            revision !== generation ||
            [...subscribed.keys()].some((key) => !wanted.has(key)))
        )
          void reconcile();
      });
    return reconciling;
  }

  function setDemand(demand) {
    if (disposed || demand.generation < generation) return;
    const next = new Map();
    for (const target of demand.targets || []) {
      const address = meterAddress(target);
      if (!address) continue;
      const key = keyFor(address);
      if (!next.has(key)) next.set(key, { address, targets: [] });
      next.get(key).targets.push(target);
    }
    if (generation !== demand.generation) levels.clear();
    generation = demand.generation;
    wanted = next;
    void reconcile();
    refresh();
  }

  function receive(params) {
    if (disposed) return;
    for (const [type, field] of [
      ["channel", "channels"],
      ["mix", "mixes"],
    ]) {
      for (const meter of params?.[field] || []) {
        const key = keyFor({ type, id: meter.id, subId: meter.subId || "" });
        if (wanted.has(key)) levels.set(key, stereoMeterLevel(meter));
      }
    }
    refresh();
  }

  function disconnected() {
    subscribed.clear();
    levels.clear();
    refresh();
  }

  async function dispose() {
    disposed = true;
    if (publishTimer) clearTimeout(publishTimer);
    await Promise.allSettled([publishing, reconciling]);
    await ctx.feedback?.setAudioLevels?.([], generation);
    if (state.wsId) {
      await Promise.all(
        [...subscribed.values()].map(({ address }) =>
          requestJsonRpc("setSubscription", {
            levelMeterChanged: { ...address, isEnabled: false },
          }).catch(() => {}),
        ),
      );
    }
    subscribed.clear();
    levels.clear();
  }

  ctx.feedback
    ?.onAudioTargetsChanged?.(setDemand)
    ?.catch((error) => console.warn("Wave Link meter demand failed", error));
  return { receive, refresh, reconcile, disconnected, dispose };
}

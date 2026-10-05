import { normalizeEndpoint } from "./protocol.js";

export function createProfileState({
  state,
  requestJsonRpc,
  flushVolumeWrites,
  getChannelEffects,
  setChannelEffectEnabled,
  invalidateFeedback,
  resetVolumeState,
}) {
  async function flush() {
    const deadline = Date.now() + 2000;
    while (state.volumeFlushInFlight) {
      if (Date.now() >= deadline)
        throw new Error("Wave Link volume writes are still pending");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await flushVolumeWrites();
  }
  async function prepareStateCapture({ refresh }) {
    if (!refresh || !state.wsId || state.disposed) return;
    await flush();
    const [channels, mixes] = await Promise.all([
      requestJsonRpc("getChannels"),
      requestJsonRpc("getMixes"),
    ]);
    if (!channels.ok || !mixes.ok)
      throw new Error("Wave Link state is unavailable");
    state.channels = channels.result.channels;
    state.mixes = mixes.result.mixes;
  }

  function source(target) {
    if (!state.wsId || state.disposed) return null;
    const endpoint = normalizeEndpoint({ Integration: target });
    if (!endpoint) return null;
    if (!endpoint.identifier)
      return state.mixes.find((mix) => String(mix.id) === endpoint.mixer_id);
    const channel = state.channels.find(
      (channel) => String(channel.id) === endpoint.identifier,
    );
    return endpoint.mixer_id
      ? channel?.mixes?.find((mix) => String(mix.id) === endpoint.mixer_id)
      : channel;
  }

  function captureTargetState(target) {
    if (!state.wsId || state.disposed) return null;
    if (target.kind === "channel_effect") {
      const channel = state.channels.find(
        (channel) =>
          String(channel.id) ===
          String(target.data.identifier || target.data.channel_id),
      );
      const effect = getChannelEffects(channel).find(
        (effect) => String(effect.id) === String(target.data.effect_id),
      );
      return typeof effect?.enabled === "boolean"
        ? { enabled: effect.enabled }
        : null;
    }
    const item = source(target);
    if (!item) return null;
    const level = item.level ?? item.volume ?? item.value;
    const muted = item.isMuted ?? item.muted;
    return typeof level === "number" && typeof muted === "boolean"
      ? { volume: level, muted }
      : null;
  }

  async function restoreTargetState(target, saved) {
    if (!state.wsId || state.disposed) return false;
    if (target.kind === "channel_effect") {
      if (!captureTargetState(target)) return false;
      return setChannelEffectEnabled(target.data, saved.enabled);
    }
    if (
      !source(target) ||
      !Number.isFinite(saved.volume) ||
      typeof saved.muted !== "boolean"
    )
      return false;
    await flush();
    const endpoint = normalizeEndpoint({ Integration: target });
    const values = {
      level: Math.max(0, Math.min(1, saved.volume)),
      isMuted: saved.muted,
    };
    const params = !endpoint.identifier
      ? { id: endpoint.mixer_id, ...values }
      : !endpoint.mixer_id
        ? { id: endpoint.identifier, ...values }
        : {
            id: endpoint.identifier,
            mixes: [{ id: endpoint.mixer_id, ...values }],
          };
    const response = await requestJsonRpc(
      endpoint.identifier ? "setChannel" : "setMix",
      params,
    );
    if (!response.ok) return false;
    Object.assign(source(target), values);
    resetVolumeState?.();
    invalidateFeedback?.();
    return true;
  }

  return { prepareStateCapture, captureTargetState, restoreTargetState };
}

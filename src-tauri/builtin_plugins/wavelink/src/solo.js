import { normalizeEndpoint } from "./protocol.js";

function muted(item) {
  const value = item?.isMuted ?? item?.muted;
  if (typeof value !== "boolean")
    throw new Error("Wave Link mute state is unavailable");
  return value;
}

// Pure planning keeps the original flags separate from temporary Solo flags.
// Windows owns the playback session snapshot and sends these mixer operations.
export function buildWaveLinkSoloPlan({
  channels,
  mixes,
  targets,
  nativeChannelIds = [],
  wsId,
}) {
  const endpoints = targets.map(normalizeEndpoint).filter(Boolean);
  const wholeMixes = new Set();
  const channelRoutes = new Map();
  const findChannel = (id) =>
    channels.find(
      (ch) => String(ch.id).toLowerCase() === String(id).toLowerCase(),
    );
  const findMix = (id) => mixes.find((mix) => String(mix.id) === String(id));
  function addChannel(id, mixId = "") {
    const channel = findChannel(id);
    if (!channel)
      throw new Error("The selected Wave Link channel is unavailable");
    const key = String(channel.id);
    if (!mixId) channelRoutes.set(key, null);
    else if (channelRoutes.get(key) !== null) {
      const routes = channelRoutes.get(key) || new Set();
      if (!channel.mixes?.some((mix) => String(mix.id) === mixId)) {
        throw new Error(
          "The selected Wave Link channel is not routed to that mix",
        );
      }
      routes.add(mixId);
      channelRoutes.set(key, routes);
    }
  }
  for (const endpoint of endpoints) {
    if (endpoint.mixer_id && !findMix(endpoint.mixer_id))
      throw new Error("The selected Wave Link mix is unavailable");
    if (endpoint.identifier) addChannel(endpoint.identifier, endpoint.mixer_id);
    else if (endpoint.mixer_id) wholeMixes.add(endpoint.mixer_id);
    else throw new Error("Select a Wave Link channel or mix to use Solo");
  }
  // The hardware's direct playback endpoint is also an Elgato virtual endpoint,
  // but is not a mixer input. Windows isolates sessions on it directly.
  for (const id of nativeChannelIds) if (findChannel(id)) addChannel(id);
  if (!endpoints.length && !channelRoutes.size) return null;
  const audibleMixes = new Set(wholeMixes);
  const apply = [],
    restore = [];
  function change(method, base, original, next) {
    restore.push({ method, params: { ...base, isMuted: original } });
    if (original === next) return;
    apply.push({ method, params: { ...base, isMuted: next } });
  }
  for (const channel of channels) {
    const id = String(channel.id);
    const selected = channelRoutes.has(id);
    const routes = channelRoutes.get(id);
    change(
      "setChannel",
      { id },
      muted(channel),
      selected ? false : wholeMixes.size ? muted(channel) : true,
    );
    for (const route of channel.mixes || []) {
      const mixId = String(route.id);
      const original = muted(route);
      let next = true;
      if (selected && routes === null) next = original;
      else if (selected && routes?.has(mixId)) next = false;
      else if (wholeMixes.has(mixId)) next = original;
      if (!next && (selected || (!muted(channel) && wholeMixes.has(mixId))))
        audibleMixes.add(mixId);
      restore.push({
        method: "setChannel",
        params: { id, mixes: [{ id: mixId, isMuted: original }] },
      });
      if (next !== original) {
        apply.push({
          method: "setChannel",
          params: { id, mixes: [{ id: mixId, isMuted: next }] },
        });
      }
    }
  }
  for (const mix of mixes)
    change(
      "setMix",
      { id: String(mix.id) },
      muted(mix),
      !audibleMixes.has(String(mix.id)),
    );
  return {
    ws_id: wsId,
    apply,
    restore,
    allow_virtual_inputs: endpoints.length > 0,
    virtual_channel_ids: channels.map((channel) => String(channel.id)),
  };
}

export function createWaveLinkSolo({ state, requestJsonRpc }) {
  return async ({ targets, nativeChannelIds }) => {
    if (!state.wsId || state.disposed)
      throw new Error("Connect Wave Link before using Solo");
    const wsId = state.wsId;
    const [channelResponse, mixResponse] = await Promise.all([
      requestJsonRpc("getChannels"),
      requestJsonRpc("getMixes"),
    ]);
    if (state.wsId !== wsId || !channelResponse.ok || !mixResponse.ok) {
      throw new Error("Could not read Wave Link's current mute states");
    }
    const channels = channelResponse.result?.channels;
    const mixes = mixResponse.result?.mixes;
    if (!Array.isArray(channels) || !Array.isArray(mixes))
      throw new Error("Wave Link mixer state is unavailable");
    return buildWaveLinkSoloPlan({
      channels,
      mixes,
      targets,
      nativeChannelIds,
      wsId,
    });
  };
}

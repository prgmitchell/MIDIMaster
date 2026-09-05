import {
  ui,
  clamp01,
  boolFromUnknown,
  pickFirstString,
  outputDeviceMatchesMainOutput,
  outputDeviceId,
  outputId,
  nextMainOutputDevice,
  normalizeEndpoint,
  shouldSyncMuteFeedback,
} from "./protocol.js";

/** feedback workflow. */
export function createFeedback({
  ctx,
  primaryFeedbackIntentByBinding,
  requestJsonRpc,
  scheduleChannelsRefresh,
  scheduleOutputDevicesRefresh,
  sendJsonRpc,
  shouldIgnoreStaleFeedbackIntent,
  shouldIgnoreStaleLocalVolume,
  state,
}) {
  function readBindings() {
    try {
      const all = ctx.bindings?.getAll?.();
      return Array.isArray(all) ? all : [];
    } catch {
      return [];
    }
  }

  function setBindings(next) {
    state.bindings = Array.isArray(next) ? next : [];
  }

  function formatApplicationInfo() {
    if (!state.applicationInfo || typeof state.applicationInfo !== "object") {
      return "Wave Link app info unavailable.";
    }
    const name = String(state.applicationInfo.name || "Wave Link");
    const version = String(state.applicationInfo.version || "").trim();
    const build = state.applicationInfo.build != null ? String(state.applicationInfo.build) : "";
    const os = String(state.applicationInfo.operatingSystem || "").trim();
    const revision =
      state.applicationInfo.interfaceRevision != null ? String(state.applicationInfo.interfaceRevision) : "";
    const parts = [];
    if (version) parts.push(`v${version}`);
    if (build) parts.push(`build ${build}`);
    if (revision) parts.push(`API ${revision}`);
    if (os) parts.push(os);
    return `${name}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  }

  function updateAppInfoUi() {
    if (ui.appInfoText) {
      ui.appInfoText.textContent = formatApplicationInfo();
    }
  }

  function integrationFromBindingTarget(target) {
    if (!target || typeof target !== "object") return null;
    const t = target.Integration || target.integration;
    if (t && typeof t === "object" && t.integration_id) return t;
    return null;
  }

  async function syncOfflineFeedback() {
    // If Wave Link is disconnected, drive bound controls to 0.
    // This keeps motor faders from staying at a stale value.
    if (state.offlineFeedbackSent) return;

    const current = state.bindings;
    if (!Array.isArray(current) || current.length === 0) {
      state.offlineFeedbackSent = true;
      return;
    }

    for (const b of current) {
      const t = integrationFromBindingTarget(b?.target);
      if (!t || t.integration_id !== "wavelink") continue;
      const action = b?.action || "Volume";
      try {
        if (action === "Volume") {
          await ctx.feedback.set(b.id, 0.0, "Volume", { silent: true });
        } else if (action === "ToggleMute" || action === "ToggleEffect" || action === "SetMainOutputDevice") {
          await ctx.feedback.set(b.id, 0.0, action, { silent: true });
        }
      } catch {
        // ignore
      }
    }

    state.offlineFeedbackSent = true;
  }

  function getLevelFromMix(mix) {
    if (!mix || typeof mix !== "object") return null;
    const v = mix.level ?? mix.volume ?? mix.value;
    const n = Number(v);
    return Number.isFinite(n) ? clamp01(n) : null;
  }

  function getMutedFromMix(mix) {
    if (!mix || typeof mix !== "object") return null;
    if (typeof mix.isMuted === "boolean") return mix.isMuted;
    if (typeof mix.muted === "boolean") return mix.muted;
    return null;
  }

  function getLevelFromChannel(ch) {
    if (!ch || typeof ch !== "object") return null;
    const v = ch.level ?? ch.volume ?? ch.value;
    const n = Number(v);
    return Number.isFinite(n) ? clamp01(n) : null;
  }

  function getMutedFromChannel(ch) {
    if (!ch || typeof ch !== "object") return null;
    if (typeof ch.isMuted === "boolean") return ch.isMuted;
    if (typeof ch.muted === "boolean") return ch.muted;
    return null;
  }

  function getMixEntry(ch, mixerId) {
    const list = ch?.mixes;
    if (!Array.isArray(list)) return null;
    return list.find((m) => m && String(m.id) === String(mixerId)) || null;
  }

  function getLevelFromMixEntry(entry) {
    const v = entry?.level ?? entry?.volume ?? entry?.value;
    const n = Number(v);
    return Number.isFinite(n) ? clamp01(n) : null;
  }

  function getMutedFromMixEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.isMuted === "boolean") return entry.isMuted;
    if (typeof entry.muted === "boolean") return entry.muted;
    return null;
  }

  function normalizeEffectState(raw) {
    if (!raw || typeof raw !== "object") return null;
    const directKeys = ["isEnabled", "enabled", "isActive", "active", "on"];
    for (const key of directKeys) {
      const value = boolFromUnknown(raw[key]);
      if (value != null) return { enabled: value, key, inverted: false };
    }
    const invertedKeys = ["isBypassed", "bypassed", "disabled", "isDisabled"];
    for (const key of invertedKeys) {
      const value = boolFromUnknown(raw[key]);
      if (value != null) return { enabled: !value, key, inverted: true };
    }
    return null;
  }

  function channelEffectCollections(ch) {
    if (!ch || typeof ch !== "object") return [];
    const fields = [
      "effects",
      "audioEffects",
      "audio_effects",
      "channelEffects",
      "channel_effects",
      "plugins",
      "filters",
      "vstEffects",
      "vst_effects",
    ];
    return fields.filter((field) => Array.isArray(ch[field])).map((field) => ({ field, items: ch[field] }));
  }

  function getChannelEffects(ch) {
    const out = [];
    for (const collection of channelEffectCollections(ch)) {
      for (const raw of collection.items) {
        if (!raw || typeof raw !== "object") continue;
        const state = normalizeEffectState(raw);
        if (!state) continue;
        const id = pickFirstString(raw, [
          "id",
          "identifier",
          "effect_id",
          "effectId",
          "plugin_id",
          "pluginId",
          "uuid",
          "name",
        ]);
        if (!id) continue;
        out.push({
          id,
          name: pickFirstString(raw, ["name", "displayName", "display_name", "title"]) || id,
          enabled: state.enabled,
          enabled_key: state.key,
          enabled_inverted: state.inverted,
          collection_field: collection.field,
        });
      }
    }
    return out;
  }

  function findChannelById(channelId) {
    return Array.isArray(state.channels)
      ? state.channels.find((c) => c && String(c.id) === String(channelId)) || null
      : null;
  }

  function findEffectState(data) {
    const ch = findChannelById(data.identifier || data.channel_id);
    if (!ch) return null;
    if (data.effect_id) {
      return getChannelEffects(ch).find((effect) => String(effect.id) === String(data.effect_id)) || null;
    }
    return null;
  }

  function targetIsMainOutputDevice(data) {
    return outputDeviceMatchesMainOutput(data, state.outputDevicesState?.mainOutput);
  }

  async function setChannelEffectEnabled(data, enabled) {
    const channelId = String(data.identifier || data.channel_id || "");
    const effectId = String(data.effect_id || "");
    if (!channelId || !effectId) return false;
    const collectionField = String(data.collection_field || "effects");
    const enabledKey = String(data.enabled_key || "isEnabled");
    const inverted = Boolean(data.enabled_inverted);
    const entry = {
      id: effectId,
      [enabledKey]: inverted ? !enabled : enabled,
    };
    await sendJsonRpc("setChannel", { id: channelId, [collectionField]: [entry] }, 401);
    scheduleChannelsRefresh();
    return true;
  }

  async function setMainOutputDevice(data) {
    const deviceId = outputDeviceId(data);
    const nextOutputId = outputId(data) || deviceId;
    if (!deviceId || !nextOutputId) return false;
    const response = await requestJsonRpc("setOutputDevice", {
      mainOutput: {
        outputDeviceId: deviceId,
        outputId: nextOutputId,
      },
    });
    if (response?.ok) {
      state.outputDevicesState = {
        ...state.outputDevicesState,
        mainOutput: { outputDeviceId: deviceId, outputId: nextOutputId },
      };
      scheduleOutputDevicesRefresh();
      return true;
    }
    const message = response?.error?.message || (response?.timeout ? "timed out" : "unknown error");
    throw new Error(`Wave Link rejected main output change: ${String(message)}`);
  }

  async function cycleMainOutputDevice() {
    const nextDevice = nextMainOutputDevice(state.outputDevicesState);
    if (!nextDevice) return false;
    return setMainOutputDevice(nextDevice);
  }

  async function syncAllFeedback() {
    const current = state.bindings;
    if (!Array.isArray(current) || current.length === 0) return;

    for (const b of current) {
      const t = integrationFromBindingTarget(b?.target);
      if (!t || t.integration_id !== "wavelink") continue;
      const action = b?.action || "Volume";
      const data = t.data || {};

      try {
        if (action === "Volume") {
          let value = null;
          if (t.kind === "mix") {
            const mix = state.mixes.find((m) => m && String(m.id) === String(data.mixer_id));
            value = getLevelFromMix(mix);
          } else if (t.kind === "channel") {
            const ch = state.channels.find((c) => c && String(c.id) === String(data.identifier));
            value = getLevelFromChannel(ch);
          } else if (t.kind === "channel_mix") {
            const ch = state.channels.find((c) => c && String(c.id) === String(data.identifier));
            const entry = getMixEntry(ch, data.mixer_id);
            value = getLevelFromMixEntry(entry);
          } else if (t.kind === "endpoint") {
            // Legacy
            const identifier = data.identifier || "";
            const mixerId = data.mixer_id || "";
            if (!identifier) {
              const mix = state.mixes.find((m) => m && String(m.id) === String(mixerId));
              value = getLevelFromMix(mix);
            } else if (!mixerId) {
              const ch = state.channels.find((c) => c && String(c.id) === String(identifier));
              value = getLevelFromChannel(ch);
            } else {
              const ch = state.channels.find((c) => c && String(c.id) === String(identifier));
              const entry = getMixEntry(ch, mixerId);
              value = getLevelFromMixEntry(entry);
            }
          }
          if (value != null) {
            const intent = primaryFeedbackIntentByBinding.get(b.id);
            const endpoint = normalizeEndpoint({ Integration: t });
            const ignoreStaleVolume =
              shouldIgnoreStaleLocalVolume(endpoint, value) ||
              shouldIgnoreStaleFeedbackIntent(intent, endpoint, value);
            if (!ignoreStaleVolume) {
              if (intent) {
                primaryFeedbackIntentByBinding.delete(b.id);
              }
              await ctx.feedback.set(b.id, value, "Volume", { silent: true });
            }
          }
        }

        if (shouldSyncMuteFeedback(action)) {
          let muted = null;
          if (t.kind === "mix") {
            const mix = state.mixes.find((m) => m && String(m.id) === String(data.mixer_id));
            muted = getMutedFromMix(mix);
          } else if (t.kind === "channel") {
            const ch = state.channels.find((c) => c && String(c.id) === String(data.identifier));
            muted = getMutedFromChannel(ch);
          } else if (t.kind === "channel_mix") {
            const ch = state.channels.find((c) => c && String(c.id) === String(data.identifier));
            const entry = getMixEntry(ch, data.mixer_id);
            muted = getMutedFromMixEntry(entry);
          } else if (t.kind === "endpoint") {
            const identifier = data.identifier || "";
            const mixerId = data.mixer_id || "";
            if (!identifier) {
              const mix = state.mixes.find((m) => m && String(m.id) === String(mixerId));
              muted = getMutedFromMix(mix);
            } else if (!mixerId) {
              const ch = state.channels.find((c) => c && String(c.id) === String(identifier));
              muted = getMutedFromChannel(ch);
            } else {
              const ch = state.channels.find((c) => c && String(c.id) === String(identifier));
              const entry = getMixEntry(ch, mixerId);
              muted = getMutedFromMixEntry(entry);
            }
          }
          if (typeof muted === "boolean") {
            await ctx.feedback.set(b.id, muted ? 1.0 : 0.0, "ToggleMute", { silent: true });
          }
        } else if (action === "ToggleEffect") {
          const state = findEffectState(data);
          if (state && typeof state.enabled === "boolean") {
            await ctx.feedback.set(b.id, state.enabled ? 1.0 : 0.0, action, { silent: true });
          }
        } else if (action === "SetMainOutputDevice" && t.kind === "main_output_device") {
          await ctx.feedback.set(b.id, targetIsMainOutputDevice(data) ? 1.0 : 0.0, action, { silent: true });
        } else if (action === "SetMainOutputDevice" && t.kind === "main_output_cycle") {
          await ctx.feedback.set(b.id, 0.0, action, { silent: true });
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    readBindings,
    setBindings,
    updateAppInfoUi,
    syncOfflineFeedback,
    getChannelEffects,
    setChannelEffectEnabled,
    setMainOutputDevice,
    cycleMainOutputDevice,
    syncAllFeedback,
  };
}

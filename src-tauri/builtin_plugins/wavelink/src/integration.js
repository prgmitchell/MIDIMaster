import {
  MAIN_OUTPUT_CYCLE_LABEL,
  normalizeEndpoint,
  lastStatus,
  createMainOutputCycleOption,
  validOutputDevices,
  outputDeviceId,
  outputDeviceName,
  outputId,
  clamp01,
  setStatus,
} from "./protocol.js";

/** integration workflow. */
export function createIntegration({
  ctx,
  cycleMainOutputDevice,
  describeFromCache,
  endpointKey,
  flushVolumeWrites,
  getChannelEffects,
  iconDataUrl,
  invalidateFeedback,
  localVolumeIntentByEndpoint,
  pendingVolumeWrites,
  primaryFeedbackIntentByBinding,
  queueVolumeWrite,
  rememberLocalVolumeIntent,
  sendJsonRpc,
  setChannelEffectEnabled,
  setMainOutputDevice,
  state,
  syncOfflineFeedback,
}) {
  function registerPluginIntegration() {
    ctx.registerIntegration({
      id: "wavelink",
      name: "Wave Link",
      icon_data: iconDataUrl || null,
      buttonActions: [{ label: "Toggle Mute", value: "ToggleMute" }],
      describeTarget: (target) => {
        const t = target?.Integration || target?.integration;
        const data = t?.data || {};
        if (t?.integration_id !== "wavelink") {
          return { label: "Wave Link", icon_data: iconDataUrl || null };
        }

        const icon_data =
          typeof data.icon_data === "string" && data.icon_data.trim() ? data.icon_data : iconDataUrl || null;

        let label = typeof data.label === "string" && data.label.trim() ? data.label : "";

        // If we previously stored a status suffix in label, strip it.
        if (label.endsWith(" (Unavailable)")) label = label.slice(0, -" (Unavailable)".length);
        if (label.endsWith(" (Connecting...)")) label = label.slice(0, -" (Connecting...)".length);
        if (label.endsWith(" (Disconnected)")) label = label.slice(0, -" (Disconnected)".length);

        if (t.kind === "channel_mix") {
          const channelName = String(data.channel_name || data.name || data.identifier || "").trim();
          const mixName = String(data.mix_name || data.mixer_name || data.mixer_id || "").trim();
          if (channelName && mixName && (!label || !label.includes("("))) {
            label = `${channelName} (${mixName})`;
          }
        } else if (t.kind === "channel_effect") {
          const channelName = String(data.channel_name || data.identifier || "").trim();
          const effectName = String(data.effect_name || data.effect_id || "").trim();
          if (channelName && effectName && (!label || !label.includes(":"))) {
            label = `${channelName}: ${effectName}`;
          }
        } else if (t.kind === "main_output_device") {
          const deviceName = String(
            data.output_device_name || data.name || data.output_device_id || "",
          ).trim();
          if (deviceName && !label) {
            label = `Main Output: ${deviceName}`;
          }
        } else if (t.kind === "main_output_cycle") {
          if (!label) {
            label = MAIN_OUTPUT_CYCLE_LABEL;
          }
        }

        // Back-compat: reconstruct label if older targets didn't store it.
        if (!label) {
          if (t.kind === "mix") {
            label = String(data.mix_name || data.mixer_name || data.mixer_id || "Wave Link");
          } else if (t.kind === "channel") {
            label = String(data.channel_name || data.name || data.identifier || "Wave Link");
          } else if (t.kind === "channel_mix") {
            const ch = data.channel_name || data.identifier;
            const mix = data.mix_name || data.mixer_id;
            label = ch && mix ? `${ch} (${mix})` : "Wave Link";
          } else if (t.kind === "channel_effect") {
            const ch = data.channel_name || data.identifier;
            const effect = data.effect_name || data.effect_id;
            label = ch && effect ? `${ch}: ${effect}` : "Wave Link Effect";
          } else if (t.kind === "main_output_device") {
            const deviceName = data.output_device_name || data.name || data.output_device_id;
            label = deviceName ? `Main Output: ${deviceName}` : "Wave Link Main Output";
          } else if (t.kind === "main_output_cycle") {
            label = MAIN_OUTPUT_CYCLE_LABEL;
          } else {
            const endpoint = normalizeEndpoint(target);
            const fromCache = describeFromCache(endpoint);
            if (fromCache?.label) label = String(fromCache.label);
            else label = "Wave Link";
          }
        }

        const isConnected = Boolean(state.wsId) && Boolean(lastStatus.connected);
        return { label: String(label), icon_data, ghost: !isConnected };
      },
      getTargetOptions: ({ controlType, nav } = {}) => {
        const isButton = controlType === "button";
        const section = String(nav?.section || "");
        const isConnected = Boolean(state.wsId) && Boolean(lastStatus.connected);

        const placeholder = (label) => [
          {
            label,
            kind: "placeholder",
            ghost: true,
            icon_data: iconDataUrl || null,
            suppressUnavailableTag: true,
          },
        ];

        if (!isConnected) {
          return [];
        }

        const levelOptions = () => {
          const opts = [];
          if (Array.isArray(state.mixes)) {
            for (const mix of state.mixes) {
              if (!mix || !mix.id) continue;
              const mixName = mix.name ? String(mix.name) : String(mix.id);
              opts.push({
                label: mix.name ? String(mix.name) : `Mix ${mix.id}`,
                icon_data: iconDataUrl || null,
                target: {
                  Integration: {
                    integration_id: "wavelink",
                    kind: "mix",
                    data: { mixer_id: String(mix.id), mix_name: mixName },
                  },
                },
              });
            }
          }
          if (Array.isArray(state.channels)) {
            for (const ch of state.channels) {
              if (!ch || !ch.id) continue;
              const channelName = ch.name ? String(ch.name) : String(ch.id);
              opts.push({
                label: ch.name ? String(ch.name) : `Channel ${ch.id}`,
                icon_data: iconDataUrl || null,
                target: {
                  Integration: {
                    integration_id: "wavelink",
                    kind: "channel",
                    data: { identifier: String(ch.id), channel_name: channelName },
                  },
                },
              });

              if (Array.isArray(ch.mixes)) {
                for (const entry of ch.mixes) {
                  const mixId = entry?.id;
                  if (!mixId) continue;
                  const mix = Array.isArray(state.mixes)
                    ? state.mixes.find((m) => m && String(m.id) === String(mixId))
                    : null;
                  const mixName = mix?.name ? String(mix.name) : String(mixId);
                  opts.push({
                    label: `${channelName} (${mixName})`,
                    icon_data: iconDataUrl || null,
                    target: {
                      Integration: {
                        integration_id: "wavelink",
                        kind: "channel_mix",
                        data: {
                          identifier: String(ch.id),
                          mixer_id: String(mixId),
                          channel_name: channelName,
                          mix_name: mixName,
                        },
                      },
                    },
                  });
                }
              }
            }
          }
          return opts;
        };

        const effectOptions = () => {
          const opts = [];
          if (!isButton || !Array.isArray(state.channels)) return opts;
          for (const ch of state.channels) {
            if (!ch || !ch.id) continue;
            const channelName = ch.name ? String(ch.name) : String(ch.id);
            for (const effect of getChannelEffects(ch)) {
              opts.push({
                label: `${channelName}: ${effect.name}`,
                icon_data: iconDataUrl || null,
                buttonActions: [{ label: "Toggle Effect", value: "ToggleEffect", behavior: "stateful" }],
                target: {
                  Integration: {
                    integration_id: "wavelink",
                    kind: "channel_effect",
                    data: {
                      identifier: String(ch.id),
                      channel_name: channelName,
                      effect_id: String(effect.id),
                      effect_name: String(effect.name),
                      collection_field: effect.collection_field,
                      enabled_key: effect.enabled_key,
                      enabled_inverted: Boolean(effect.enabled_inverted),
                    },
                  },
                },
              });
            }
          }
          return opts;
        };

        const outputDeviceOptions = () => {
          const opts = [];
          if (!isButton || !Array.isArray(state.outputDevicesState.outputDevices)) return opts;
          const cycleOption = createMainOutputCycleOption(
            state.outputDevicesState.outputDevices,
            iconDataUrl,
          );
          if (cycleOption) {
            opts.push(cycleOption);
          }
          for (const device of validOutputDevices(state.outputDevicesState.outputDevices)) {
            const id = outputDeviceId(device);
            const name = outputDeviceName(device);
            const nextOutputId = outputId(device) || id;
            opts.push({
              label: `Main Output: ${name}`,
              icon_data: iconDataUrl || null,
              buttonActions: [
                { label: "Set Main Output", value: "SetMainOutputDevice", behavior: "momentary" },
              ],
              target: {
                Integration: {
                  integration_id: "wavelink",
                  kind: "main_output_device",
                  data: {
                    output_device_id: id,
                    output_id: nextOutputId,
                    output_device_name: name,
                    device_type: String(device.deviceType || device.type || ""),
                  },
                },
              },
            });
          }
          return opts;
        };

        if (section === "levels") {
          const opts = levelOptions();
          return opts.length > 0 ? opts : placeholder("No Wave Link level targets exposed");
        }
        if (section === "effects") {
          const opts = effectOptions();
          return opts.length > 0 ? opts : placeholder("No Wave Link effects exposed");
        }
        if (section === "outputs") {
          const opts = outputDeviceOptions();
          return opts.length > 0 ? opts : placeholder("No Wave Link output devices exposed");
        }

        const groups = [
          {
            label: "Levels",
            nav: { section: "levels" },
            description: "Channels, mixes, and channel-in-mix levels.",
            tags: [String(levelOptions().length)],
            icon_data: iconDataUrl || null,
          },
        ];
        if (isButton) {
          groups.push(
            {
              label: "Effects",
              nav: { section: "effects" },
              description: "Channel audio effects.",
              tags: [String(effectOptions().length)],
              icon_data: iconDataUrl || null,
            },
            {
              label: "Output Devices",
              nav: { section: "outputs" },
              description: "Set the Wave Link main output device.",
              tags: [String(outputDeviceOptions().length)],
              icon_data: iconDataUrl || null,
            },
          );
        }

        if (groups.length === 0) {
          return placeholder("No compatible Wave Link targets exposed");
        }
        return groups;
      },
      onBindingTriggered: async (payload) => {
        // Local actions may change native/optimistic feedback before the next
        // state response, including momentary press/release feedback.
        invalidateFeedback({ retryInterrupted: true });
        const bindingId = payload?.binding_id;
        const action = payload?.action;
        const value = payload?.value;
        const source = String(payload?.source || "");
        const isPrimaryTarget = payload?.is_primary_target !== false;
        const targetIndex = Number(payload?.target_index ?? 0);
        const targetCount = Number(payload?.target_count ?? 1);
        const target = payload?.target || {};
        const targetData = target?.data || {};
        if (action === "ToggleEffect") {
          const enabled = clamp01(value) > 0.5;
          if (!state.wsId) return;
          try {
            const applied = await setChannelEffectEnabled(targetData, enabled);
            if (applied && bindingId && isPrimaryTarget) {
              await ctx.feedback.set(bindingId, enabled ? 1.0 : 0.0, action);
            }
          } catch {
            state.wsId = null;
            state.connectedPort = null;
            pendingVolumeWrites.clear();
            state.mixes = [];
            state.channels = [];
            localVolumeIntentByEndpoint.clear();
            state.offlineFeedbackSent = false;
            syncOfflineFeedback().catch(() => {});
            state.wasConnected = false;
            setStatus(false, "Disconnected");
          }
          return;
        }
        if (action === "SetMainOutputDevice") {
          if (!state.wsId) return;
          try {
            const applied =
              target?.kind === "main_output_cycle"
                ? await cycleMainOutputDevice()
                : await setMainOutputDevice(targetData);
            if (applied && bindingId && isPrimaryTarget) {
              await ctx.feedback.set(bindingId, 1.0, action);
            }
          } catch {
            state.wsId = null;
            state.connectedPort = null;
            pendingVolumeWrites.clear();
            state.mixes = [];
            state.channels = [];
            state.outputDevicesState = { mainOutput: null, outputDevices: [] };
            localVolumeIntentByEndpoint.clear();
            state.offlineFeedbackSent = false;
            syncOfflineFeedback().catch(() => {});
            state.wasConnected = false;
            setStatus(false, "Disconnected");
          }
          return;
        }
        const endpoint = normalizeEndpoint({ Integration: payload?.target });
        if (!endpoint) return;

        const level = clamp01(value);
        try {
          if (action === "Volume") {
            // Update UI/OSD and internal state immediately (optimistic), then coalesce
            // websocket writes to keep rapid fader motion smooth.
            // Latch user intent so background sync doesn't snap the motorized fader
            // back to stale levels right after release.
            rememberLocalVolumeIntent(endpoint, level, source);
            if (bindingId && isPrimaryTarget) {
              primaryFeedbackIntentByBinding.set(bindingId, {
                value: level,
                at: Date.now(),
                source,
                endpoint_key: endpointKey(endpoint),
              });
            }

            if (!state.wsId) {
              return;
            }

            queueVolumeWrite(endpoint, level);
            // For multi-target bindings, Rust emits one event per target in order.
            // Flush immediately after the last target event for the current tick so
            // grouped targets update in real time while preserving anti-jitter logic.
            if (Number.isFinite(targetCount) && targetCount > 1 && targetIndex >= targetCount - 1) {
              flushVolumeWrites().catch(() => {});
            }
            return;
          } else if (action === "ToggleMute") {
            const muted = level > 0.5;
            if (!state.wsId) {
              return;
            }
            if (!endpoint.identifier) {
              await sendJsonRpc("setMix", { id: endpoint.mixer_id, isMuted: muted }, 202);
            } else if (!endpoint.mixer_id) {
              await sendJsonRpc("setChannel", { id: endpoint.identifier, isMuted: muted }, 102);
            } else {
              await sendJsonRpc(
                "setChannel",
                { id: endpoint.identifier, mixes: [{ id: endpoint.mixer_id, isMuted: muted }] },
                102,
              );
            }
          }

          if (bindingId && isPrimaryTarget && action !== "Volume") {
            await ctx.feedback.set(
              bindingId,
              action === "ToggleMute" ? (level > 0.5 ? 1.0 : 0.0) : level,
              action,
            );
          }
        } catch (e) {
          // If send failed, force reconnect.
          state.wsId = null;
          state.connectedPort = null;
          pendingVolumeWrites.clear();
          state.mixes = [];
          state.channels = [];
          state.outputDevicesState = { mainOutput: null, outputDevices: [] };
          localVolumeIntentByEndpoint.clear();
          state.offlineFeedbackSent = false;
          syncOfflineFeedback().catch(() => {});
          state.wasConnected = false;
          setStatus(false, "Disconnected");
        }
      },
    });
  }

  return { registerPluginIntegration };
}

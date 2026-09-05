import {
  decodeRelativeDelta,
  getPrimaryBindingTarget,
  normalizeFaderCurve,
  applyCustomFaderCurve,
  applyFaderCurve,
  buttonVisualBehavior,
  getBindingTargets,
  bindingHasIntegrationTarget,
} from "../../core/binding_model.js";
import { createFrameBatcher, volumePayloadKey } from "../render_batching.js";

/** midi display workflow. */
export function createMidiDisplay({
  BACKEND_ECHO_SUPPRESSION_MS,
  FADER_TRIGGER_FLASH_MIN_MS,
  INTEGRATION_ACTIVE_ECHO_SUPPRESSION_MS,
  applyVolumeUpdatePayload,
  bindingIsButtonLike,
  features,
  findBindingSlider,
  findInlineMuteButton,
  flashBindingTrigger,
  knownMidiRouteCount,
  getTargetMetadata = () => [],
  liveState,
  midiControlSignature,
  profileState,
  resolveTargetVolume,
  resolveTargetKey,
  targetsMatch,
  setBindingSliderVolume,
  setInlineMuteButtonState,
}) {
  function findBindingForEvent(payload) {
    if (!payload || !profileState.bindings.length) {
      return null;
    }
    return profileState.bindingLookupIndex.find(payload, {
      allowLegacyFallback: knownMidiRouteCount() <= 1,
    });
  }

  function resolveOsdVolume(binding, payload) {
    if (!binding || !payload) {
      return null;
    }
    if (binding.mode === "Relative") {
      const delta = decodeRelativeDelta(binding, payload.value, liveState.osdRelativeAutoFormatByBinding);
      if (delta == null) {
        return null;
      }
      let current = liveState.osdBindingValues.get(binding.id);
      if (current == null) {
        // Prefer last known feedback for integrations (and everything else).
        current =
          liveState.bindingLastValues[binding.id] != null
            ? liveState.bindingLastValues[binding.id]
            : (resolveTargetVolume(getPrimaryBindingTarget(binding)) ?? 0);
      }
      const next = Math.min(1, Math.max(0, current + delta * 0.02));
      liveState.osdBindingValues.set(binding.id, next);
      return next;
    }
    if (binding.control?.controller === 224 && payload.value_14 != null) {
      const normalized = payload.value_14 / 16383;
      return normalizeFaderCurve(binding.fader_curve) === "Custom"
        ? applyCustomFaderCurve(binding.custom_curve, normalized)
        : applyFaderCurve(binding.fader_curve, normalized);
    }
    const normalized = payload.value / 127;
    return normalizeFaderCurve(binding.fader_curve) === "Custom"
      ? applyCustomFaderCurve(binding.custom_curve, normalized)
      : applyFaderCurve(binding.fader_curve, normalized);
  }

  function syncButtonValueVisual(bindingId, options = {}) {
    features.bindings?.syncButtonVisualState?.(bindingId, options);
  }

  function updateButtonVisualFromMidiEvent(binding, payload, inputValue) {
    const behavior = buttonVisualBehavior(binding);
    if (!behavior || !binding?.id) {
      return false;
    }

    const bindingId = binding.id;
    if (behavior === "momentary") {
      liveState.bindingLastValues[bindingId] = inputValue;
      syncButtonValueVisual(bindingId, { inputValue });
      return true;
    }

    if ((Number(payload?.value) || 0) <= 0) {
      syncButtonValueVisual(bindingId, { inputValue });
      return true;
    }

    if (binding.action === "ToggleMute") {
      const muteButton = findInlineMuteButton(bindingId);
      const currentlyMuted =
        liveState.bindingMuteValues[bindingId] != null
          ? Boolean(liveState.bindingMuteValues[bindingId])
          : Boolean(muteButton?.classList?.contains("muted"));
      const nextMuted = !currentlyMuted;
      liveState.bindingMuteValues[bindingId] = nextMuted;
      if (muteButton) {
        setInlineMuteButtonState(muteButton, nextMuted);
      }
      syncButtonValueVisual(bindingId, {
        inputValue,
        muted: nextMuted,
        stateValue: nextMuted ? 1 : 0,
      });
      return true;
    }

    const currentlyOn =
      liveState.bindingLastValues[bindingId] != null
        ? Number(liveState.bindingLastValues[bindingId]) > 0.5
        : false;
    const nextValue = currentlyOn ? 0.0 : 1.0;
    liveState.bindingLastValues[bindingId] = nextValue;
    syncButtonValueVisual(bindingId, { inputValue, stateValue: nextValue });
    return true;
  }

  function applyMidiUiEvent(payload) {
    const normalizedLiveValue =
      payload.controller === 224 && payload.value_14 != null
        ? payload.value_14 / 16383
        : (Number(payload.value) || 0) / 127;
    liveState.liveMidiValuesByControl.set(
      midiControlSignature(payload.device_id, {
        channel: payload.channel,
        controller: payload.controller,
        msg_type: payload.msg_type || "ControlChange",
      }),
      normalizedLiveValue,
    );

    const binding = findBindingForEvent(payload);
    if (!binding || getBindingTargets(binding).length === 0) {
      return;
    }
    const buttonLike = bindingIsButtonLike(binding, payload);
    flashBindingTrigger(binding.id, {
      rateLimitMs: buttonLike ? 0 : FADER_TRIGGER_FLASH_MIN_MS,
    });
    const handledButtonVisual = updateButtonVisualFromMidiEvent(binding, payload, normalizedLiveValue);
    if (binding.action === "ToggleMute") {
      return;
    }

    if (handledButtonVisual && buttonVisualBehavior(binding) === "stateful") {
      return;
    }

    const volume = resolveOsdVolume(binding, payload);
    if (volume == null) {
      return;
    }

    const directSlider = findBindingSlider(binding.id);
    if (directSlider) {
      setBindingSliderVolume(directSlider, volume, {
        bindingId: binding.id,
        markMidiUpdate: true,
      });
    }
  }

  function getVolumeUpdateBatcher() {
    if (!liveState.volumeUpdateBatcher) {
      liveState.volumeUpdateBatcher = createFrameBatcher({
        keyFor: volumePayloadKey,
        onFlush: flushVolumeUpdatePayloads,
      });
    }
    return liveState.volumeUpdateBatcher;
  }

  function queueVolumeUpdatePayload(payload) {
    if (!payload || typeof payload !== "object") return;
    liveState.lastVolumeUpdateAt = Date.now();
    getVolumeUpdateBatcher().queue(payload);
  }

  function volumeSliderEntries() {
    const index = features.bindings?.getRenderedBindingIndex?.();
    if (index) return index.volumeEntries();
    return Array.from(document.querySelectorAll(".binding-volume-slider")).map((slider) => {
      let target = null;
      try {
        target = JSON.parse(slider.dataset.targetJson || "null");
      } catch {
        target = null;
      }
      return {
        slider,
        bindingId: String(slider.dataset.bindingId || ""),
        target,
      };
    });
  }

  function flushVolumeUpdatePayloads(payloads) {
    if (!Array.isArray(payloads) || payloads.length === 0) return;
    const now = Date.now();
    const index = features.bindings?.getRenderedBindingIndex?.();
    const sliderEntries = index ? null : volumeSliderEntries();
    const slidersByBinding = index ? { get: (id) => index.volumeEntry(id) } : new Map();
    if (!index) {
      for (const entry of sliderEntries) {
        if (entry.bindingId && !slidersByBinding.has(entry.bindingId)) {
          slidersByBinding.set(entry.bindingId, entry);
        }
      }
    }
    const bindingsById = profileState.bindingLookupIndex;
    const shouldSuppressIntegrationEcho = (entry) => {
      const bindingId = entry.bindingId;
      if (!bindingId) return false;
      const binding = bindingsById?.findLastById
        ? bindingsById.findLastById(bindingId)
        : profileState.bindings.findLast((binding) => String(binding.id) === bindingId);
      if (!binding || !bindingHasIntegrationTarget(binding)) return false;
      const lastInteraction = Number(liveState.bindingInteractionTimes[bindingId] || 0);
      return lastInteraction > 0 && now - lastInteraction < INTEGRATION_ACTIVE_ECHO_SUPPRESSION_MS;
    };
    const canAcceptBackendVolume = (entry) =>
      entry &&
      now - Number(entry.slider.dataset.lastMidiUpdate || 0) > BACKEND_ECHO_SUPPRESSION_MS &&
      !shouldSuppressIntegrationEcho(entry);

    for (const payload of payloads) {
      applyVolumeUpdatePayload(payload, {
        sliderEntries,
        slidersByBinding,
        canAcceptBackendVolume,
        matchingSliders: index ? (target) => index.matchVolumeTargets(target, {
          targetsMatch, resolveTargetKey, metadata: getTargetMetadata(),
        }) : null,
      });
    }
  }

  return {
    findBindingForEvent,
    resolveOsdVolume,
    syncButtonValueVisual,
    updateButtonVisualFromMidiEvent,
    applyMidiUiEvent,
    getVolumeUpdateBatcher,
    queueVolumeUpdatePayload,
    volumeSliderEntries,
    flushVolumeUpdatePayloads,
  };
}

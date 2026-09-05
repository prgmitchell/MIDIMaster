import { buttonVisualBehavior } from "../../core/binding_model.js";

/** volume events workflow. */
export function createVolumeEvents({
  liveState,
  profileState,
  setBindingSliderVolume,
  syncButtonValueVisual,
  targetsMatch,
  updateFocusedSessionState,
  updateIntegrationStateFromEventPayload,
}) {
  function applyVolumeUpdatePayload(payload, context) {
    updateIntegrationStateFromEventPayload(payload);
    if (Object.prototype.hasOwnProperty.call(payload, "focus_session")) {
      updateFocusedSessionState(payload.focus_session);
    }

    const buttonInputValue = typeof payload.input_value === "number" ? payload.input_value : null;
    const feedbackBinding = payload.binding_id
      ? profileState.bindings.find((binding) => binding && String(binding.id) === String(payload.binding_id))
      : null;
    const feedbackButtonBehavior = feedbackBinding ? buttonVisualBehavior(feedbackBinding) : null;

    if (payload.binding_id && feedbackButtonBehavior) {
      if (feedbackButtonBehavior === "momentary") {
        if (buttonInputValue != null) {
          liveState.bindingLastValues[payload.binding_id] = buttonInputValue;
          syncButtonValueVisual(payload.binding_id, { inputValue: buttonInputValue });
        }
      } else if (typeof payload.volume === "number") {
        liveState.bindingLastValues[payload.binding_id] = payload.volume;
        syncButtonValueVisual(payload.binding_id, {
          stateValue: payload.volume,
          ...(buttonInputValue != null ? { inputValue: buttonInputValue } : {}),
        });
      }
    }

    if (payload.binding_id) {
      const direct = context.slidersByBinding.get(String(payload.binding_id));
      if (context.canAcceptBackendVolume(direct)) {
        setBindingSliderVolume(direct.slider, payload.volume, { bindingId: payload.binding_id });
      }
    }

    for (const entry of context.sliderEntries) {
      if (payload.binding_id && entry.bindingId === String(payload.binding_id)) continue;
      if (!context.canAcceptBackendVolume(entry)) continue;
      if (entry.target && targetsMatch(entry.target, payload.target)) {
        setBindingSliderVolume(entry.slider, payload.volume);
      }
    }
  }

  return { applyVolumeUpdatePayload };
}

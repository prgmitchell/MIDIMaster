import { bindingLooksLikeButton } from "../../core/binding_model.js";

/** binding display workflow. */
export function createBindingDisplay({ audioState, features, liveState }) {
  function updateSliderFill(slider) {
    features.bindings?.updateSliderFill?.(slider);
  }

  function setBindingSliderVolume(slider, volume, options = {}) {
    features.bindings?.setSliderVolume?.(slider, volume, options);
  }

  function flashBindingTrigger(bindingId, options = {}) {
    if (!bindingId) return;
    const rateLimitMs = Number(options.rateLimitMs || 0);
    if (rateLimitMs > 0) {
      const now = Date.now();
      const previous = Number(liveState.bindingTriggerFlashTimes[bindingId] || 0);
      if (previous > 0 && now - previous < rateLimitMs) {
        return;
      }
      liveState.bindingTriggerFlashTimes[bindingId] = now;
    }
    const item =
      features.bindings?.getRenderedBindingRefs?.(bindingId)?.item ||
      document.querySelector(`.binding-item[data-binding-id="${CSS.escape(String(bindingId))}"]`);
    if (item) {
      const el = item;
      el.classList.add("triggered");
      clearTimeout(el._triggerTimer);
      el._triggerTimer = setTimeout(() => el.classList.remove("triggered"), 300);
    }
  }

  function findBindingSlider(bindingId) {
    if (!bindingId) return null;
    return (
      features.bindings?.getRenderedBindingRefs?.(bindingId)?.slider ||
      document.querySelector(`.binding-volume-slider[data-binding-id="${CSS.escape(String(bindingId))}"]`)
    );
  }

  function bindingIsButtonLike(binding, payload = null) {
    return bindingLooksLikeButton({
      control_kind: binding?.control_kind || binding?.controlKind,
      control: {
        msg_type:
          binding?.control?.msg_type || binding?.control?.msgType || payload?.msg_type || payload?.msgType,
      },
    });
  }

  function isBindingTargetMenuOpen() {
    return Boolean(document.querySelector(".target-dropdown.open"));
  }

  function isBindingNameEditing() {
    return Boolean(document.querySelector(".binding-name-input:focus"));
  }

  function isBindingSelectEditing() {
    const active = document.activeElement;
    return Boolean(active && active.closest(".binding-item") && active.tagName === "SELECT");
  }

  function isBindingInteractionActive() {
    return (
      features.bindings?.isBindingInteractionActive?.() ??
      (isBindingTargetMenuOpen() || isBindingNameEditing() || isBindingSelectEditing())
    );
  }

  function updateBindingValues() {
    features.bindings?.updateBindingValues?.();
  }

  function updateFocusedSessionState(nextFocusedSession) {
    const normalized =
      nextFocusedSession && typeof nextFocusedSession === "object" ? nextFocusedSession : null;
    if (JSON.stringify(normalized) === JSON.stringify(audioState.focusedSession ?? null)) {
      return;
    }
    audioState.focusedSession = normalized;
    features.bindings?.updateBindingTargetDisplays?.();
    if (!isBindingInteractionActive()) {
      features.bindings?.updateBindingValues?.();
    }
  }

  return {
    updateSliderFill,
    setBindingSliderVolume,
    flashBindingTrigger,
    findBindingSlider,
    bindingIsButtonLike,
    isBindingTargetMenuOpen,
    isBindingNameEditing,
    isBindingSelectEditing,
    isBindingInteractionActive,
    updateBindingValues,
    updateFocusedSessionState,
  };
}

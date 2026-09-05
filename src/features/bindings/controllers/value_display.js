import {
  buttonVisualBehavior,
  getPrimaryBindingTarget as getPrimaryTarget,
  mappedButtonLightFeedbackValue,
  resolveButtonVisualActive,
  getBindingTargets as getTargets,
} from "../../../core/binding_model.js";

/** value display workflow. */
export function createValueDisplay({
  bindingLastValues,
  bindingMuteValues,
  getBindingById,
  getLiveMidiValue,
  getMuted,
  renderedBindings,
}) {
  function buttonVisualOptions(binding, overrides = {}) {
    const behavior = buttonVisualBehavior(binding);
    const bindingId = binding?.id;
    const storedValue =
      bindingId != null && bindingLastValues[bindingId] != null ? Number(bindingLastValues[bindingId]) : null;
    const liveInputValue = getLiveMidiValue(binding?.device_id, binding?.control);
    const mappedMuteValue =
      bindingId != null && bindingMuteValues[bindingId] != null
        ? Boolean(bindingMuteValues[bindingId])
        : null;
    const muted = typeof overrides.muted === "boolean" ? overrides.muted : mappedMuteValue;
    return {
      inputValue: Object.prototype.hasOwnProperty.call(overrides, "inputValue")
        ? overrides.inputValue
        : liveInputValue != null
          ? liveInputValue
          : behavior === "momentary"
            ? storedValue
            : null,
      stateValue: Object.prototype.hasOwnProperty.call(overrides, "stateValue")
        ? overrides.stateValue
        : behavior === "stateful" && binding?.action !== "ToggleMute"
          ? storedValue
          : null,
      muted,
      fallbackMuted: Object.prototype.hasOwnProperty.call(overrides, "fallbackMuted")
        ? overrides.fallbackMuted
        : muted == null
          ? Boolean(getMuted(getPrimaryTarget(binding)))
          : null,
    };
  }

  function buttonVisualActive(binding, overrides = {}) {
    const mappedLightValue = mappedButtonLightFeedbackValue(binding);
    if (mappedLightValue != null) return mappedLightValue > 0.5;
    return resolveButtonVisualActive(binding, buttonVisualOptions(binding, overrides));
  }

  function setButtonVisualState(bindingId, active) {
    if (bindingId == null) return false;
    const item = renderedBindings.get(bindingId)?.item;
    if (!item) return false;
    let updated = false;
    item.querySelectorAll(".binding-momentary-value").forEach((fill) => {
      fill.classList.toggle("is-active", Boolean(active));
      updated = true;
    });
    item.querySelectorAll(".binding-toggle-value").forEach((toggle) => {
      toggle.classList.toggle("on", Boolean(active));
      updated = true;
    });
    return updated;
  }

  function syncButtonVisualState(bindingOrId, overrides = {}) {
    const binding =
      typeof bindingOrId === "object" && bindingOrId ? bindingOrId : getBindingById(bindingOrId);
    if (!binding) return false;
    const active = buttonVisualActive(binding, overrides);
    setButtonVisualState(binding.id, active);
    return active;
  }

  function buttonUsesPressReleaseCommand(binding) {
    if (buttonVisualBehavior(binding) !== "momentary") return false;
    if (!getTargets(binding).some(targetIsNonUnset)) return true;
    const target = getPrimaryTarget(binding);
    const integration = target?.Integration || target?.integration;
    if (String(integration?.integration_id || "").toLowerCase() !== "obs") return false;
    const kind = String(integration?.kind || "").toLowerCase();
    return kind === "action" || kind === "scene" || kind === "media";
  }

  function targetIsNonUnset(target) {
    return Boolean(
      target && target !== "Unset" && !("Unset" in Object(target)) && !("unset" in Object(target)),
    );
  }

  return { buttonVisualActive, setButtonVisualState, syncButtonVisualState, buttonUsesPressReleaseCommand };
}

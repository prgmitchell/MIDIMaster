import {
  getPrimaryBindingTarget as getPrimaryTarget,
  mappedButtonLightFeedbackValue,
  buttonVisualBehavior,
  resolveButtonVisualActive,
} from "../../../core/binding_model.js";
import { effectiveIsButton, applyCurveToNormalized, curveDisplayName } from "../shape_helpers.js";
import { resolveBindingVolumeValue } from "../value_sync.js";

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function toggleClass(element, name, enabled) {
  if (element && element.classList.contains(name) !== enabled) element.classList.toggle(name, enabled);
}

function setHidden(element, hidden) {
  toggleClass(element, "hidden", hidden);
  if (element && element.getAttribute("aria-hidden") !== String(hidden)) {
    element.setAttribute("aria-hidden", String(hidden));
  }
}

function setStyle(element, property, value) {
  if (element && element.style[property] !== value) element.style[property] = value;
}

/** config preview workflow. */
export function createConfigPreview({
  bindingInteractionTimes,
  bindingLastValues,
  bindingMuteValues,
  elements,
  editorState,
  formatMidiControlLabel,
  formatPreviewMidiValue,
  getConfigBinding,
  getLiveMidiValue,
  getMuted,
  getVol,
  iconForTarget,
  labelForControl,
  parseDisplayTags,
  renderMidiMappingSummary,
  resolveTargetDisplay,
  t,
}) {
  let targetDisplayKey = null;

  function renderPreviewTarget(binding) {
    const target = getPrimaryTarget(binding);
    const display = resolveTargetDisplay(target) || { label: "Target", icon_data: null };
    // Resolve on every refresh so asynchronous target discovery and locale changes
    // remain visible, but only recreate metadata nodes when their output changes.
    const displayKey = [display.label, display.icon_data, display.icon_kind, display.kind, display.value];
    if (targetDisplayKey?.every((value, index) => value === displayKey[index])) return;
    targetDisplayKey = displayKey;
    if (elements.bindingConfigPreviewTargetLabel) {
      const baseLabel = String(display.label || "Target")
        .replace(/\s*\([^()]+\)/g, "")
        .trim();
      setText(elements.bindingConfigPreviewTargetLabel, baseLabel || "Target");
    }
    if (elements.bindingConfigPreviewTargetTags) {
      elements.bindingConfigPreviewTargetTags.innerHTML = "";
      parseDisplayTags(display.label).forEach((tag) => {
        const badge = document.createElement("span");
        badge.className = "binding-config-preview-tag";
        badge.textContent = tag;
        elements.bindingConfigPreviewTargetTags.appendChild(badge);
      });
    }
    if (elements.bindingConfigPreviewTargetIcon) {
      elements.bindingConfigPreviewTargetIcon.innerHTML = "";
      const icon = iconForTarget(display);
      if (icon) elements.bindingConfigPreviewTargetIcon.appendChild(icon);
    }
  }

  function renderPreviewMetadata(binding, isButton) {
    renderPreviewTarget(binding);
    const faderPreview = elements.bindingConfigPreviewFill?.closest?.(".binding-config-preview-fader");
    setHidden(faderPreview, isButton);
    setHidden(elements.bindingConfigPreviewButton, !isButton);
    for (const row of [
      elements.bindingConfigPreviewMuteRow,
      elements.bindingConfigPreviewAssignRow,
      elements.bindingConfigPreviewCurveRow,
    ]) {
      toggleClass(row, "hidden", isButton);
    }
    renderMidiMappingSummary(
      elements.bindingConfigPreviewMainMidi,
      binding.device_id,
      binding.control,
      labelForControl(binding.control || {}),
    );
    renderMidiMappingSummary(
      elements.bindingConfigPreviewMute,
      binding.mute_control?.device_id,
      binding.mute_control,
      formatMidiControlLabel(binding.mute_control),
    );
    renderMidiMappingSummary(
      elements.bindingConfigPreviewAssign,
      binding.assign_control?.device_id,
      binding.assign_control,
      formatMidiControlLabel(binding.assign_control),
    );
    setText(elements.bindingConfigPreviewCurve, curveDisplayName(binding.fader_curve));
  }

  function renderConfigPreview() {
    const binding = getConfigBinding();
    if (!binding) return;
    const bindingId = editorState.bindingId;
    const isButton = effectiveIsButton(binding);
    const target = getPrimaryTarget(binding);
    const liveMidiValue = getLiveMidiValue(binding.device_id, binding.control);
    const mappedLightValue = mappedButtonLightFeedbackValue(binding);
    const storedBindingValue =
      bindingId != null && bindingLastValues[bindingId] != null ? Number(bindingLastValues[bindingId]) : null;
    const targetVolume = getVol(target);
    const resolvedVolume = resolveBindingVolumeValue({
      bindingId,
      targetVolume,
      cachedVolume: storedBindingValue,
      interactionTimes: bindingInteractionTimes,
    });
    const liveValue =
      liveMidiValue != null ? applyCurveToNormalized(binding, liveMidiValue) : (resolvedVolume.value ?? 0);
    const muted =
      bindingId != null && bindingMuteValues[bindingId] != null
        ? Boolean(bindingMuteValues[bindingId])
        : Boolean(getMuted(target));
    const visualBehavior = buttonVisualBehavior(binding);
    const buttonActive = isButton
      ? mappedLightValue != null
        ? mappedLightValue > 0.5
        : resolveButtonVisualActive(binding, {
            inputValue:
              liveMidiValue != null
                ? liveMidiValue
                : visualBehavior === "momentary"
                  ? storedBindingValue
                  : null,
            stateValue:
              visualBehavior === "stateful" && binding.action !== "ToggleMute" ? storedBindingValue : null,
            muted,
            fallbackMuted: muted,
          })
      : false;
    const previewValue = isButton ? (buttonActive ? 1 : 0) : Math.min(1, Math.max(0, Number(liveValue) || 0));
    const fillPercent = Math.round(Math.min(1, Math.max(0, previewValue)) * 100);
    const learningPrimary = editorState.learnField === "control";

    renderPreviewMetadata(binding, isButton);
    toggleClass(elements.bindingConfigPreviewButtonFace, "is-active", buttonActive);
    toggleClass(
      elements.bindingConfigPreviewButtonFace,
      "is-mapped",
      mappedLightValue != null && mappedLightValue > 0.5,
    );
    const buttonLabel = buttonActive ? t("bindings.on") : t("bindings.off");
    setText(elements.bindingConfigPreviewButtonLabel, buttonLabel);
    setText(elements.bindingConfigPreviewValue, isButton ? buttonLabel : `${fillPercent}%`);
    setStyle(elements.bindingConfigPreviewFill, "height", `${fillPercent}%`);
    setStyle(elements.bindingConfigPreviewThumb, "bottom", `calc(${fillPercent}% - 18px)`);
    setText(
      elements.bindingConfigPreviewMidiValue,
      formatPreviewMidiValue(binding, previewValue, liveMidiValue),
    );

    let statusKey;
    if (learningPrimary) {
      statusKey = isButton ? "bindings.waitingForNewButtonInput" : "bindings.waitingForNewFaderInput";
    } else if (isButton && mappedLightValue != null && mappedLightValue > 0.5) {
      statusKey = "bindings.mappedLightOn";
    } else if (muted) {
      statusKey = "bindings.targetMuted";
    } else if ((bindingId != null && bindingLastValues[bindingId] != null) || liveMidiValue != null) {
      statusKey = "bindings.receivingLiveFeedback";
    } else {
      statusKey = "bindings.waitingForLiveInput";
    }
    setText(elements.bindingConfigPreviewStatus, t(statusKey));
    for (const indicator of [
      elements.bindingConfigPreviewLearnIndicator,
      elements.bindingConfigButtonLearnIndicator,
    ]) {
      toggleClass(indicator, "hidden", true);
      toggleClass(indicator, "is-learning", false);
    }
    setText(elements.bindingConfigPreviewLearnStatus, t("bindings.waitingMidiInput"));
    setText(elements.bindingConfigButtonLearnStatus, t("bindings.waitingMidiInput"));
  }

  return { renderPreviewTarget, renderConfigPreview };
}

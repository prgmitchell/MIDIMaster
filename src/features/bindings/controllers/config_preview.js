import {
  getPrimaryBindingTarget as getPrimaryTarget,
  mappedButtonLightFeedbackValue,
  buttonVisualBehavior,
  resolveButtonVisualActive,
} from "../../../core/binding_model.js";
import { effectiveIsButton, applyCurveToNormalized, curveDisplayName } from "../shape_helpers.js";
import { resolveBindingVolumeValue } from "../value_sync.js";

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
  function renderPreviewTarget(binding) {
    const target = getPrimaryTarget(binding);
    const display = resolveTargetDisplay(target) || { label: "Target", icon_data: null };
    if (elements.bindingConfigPreviewTargetLabel) {
      const baseLabel = String(display.label || "Target")
        .replace(/\s*\([^()]+\)/g, "")
        .trim();
      elements.bindingConfigPreviewTargetLabel.textContent = baseLabel || "Target";
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

    renderPreviewTarget(binding);
    const faderPreview = elements.bindingConfigPreviewFill?.closest?.(".binding-config-preview-fader");
    if (faderPreview) {
      faderPreview.classList.toggle("hidden", isButton);
      faderPreview.setAttribute("aria-hidden", String(isButton));
    }
    if (elements.bindingConfigPreviewButton) {
      elements.bindingConfigPreviewButton.classList.toggle("hidden", !isButton);
      elements.bindingConfigPreviewButton.setAttribute("aria-hidden", String(!isButton));
    }
    if (elements.bindingConfigPreviewButtonFace) {
      elements.bindingConfigPreviewButtonFace.classList.toggle("is-active", buttonActive);
      elements.bindingConfigPreviewButtonFace.classList.toggle(
        "is-mapped",
        mappedLightValue != null && mappedLightValue > 0.5,
      );
    }
    if (elements.bindingConfigPreviewButtonLabel) {
      elements.bindingConfigPreviewButtonLabel.textContent = buttonActive
        ? t("bindings.on")
        : t("bindings.off");
    }
    if (elements.bindingConfigPreviewValue) {
      elements.bindingConfigPreviewValue.textContent = isButton
        ? buttonActive
          ? t("bindings.on")
          : t("bindings.off")
        : `${fillPercent}%`;
    }
    if (elements.bindingConfigPreviewFill) elements.bindingConfigPreviewFill.style.height = `${fillPercent}%`;
    if (elements.bindingConfigPreviewThumb)
      elements.bindingConfigPreviewThumb.style.bottom = `calc(${fillPercent}% - 18px)`;
    renderMidiMappingSummary(
      elements.bindingConfigPreviewMainMidi,
      binding.device_id,
      binding.control,
      labelForControl(binding.control || {}),
    );
    if (elements.bindingConfigPreviewMuteRow)
      elements.bindingConfigPreviewMuteRow.classList.toggle("hidden", isButton);
    if (elements.bindingConfigPreviewAssignRow)
      elements.bindingConfigPreviewAssignRow.classList.toggle("hidden", isButton);
    if (elements.bindingConfigPreviewCurveRow)
      elements.bindingConfigPreviewCurveRow.classList.toggle("hidden", isButton);
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
    if (elements.bindingConfigPreviewCurve)
      elements.bindingConfigPreviewCurve.textContent = curveDisplayName(binding.fader_curve);
    if (elements.bindingConfigPreviewMidiValue) {
      elements.bindingConfigPreviewMidiValue.textContent = formatPreviewMidiValue(
        binding,
        previewValue,
        liveMidiValue,
      );
    }
    if (elements.bindingConfigPreviewStatus) {
      if (learningPrimary) {
        elements.bindingConfigPreviewStatus.textContent = isButton
          ? t("bindings.waitingForNewButtonInput")
          : t("bindings.waitingForNewFaderInput");
      } else if (isButton && mappedLightValue != null && mappedLightValue > 0.5) {
        elements.bindingConfigPreviewStatus.textContent = t("bindings.mappedLightOn");
      } else if (muted) {
        elements.bindingConfigPreviewStatus.textContent = t("bindings.targetMuted");
      } else if ((bindingId != null && bindingLastValues[bindingId] != null) || liveMidiValue != null) {
        elements.bindingConfigPreviewStatus.textContent = t("bindings.receivingLiveFeedback");
      } else {
        elements.bindingConfigPreviewStatus.textContent = t("bindings.waitingForLiveInput");
      }
    }
    if (elements.bindingConfigPreviewLearnIndicator) {
      elements.bindingConfigPreviewLearnIndicator.classList.add("hidden");
      elements.bindingConfigPreviewLearnIndicator.classList.remove("is-learning");
    }
    if (elements.bindingConfigPreviewLearnStatus) {
      elements.bindingConfigPreviewLearnStatus.textContent = t("bindings.waitingMidiInput");
    }
    if (elements.bindingConfigButtonLearnIndicator) {
      elements.bindingConfigButtonLearnIndicator.classList.add("hidden");
      elements.bindingConfigButtonLearnIndicator.classList.remove("is-learning");
    }
    if (elements.bindingConfigButtonLearnStatus) {
      elements.bindingConfigButtonLearnStatus.textContent = t("bindings.waitingMidiInput");
    }
  }

  return { renderPreviewTarget, renderConfigPreview };
}

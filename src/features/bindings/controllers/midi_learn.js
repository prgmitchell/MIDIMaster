import {
  effectiveIsButton,
  assignModeTooltip,
  muteBehaviorLabel,
  muteBehaviorTooltip,
} from "../shape_helpers.js";

/** midi learn workflow. */
export function createMidiLearn({
  elements,
  editorState,
  hideLearnPanel,
  labelForMidiDevice,
  listState,
  renderConfigPreview,
  syncFeedbackControllerInputState,
  t,
}) {
  const midiSummaryKeys = new WeakMap();

  function updateAuxLearnUi() {
    const muteLearn = elements.bindingConfigMuteLearn;
    const assignLearn = elements.bindingConfigAssignLearn;
    const indicatorLearn = elements.bindingConfigIndicatorLearn;
    const feedbackLearn = elements.bindingConfigFeedbackLearn;
    const muteClear = elements.bindingConfigMuteClear;
    const assignClear = elements.bindingConfigAssignClear;
    const indicatorClear = elements.bindingConfigIndicatorClear;
    const feedbackClear = elements.bindingConfigFeedbackClear;
    const previewLearnButton = elements.bindingConfigPreviewLearnButton;
    const buttonLearnButton = elements.bindingConfigButtonLearnButton;
    const transferLocked = Boolean(editorState.transferPrompt);
    const learningPrimary = editorState.learnField === "control";
    const binding = getConfigBinding();
    const isButton = effectiveIsButton(binding);
    const feedbackDisabled = binding?.feedback_enabled === false;
    const buttonFeedbackDisabled = isButton && feedbackDisabled;

    if (muteLearn) {
      const active = editorState.learnField === "mute_control";
      const label = active ? t("bindings.listening") : t("common.learn");
      muteLearn.classList.toggle("is-learning", active);
      muteLearn.title = label;
      muteLearn.setAttribute("aria-label", label);
      muteLearn.disabled = transferLocked || Boolean(editorState.learnField && !active);
    }
    if (assignLearn) {
      const active = editorState.learnField === "assign_control";
      const label = active ? t("bindings.listening") : t("common.learn");
      assignLearn.classList.toggle("is-learning", active);
      assignLearn.title = label;
      assignLearn.setAttribute("aria-label", label);
      assignLearn.disabled = transferLocked || Boolean(editorState.learnField && !active);
    }
    if (indicatorLearn) {
      const active = editorState.learnField === "indicator_control";
      const label = active ? t("bindings.listening") : t("bindings.learnIndicatorOutput");
      indicatorLearn.classList.toggle("is-learning", active);
      indicatorLearn.title = label;
      indicatorLearn.setAttribute("aria-label", label);
      indicatorLearn.disabled =
        buttonFeedbackDisabled || transferLocked || Boolean(editorState.learnField && !active);
    }
    if (feedbackLearn) {
      const active = editorState.learnField === "indicator_control";
      const label = active ? t("bindings.listening") : t("bindings.learnFeedbackOutput");
      feedbackLearn.classList.toggle("is-learning", active);
      feedbackLearn.title = label;
      feedbackLearn.setAttribute("aria-label", label);
      feedbackLearn.disabled = transferLocked || Boolean(editorState.learnField && !active);
    }

    const lockClear = transferLocked || Boolean(editorState.learnField);
    if (muteClear) muteClear.disabled = lockClear;
    if (assignClear) assignClear.disabled = lockClear;
    if (indicatorClear) indicatorClear.disabled = lockClear || buttonFeedbackDisabled;
    if (feedbackClear) feedbackClear.disabled = lockClear;
    if (elements.bindingConfigIndicatorMsgType)
      elements.bindingConfigIndicatorMsgType.disabled = lockClear || buttonFeedbackDisabled;
    if (elements.bindingConfigIndicatorChannel)
      elements.bindingConfigIndicatorChannel.disabled = lockClear || buttonFeedbackDisabled;
    if (elements.bindingConfigIndicatorController)
      elements.bindingConfigIndicatorController.disabled = lockClear || buttonFeedbackDisabled;
    if (elements.bindingConfigFeedbackMsgType) elements.bindingConfigFeedbackMsgType.disabled = lockClear;
    if (elements.bindingConfigFeedbackChannel)
      elements.bindingConfigFeedbackChannel.disabled = lockClear || feedbackDisabled;
    syncFeedbackControllerInputState(lockClear, feedbackDisabled);
    if (listState.indicatorMsgTypeDropdown) {
      listState.indicatorMsgTypeDropdown.button.disabled = lockClear || buttonFeedbackDisabled;
      listState.indicatorMsgTypeDropdown.button.setAttribute(
        "aria-disabled",
        String(lockClear || buttonFeedbackDisabled),
      );
      listState.indicatorMsgTypeDropdown.root.classList.toggle(
        "is-disabled",
        lockClear || buttonFeedbackDisabled,
      );
    }
    if (listState.feedbackOutputMsgTypeDropdown) {
      listState.feedbackOutputMsgTypeDropdown.button.disabled = lockClear;
      listState.feedbackOutputMsgTypeDropdown.button.setAttribute("aria-disabled", String(lockClear));
      listState.feedbackOutputMsgTypeDropdown.root.classList.toggle("is-disabled", lockClear);
    }
    if (elements.bindingConfigMuteModeButton) elements.bindingConfigMuteModeButton.disabled = lockClear;
    if (elements.bindingConfigAssignModeButton) elements.bindingConfigAssignModeButton.disabled = lockClear;
    for (const learnButton of [previewLearnButton, buttonLearnButton]) {
      if (!learnButton) continue;
      const label = isButton ? t("bindings.learnButton") : t("bindings.learnFader");
      learnButton.classList.remove("is-learning");
      learnButton.textContent = label;
      learnButton.title = label;
      learnButton.setAttribute("aria-label", label);
      learnButton.disabled = transferLocked || Boolean(editorState.learnField && !learningPrimary);
    }
  }

  function stopAuxLearn(options = {}) {
    const closePanel = options.closePanel !== false;
    if (editorState.learnTimer) {
      clearInterval(editorState.learnTimer);
      editorState.learnTimer = null;
    }
    editorState.learnField = null;
    updateAuxLearnUi();
    renderConfigPreview();
    if (closePanel) {
      hideLearnPanel();
    }
  }

  function formatMidiControlLabel(control) {
    if (!control) return "Not mapped";
    const msg =
      control.msg_type === "PitchBend"
        ? "PB"
        : control.msg_type === "Note"
          ? "Note"
          : control.msg_type === "ProgramChange"
            ? "Program"
            : "CC";
    return `Ch ${control.channel} ${msg} ${control.controller}`;
  }

  function renderMidiMappingSummary(element, deviceId, control, controlText) {
    if (!element) return;
    const deviceLabel = control ? labelForMidiDevice(deviceId) || String(deviceId || "").trim() : "";
    const unmappedLabel = t("bindings.notMapped");
    const key = [Boolean(control), deviceLabel, controlText, unmappedLabel];
    if (midiSummaryKeys.get(element)?.every((value, index) => value === key[index])) return;
    midiSummaryKeys.set(element, key);
    element.innerHTML = "";
    if (!control) {
      element.textContent = unmappedLabel;
      return;
    }

    const wrapper = document.createElement("span");
    wrapper.className = "binding-config-midi-stack";
    wrapper.title = deviceLabel ? `${deviceLabel} - ${controlText}` : controlText;

    const device = document.createElement("span");
    device.className = "binding-config-midi-device";
    device.textContent = deviceLabel || unmappedLabel;

    const controlLabelEl = document.createElement("span");
    controlLabelEl.className = "binding-config-midi-control";
    controlLabelEl.textContent = controlText;

    wrapper.appendChild(device);
    wrapper.appendChild(controlLabelEl);
    element.appendChild(wrapper);
  }

  function formatPreviewMidiValue(binding, normalizedValue, rawNormalizedValue = null) {
    const sourceValue = rawNormalizedValue != null ? rawNormalizedValue : normalizedValue;
    const clamped = Math.min(1, Math.max(0, Number(sourceValue) || 0));
    const msgType = String(binding?.control?.msg_type || "ControlChange");
    if (msgType === "PitchBend") {
      const raw = Math.round(clamped * 16383);
      return `${raw} / 16383`;
    }
    const raw = Math.round(clamped * 127);
    return `${raw} / 127`;
  }

  function renderAssignMappingLabel(binding) {
    if (!elements.bindingConfigAssignLabel) return;
    const mode =
      binding?.assign_mode === "Replace" ? "Replace" : binding?.assign_mode === "Clear" ? "Clear" : "Add";
    const mappingText = formatMidiControlLabel(binding?.assign_control);
    elements.bindingConfigAssignLabel.innerHTML = "";

    const main = document.createElement("span");
    main.className = "binding-config-label-main";
    main.textContent = mappingText;

    const badge = document.createElement("span");
    badge.className = "binding-config-inline-badge";
    badge.textContent = mode;
    badge.title = assignModeTooltip(mode);
    badge.setAttribute("aria-label", badge.title);

    elements.bindingConfigAssignLabel.appendChild(main);
    elements.bindingConfigAssignLabel.appendChild(badge);
  }

  function renderMuteMappingLabel(binding) {
    if (!elements.bindingConfigMuteLabel) return;
    const behavior = muteBehaviorLabel(binding?.mute_control?.mute_behavior || binding?.mute_behavior);
    const mappingText = formatMidiControlLabel(binding?.mute_control);
    elements.bindingConfigMuteLabel.innerHTML = "";

    const main = document.createElement("span");
    main.className = "binding-config-label-main";
    main.textContent = mappingText;

    const badge = document.createElement("span");
    badge.className = "binding-config-inline-badge";
    badge.textContent = behavior;
    badge.title = muteBehaviorTooltip(binding?.mute_control?.mute_behavior || binding?.mute_behavior);
    badge.setAttribute("aria-label", badge.title);

    elements.bindingConfigMuteLabel.appendChild(main);
    elements.bindingConfigMuteLabel.appendChild(badge);
  }

  function normalizeAuxControl(learned) {
    if (!learned || typeof learned !== "object") return null;
    return {
      device_id: learned.device_id,
      channel: learned.channel,
      controller: learned.controller,
      msg_type: learned.msg_type || "ControlChange",
      control_kind: learned.control_kind || "Auto",
      mode: "Absolute",
      deadzone: 0,
      debounce_ms: 0,
      mute_behavior: "ToggleOnPress",
    };
  }

  function getConfigBinding() {
    return editorState.draft;
  }

  return {
    updateAuxLearnUi,
    stopAuxLearn,
    formatMidiControlLabel,
    renderMidiMappingSummary,
    formatPreviewMidiValue,
    renderAssignMappingLabel,
    renderMuteMappingLabel,
    normalizeAuxControl,
    getConfigBinding,
  };
}

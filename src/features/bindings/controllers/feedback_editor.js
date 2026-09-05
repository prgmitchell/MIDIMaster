import { effectiveButtonLightMode, normalizeButtonLightBehavior } from "../../../core/binding_model.js";
import { renderNativeSelectDropdown } from "../../ui/dropdown_select.js";
import { normalizeControlKind } from "../shape_helpers.js";

/** feedback editor workflow. */
export function createFeedbackEditor({
  elements,
  editorState,
  getConfigBinding,
  listState,
  renderConfigPreview,
  t,
  updateAuxLearnUi,
}) {
  function buttonLightOptionText(value) {
    if (value === "Disabled") {
      return t("bindings.feedbackDisabled");
    }
    const mode = value === "MappedWhenAssigned" ? "MappedWhenAssigned" : normalizeButtonLightBehavior(value);
    switch (mode) {
      case "MappedWhenAssigned":
        return t("bindings.buttonLightWhenMapped");
      case "InvertState":
        return t("bindings.buttonLightWhenOff");
      case "Pressed":
        return t("bindings.buttonLightWhilePressed");
      case "FollowState":
      case "Activity":
      default:
        return t("bindings.buttonLightWhenOn");
    }
  }

  function buttonLightSelectValue(binding) {
    if (binding?.feedback_enabled === false) return "Disabled";
    return effectiveButtonLightMode(binding);
  }

  function renderButtonLightDropdown() {
    if (!listState.buttonLightDropdown || !elements.bindingConfigButtonLightSelect) return;
    renderNativeSelectDropdown({
      entry: listState.buttonLightDropdown,
      selectEl: elements.bindingConfigButtonLightSelect,
      fallbackText: t("bindings.buttonLightWhenMapped"),
      formatOptionText: (option) => buttonLightOptionText(option.value),
      truncateDisplayLabel: false,
    });
  }

  function renderIndicatorDropdowns() {
    if (listState.indicatorMsgTypeDropdown && elements.bindingConfigIndicatorMsgType) {
      renderNativeSelectDropdown({
        entry: listState.indicatorMsgTypeDropdown,
        selectEl: elements.bindingConfigIndicatorMsgType,
        fallbackText: "Note",
        formatOptionText: (option) => option.textContent || option.value,
        onOptionSelected: () => updateIndicatorFromFields(),
        truncateDisplayLabel: false,
      });
    }
    if (listState.feedbackOutputMsgTypeDropdown && elements.bindingConfigFeedbackMsgType) {
      renderNativeSelectDropdown({
        entry: listState.feedbackOutputMsgTypeDropdown,
        selectEl: elements.bindingConfigFeedbackMsgType,
        fallbackText: "Note",
        formatOptionText: (option) => option.textContent || option.value,
        onOptionSelected: () => updateFeedbackOutputFromFields(),
        truncateDisplayLabel: false,
      });
    }
  }

  function clampMidiNumber(value, min, max, fallback) {
    const number = Math.trunc(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function normalizeIndicatorControl(raw, options = {}) {
    if (!raw || typeof raw !== "object") return null;
    const deviceId = String(raw.device_id || "").trim();
    if (!deviceId) return null;
    const allowPitchBend = options.allowPitchBend === true;
    const msgType =
      raw.msg_type === "Note"
        ? "Note"
        : allowPitchBend && raw.msg_type === "PitchBend"
          ? "PitchBend"
          : "ControlChange";
    return {
      device_id: deviceId,
      channel: clampMidiNumber(raw.channel, 0, 15, 0),
      controller: msgType === "PitchBend" ? 0 : clampMidiNumber(raw.controller, 0, 127, 0),
      msg_type: msgType,
      control_kind: options.controlKind || normalizeControlKind(raw.control_kind),
      mode: "Absolute",
      deadzone: 0,
      debounce_ms: 0,
      mute_behavior: "ToggleOnPress",
    };
  }

  function defaultIndicatorControl(binding, controlKind = "Button") {
    const allowPitchBend = controlKind === "Continuous";
    const primaryMsgType =
      binding?.control?.msg_type === "ControlChange"
        ? "ControlChange"
        : allowPitchBend && binding?.control?.msg_type === "PitchBend"
          ? "PitchBend"
          : "Note";
    return normalizeIndicatorControl(
      {
        device_id: binding?.device_id,
        channel: binding?.control?.channel ?? 0,
        controller: binding?.control?.controller ?? 0,
        msg_type: primaryMsgType,
        control_kind: controlKind,
      },
      {
        allowPitchBend,
        controlKind,
      },
    );
  }

  function ensureIndicatorControl(binding, controlKind = "Button") {
    if (!binding || typeof binding !== "object") return null;
    const allowPitchBend = controlKind === "Continuous";
    const normalized = normalizeIndicatorControl(binding.indicator_control, { allowPitchBend, controlKind });
    if (normalized) {
      binding.indicator_control = normalized;
      return normalized;
    }
    const fallback = defaultIndicatorControl(binding, controlKind);
    binding.indicator_control = fallback;
    return fallback;
  }

  function syncFeedbackControllerInputState(lockClear = false, feedbackDisabled = false) {
    if (!elements.bindingConfigFeedbackController) return;
    const isPitchBend = elements.bindingConfigFeedbackMsgType?.value === "PitchBend";
    if (isPitchBend) {
      elements.bindingConfigFeedbackController.type = "text";
      elements.bindingConfigFeedbackController.value = "N/A";
      elements.bindingConfigFeedbackController.disabled = true;
      elements.bindingConfigFeedbackController.readOnly = true;
      elements.bindingConfigFeedbackController.classList.add("is-readonly");
      return;
    }
    elements.bindingConfigFeedbackController.type = "number";
    elements.bindingConfigFeedbackController.min = "0";
    elements.bindingConfigFeedbackController.max = "127";
    elements.bindingConfigFeedbackController.step = "1";
    elements.bindingConfigFeedbackController.inputMode = "numeric";
    elements.bindingConfigFeedbackController.disabled = lockClear || feedbackDisabled;
    elements.bindingConfigFeedbackController.readOnly = false;
    elements.bindingConfigFeedbackController.classList.remove("is-readonly");
  }

  function syncIndicatorUi(binding, options = {}) {
    const feedbackDisabled = binding?.feedback_enabled === false;
    let custom = normalizeIndicatorControl(binding?.indicator_control);
    if (binding && custom) binding.indicator_control = custom;
    if (options.forceCustom && binding && !custom) {
      custom = ensureIndicatorControl(binding);
    }
    if (elements.bindingConfigIndicatorCustom) {
      elements.bindingConfigIndicatorCustom.classList.remove("hidden");
      elements.bindingConfigIndicatorCustom.classList.add("is-visible");
      elements.bindingConfigIndicatorCustom.setAttribute("aria-hidden", "false");
      elements.bindingConfigIndicatorCustom.classList.toggle("is-feedback-disabled", feedbackDisabled);
    }
    elements.bindingConfigButtonLightSection?.classList.add("is-indicator-custom");
    const control = custom || defaultIndicatorControl(binding);
    if (elements.bindingConfigIndicatorMsgType)
      elements.bindingConfigIndicatorMsgType.value = control?.msg_type || "Note";
    if (elements.bindingConfigIndicatorChannel)
      elements.bindingConfigIndicatorChannel.value = String((control?.channel ?? 0) + 1);
    if (elements.bindingConfigIndicatorController)
      elements.bindingConfigIndicatorController.value = String(control?.controller ?? 0);
    renderIndicatorDropdowns();
  }

  function syncFeedbackOutputUi(binding, options = {}) {
    const feedbackDisabled = binding?.feedback_enabled === false;
    let custom = normalizeIndicatorControl(binding?.indicator_control, {
      allowPitchBend: true,
      controlKind: "Continuous",
    });
    if (binding && custom) binding.indicator_control = { ...custom, control_kind: "Continuous" };
    if (options.forceCustom && binding && !custom) {
      custom = ensureIndicatorControl(binding, "Continuous");
    }
    if (elements.bindingConfigFeedbackOutputCustom) {
      elements.bindingConfigFeedbackOutputCustom.classList.remove("hidden");
      elements.bindingConfigFeedbackOutputCustom.classList.add("is-visible");
      elements.bindingConfigFeedbackOutputCustom.setAttribute("aria-hidden", "false");
      elements.bindingConfigFeedbackOutputCustom.classList.toggle("is-feedback-disabled", feedbackDisabled);
    }
    const control = custom || defaultIndicatorControl(binding, "Continuous");
    if (elements.bindingConfigFeedbackMsgType) {
      elements.bindingConfigFeedbackMsgType.value = feedbackDisabled
        ? "Disabled"
        : control?.msg_type || "Note";
    }
    if (elements.bindingConfigFeedbackChannel)
      elements.bindingConfigFeedbackChannel.value = String((control?.channel ?? 0) + 1);
    if (elements.bindingConfigFeedbackController)
      elements.bindingConfigFeedbackController.value = String(control?.controller ?? 0);
    syncFeedbackControllerInputState(
      Boolean(editorState.transferPrompt) || Boolean(editorState.learnField),
      feedbackDisabled,
    );
    renderIndicatorDropdowns();
  }

  function updateIndicatorFromFields() {
    const binding = getConfigBinding();
    if (!binding) return;
    const current = ensureIndicatorControl(binding);
    if (!current) return;
    binding.indicator_control = normalizeIndicatorControl({
      ...current,
      msg_type: elements.bindingConfigIndicatorMsgType?.value === "ControlChange" ? "ControlChange" : "Note",
      channel: clampMidiNumber((Number(elements.bindingConfigIndicatorChannel?.value) || 1) - 1, 0, 15, 0),
      controller: clampMidiNumber(
        elements.bindingConfigIndicatorController?.value,
        0,
        127,
        current.controller,
      ),
    });
    syncIndicatorUi(binding, { forceCustom: true });
    renderConfigPreview();
  }

  function updateFeedbackOutputFromFields() {
    const binding = getConfigBinding();
    if (!binding) return;
    if (elements.bindingConfigFeedbackMsgType?.value === "Disabled") {
      binding.feedback_enabled = false;
      syncFeedbackOutputUi(binding);
      updateAuxLearnUi();
      renderConfigPreview();
      return;
    }
    binding.feedback_enabled = true;
    const current = ensureIndicatorControl(binding, "Continuous");
    if (!current) return;
    const msgType =
      elements.bindingConfigFeedbackMsgType?.value === "PitchBend"
        ? "PitchBend"
        : elements.bindingConfigFeedbackMsgType?.value === "ControlChange"
          ? "ControlChange"
          : "Note";
    binding.indicator_control = normalizeIndicatorControl(
      {
        ...current,
        control_kind: "Continuous",
        msg_type: msgType,
        channel: clampMidiNumber((Number(elements.bindingConfigFeedbackChannel?.value) || 1) - 1, 0, 15, 0),
        controller:
          msgType === "PitchBend"
            ? 0
            : clampMidiNumber(elements.bindingConfigFeedbackController?.value, 0, 127, current.controller),
      },
      {
        allowPitchBend: true,
        controlKind: "Continuous",
      },
    );
    syncFeedbackOutputUi(binding, { forceCustom: true });
    renderConfigPreview();
  }

  return {
    buttonLightSelectValue,
    renderButtonLightDropdown,
    renderIndicatorDropdowns,
    normalizeIndicatorControl,
    syncFeedbackControllerInputState,
    syncIndicatorUi,
    syncFeedbackOutputUi,
    updateIndicatorFromFields,
    updateFeedbackOutputFromFields,
  };
}

import { getFaderModifiers } from "../../../core/fader_modifiers.js";
import {
  controlsEqual,
  primaryControlMapping,
} from "../../../core/control_mapping.js";
import {
  createSelectDropdownShell,
  renderNativeSelectDropdown,
} from "../../ui/dropdown_select.js";

export function renderLedModeDropdown(entry, selectEl, t) {
  if (!entry || !selectEl) return;
  renderNativeSelectDropdown({ entry, selectEl });
  entry.root.classList.add("binding-config-output-mode-dropdown");
  entry.button.classList.add(
    "binding-config-button",
    "binding-config-button--secondary",
    "binding-config-icon-button",
  );
  entry.button.dataset.outputModeTrigger = "true";
  if (!entry.button.querySelector("[data-output-mode-icon]")) {
    entry.button.insertAdjacentHTML(
      "beforeend",
      `<svg class="binding-config-mode-icon" data-output-mode-icon viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M15.5 5.5 17 4l3 3-1.5 1.5M8.5 5.5 7 4 4 7l1.5 1.5M15.5 18.5 17 20l3-3-1.5-1.5M8.5 18.5 7 20l-3-3 1.5-1.5M20 12h-2M6 12H4M12 4v2M12 18v2"/></svg>`,
    );
  }
  entry.button.title = `${t("bindings.feedbackMode")}: ${t(selectEl.value === "AudioReactive" ? "bindings.audioReactive" : "bindings.followValue")}`;
  entry.button.setAttribute("aria-label", entry.button.title);
  entry.button.disabled = selectEl.disabled;
}

/** Known LED protocols are automatic; unknown hardware uses a manual address. */
export function createLedFeedbackEditor({
  elements,
  lifetime,
  invoke,
  editorState,
  getConfigBinding,
  listState,
  t,
}) {
  const mode = elements.bindingConfigFeedbackMode;
  const type = elements.bindingConfigLedMsgType;
  const channel = elements.bindingConfigLedChannel;
  const control = elements.bindingConfigLedController;
  for (const [selectEl, key, title] of [
    [mode, "feedbackModeDropdown", "bindings.feedbackMode"],
    [type, "ledMsgTypeDropdown", "bindings.ledMessageType"],
  ]) {
    if (!selectEl || listState[key]) continue;
    listState[key] = createSelectDropdownShell({
      selectEl,
      rootClass: `binding-config-light-dropdown settings-select-dropdown${selectEl === mode ? " binding-config-feedback-mode" : ""}`,
      title: t(title),
      preferUp: true,
    });
    listState[key].button.dataset.i18nTitle = title;
  }

  let request = 0;
  function sync(binding) {
    if (!mode || !type || !channel || !control) return;
    const led = binding?.led_control;
    const enabled = binding?.led_enabled === true;
    const automatic = enabled && !led;
    const manual = enabled && !automatic;
    const existing =
      binding?.indicator_control || primaryControlMapping(binding);
    const address = enabled ? led : existing;
    const pitchBend = address?.msg_type === "PitchBend";
    const meter = address?.msg_type === "ChannelPressure";
    const revision = ++request;
    const locked = Boolean(
      editorState.learnField || editorState.transferPrompt,
    );
    type.value = enabled ? led?.msg_type || "Automatic" : "Existing";
    channel.value = String((address?.channel ?? 0) + 1);
    control.type = pitchBend ? "text" : "number";
    control.min = meter ? "1" : "0";
    control.max = meter ? "8" : "127";
    control.value = pitchBend
      ? "N/A"
      : String((address?.controller ?? 0) + (meter ? 1 : 0));
    const controlLabel = control.closest("label")?.querySelector("span");
    if (controlLabel) {
      controlLabel.dataset.i18n = meter
        ? "bindings.ledMeterStrip"
        : "bindings.indicatorControl";
      controlLabel.textContent = t(controlLabel.dataset.i18n);
    }
    control.dataset.i18nAriaLabel = meter
      ? "bindings.ledMeterStrip"
      : "bindings.ledControlLabel";
    control.setAttribute("aria-label", t(control.dataset.i18nAriaLabel));
    mode.value =
      binding?.feedback_mode === "AudioReactive"
        ? "AudioReactive"
        : "FollowValue";
    type.disabled = locked;
    mode.disabled = locked;
    for (const field of [channel, control]) {
      field.disabled = locked || !manual;
      field.closest("label")?.classList.toggle("hidden", automatic);
    }
    if (meter) channel.disabled = true;
    type
      .closest(".binding-config-led-fields")
      ?.classList.toggle("is-automatic", automatic);
    type
      .closest(".binding-config-led-fields")
      ?.classList.toggle("is-existing", !enabled || meter);
    const valueOutput = binding?.feedback_enabled !== false ? existing : null;
    const conflict =
      enabled &&
      [
        valueOutput,
        ...(binding.additional_outputs || [])
          .filter(
            (output) => output.kind === "Feedback" && output.enabled !== false,
          )
          .map((output) => output.control),
        ...getFaderModifiers(binding).map((item) => item.control),
      ].some((other) => controlsEqual(led, other));
    const help = elements.bindingConfigLedHelp;
    if (help) {
      const reactive = mode.value === "AudioReactive";
      let key = reactive
        ? "bindings.audioReactiveHelp"
        : "bindings.ledOutputHelp";
      if (meter) key = "bindings.ledMackieMeterHelp";
      if (conflict) key = "bindings.ledAddressConflict";
      if (!enabled) {
        if (!reactive) key = "bindings.ledExistingFeedbackHelp";
        if (reactive && pitchBend) key = "bindings.ledExistingMotorHelp";
        if (binding?.feedback_enabled === false)
          key = "bindings.ledExistingFeedbackDisabled";
      }
      help.dataset.i18n = key;
      help.textContent = t(key);
      help.title = help.textContent;
    }
    if (automatic && invoke) {
      void invoke("get_automatic_led_output", { binding })
        .then((mapping) => {
          if (revision !== request || !help) return;
          const known =
            Number.isFinite(mapping?.channel) &&
            Number.isFinite(mapping?.controller);
          const key = !known
            ? "bindings.ledAutomaticUnavailable"
            : mode.value === "AudioReactive"
              ? "bindings.audioReactiveHelp"
              : "bindings.ledAutomaticKnown";
          help.dataset.i18n = key;
          help.textContent = t(key);
          help.title = help.textContent;
        })
        .catch(() => {});
    }
    control.setAttribute("aria-invalid", String(conflict));
    for (const [selectEl, entry] of [
      [mode, listState.feedbackModeDropdown],
      [type, listState.ledMsgTypeDropdown],
    ]) {
      if (!entry) continue;
      if (selectEl === mode) renderLedModeDropdown(entry, selectEl, t);
      else {
        renderNativeSelectDropdown({ entry, selectEl });
        entry.button.title = t(entry.button.dataset.i18nTitle);
      }
      entry.button.disabled = selectEl.disabled;
    }
  }

  const midiNumber = (value, max) =>
    Math.min(max, Math.max(0, Math.trunc(Number(value) || 0)));
  function update() {
    const binding = getConfigBinding();
    if (!binding) return;
    binding.feedback_mode =
      mode.value === "AudioReactive" ? "AudioReactive" : "FollowValue";
    binding.led_enabled = type.value !== "Existing";
    const meter = type.value === "ChannelPressure";
    const enteringMeter =
      meter && binding.led_control?.msg_type !== "ChannelPressure";
    binding.led_control = ["Existing", "Automatic"].includes(type.value)
      ? null
      : {
          device_id: binding.device_id,
          msg_type: meter
            ? "ChannelPressure"
            : type.value === "Note"
              ? "Note"
              : "ControlChange",
          channel: meter ? 0 : midiNumber(Number(channel.value) - 1, 15),
          controller: meter
            ? enteringMeter
              ? midiNumber(binding.control?.channel, 7)
              : midiNumber(Number(control.value) - 1, 7)
            : midiNumber(control.value, 127),
          control_kind: "Continuous",
          mode: "Absolute",
          deadzone: 0,
          debounce_ms: 0,
          mute_behavior: "ToggleOnPress",
        };
    sync(binding);
  }
  lifetime?.listen(mode, "change", update);
  lifetime?.listen(type, "change", update);
  lifetime?.listen(channel, "input", update);
  lifetime?.listen(control, "input", update);
  return { sync };
}

import {
  positionFloatingDropdownMenu,
  renderLabelWithBadges,
  wireDropdownToggle,
} from "../ui/dropdown_badges.js";
import {
  createSelectDropdownShell,
  renderNativeSelectDropdown,
} from "../ui/dropdown_select.js";
import {
  applyCurveToNormalized,
  assignModeTooltip,
  buildHotkeyMappingFromEvent,
  buttonModeValue,
  buttonVisualBehavior,
  cloneBindingDraft,
  curveDisplayName,
  curveEditorPoints,
  curveHelpText,
  customCurvePoints,
  effectiveButtonLightMode,
  effectiveIsButton,
  ensureAuxShape,
  ensureBindingShape,
  getPrimaryTarget,
  getTargets,
  isAutoHotkeyScriptTarget,
  isHotkeyTarget,
  isMacroTarget,
  isOpenApplicationTarget,
  isSoundboardTarget,
  MACRO_MAX_PARALLEL_STEPS,
  MACRO_MAX_TOP_LEVEL_STEPS,
  MACRO_MAX_WAIT_MS,
  modeTooltip,
  muteBehaviorLabel,
  muteBehaviorTooltip,
  normalizeButtonLightBehavior,
  normalizeControlKind,
  normalizeCustomCurve,
  normalizeFaderCurve,
  normalizeMacroActionState,
  normalizeMacroActionStep,
  normalizeMacroSteps,
  normalizeMuteBehavior,
  normalizeRelativeFormat,
  normalizeSoundboardMapping,
  presetCurvePoints,
  resolveButtonVisualActive,
  setTargets,
} from "./shape_helpers.js";
import {
  clampSoundboardTrim,
  drawSoundboardWaveform,
  formatSoundboardTime,
  soundboardArrowStep,
  waveformTimeFromPointer,
} from "./soundboard_editor.js";
import {
  resolveBindingVolumeValue,
  resolveTargetChangeVolumeValue,
} from "./value_sync.js";
import { reorderVisibleBindings } from "./reorder.js";
import {
  MAX_FADER_CURVE_PRESETS,
  curvePointsForBinding,
  curvePresetPointsEqual,
  findMatchingFaderCurvePreset,
  nextCurvePresetName,
  normalizeCurvePresetName,
  normalizeCurvePresetPoints,
  normalizeFaderCurvePresets,
} from "./fader_curve_presets.js";

const CUSTOM_CURVE_VIEWBOX_SIZE = 120;
const CUSTOM_CURVE_PADDING = 10;
const CUSTOM_CURVE_PLOT_SIZE = CUSTOM_CURVE_VIEWBOX_SIZE - (CUSTOM_CURVE_PADDING * 2);
const CUSTOM_CURVE_MIN_POINT_SPACING = 0.035;
const CUSTOM_CURVE_EPSILON = 0.0001;

export function createBindingsFeature({
  invoke,
  dom,
  getPlaybackDevices,
  getRecordingDevices,
  getBindings,
  setBindings,
  bindingFallbackName,
  controlLabel,
  getMidiDeviceLabel,
  buildTargetSelect,
  getVolumeForTarget,
  getMuteForTarget,
  triggerIntegration,
  extractIntegrationTarget,
  i18n,
  showVolumeOsd,
  showMuteOsd,
  saveBindingsForProfile,
  getFaderCurvePresets,
  saveFaderCurvePresets,
  getPluginHost,
  getEditingBindingId,
  setEditingBindingId,
  getPendingFocusBindingId,
  setPendingFocusBindingId,
  getDragState,
  setDragState,
  bindingInteractionTimes,
  bindingLastValues,
  bindingMuteValues,
  getLiveMidiValueForControl,
  createTargetIcon,
  resolveOsdTarget,
  showChoices,
  showConfirm,
  showAlert,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createBindingsFeature: invoke is required");
  }

  const SLIDER_ACTION_FLUSH_MS = 16;
  const sliderIntentSequenceByBinding = {};
  const pendingSliderActionsByBinding = new Map();
  const d = (dom && typeof dom === "object") ? dom : {};
  const t = (key, params = {}) => (i18n && typeof i18n.t === "function") ? i18n.t(key, params) : String(key || "");
  if (!d.bindingsContainer) {
    throw new Error("createBindingsFeature: dom.bindingsContainer is required");
  }

  const getB = (typeof getBindings === "function") ? getBindings : (() => []);
  const setB = (typeof setBindings === "function") ? setBindings : (() => { });
  let buttonLightDropdown = null;
  let indicatorMsgTypeDropdown = null;
  let feedbackOutputMsgTypeDropdown = null;

  const getPlayback = (typeof getPlaybackDevices === "function") ? getPlaybackDevices : (() => []);
  const getRecording = (typeof getRecordingDevices === "function") ? getRecordingDevices : (() => []);

  const fallbackNameFor = (typeof bindingFallbackName === "function")
    ? bindingFallbackName
    : ((_b, i) => `Binding ${i + 1}`);
  const labelForControl = (typeof controlLabel === "function")
    ? controlLabel
    : ((c) => {
      const msgType = String(c?.msg_type || c?.msgType || "ControlChange");
      const label = msgType === "PitchBend"
        ? "Pitch Bend"
        : (msgType === "Note" ? "Note" : (msgType === "ProgramChange" ? "Program" : "CC"));
      return `Ch ${c?.channel ?? "?"} ${label} ${msgType === "PitchBend" ? "" : (c?.controller ?? "?")}`.trim();
    });
  const labelForMidiDevice = (typeof getMidiDeviceLabel === "function")
    ? getMidiDeviceLabel
    : ((deviceId) => String(deviceId || "").trim());

  const buildTarget = (typeof buildTargetSelect === "function")
    ? buildTargetSelect
    : (() => {
      const s = document.createElement("select");
      const o = document.createElement("option");
      o.value = "Unset";
      o.textContent = "Unset";
      s.appendChild(o);
      return s;
    });

  const getVol = (typeof getVolumeForTarget === "function") ? getVolumeForTarget : (() => null);
  const getMuted = (typeof getMuteForTarget === "function") ? getMuteForTarget : (() => false);
  const getLiveMidiValue = (typeof getLiveMidiValueForControl === "function") ? getLiveMidiValueForControl : (() => null);
  const saveProfile = (typeof saveBindingsForProfile === "function") ? saveBindingsForProfile : (async () => { });
  const getCurvePresets = (typeof getFaderCurvePresets === "function") ? getFaderCurvePresets : (() => []);
  const saveCurvePresets = (typeof saveFaderCurvePresets === "function")
    ? saveFaderCurvePresets
    : (async (presets) => normalizeFaderCurvePresets(presets));
  const getHost = (typeof getPluginHost === "function") ? getPluginHost : (() => null);
  const iconForTarget = (typeof createTargetIcon === "function") ? createTargetIcon : (() => document.createElement("span"));
  const resolveTargetDisplay = (typeof resolveOsdTarget === "function") ? resolveOsdTarget : (() => null);
  const confirmAction = (typeof showConfirm === "function")
    ? showConfirm
    : async ({ message = "" } = {}) => {
      if (typeof window !== "undefined" && typeof window.confirm === "function") {
        return window.confirm(message);
      }
      return false;
    };
  const alertAction = (typeof showAlert === "function")
    ? showAlert
    : ((title = "", message = "") => {
      if (typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert([title, message].filter(Boolean).join("\n\n"));
      }
    });
  const getEditingId = (typeof getEditingBindingId === "function") ? getEditingBindingId : (() => null);
  const setEditingId = (typeof setEditingBindingId === "function") ? setEditingBindingId : (() => { });
  const getPendingFocusId = (typeof getPendingFocusBindingId === "function") ? getPendingFocusBindingId : (() => null);
  const setPendingFocusId = (typeof setPendingFocusBindingId === "function") ? setPendingFocusBindingId : (() => { });

  const getDrag = (typeof getDragState === "function") ? getDragState : (() => null);
  const setDrag = (typeof setDragState === "function") ? setDragState : (() => { });
  const getSearchQuery = () => String(d.bindingSearchInput?.value || "").trim().toLowerCase();
  const bindingTypeFilterValues = new Set(["all", "faders", "buttons"]);
  let bindingTypeFilter = "all";
  let compactBindings = false;
  let bindingDensitySaveSequence = 0;
  const bindingsCard = d.bindingsContainer.closest?.(".bindings-card") || null;
  let bindingsScrollbarWidth = 0;
  let bindingsLayoutSyncQueued = false;
  let pendingRevealBindingId = null;

  function normalizeBindingTypeFilter(value) {
    const normalized = String(value || "all").toLowerCase();
    return bindingTypeFilterValues.has(normalized) ? normalized : "all";
  }

  function getBindingTypeFilter() {
    return normalizeBindingTypeFilter(bindingTypeFilter);
  }

  function showMacroAlreadyConfiguredError() {
    alertAction(
      t("dialogs.macroAlreadyConfiguredTitle"),
      t("dialogs.macroAlreadyConfiguredMessage"),
    );
  }

  function bindingTypeFilterOptions() {
    return [
      { value: "all", label: t("bindings.filterAll") },
      { value: "faders", label: t("bindings.filterFaders") },
      { value: "buttons", label: t("bindings.filterButtons") },
    ];
  }

  function bindingMatchesTypeFilter(binding, filterValue = getBindingTypeFilter()) {
    const normalized = normalizeBindingTypeFilter(filterValue);
    if (normalized === "all") return true;
    const isButton = effectiveIsButton(binding);
    return normalized === "buttons" ? isButton : !isButton;
  }

  function updateBindingTypeFilterUi() {
    const currentFilter = getBindingTypeFilter();
    const options = bindingTypeFilterOptions();
    const active = options.find((option) => option.value === currentFilter) || options[0];

    if (d.bindingTypeFilter) {
      const label = t("bindings.typeFilterLabel");
      d.bindingTypeFilter.title = `${label}: ${active.label}`;
      d.bindingTypeFilter.setAttribute("aria-label", label);
    }
    d.bindingTypeFilter?.querySelectorAll("[data-filter]").forEach((optionButton) => {
      const selected = normalizeBindingTypeFilter(optionButton.dataset?.filter) === currentFilter;
      optionButton.classList.toggle("selected", selected);
      optionButton.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function setBindingTypeFilter(value) {
    const next = normalizeBindingTypeFilter(value);
    const changed = next !== bindingTypeFilter;
    bindingTypeFilter = next;
    updateBindingTypeFilterUi();
    if (changed) {
      renderBindings();
    }
  }

  function bindBindingTypeFilterUi() {
    const root = d.bindingTypeFilter;
    if (!root) return;

    root.querySelectorAll("[data-filter]").forEach((optionButton) => {
      optionButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setBindingTypeFilter(optionButton.dataset?.filter);
      });
    });

    updateBindingTypeFilterUi();
  }

  function updateBindingDensityUi() {
    const density = compactBindings ? "compact" : "comfortable";
    if (d.mainScreen) {
      d.mainScreen.dataset.bindingsDensity = density;
    }
    d.bindingDensityToggle?.querySelectorAll("[data-density]").forEach((optionButton) => {
      const selected = String(optionButton.dataset?.density || "") === density;
      optionButton.classList.toggle("selected", selected);
      optionButton.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    queueBindingsScrollLayoutSync();
  }

  async function setCompactBindings(value, { persist = false } = {}) {
    const next = Boolean(value);
    const previous = compactBindings;
    compactBindings = next;
    updateBindingDensityUi();
    if (!persist || next === previous) {
      return compactBindings;
    }

    const sequence = ++bindingDensitySaveSequence;
    try {
      const saved = await invoke("set_compact_bindings", { compactBindings: next });
      if (sequence !== bindingDensitySaveSequence) {
        return compactBindings;
      }
      compactBindings = typeof saved === "boolean" ? saved : next;
      updateBindingDensityUi();
    } catch (error) {
      if (sequence === bindingDensitySaveSequence) {
        compactBindings = previous;
        updateBindingDensityUi();
        alertAction(t("dialogs.actionFailedTitle"), t("dialogs.actionFailedMessage"));
      }
      console.error("Failed to save binding view density", error);
    }
    return compactBindings;
  }

  function bindBindingDensityUi() {
    const root = d.bindingDensityToggle;
    if (!root) return;
    root.querySelectorAll("[data-density]").forEach((optionButton) => {
      optionButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void setCompactBindings(optionButton.dataset?.density === "compact", { persist: true });
      });
    });
    updateBindingDensityUi();
  }

  function measureScrollbarWidth() {
    const probe = document.createElement("div");
    probe.style.cssText = [
      "position:absolute",
      "top:-9999px",
      "left:-9999px",
      "width:120px",
      "height:120px",
      "overflow:scroll",
      "visibility:hidden",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(probe);
    const width = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    return Math.max(0, width || 0);
  }

  function syncBindingsScrollLayout() {
    bindingsLayoutSyncQueued = false;
    if (!bindingsCard || !d.bindingsContainer?.isConnected) return;

    if (!bindingsScrollbarWidth) {
      bindingsScrollbarWidth = measureScrollbarWidth();
    }

    const isScrollable = d.bindingsContainer.scrollHeight > d.bindingsContainer.clientHeight + 1;
    bindingsCard.classList.toggle("is-scrollable", isScrollable);
    bindingsCard.style.setProperty("--bindings-scrollbar-width", `${bindingsScrollbarWidth}px`);
    bindingsCard.style.setProperty("--bindings-header-reserve", `${bindingsScrollbarWidth}px`);
    bindingsCard.style.setProperty("--bindings-row-reserve", "0px");
  }

  function queueBindingsScrollLayoutSync() {
    if (bindingsLayoutSyncQueued) return;
    bindingsLayoutSyncQueued = true;
    requestAnimationFrame(syncBindingsScrollLayout);
  }

  function queueBindingReveal(bindingId) {
    const nextId = String(bindingId || "").trim();
    pendingRevealBindingId = nextId || null;
  }

  function findRenderedBindingItem(bindingId) {
    const targetId = String(bindingId || "");
    if (!targetId || !d.bindingsContainer) return null;
    return Array.from(d.bindingsContainer.querySelectorAll(".binding-item"))
      .find((item) => String(item.dataset?.bindingId || "") === targetId) || null;
  }

  function flushQueuedBindingReveal() {
    const bindingId = pendingRevealBindingId;
    if (!bindingId) return;
    pendingRevealBindingId = null;

    requestAnimationFrame(() => {
      const item = findRenderedBindingItem(bindingId);
      if (!item) return;
      const reduceMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
      item.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
      item.classList.remove("binding-item-revealed");
      void item.offsetWidth;
      item.classList.add("binding-item-revealed");
      clearTimeout(item.__bindingRevealTimer);
      item.__bindingRevealTimer = setTimeout(() => {
        item.classList.remove("binding-item-revealed");
      }, reduceMotion ? 700 : 1800);
    });
  }

  function ensureBindingVisibleForPicker(bindingId) {
    const binding = getBindingById(bindingId);
    let needsRender = false;
    if (d.bindingSearchInput && String(d.bindingSearchInput.value || "").trim()) {
      d.bindingSearchInput.value = "";
      needsRender = true;
    }
    if (binding && !bindingMatchesTypeFilter(binding, getBindingTypeFilter())) {
      bindingTypeFilter = "all";
      updateBindingTypeFilterUi();
      needsRender = true;
    }
    if (needsRender) {
      renderBindings();
    }
  }

  function openBindingTargetPicker(bindingId) {
    const targetId = String(bindingId || "");
    if (!targetId) return;
    setEditingId(null);
    setPendingFocusId(null);
    ensureBindingVisibleForPicker(targetId);

    const openRenderedPicker = () => {
      const item = findRenderedBindingItem(targetId);
      if (!item) return false;
      const reduceMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
      item.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
      item.classList.remove("binding-item-revealed");
      void item.offsetWidth;
      item.classList.add("binding-item-revealed");
      clearTimeout(item.__bindingRevealTimer);
      item.__bindingRevealTimer = setTimeout(() => {
        item.classList.remove("binding-item-revealed");
      }, reduceMotion ? 700 : 1800);

      const targetDropdown = item.querySelector(".binding-target-dropdown");
      if (typeof targetDropdown?.openTargetPicker === "function") {
        targetDropdown.openTargetPicker();
        return true;
      }
      const targetButton = targetDropdown?.querySelector?.(".target-button");
      if (targetButton) {
        targetButton.click();
        return true;
      }
      return false;
    };

    requestAnimationFrame(() => {
      if (!openRenderedPicker()) {
        setTimeout(openRenderedPicker, 0);
      }
    });
  }

  function displayModeName(binding) {
    if (effectiveIsButton(binding) && binding?.action === "ToggleMute") {
      return muteBehaviorLabel(binding?.mute_behavior);
    }
    if (effectiveIsButton(binding)) return muteBehaviorLabel(binding?.mute_behavior);
    return binding?.mode === "Relative" ? "Relative" : "Absolute";
  }

  function buttonVisualOptions(binding, overrides = {}) {
    const behavior = buttonVisualBehavior(binding);
    const bindingId = binding?.id;
    const storedValue = bindingId != null && bindingLastValues[bindingId] != null
      ? Number(bindingLastValues[bindingId])
      : null;
    const liveInputValue = getLiveMidiValue(binding?.device_id, binding?.control);
    const mappedMuteValue = bindingId != null && bindingMuteValues[bindingId] != null
      ? Boolean(bindingMuteValues[bindingId])
      : null;
    const muted = typeof overrides.muted === "boolean" ? overrides.muted : mappedMuteValue;
    return {
      inputValue: Object.prototype.hasOwnProperty.call(overrides, "inputValue")
        ? overrides.inputValue
        : (liveInputValue != null ? liveInputValue : (behavior === "momentary" ? storedValue : null)),
      stateValue: Object.prototype.hasOwnProperty.call(overrides, "stateValue")
        ? overrides.stateValue
        : (behavior === "stateful" && binding?.action !== "ToggleMute" ? storedValue : null),
      muted,
      fallbackMuted: Object.prototype.hasOwnProperty.call(overrides, "fallbackMuted")
        ? overrides.fallbackMuted
        : (muted == null ? Boolean(getMuted(getPrimaryTarget(binding))) : null),
    };
  }

  function buttonVisualActive(binding, overrides = {}) {
    const mappedLightValue = mappedButtonLightFeedbackValue(binding);
    if (mappedLightValue != null) return mappedLightValue > 0.5;
    return resolveButtonVisualActive(binding, buttonVisualOptions(binding, overrides));
  }

  function setButtonVisualState(bindingId, active) {
    if (bindingId == null) return false;
    const selector = `[data-binding-id="${CSS.escape(String(bindingId))}"]`;
    let updated = false;
    document.querySelectorAll(`.binding-momentary-value${selector}`).forEach((fill) => {
      fill.classList.toggle("is-active", Boolean(active));
      updated = true;
    });
    document.querySelectorAll(`.binding-toggle-value${selector}`).forEach((toggle) => {
      toggle.classList.toggle("on", Boolean(active));
      updated = true;
    });
    return updated;
  }

  function syncButtonVisualState(bindingOrId, overrides = {}) {
    const binding = typeof bindingOrId === "object" && bindingOrId
      ? bindingOrId
      : getBindingById(bindingOrId);
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
    return Boolean(target && target !== "Unset" && !("Unset" in Object(target)) && !("unset" in Object(target)));
  }

  function integrationFromTarget(target) {
    return target?.Integration || target?.integration || null;
  }

  function targetIsCompleteForMappedLight(target) {
    if (!targetIsNonUnset(target)) return false;
    if (
      target === "Master"
      || target === "Focus"
      || target === "MediaControl"
      || target === "CaptureControl"
      || target === "Macro"
    ) {
      return true;
    }
    const profile = target?.Profile || target?.profile;
    if (profile) return Boolean(String(profile.name || "").trim());
    const session = target?.Session || target?.session;
    if (session) return Boolean(String(session.session_id || "").trim());
    const app = target?.Application || target?.application;
    if (app) return Boolean(String(app.name || "").trim());
    const device = target?.Device || target?.device;
    if (device) return Boolean(String(device.device_id || "").trim());
    const integration = integrationFromTarget(target);
    if (integration) {
      return Boolean(String(integration.integration_id || "").trim())
        && Boolean(String(integration.kind || "").trim());
    }
    return false;
  }

  function mappedButtonLightTargetComplete(binding) {
    const targets = getTargets(binding);
    const action = String(binding?.action || "");
    if (action === "OpenApplication") {
      return targets.some(isOpenApplicationTarget)
        && Boolean(String(normalizeOpenApplicationMapping(binding?.open_application)?.path || "").trim());
    }
    if (action === "RunAutoHotkeyScript") {
      return targets.some(isAutoHotkeyScriptTarget)
        && Boolean(String(normalizeAutoHotkeyScriptMapping(binding?.autohotkey_script)?.path || "").trim());
    }
    if (action === "Hotkey") {
      return targets.some(isHotkeyTarget)
        && Boolean(normalizeHotkeyMapping(binding?.hotkey)?.keys?.length);
    }
    if (action === "Macro") {
      return targets.some(isMacroTarget)
        && normalizeMacroSteps(binding?.macro_steps).length > 0;
    }
    if (
      action === "MediaPlayPause"
      || action === "MediaNextTrack"
      || action === "MediaPrevTrack"
      || action === "MediaStop"
    ) {
      return targets.some((target) => target === "MediaControl");
    }
    if (action === "FocusWindow") {
      return targets.some((target) => {
        const app = target?.Application || target?.application;
        return Boolean(String(app?.name || "").trim());
      });
    }
    if (
      action === "FullScreenshot"
      || action === "SnipScreenshot"
      || action === "ToggleScreenRecording"
    ) {
      return targets.some((target) => target === "CaptureControl");
    }
    if (action === "SetDefaultDevice") {
      return targets.some((target) => Boolean(String((target?.Device || target?.device)?.device_id || "").trim()));
    }
    if (action === "SwitchProfile") {
      return targets.some((target) => Boolean(String((target?.Profile || target?.profile)?.name || "").trim()));
    }
    return targets.some(targetIsCompleteForMappedLight);
  }

  function mappedButtonLightFeedbackValue(binding) {
    if (
      !effectiveIsButton(binding)
      || effectiveButtonLightMode(binding) !== "MappedWhenAssigned"
    ) {
      return null;
    }
    const targets = getTargets(binding);
    if (!targets.some(targetIsNonUnset)) {
      return 0;
    }
    return mappedButtonLightTargetComplete(binding) ? 1 : 0;
  }

  function buttonLightLabel(binding) {
    switch (effectiveButtonLightMode(binding)) {
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

  function buttonLightOptionText(value) {
    const mode = value === "MappedWhenAssigned"
      ? "MappedWhenAssigned"
      : normalizeButtonLightBehavior(value);
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
    return effectiveButtonLightMode(binding);
  }

  function renderButtonLightDropdown() {
    if (!buttonLightDropdown || !d.bindingConfigButtonLightSelect) return;
    renderNativeSelectDropdown({
      entry: buttonLightDropdown,
      selectEl: d.bindingConfigButtonLightSelect,
      fallbackText: t("bindings.buttonLightWhenMapped"),
      formatOptionText: (option) => buttonLightOptionText(option.value),
      truncateDisplayLabel: false,
    });
  }

  function renderIndicatorDropdowns() {
    if (indicatorMsgTypeDropdown && d.bindingConfigIndicatorMsgType) {
      renderNativeSelectDropdown({
        entry: indicatorMsgTypeDropdown,
        selectEl: d.bindingConfigIndicatorMsgType,
        fallbackText: "Note",
        formatOptionText: (option) => option.textContent || option.value,
        onOptionSelected: () => updateIndicatorFromFields(),
        truncateDisplayLabel: false,
      });
    }
    if (feedbackOutputMsgTypeDropdown && d.bindingConfigFeedbackMsgType) {
      renderNativeSelectDropdown({
        entry: feedbackOutputMsgTypeDropdown,
        selectEl: d.bindingConfigFeedbackMsgType,
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
    const msgType = raw.msg_type === "Note"
      ? "Note"
      : (allowPitchBend && raw.msg_type === "PitchBend" ? "PitchBend" : "ControlChange");
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
    const primaryMsgType = binding?.control?.msg_type === "ControlChange"
      ? "ControlChange"
      : (allowPitchBend && binding?.control?.msg_type === "PitchBend" ? "PitchBend" : "Note");
    return normalizeIndicatorControl({
      device_id: binding?.device_id,
      channel: binding?.control?.channel ?? 0,
      controller: binding?.control?.controller ?? 0,
      msg_type: primaryMsgType,
      control_kind: controlKind,
    }, {
      allowPitchBend,
      controlKind,
    });
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

  function syncFeedbackControllerInputState(lockClear = false) {
    if (!d.bindingConfigFeedbackController) return;
    const isPitchBend = d.bindingConfigFeedbackMsgType?.value === "PitchBend";
    if (isPitchBend) {
      d.bindingConfigFeedbackController.type = "text";
      d.bindingConfigFeedbackController.value = "N/A";
      d.bindingConfigFeedbackController.disabled = true;
      d.bindingConfigFeedbackController.readOnly = true;
      d.bindingConfigFeedbackController.classList.add("is-readonly");
      return;
    }
    d.bindingConfigFeedbackController.type = "number";
    d.bindingConfigFeedbackController.min = "0";
    d.bindingConfigFeedbackController.max = "127";
    d.bindingConfigFeedbackController.step = "1";
    d.bindingConfigFeedbackController.inputMode = "numeric";
    d.bindingConfigFeedbackController.disabled = lockClear;
    d.bindingConfigFeedbackController.readOnly = false;
    d.bindingConfigFeedbackController.classList.remove("is-readonly");
  }

  function syncIndicatorUi(binding, options = {}) {
    let custom = normalizeIndicatorControl(binding?.indicator_control);
    if (binding && custom) binding.indicator_control = custom;
    if (options.forceCustom && binding && !custom) {
      custom = ensureIndicatorControl(binding);
    }
    if (d.bindingConfigIndicatorCustom) {
      d.bindingConfigIndicatorCustom.classList.remove("hidden");
      d.bindingConfigIndicatorCustom.classList.add("is-visible");
      d.bindingConfigIndicatorCustom.setAttribute("aria-hidden", "false");
    }
    d.bindingConfigButtonLightSection?.classList.add("is-indicator-custom");
    const control = custom || defaultIndicatorControl(binding);
    if (d.bindingConfigIndicatorMsgType) d.bindingConfigIndicatorMsgType.value = control?.msg_type || "Note";
    if (d.bindingConfigIndicatorChannel) d.bindingConfigIndicatorChannel.value = String((control?.channel ?? 0) + 1);
    if (d.bindingConfigIndicatorController) d.bindingConfigIndicatorController.value = String(control?.controller ?? 0);
    renderIndicatorDropdowns();
  }

  function syncFeedbackOutputUi(binding, options = {}) {
    let custom = normalizeIndicatorControl(binding?.indicator_control, {
      allowPitchBend: true,
      controlKind: "Continuous",
    });
    if (binding && custom) binding.indicator_control = { ...custom, control_kind: "Continuous" };
    if (options.forceCustom && binding && !custom) {
      custom = ensureIndicatorControl(binding, "Continuous");
    }
    if (d.bindingConfigFeedbackOutputCustom) {
      d.bindingConfigFeedbackOutputCustom.classList.remove("hidden");
      d.bindingConfigFeedbackOutputCustom.classList.add("is-visible");
      d.bindingConfigFeedbackOutputCustom.setAttribute("aria-hidden", "false");
    }
    const control = custom || defaultIndicatorControl(binding, "Continuous");
    if (d.bindingConfigFeedbackMsgType) d.bindingConfigFeedbackMsgType.value = control?.msg_type || "Note";
    if (d.bindingConfigFeedbackChannel) d.bindingConfigFeedbackChannel.value = String((control?.channel ?? 0) + 1);
    if (d.bindingConfigFeedbackController) d.bindingConfigFeedbackController.value = String(control?.controller ?? 0);
    syncFeedbackControllerInputState(Boolean(transferPrompt) || Boolean(configLearnField));
    renderIndicatorDropdowns();
  }

  function updateIndicatorFromFields() {
    const binding = getConfigBinding();
    if (!binding) return;
    const current = ensureIndicatorControl(binding);
    if (!current) return;
    binding.indicator_control = normalizeIndicatorControl({
      ...current,
      msg_type: d.bindingConfigIndicatorMsgType?.value === "ControlChange" ? "ControlChange" : "Note",
      channel: clampMidiNumber((Number(d.bindingConfigIndicatorChannel?.value) || 1) - 1, 0, 15, 0),
      controller: clampMidiNumber(d.bindingConfigIndicatorController?.value, 0, 127, current.controller),
    });
    syncIndicatorUi(binding, { forceCustom: true });
    renderConfigPreview();
  }

  function updateFeedbackOutputFromFields() {
    const binding = getConfigBinding();
    if (!binding) return;
    const current = ensureIndicatorControl(binding, "Continuous");
    if (!current) return;
    const msgType = d.bindingConfigFeedbackMsgType?.value === "PitchBend"
      ? "PitchBend"
      : (d.bindingConfigFeedbackMsgType?.value === "ControlChange" ? "ControlChange" : "Note");
    binding.indicator_control = normalizeIndicatorControl({
      ...current,
      control_kind: "Continuous",
      msg_type: msgType,
      channel: clampMidiNumber((Number(d.bindingConfigFeedbackChannel?.value) || 1) - 1, 0, 15, 0),
      controller: msgType === "PitchBend" ? 0 : clampMidiNumber(d.bindingConfigFeedbackController?.value, 0, 127, current.controller),
    }, {
      allowPitchBend: true,
      controlKind: "Continuous",
    });
    syncFeedbackOutputUi(binding, { forceCustom: true });
    renderConfigPreview();
  }

  function pulseMomentaryValue(button) {
    if (!button) return;
    button.classList.add("is-active");
    clearTimeout(button.__momentaryPulseTimer);
    button.__momentaryPulseTimer = setTimeout(() => {
      button.classList.remove("is-active");
    }, 160);
  }

  function bindingSearchText(binding, index) {
    return [
      binding?.name || "",
      fallbackNameFor(binding, index),
      labelForControl(binding?.control || {}),
      displayModeName(binding),
      JSON.stringify(getTargets(binding)),
      binding?.action || "",
      binding?.soundboard?.display || "",
      binding?.soundboard?.path || "",
    ].join(" ").toLowerCase();
  }

  function actionIconSvg(name) {
    const icons = {
      edit: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m14 6 4 4"/></svg>',
      delete: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M8 7l1 13h6l1-13"/><path d="M10.5 11v5M13.5 11v5"/></svg>',
    };
    return icons[name] || "";
  }

  function setActionIcon(button, name, label) {
    button.innerHTML = actionIconSvg(name);
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function muteIconSvg(muted) {
    if (muted) {
      return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m18 9-4 6M14 9l4 6"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>';
  }

  function setMuteButtonState(button, muted) {
    if (!button) return;
    const nextMuted = Boolean(muted);
    button.innerHTML = muteIconSvg(nextMuted);
    button.classList.toggle("muted", nextMuted);
    const label = nextMuted ? t("bindings.unmuteTarget") : t("bindings.muteTarget");
    button.title = label;
    button.setAttribute("aria-label", label);

    const row = button.closest(".binding-row");
    const toggle = row?.querySelector(".binding-toggle-value");
    if (toggle) {
      toggle.classList.toggle("on", nextMuted);
      toggle.title = label;
      toggle.setAttribute("aria-label", label);
    }
    const bindingId = button.dataset?.bindingId;
    if (bindingId != null) {
      const binding = getBindingById(bindingId);
      syncButtonVisualState(binding || bindingId, binding?.action === "ToggleMute"
        ? { muted: nextMuted, stateValue: nextMuted ? 1 : 0 }
        : { muted: nextMuted });
    }
  }

  function updateSliderFill(slider) {
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 1;
    const val = parseFloat(slider.value) || 0;
    const span = max - min;
    const percent = span > 0 ? Math.min(100, Math.max(0, ((val - min) / span) * 100)) : 0;
    slider.style.setProperty("--range-fill", `${percent}%`);
  }

  function updateVolumePercentForSlider(slider) {
    if (!slider) return;
    const percent = slider.closest(".binding-value-cell")?.querySelector(".binding-volume-percent");
    if (!percent) return;
    percent.textContent = `${Math.round((Number(slider.value) || 0) * 100)}%`;
  }

  function setSliderVolume(slider, volume, { bindingId = null, markMidiUpdate = false } = {}) {
    if (!slider) return;
    const next = Number(volume);
    if (!Number.isFinite(next)) return;
    slider.value = String(next);
    updateSliderFill(slider);
    updateVolumePercentForSlider(slider);
    const resolvedBindingId = bindingId || slider.dataset.bindingId;
    if (resolvedBindingId) {
      bindingLastValues[resolvedBindingId] = next;
    }
    if (markMidiUpdate) {
      slider.dataset.lastMidiUpdate = Date.now().toString();
    }
  }

  function resolveRenderedBindingVolume(bindingId, target) {
    return resolveBindingVolumeValue({
      bindingId,
      targetVolume: getVol(target),
      cachedVolume: bindingId != null ? bindingLastValues[bindingId] : null,
      interactionTimes: bindingInteractionTimes,
    });
  }

  function scheduleSliderActionFlush(bindingId) {
    const entry = pendingSliderActionsByBinding.get(bindingId);
    if (!entry || entry.timer || entry.inFlight) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      flushSliderAction(bindingId).catch((err) => {
        console.error("Failed to set volume:", err);
      });
    }, SLIDER_ACTION_FLUSH_MS);
  }

  async function flushSliderAction(bindingId) {
    const entry = pendingSliderActionsByBinding.get(bindingId);
    if (!entry || entry.inFlight) return;

    entry.inFlight = true;
    entry.dirty = false;
    const value = entry.value;
    const sourceSequence = entry.sourceSequence;

    try {
      await invoke("apply_binding_action", {
        bindingId,
        action: "Volume",
        value,
        silent: false,
        source: "ui_slider",
        sourceSequence,
      });
    } finally {
      entry.inFlight = false;
      if (entry.dirty || entry.value !== value || entry.sourceSequence !== sourceSequence) {
        entry.dirty = false;
        scheduleSliderActionFlush(bindingId);
      } else {
        pendingSliderActionsByBinding.delete(bindingId);
      }
    }
  }

  function queueSliderAction(bindingId, value, sourceSequence) {
    if (!bindingId) return;
    let entry = pendingSliderActionsByBinding.get(bindingId);
    if (!entry) {
      entry = {
        value,
        sourceSequence,
        timer: null,
        inFlight: false,
        dirty: false,
      };
      pendingSliderActionsByBinding.set(bindingId, entry);
    } else {
      entry.value = value;
      entry.sourceSequence = sourceSequence;
      entry.dirty = true;
    }
    scheduleSliderActionFlush(bindingId);
  }

  function isBindingTargetMenuOpen() {
    return Boolean(document.querySelector(".target-dropdown.open"));
  }

  function isTargetPanelOpen() {
    const panel = document.getElementById("target-panel");
    return Boolean(panel && !panel.classList.contains("hidden"));
  }

  function isBindingNameEditing() {
    return Boolean(document.querySelector(".binding-name-input:focus"));
  }

  function isBindingSelectEditing() {
    const active = document.activeElement;
    return Boolean(active && active.closest(".binding-item") && active.tagName === "SELECT");
  }

  function isBindingConfigOpen() {
    return Boolean(d.bindingConfigPanel && !d.bindingConfigPanel.classList.contains("hidden"));
  }

  function isBindingInteractionActive() {
    return isBindingTargetMenuOpen()
      || isTargetPanelOpen()
      || isBindingNameEditing()
      || isBindingSelectEditing()
      || isBindingConfigOpen();
  }

  function updateBindingValues() {
    updateBindingTargetDisplays();

    const sliders = document.querySelectorAll(".binding-volume-slider");
    sliders.forEach((slider) => {
      const lastMidiUpdate = Number(slider.dataset.lastMidiUpdate || 0);
      if (Date.now() - lastMidiUpdate < 1000) return;

      let target = null;
      try {
        target = JSON.parse(slider.dataset.targetJson);
      } catch {
        return;
      }

      const bindingId = slider.dataset.bindingId;
      const resolved = resolveRenderedBindingVolume(bindingId, target);
      if (resolved.source === "target") {
        if (bindingId) {
          bindingLastValues[bindingId] = resolved.value;
        }
        if (Math.abs(Number(slider.value) - resolved.value) > 0.01) {
          setSliderVolume(slider, resolved.value, { bindingId });
          invoke("update_midi_feedback", { target, value: resolved.value, action: "Volume" });
        }
      }
    });

    const buttons = document.querySelectorAll(".binding-mute-button");
    buttons.forEach((btn) => {
      let target = null;
      try {
        target = JSON.parse(btn.dataset.targetJson);
      } catch {
        return;
      }

      const muted = Boolean(getMuted(target));
      const currentlyMuted = btn.classList.contains("muted");
      const bindingId = btn.dataset.bindingId;
      const nextMuted = bindingId != null && bindingMuteValues[bindingId] != null
        ? Boolean(bindingMuteValues[bindingId])
        : muted;
      if (nextMuted !== currentlyMuted) {
        setMuteButtonState(btn, nextMuted);
      }
    });
  }

  function updateBindingTargetDisplays() {
    document.querySelectorAll(".binding-target-dropdown").forEach((targetDropdown) => {
      if (typeof targetDropdown.refreshTargetDisplay === "function") {
        targetDropdown.refreshTargetDisplay();
      }
    });

    if (configBindingId) {
      const binding = getConfigBinding();
      if (binding) {
        renderPreviewTarget(binding);
      }
    }
  }

  let configBindingId = null;
  let configDraft = null;
  let configMacroPageOpen = false;
  let configSoundboardPageOpen = false;
  let configRemoveEmptySoundboardTargetOnCancel = false;
  let soundboardAnalysis = null;
  let soundboardAnalysisError = "";
  let soundboardAnalysisToken = 0;
  let soundboardPreviewState = "stopped";
  let soundboardPreviewStartedAt = 0;
  let soundboardPreviewElapsedMs = 0;
  let soundboardPreviewAnimationFrame = null;
  let soundboardOutputDevices = [];
  let soundboardOutputDevicesLoaded = false;
  let soundboardOutputDropdown = null;
  let soundboardPointerHandle = null;
  let configMacroSelectedPath = null;
  let configMacroPendingSelectedScroll = false;
  let configPreviewOriginalBindings = null;
  let configLearnField = null;
  let configLearnTimer = null;
  let transferPrompt = null;
  const configAcceptedTransfers = new Map();
  let configPreviewTimer = null;
  let customCurvePointer = null;
  let curvePresetMenuOpen = false;
  let curvePresetSearchQuery = "";
  let curvePresetFormMode = null;
  let curvePresetFormPresetId = null;
  let selectedCustomCurvePresetId = null;
  let macroDragState = null;
  let hotkeyLearnBindingId = null;
  let hotkeyLearnCleanup = null;
  const nameDrafts = new Map();
  let pendingRerender = false;
  let suppressPendingFocusClearUntil = 0;
  const defaultLearnPanelTitle = () => t("bindings.waitingMidiTitle");
  const defaultLearnPanelMessage = () => t("bindings.learnMessage");

  function clearTransferPrompt() {
    transferPrompt = null;
  }

  function setTransferPrompt(nextPrompt) {
    transferPrompt = nextPrompt || null;
    updateAuxLearnUi();
  }

  function hasLearnPanelSupport() {
    return Boolean(d.learnPanel);
  }

  function resetLearnPanelUi() {
    if (!hasLearnPanelSupport()) return;
    if (d.learnPanelTitle) d.learnPanelTitle.textContent = defaultLearnPanelTitle();
    if (d.learnPanelMessage) d.learnPanelMessage.textContent = defaultLearnPanelMessage();
    if (d.learnPanelSpinner) d.learnPanelSpinner.classList.remove("hidden");
    if (d.learnPanelActions) d.learnPanelActions.classList.add("hidden");
    if (d.learnPanelCancel) d.learnPanelCancel.textContent = t("common.cancel");
    if (d.learnPanelConfirm) {
      d.learnPanelConfirm.textContent = t("common.transfer");
      d.learnPanelConfirm.classList.remove("hidden");
    }
  }

  function showLearnPanel() {
    if (!hasLearnPanelSupport()) return;
    d.learnPanel.classList.remove("hidden");
  }

  function hideLearnPanel() {
    if (!hasLearnPanelSupport()) return;
    d.learnPanel.classList.add("hidden");
    resetLearnPanelUi();
  }

  function setLearnPanelWaiting() {
    if (!hasLearnPanelSupport()) return;
    if (d.learnPanelTitle) d.learnPanelTitle.textContent = defaultLearnPanelTitle();
    if (d.learnPanelMessage) d.learnPanelMessage.textContent = defaultLearnPanelMessage();
    if (d.learnPanelSpinner) d.learnPanelSpinner.classList.remove("hidden");
    if (d.learnPanelActions) d.learnPanelActions.classList.add("hidden");
    showLearnPanel();
  }

  function setLearnPanelTransfer(message) {
    if (!hasLearnPanelSupport()) return;
    if (d.learnPanelTitle) d.learnPanelTitle.textContent = t("bindings.transferMapping");
    if (d.learnPanelMessage) d.learnPanelMessage.textContent = message || "";
    if (d.learnPanelSpinner) d.learnPanelSpinner.classList.add("hidden");
    if (d.learnPanelActions) d.learnPanelActions.classList.remove("hidden");
    if (d.learnPanelCancel) d.learnPanelCancel.textContent = t("common.cancel");
    if (d.learnPanelConfirm) {
      d.learnPanelConfirm.textContent = t("common.transfer");
      d.learnPanelConfirm.classList.remove("hidden");
    }
    showLearnPanel();
  }

  function normalizeHotkeyMapping(rawHotkey) {
    if (!rawHotkey || typeof rawHotkey !== "object") return null;
    const keys = Array.isArray(rawHotkey.keys)
      ? rawHotkey.keys
        .map((key) => String(key || "").trim())
        .filter(Boolean)
      : [];
    if (keys.length === 0) return null;
    const display = String(rawHotkey.display || "").trim() || keys.join("+");
    return { keys, display };
  }

  function normalizeOpenApplicationMapping(rawOpenApplication) {
    if (!rawOpenApplication || typeof rawOpenApplication !== "object") return null;
    const path = String(rawOpenApplication.path || "").trim();
    const display = String(rawOpenApplication.display || "").trim();
    const icon_data = typeof rawOpenApplication.icon_data === "string" && rawOpenApplication.icon_data.trim()
      ? rawOpenApplication.icon_data.trim()
      : null;
    if (!path) return null;
    return {
      path,
      display: display || path,
      icon_data,
    };
  }

  function normalizeAutoHotkeyScriptMapping(rawScript) {
    if (!rawScript || typeof rawScript !== "object") return null;
    const path = String(rawScript.path || "").trim();
    const display = String(rawScript.display || "").trim();
    return path ? { path, display: display || path } : null;
  }

  function clonePlain(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeMacroName(raw) {
    return String(raw || "").trim().slice(0, 80);
  }

  function defaultMacroName(binding) {
    const name = String(binding?.name || "").trim();
    return name && !/^Binding\s+\d+$/i.test(name) ? name.slice(0, 80) : "My Macro";
  }

  function ensureMacroName(binding, { defaultIfBlank = false } = {}) {
    if (!binding || typeof binding !== "object") return "";
    const normalized = normalizeMacroName(binding.macro_name);
    binding.macro_name = normalized || (defaultIfBlank ? defaultMacroName(binding) : "");
    return binding.macro_name;
  }

  function blankMacroActionStep({ includeKind = true } = {}) {
    const step = {
      action: "",
      targets: [],
      state: "Default",
    };
    return includeKind ? { kind: "action", ...step } : step;
  }

  function defaultMacroActionStep() {
    return blankMacroActionStep();
  }

  function defaultMacroParallelActionStep() {
    return blankMacroActionStep({ includeKind: false });
  }

  function defaultMacroWaitStep() {
    return {
      kind: "wait",
      duration_ms: 500,
    };
  }

  function defaultMacroParallelStep() {
    return {
      kind: "parallel",
      steps: [
        defaultMacroParallelActionStep(),
        defaultMacroParallelActionStep(),
      ],
    };
  }

  function macroDraftHasCommandMetadata(step) {
    const explicit = String(step?.action_label || step?.actionLabel || "").trim();
    if (explicit) return true;
    const targets = Array.isArray(step?.targets) ? step.targets : [];
    return targets.some((target) => {
      const integration = target?.Integration || target?.integration;
      const data = integration?.data || {};
      return Boolean(
        data.action_label
        || data.action_value
        || data.action_kind
        || data.button_action
        || data.osd_value_text
      );
    });
  }

  function macroDraftLooksLikeLegacyTriggerPlaceholder(step) {
    if (String(step?.action || "") !== "Volume") return false;
    const role = String(step?.action_role || step?.actionRole || "").trim().toLowerCase();
    return role !== "value" && !macroDraftHasCommandMetadata(step);
  }

  function normalizeMacroDraftActionStep(step, { includeKind = false } = {}) {
    if (macroDraftLooksLikeLegacyTriggerPlaceholder(step)) {
      const draft = blankMacroActionStep({ includeKind });
      draft.targets = (Array.isArray(step?.targets) ? step.targets : [])
        .filter((target) => target && target !== "Unset" && !isMacroTarget(target))
        .slice(0, 8);
      draft.state = normalizeMacroActionState(step?.state || "Default");
      return draft;
    }
    const normalized = normalizeMacroActionStep(step);
    if (normalized) {
      return includeKind ? { kind: "action", ...normalized } : normalized;
    }
    const draft = blankMacroActionStep({ includeKind });
    const targets = (Array.isArray(step?.targets) ? step.targets : [])
      .filter((target) => target && target !== "Unset" && !isMacroTarget(target))
      .slice(0, 8);
    if (targets.length > 0) {
      draft.targets = targets;
      draft.action = "";
      draft.state = normalizeMacroActionState(step?.state || "Default");
      draft.hotkey = normalizeHotkeyMapping(step?.hotkey);
      draft.open_application = normalizeOpenApplicationMapping(step?.open_application);
      draft.autohotkey_script = normalizeAutoHotkeyScriptMapping(step?.autohotkey_script);
    }
    return draft;
  }

  function normalizeMacroDraftStep(step) {
    if (!step || typeof step !== "object") return null;
    const kind = String(step.kind || "action");
    if (kind === "wait") {
      const durationMs = Math.round(Number(step.duration_ms ?? step.durationMs ?? 0));
      return {
        kind: "wait",
        duration_ms: Math.min(MACRO_MAX_WAIT_MS, Math.max(0, Number.isFinite(durationMs) ? durationMs : 0)),
      };
    }
    if (kind === "parallel") {
      const steps = (Array.isArray(step.steps) ? step.steps : [])
        .map((child) => normalizeMacroDraftActionStep(child))
        .slice(0, MACRO_MAX_PARALLEL_STEPS);
      return {
        kind: "parallel",
        steps: steps.length > 0 ? steps : [defaultMacroParallelActionStep()],
      };
    }
    return normalizeMacroDraftActionStep(step, { includeKind: true });
  }

  function normalizeMacroDraftSteps(steps) {
    return (Array.isArray(steps) ? steps : [])
      .map(normalizeMacroDraftStep)
      .filter(Boolean)
      .slice(0, MACRO_MAX_TOP_LEVEL_STEPS);
  }

  function prepareMacroDraftBinding(binding, { preservePlaceholders = false } = {}) {
    if (!binding || typeof binding !== "object") return;
    binding.action = "Macro";
    setTargets(binding, ["Macro"]);
    binding.hotkey = null;
    binding.open_application = null;
    binding.autohotkey_script = null;
    ensureMacroName(binding, { defaultIfBlank: preservePlaceholders });
    binding.macro_steps = preservePlaceholders
      ? normalizeMacroDraftSteps(binding.macro_steps)
      : normalizeMacroSteps(binding.macro_steps);
  }

  function clearMacroActionStep(step) {
    Object.keys(step).forEach((key) => delete step[key]);
    Object.assign(step, blankMacroActionStep());
  }

  function macroActionHasTarget(step) {
    return Array.isArray(step?.targets) && step.targets.some((target) => target && target !== "Unset" && !isMacroTarget(target));
  }

  function macroIntegrationTarget(step) {
    const targets = Array.isArray(step?.targets) ? step.targets : [];
    const target = targets.find((candidate) => candidate?.Integration || candidate?.integration);
    return target?.Integration || target?.integration || null;
  }

  function macroIntegrationActionLabel(step) {
    const stepLabel = String(step?.action_label || step?.actionLabel || "").trim();
    if (stepLabel) return stepLabel;
    const integration = macroIntegrationTarget(step);
    const data = integration?.data || {};
    const explicit = String(data.action_label || "").trim();
    if (explicit) return explicit;
    const buttonAction = String(data.button_action || data.action_value || data.action || "").trim();
    const normalized = buttonAction.toLowerCase().replace(/[-\s]+/g, "_");
    if (normalized === "turn_on" || normalized === "on") return "Turn On";
    if (normalized === "turn_off" || normalized === "off") return "Turn Off";
    if (normalized === "toggle" || normalized === "toggle_on_off") return "Toggle";
    const osdText = String(data.osd_value_text || "").trim().toUpperCase();
    if (osdText === "ON") return "Turn On";
    if (osdText === "OFF") return "Turn Off";
    return "";
  }

  function macroActionRole(step) {
    const role = String(step?.action_role || step?.actionRole || "").trim().toLowerCase();
    if (role) return role;
    if (String(step?.action || "") !== "Volume") return "";
    const integration = macroIntegrationTarget(step);
    if (!integration) return "value";
    const data = integration?.data || {};
    if (
      data.action_label
      || data.action_value
      || data.action_kind
      || data.button_action
      || data.osd_value_text
    ) {
      return "command";
    }
    return typeof step?.value === "number" ? "value" : "command";
  }

  function macroActionUsesValue(step) {
    if (String(step?.action || "") !== "Volume") return false;
    return macroActionRole(step) === "value";
  }

  function macroActionIsLegacyTriggerPlaceholder(step) {
    return String(step?.action || "") === "Volume"
      && !macroActionUsesValue(step)
      && !macroIntegrationActionLabel(step);
  }

  function macroActionTitle(action, step = null) {
    const explicit = String(step?.action_label || step?.actionLabel || "").trim();
    if (explicit && !(String(action || "") === "Volume" && macroActionUsesValue(step))) {
      return explicit;
    }
    switch (String(action || "")) {
      case "": return "Choose Action";
      case "Volume": return step && !macroActionUsesValue(step)
        ? (macroIntegrationActionLabel(step) || "Choose Action")
        : "Set Value";
      case "ToggleMute": return "Mute";
      case "ToggleEffect": return "State";
      case "SetMainOutputDevice": return "Trigger";
      case "SetDefaultDevice": return "Set Default Device";
      case "FocusWindow": return "Focus Window";
      case "FullScreenshot": return "Full Screenshot";
      case "SnipScreenshot": return "Snip";
      case "ToggleScreenRecording": return "Screen Recording";
      case "MediaPlayPause": return "Play/Pause";
      case "MediaNextTrack": return "Next Track";
      case "MediaPrevTrack": return "Previous Track";
      case "MediaStop": return "Stop";
      case "Hotkey": return "Hotkey";
      case "OpenApplication": return "Open App";
      case "RunAutoHotkeyScript": return "AutoHotkey";
      default: return String(action || "Action");
    }
  }

  function macroTargetTitle(step) {
    const targets = Array.isArray(step?.targets) ? step.targets : [];
    if (targets.length === 0) {
      return "No target selected";
    }
    if (step?.action === "Hotkey") {
      return step?.hotkey?.display || "Hotkey";
    }
    if (step?.action === "OpenApplication") {
      return step?.open_application?.display || step?.open_application?.path || "Application";
    }
    if (step?.action === "RunAutoHotkeyScript") {
      return step?.autohotkey_script?.display || step?.autohotkey_script?.path || "Script";
    }
    const display = resolveTargetDisplay(targets[0]);
    const label = String(display?.label || "").replace(/\s*\([^()]+\)\s*$/g, "").trim();
    if (targets.length > 1) return `${label || "Targets"} +${targets.length - 1}`;
    return label || "Target";
  }

  function macroStepSummary(step) {
    if (!step) return "";
    if (step.kind === "wait") {
      return t("macro.waitSummary", { duration: macroWaitDurationLabel(step) });
    }
    if (step.kind === "parallel") {
      const count = Array.isArray(step.steps) ? step.steps.length : 0;
      return t("macro.parallelSummary", { actions: macroActionCountLabel(count) });
    }
    if (!String(step.action || "").trim() || !macroActionHasTarget(step)) {
      return t("macro.chooseAction");
    }
    return `${macroActionTitle(step.action, step)} - ${macroTargetTitle(step)}`;
  }

  function macroWaitDurationLabel(step) {
    return `${((Number(step?.duration_ms) || 0) / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  }

  function macroActionCountLabel(count) {
    return t(count === 1 ? "macro.actionCountOne" : "macro.actionCountOther", { count });
  }

  function macroStepCountLabel(binding) {
    const count = normalizeMacroSteps(binding?.macro_steps).length;
    return t(count === 1 ? "macro.stepCountOne" : "macro.stepCountOther", { count });
  }

  function renderMacroSummary(binding) {
    const root = d.bindingConfigMacroSummary;
    if (!root) return;
    const steps = normalizeMacroSteps(binding?.macro_steps);
    root.innerHTML = "";

    const count = document.createElement("div");
    count.className = "binding-config-macro-summary-count";
    count.textContent = macroStepCountLabel(binding);
    root.appendChild(count);

    if (steps.length === 0) {
      const empty = document.createElement("div");
      empty.className = "binding-config-macro-summary-empty";
      empty.textContent = t("macro.noStepsConfigured");
      root.appendChild(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "binding-config-macro-summary-list";
    steps.slice(0, 4).forEach((step, index) => {
      const item = document.createElement("div");
      item.className = "binding-config-macro-summary-item";
      const number = document.createElement("span");
      number.className = "binding-config-macro-summary-number";
      number.textContent = String(index + 1);
      const label = document.createElement("span");
      label.className = "binding-config-macro-summary-label";
      label.textContent = macroStepSummary(step);
      item.appendChild(number);
      item.appendChild(label);
      list.appendChild(item);
    });
    if (steps.length > 4) {
      const more = document.createElement("div");
      more.className = "binding-config-macro-summary-more";
      more.textContent = t("macro.moreSteps", { count: steps.length - 4 });
      list.appendChild(more);
    }
    root.appendChild(list);
  }

  function macroPathKey(path) {
    if (!path) return "";
    return path.type === "parallel"
      ? `parallel:${path.groupIndex}:${path.index}`
      : `top:${path.index}`;
  }

  function macroPathsEqual(a, b) {
    return macroPathKey(a) === macroPathKey(b);
  }

  function macroPathForFirstStep(binding) {
    const steps = Array.isArray(binding?.macro_steps) ? binding.macro_steps : [];
    return steps.length > 0 ? { type: "top", index: 0 } : null;
  }

  function normalizeMacroSelectedPath(binding, preferred = configMacroSelectedPath) {
    const steps = Array.isArray(binding?.macro_steps) ? binding.macro_steps : [];
    if (steps.length === 0) {
      configMacroSelectedPath = null;
      return null;
    }
    const path = preferred || { type: "top", index: 0 };
    if (path.type === "parallel") {
      const groupIndex = Math.min(Math.max(Number(path.groupIndex) || 0, 0), steps.length - 1);
      const group = steps[groupIndex];
      if (group?.kind === "parallel" && Array.isArray(group.steps) && group.steps.length > 0) {
        configMacroSelectedPath = {
          type: "parallel",
          groupIndex,
          index: Math.min(Math.max(Number(path.index) || 0, 0), group.steps.length - 1),
        };
        return configMacroSelectedPath;
      }
    }
    configMacroSelectedPath = {
      type: "top",
      index: Math.min(Math.max(Number(path.index) || 0, 0), steps.length - 1),
    };
    return configMacroSelectedPath;
  }

  function getMacroStepAtPath(binding, path = configMacroSelectedPath) {
    const steps = Array.isArray(binding?.macro_steps) ? binding.macro_steps : [];
    const normalized = normalizeMacroSelectedPath(binding, path);
    if (!normalized) return null;
    if (normalized.type === "parallel") {
      return steps[normalized.groupIndex]?.steps?.[normalized.index] || null;
    }
    return steps[normalized.index] || null;
  }

  function scrollSelectedMacroStepIntoView() {
    if (!configMacroPendingSelectedScroll) return;
    configMacroPendingSelectedScroll = false;
    const section = d.bindingConfigMacroSection;
    requestAnimationFrame(() => {
      const selected = section?.querySelector?.(".binding-config-macro-step-card.is-selected");
      if (!selected) return;
      const reduceMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
      selected.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
    });
  }

  function findMacroPathForStep(steps, stepRef) {
    if (!stepRef || !Array.isArray(steps)) return null;
    for (let index = 0; index < steps.length; index += 1) {
      if (steps[index] === stepRef) return { type: "top", index };
      if (steps[index]?.kind === "parallel" && Array.isArray(steps[index].steps)) {
        const childIndex = steps[index].steps.findIndex((child) => child === stepRef);
        if (childIndex >= 0) return { type: "parallel", groupIndex: index, index: childIndex };
      }
    }
    return null;
  }

  function macroStepOrdinalLabel(path) {
    if (!path) return "";
    return path.type === "parallel"
      ? `${(Number(path.groupIndex) || 0) + 1}.${(Number(path.index) || 0) + 1}`
      : `${(Number(path.index) || 0) + 1}`;
  }

  function createBindingConfigButton(id, text, variant = "secondary") {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = `binding-config-button binding-config-button--${variant}`;
    button.textContent = text;
    return button;
  }

  function wireMacroButton(button, handler) {
    if (!button || button.__macroConfigBound) return;
    button.__macroConfigBound = true;
    button.addEventListener("click", handler);
  }

  function wireMacroConfigControls() {
    wireMacroButton(d.bindingConfigBack, (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMacroConfigPage();
    });
    wireMacroButton(d.bindingConfigMacroAddAction, () => {
      updateMacroDraft((steps) => {
        if (steps.length >= MACRO_MAX_TOP_LEVEL_STEPS) return;
        steps.push(defaultMacroActionStep());
        configMacroSelectedPath = { type: "top", index: steps.length - 1 };
      }, { scrollSelected: true });
    });
    wireMacroButton(d.bindingConfigMacroAddWait, () => {
      updateMacroDraft((steps) => {
        if (steps.length >= MACRO_MAX_TOP_LEVEL_STEPS) return;
        steps.push(defaultMacroWaitStep());
        configMacroSelectedPath = { type: "top", index: steps.length - 1 };
      }, { scrollSelected: true });
    });
    wireMacroButton(d.bindingConfigMacroAddParallel, () => {
      updateMacroDraft((steps) => {
        if (steps.length >= MACRO_MAX_TOP_LEVEL_STEPS) return;
        steps.push(defaultMacroParallelStep());
        configMacroSelectedPath = { type: "top", index: steps.length - 1 };
      }, { scrollSelected: true });
    });
    wireMacroButton(d.bindingConfigMacroEdit, (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMacroConfigPage();
    });
  }

  function ensureMacroConfigDom() {
    const panel = d.bindingConfigPanel;
    const main = panel?.querySelector?.(".binding-config-main-column");
    const header = panel?.querySelector?.(".target-panel-header");

    if (panel) {
      d.bindingConfigBack ||= panel.querySelector("#binding-config-back");
      d.bindingConfigMacroSummarySection ||= panel.querySelector("#binding-config-macro-summary-section");
      d.bindingConfigMacroSummary ||= panel.querySelector("#binding-config-macro-summary");
      d.bindingConfigMacroEdit ||= panel.querySelector("#binding-config-macro-edit");
      d.bindingConfigMacroSection ||= panel.querySelector("#binding-config-macro-section");
      d.bindingConfigMacroList ||= panel.querySelector("#binding-config-macro-list");
      d.bindingConfigMacroAddAction ||= panel.querySelector("#binding-config-macro-add-action");
      d.bindingConfigMacroAddWait ||= panel.querySelector("#binding-config-macro-add-wait");
      d.bindingConfigMacroAddParallel ||= panel.querySelector("#binding-config-macro-add-parallel");
    }

    if (!d.bindingConfigBack && header) {
      const back = document.createElement("button");
      back.id = "binding-config-back";
      back.type = "button";
      back.className = "target-panel-back binding-config-back hidden";
      back.setAttribute("aria-label", t("common.back"));
      back.dataset.i18nAriaLabel = "common.back";
      back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6" /></svg>';
      header.insertBefore(back, d.bindingConfigTitle || header.firstChild);
      d.bindingConfigBack = back;
    }

    if (main && !d.bindingConfigMacroSummarySection) {
      const summarySection = document.createElement("section");
      summarySection.id = "binding-config-macro-summary-section";
      summarySection.className = "binding-config-section binding-config-section--macro-summary hidden";

      const titleRow = document.createElement("div");
      titleRow.className = "binding-config-title-row";
      const title = document.createElement("span");
      title.className = "binding-config-title";
      title.textContent = t("macro.title");
      title.dataset.i18n = "macro.title";
      const actions = document.createElement("div");
      actions.className = "binding-config-title-actions";
      const edit = createBindingConfigButton("binding-config-macro-edit", t("macro.edit"), "primary");
      edit.dataset.i18n = "macro.edit";
      actions.appendChild(edit);
      titleRow.appendChild(title);
      titleRow.appendChild(actions);

      const summary = document.createElement("div");
      summary.id = "binding-config-macro-summary";
      summary.className = "binding-config-macro-summary";
      summarySection.appendChild(titleRow);
      summarySection.appendChild(summary);

      main.insertBefore(summarySection, d.bindingConfigCurveSection || null);
      d.bindingConfigMacroSummarySection = summarySection;
      d.bindingConfigMacroSummary = summary;
      d.bindingConfigMacroEdit = edit;
    }

    if (main && !d.bindingConfigMacroSection) {
      const macroSection = document.createElement("section");
      macroSection.id = "binding-config-macro-section";
      macroSection.className = "binding-config-section binding-config-section--macro hidden";

      const titleRow = document.createElement("div");
      titleRow.className = "binding-config-title-row";
      const title = document.createElement("span");
      title.className = "binding-config-title";
      title.textContent = t("macro.title");
      title.dataset.i18n = "macro.title";
      const actions = document.createElement("div");
      actions.className = "binding-config-title-actions";
      const addAction = createBindingConfigButton("binding-config-macro-add-action", t("macro.step.action"));
      const addWait = createBindingConfigButton("binding-config-macro-add-wait", t("macro.step.wait"));
      const addParallel = createBindingConfigButton("binding-config-macro-add-parallel", t("macro.step.parallelGroup"));
      addAction.dataset.i18n = "macro.step.action";
      addWait.dataset.i18n = "macro.step.wait";
      addParallel.dataset.i18n = "macro.step.parallelGroup";
      actions.appendChild(addAction);
      actions.appendChild(addWait);
      actions.appendChild(addParallel);
      titleRow.appendChild(title);
      titleRow.appendChild(actions);

      const list = document.createElement("div");
      list.id = "binding-config-macro-list";
      list.className = "binding-config-macro-list";
      macroSection.appendChild(titleRow);
      macroSection.appendChild(list);

      main.insertBefore(macroSection, d.bindingConfigCurveSection || null);
      d.bindingConfigMacroSection = macroSection;
      d.bindingConfigMacroList = list;
      d.bindingConfigMacroAddAction = addAction;
      d.bindingConfigMacroAddWait = addWait;
      d.bindingConfigMacroAddParallel = addParallel;
    }

    wireMacroConfigControls();
  }

  function openMacroConfigPage() {
    const binding = getConfigBinding();
    if (!binding || binding.action !== "Macro") return;
    ensureMacroConfigDom();
    prepareMacroDraftBinding(binding, { preservePlaceholders: true });
    normalizeMacroSelectedPath(binding, configMacroSelectedPath || macroPathForFirstStep(binding));
    configMacroPageOpen = true;
    renderConfigModal();
  }

  function closeMacroConfigPage() {
    configMacroPageOpen = false;
    configMacroSelectedPath = null;
    renderConfigModal();
  }

  function updateMacroDraft(mutator, options = {}) {
    const binding = getConfigBinding();
    if (!binding || binding.action !== "Macro") return;
    const steps = Array.isArray(binding.macro_steps) ? binding.macro_steps : [];
    mutator(steps);
    binding.macro_steps = normalizeMacroDraftSteps(steps);
    normalizeMacroSelectedPath(binding, options.selectPath || configMacroSelectedPath);
    if (options.scrollSelected) configMacroPendingSelectedScroll = true;
    renderMacroEditor(binding);
    renderConfigPreview();
  }

  function commitMacroDraftEdit(binding, { rerender = true } = {}) {
    if (!binding || binding.action !== "Macro") return;
    binding.macro_steps = normalizeMacroDraftSteps(binding.macro_steps);
    normalizeMacroSelectedPath(binding);
    if (rerender) renderMacroEditor(binding);
    renderConfigPreview();
  }

  function setMacroActionFromTargetSelect(step, targetSelect, previous = {}) {
    const selectedTargets = Array.isArray(targetSelect.__selectedTargets)
      ? targetSelect.__selectedTargets
      : (targetSelect.__selectedTarget ? [targetSelect.__selectedTarget] : []);
    if (selectedTargets.some(isMacroTarget) || targetSelect.dataset.action === "Macro") {
      Object.assign(step, previous);
      return false;
    }
    const usableTargets = selectedTargets.filter((target) => target && target !== "Unset" && !isMacroTarget(target));
    if (usableTargets.length === 0) {
      clearMacroActionStep(step);
      return true;
    }

    const hasHotkeyTarget = usableTargets.some(isHotkeyTarget);
    const hasOpenApplicationTarget = usableTargets.some(isOpenApplicationTarget);
    const hasAutoHotkeyScriptTarget = usableTargets.some(isAutoHotkeyScriptTarget);
    step.targets = usableTargets;
    step.action = hasHotkeyTarget
      ? "Hotkey"
      : hasOpenApplicationTarget
        ? "OpenApplication"
        : hasAutoHotkeyScriptTarget
          ? "RunAutoHotkeyScript"
          : (targetSelect.dataset.action || step.action || "ToggleMute");

    const usesDirectUtilityTarget = hasHotkeyTarget || hasOpenApplicationTarget || hasAutoHotkeyScriptTarget;
    const actionRole = usesDirectUtilityTarget ? "" : String(targetSelect.dataset.actionRole || "").trim().toLowerCase();
    const actionLabel = usesDirectUtilityTarget ? "" : String(targetSelect.dataset.actionLabel || "").trim();
    const valueKind = usesDirectUtilityTarget ? "" : String(targetSelect.dataset.valueKind || "").trim();
    if (actionRole) step.action_role = actionRole;
    else delete step.action_role;
    if (actionLabel) step.action_label = actionLabel;
    else delete step.action_label;
    if (valueKind) step.value_kind = valueKind;
    else delete step.value_kind;
    if (step.action === "Volume" && step.action_role === "value") {
      step.value = Math.min(1, Math.max(0, Number(step.value ?? previous.value ?? 1)));
    } else {
      delete step.value;
    }

    step.hotkey = step.action === "Hotkey" ? normalizeHotkeyMapping(step.hotkey) : null;
    step.open_application = step.action === "OpenApplication"
      ? normalizeOpenApplicationMapping(targetSelect?.getOpenApplication?.() || targetSelect?.__openApplication)
      : null;
    step.autohotkey_script = step.action === "RunAutoHotkeyScript"
      ? normalizeAutoHotkeyScriptMapping(targetSelect?.getAutoHotkeyScript?.() || targetSelect?.__autoHotkeyScript)
      : null;
    step.state = normalizeMacroActionState(step.state || (step.action === "ToggleMute" || step.action === "ToggleEffect" ? "Toggle" : "Default"));
    return true;
  }

  function sameMacroTargets(a = [], b = []) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((target, index) => JSON.stringify(target) === JSON.stringify(b[index]));
  }

  function setMacroActionTargetFromTargetSelect(step, targetSelect, previous = {}) {
    const selectedTargets = Array.isArray(targetSelect.__selectedTargets)
      ? targetSelect.__selectedTargets
      : (targetSelect.__selectedTarget ? [targetSelect.__selectedTarget] : []);
    if (selectedTargets.some(isMacroTarget) || targetSelect.dataset.action === "Macro") {
      Object.assign(step, previous);
      return false;
    }
    const usableTargets = selectedTargets.filter((target) => target && target !== "Unset" && !isMacroTarget(target));
    if (usableTargets.length === 0) {
      clearMacroActionStep(step);
      return true;
    }

    const targetChanged = !sameMacroTargets(previous.targets || [], usableTargets);
    const hasHotkeyTarget = usableTargets.some(isHotkeyTarget);
    const hasOpenApplicationTarget = usableTargets.some(isOpenApplicationTarget);
    const hasAutoHotkeyScriptTarget = usableTargets.some(isAutoHotkeyScriptTarget);
    step.targets = usableTargets;
    if (targetChanged && !hasHotkeyTarget && !hasOpenApplicationTarget && !hasAutoHotkeyScriptTarget) {
      step.action = "";
      delete step.action_role;
      delete step.action_label;
      delete step.value_kind;
      delete step.value;
      step.state = "Default";
      step.hotkey = null;
      step.open_application = null;
      step.autohotkey_script = null;
      return true;
    }

    if (hasHotkeyTarget) {
      step.action = "Hotkey";
      step.hotkey = normalizeHotkeyMapping(step.hotkey);
    } else if (hasOpenApplicationTarget) {
      step.action = "OpenApplication";
      step.open_application = normalizeOpenApplicationMapping(
        targetSelect?.getOpenApplication?.() || targetSelect?.__openApplication,
      );
    } else if (hasAutoHotkeyScriptTarget) {
      step.action = "RunAutoHotkeyScript";
      step.autohotkey_script = normalizeAutoHotkeyScriptMapping(
        targetSelect?.getAutoHotkeyScript?.() || targetSelect?.__autoHotkeyScript,
      );
    }
    return true;
  }

  function applyMacroActionOptionToStep(step, actionOption, targetSelect = null) {
    if (!step || !actionOption) return;
    const action = String(actionOption.value || "");
    step.action = action;
    const role = String(actionOption.role || actionOption.action_role || "").trim().toLowerCase();
    const label = String(actionOption.label || "").trim();
    const valueKind = String(actionOption.value_kind || actionOption.valueKind || "").trim();
    if (role) step.action_role = role;
    else delete step.action_role;
    if (label && role !== "value") step.action_label = label;
    else delete step.action_label;
    if (valueKind) step.value_kind = valueKind;
    else delete step.value_kind;
    if (action === "Volume" && role === "value") {
      step.value = Math.min(1, Math.max(0, Number(step.value ?? 1)));
    } else {
      delete step.value;
    }
    step.state = normalizeMacroActionState(step.state || (action === "ToggleMute" || action === "ToggleEffect" ? "Toggle" : "Default"));
    step.hotkey = action === "Hotkey" ? normalizeHotkeyMapping(step.hotkey) : null;
    step.open_application = action === "OpenApplication"
      ? normalizeOpenApplicationMapping(targetSelect?.getOpenApplication?.() || targetSelect?.__openApplication || step.open_application)
      : null;
    step.autohotkey_script = action === "RunAutoHotkeyScript"
      ? normalizeAutoHotkeyScriptMapping(targetSelect?.getAutoHotkeyScript?.() || targetSelect?.__autoHotkeyScript || step.autohotkey_script)
      : null;
  }

  function buildMacroStateSelect(step, onChange) {
    const select = document.createElement("select");
    select.className = "binding-config-macro-select";
    const isMute = step.action === "ToggleMute";
    const options = isMute
      ? [
        ["Toggle", "Toggle"],
        ["Mute", "Mute"],
        ["Unmute", "Unmute"],
      ]
      : [
        ["Toggle", "Toggle"],
        ["On", "On"],
        ["Off", "Off"],
      ];
    options.forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    });
    select.value = options.some(([value]) => value === step.state) ? step.state : "Toggle";
    select.addEventListener("change", () => {
      step.state = select.value;
      onChange({ rerender: false });
    });
    return select;
  }

  function buildMacroActionControls(step, onChange) {
    const controls = document.createElement("div");
    controls.className = "binding-config-macro-controls";

    if (!String(step.action || "").trim() || !macroActionHasTarget(step)) {
      return controls;
    }

    if (macroActionUsesValue(step)) {
      const label = document.createElement("label");
      label.className = "binding-config-macro-number";
      const text = document.createElement("span");
      text.textContent = "Value";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = "100";
      input.step = "1";
      input.value = String(Math.round(Math.min(1, Math.max(0, Number(step.value ?? 1))) * 100));
      input.addEventListener("input", () => {
        step.value = Math.min(1, Math.max(0, (Number(input.value) || 0) / 100));
        onChange({ rerender: false });
      });
      label.appendChild(text);
      label.appendChild(input);
      const suffix = document.createElement("span");
      suffix.textContent = "%";
      label.appendChild(suffix);
      controls.appendChild(label);
    }

    if (step.action === "ToggleMute" || step.action === "ToggleEffect") {
      controls.appendChild(buildMacroStateSelect(step, onChange));
    }

    if (step.action === "Hotkey") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "binding-config-button binding-config-button--secondary";
      button.textContent = step.hotkey?.display ? "Change Hotkey" : "Learn Hotkey";
      button.addEventListener("click", async () => {
        const binding = getConfigBinding();
        const learned = await startHotkeyLearn({ id: `${binding?.id || "macro"}-hotkey` });
        if (!learned) return;
        step.hotkey = learned;
        onChange({ rerender: true });
      });
      controls.appendChild(button);
    }

    return controls;
  }

  function moveMacroItem(items, fromIndex, toIndex) {
    if (!Array.isArray(items)) return;
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) return;
    const [moved] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, moved);
  }

  function macroDragItemSelector(type) {
    return type === "parallel" ? ".binding-config-macro-action" : ".binding-config-macro-step";
  }

  function macroDragContainerForItem(item, dragInfo) {
    if (!item || !dragInfo) return null;
    if (dragInfo.type === "parallel") {
      return item.closest(".binding-config-macro-parallel-children");
    }
    return d.bindingConfigMacroList;
  }

  function macroPlaceholderIndex(state = macroDragState) {
    if (!state?.container || !state?.placeholder) return null;
    let index = 0;
    for (const child of state.container.children) {
      if (child === state.placeholder) return index;
      if (child.matches?.(state.itemSelector)) {
        index += 1;
      }
    }
    return null;
  }

  function cleanupMacroDragState({ reorder = false } = {}) {
    const state = macroDragState;
    if (!state) return;
    const newIndex = reorder && state.active ? macroPlaceholderIndex(state) : null;
    macroDragState = null;
    state.item.style.display = "";
    state.item.classList.remove("is-dragging");
    state.ghost.remove();
    if (state.active) {
      state.placeholder.remove();
    }
    document.body.classList.remove("dragging-binding");

    if (!reorder || !state.active || newIndex === null || newIndex === state.index) {
      return;
    }

    const insertIndex = newIndex > state.index ? newIndex - 1 : newIndex;
    const binding = getConfigBinding();
    const selectedStepRef = getMacroStepAtPath(binding);
    updateMacroDraft((draftSteps) => {
      if (state.type === "top") {
        moveMacroItem(draftSteps, state.index, insertIndex);
      } else {
        const group = draftSteps[state.groupIndex];
        if (!group || !Array.isArray(group.steps)) return;
        moveMacroItem(group.steps, state.index, insertIndex);
      }
      configMacroSelectedPath = findMacroPathForStep(draftSteps, selectedStepRef) || configMacroSelectedPath;
    });
  }

  function cancelMacroDrag() {
    cleanupMacroDragState();
  }

  function endMacroDrag() {
    cleanupMacroDragState({ reorder: true });
  }

  function startMacroDrag(item, dragInfo, event) {
    if (!item || !dragInfo || event.button !== 0) return;
    const container = macroDragContainerForItem(item, dragInfo);
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = item.getBoundingClientRect();
    const ghost = item.cloneNode(true);
    ghost.classList.add("binding-config-macro-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.opacity = "0";

    const placeholder = document.createElement("div");
    placeholder.className = "binding-config-macro-placeholder";
    placeholder.style.height = `${rect.height}px`;

    document.body.appendChild(ghost);
    macroDragState = {
      ...dragInfo,
      item,
      container,
      ghost,
      placeholder,
      itemSelector: macroDragItemSelector(dragInfo.type),
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };

    item.classList.add("is-dragging");
    document.body.classList.add("dragging-binding");
  }

  function updateMacroDrag(event) {
    const state = macroDragState;
    if (!state) return;

    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    if (!state.active) {
      if (Math.hypot(deltaX, deltaY) < 6) {
        return;
      }
      state.active = true;
      state.item.style.display = "none";
      state.container.insertBefore(state.placeholder, state.item.nextSibling);
      state.ghost.style.opacity = "0.85";
    }

    state.ghost.style.left = `${event.clientX - state.offsetX}px`;
    state.ghost.style.top = `${event.clientY - state.offsetY}px`;

    const target = document.elementFromPoint(event.clientX, event.clientY);
    const macroItem = target?.closest?.(state.itemSelector);
    if (!macroItem || macroItem === state.item || macroItem.parentElement !== state.container) {
      return;
    }

    const rect = macroItem.getBoundingClientRect();
    const insertBefore = event.clientY < rect.top + rect.height / 2;
    const reference = insertBefore ? macroItem : macroItem.nextSibling;
    if (reference !== state.placeholder) {
      state.container.insertBefore(state.placeholder, reference);
    }
  }

  function createMacroDragHandle(label, dragInfo) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "binding-config-macro-drag";
    handle.title = label;
    handle.setAttribute("aria-label", label);
    const grip = document.createElement("span");
    grip.className = "drag-grip";
    grip.setAttribute("aria-hidden", "true");
    handle.appendChild(grip);
    handle.addEventListener("pointerdown", (event) => {
      const item = handle.closest(macroDragItemSelector(dragInfo?.type));
      handle.setPointerCapture?.(event.pointerId);
      startMacroDrag(item, dragInfo, event);
    });
    handle.addEventListener("pointerup", (event) => {
      handle.releasePointerCapture?.(event.pointerId);
    });
    return handle;
  }

  function renderMacroActionEditor({
    parent,
    binding,
    step,
    indexLabel,
    dragHandle = null,
    canMoveUp = false,
    canMoveDown = false,
    onChange,
    onMoveUp = null,
    onMoveDown = null,
    onDuplicate = null,
    onDelete = null,
  }) {
    const row = document.createElement("div");
    row.className = "binding-config-macro-action";

    const header = document.createElement("div");
    header.className = "binding-config-macro-row-header";
    if (dragHandle) {
      header.classList.add("has-drag-handle");
      header.appendChild(dragHandle);
    }
    const title = document.createElement("span");
    title.className = "binding-config-macro-row-title";
    title.textContent = t("macro.actionLabelWithIndex", { index: indexLabel });
    const summary = document.createElement("span");
    summary.className = "binding-config-macro-row-summary";
    summary.textContent = macroStepSummary(step);
    header.appendChild(title);
    header.appendChild(summary);
    row.appendChild(header);

    const targetSelect = buildTarget(
      step.targets,
      true,
      step.action || "",
      step.hotkey?.display || "",
      step.open_application || null,
      step.autohotkey_script || null,
      {
        allowEmptyInitial: true,
        excludeMacroTarget: true,
        includeValueAction: true,
        overConfigModal: true,
        currentActionRole: step.action_role || "",
        currentActionLabel: step.action_label || "",
        currentValueKind: step.value_kind || "",
      },
    );
    targetSelect.addEventListener("change", async () => {
      const previous = clonePlain(step);
      const changed = setMacroActionFromTargetSelect(step, targetSelect, previous);
      if (!changed) {
        onChange({ rerender: true });
        return;
      }
      const newlyHotkey = step.action === "Hotkey" && !previous.hotkey;
      if (newlyHotkey) {
        const learned = await startHotkeyLearn({ id: `${binding.id}-macro-${indexLabel}` });
        if (learned) {
          step.hotkey = learned;
        } else {
          Object.assign(step, previous);
        }
      }
      onChange({ rerender: true });
    });
    row.appendChild(targetSelect);
    row.appendChild(buildMacroActionControls(step, onChange));

    const actions = document.createElement("div");
    actions.className = "binding-config-macro-row-actions";
    [
      ["Up", canMoveUp, onMoveUp],
      ["Down", canMoveDown, onMoveDown],
      ["Duplicate", Boolean(onDuplicate), onDuplicate],
      ["Delete", Boolean(onDelete), onDelete],
    ].forEach(([label, enabled, handler]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "binding-config-button binding-config-button--secondary";
      button.textContent = label;
      button.disabled = !enabled;
      button.addEventListener("click", () => handler?.());
      actions.appendChild(button);
    });
    row.appendChild(actions);
    parent.appendChild(row);
  }

  function macroSelectablePaths(binding) {
    const steps = Array.isArray(binding?.macro_steps) ? binding.macro_steps : [];
    const paths = [];
    steps.forEach((step, index) => {
      paths.push({ type: "top", index });
      if (step?.kind === "parallel" && Array.isArray(step.steps)) {
        step.steps.forEach((_child, childIndex) => {
          paths.push({ type: "parallel", groupIndex: index, index: childIndex });
        });
      }
    });
    return paths;
  }

  function macroPathListIndex(binding, path) {
    const key = macroPathKey(path);
    return macroSelectablePaths(binding).findIndex((candidate) => macroPathKey(candidate) === key);
  }

  function macroStepTitle(step) {
    if (step?.kind === "wait") return t("macro.step.wait");
    if (step?.kind === "parallel") return t("macro.step.parallelGroup");
    return t("macro.step.action");
  }

  function macroStepMeta(step) {
    if (step?.kind === "wait") return macroWaitDurationLabel(step) || t("macro.zeroMs");
    if (step?.kind === "parallel") {
      const count = Array.isArray(step.steps) ? step.steps.length : 0;
      return macroActionCountLabel(count);
    }
    if (!macroActionHasTarget(step)) return t("macro.selectTarget");
    if (!String(step.action || "").trim()) return `${macroTargetTitle(step)} -> ${t("macro.chooseAction")}`;
    const suffix = macroActionUsesValue(step) && typeof step.value === "number"
      ? ` -> ${Math.round(step.value * 100)}%`
      : "";
    return `${macroTargetTitle(step)} -> ${macroActionTitle(step.action, step)}${suffix}`;
  }

  function macroIconSvg(kind) {
    if (kind === "wait") return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8"></circle><path d="M12 7v5l3 2"></path></svg>';
    if (kind === "parallel") return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 4 7 4-7 4-7-4 7-4Z"></path><path d="m5 12 7 4 7-4"></path><path d="m5 16 7 4 7-4"></path></svg>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12h3M17 12h3M8 7v10M12 5v14M16 8v8"></path></svg>';
  }

  function createMacroIconButton(label, svg) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "binding-config-macro-icon-button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = svg;
    return button;
  }

  function duplicateMacroStep(path) {
    updateMacroDraft((steps) => {
      if (path.type === "parallel") {
        const group = steps[path.groupIndex];
        if (!group || !Array.isArray(group.steps) || group.steps.length >= MACRO_MAX_PARALLEL_STEPS) return;
        group.steps.splice(path.index + 1, 0, clonePlain(group.steps[path.index]));
        configMacroSelectedPath = { type: "parallel", groupIndex: path.groupIndex, index: path.index + 1 };
        return;
      }
      if (steps.length >= MACRO_MAX_TOP_LEVEL_STEPS) return;
      steps.splice(path.index + 1, 0, clonePlain(steps[path.index]));
      configMacroSelectedPath = { type: "top", index: path.index + 1 };
    }, { scrollSelected: true });
  }

  function deleteMacroStep(path) {
    updateMacroDraft((steps) => {
      if (path.type === "parallel") {
        const group = steps[path.groupIndex];
        if (!group || !Array.isArray(group.steps)) return;
        group.steps.splice(path.index, 1);
        if (group.steps.length === 0) {
          steps.splice(path.groupIndex, 1);
          configMacroSelectedPath = { type: "top", index: Math.max(0, Math.min(path.groupIndex, steps.length - 1)) };
        } else {
          configMacroSelectedPath = {
            type: "parallel",
            groupIndex: path.groupIndex,
            index: Math.max(0, Math.min(path.index, group.steps.length - 1)),
          };
        }
        return;
      }
      steps.splice(path.index, 1);
      configMacroSelectedPath = steps.length > 0
        ? { type: "top", index: Math.max(0, Math.min(path.index, steps.length - 1)) }
        : null;
    });
  }

  function positionMacroOverflowMenu(menu, button) {
    if (!menu || !button || menu.classList.contains("hidden")) return;
    menu.classList.remove("is-open-up");
    const scrollContainer = menu.closest(".binding-config-macro-timeline")
      || menu.closest(".binding-config-macro-steps-panel");
    if (!scrollContainer) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const menuHeight = menu.offsetHeight || 72;
    const availableBelow = containerRect.bottom - buttonRect.bottom - 6;
    const availableAbove = buttonRect.top - containerRect.top - 6;
    if (availableBelow < menuHeight && availableAbove > availableBelow) {
      menu.classList.add("is-open-up");
    }
  }

  function renderMacroOverflow(row, path) {
    const wrap = document.createElement("div");
    wrap.className = "binding-config-macro-overflow";
    const button = createMacroIconButton("Step actions", '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="5" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><circle cx="12" cy="19" r="1.5"></circle></svg>');
    const menu = document.createElement("div");
    menu.className = "binding-config-macro-overflow-menu hidden";
    [
      {
        label: "Duplicate",
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 15V7a2 2 0 0 1 2-2h8"></path></svg>',
        handler: () => duplicateMacroStep(path),
      },
      {
        label: "Delete",
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"></path><path d="M9 7V4h6v3"></path></svg>',
        danger: true,
        handler: () => deleteMacroStep(path),
      },
    ].forEach(({ label, icon, danger = false, handler }) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = danger ? "is-danger" : "";
      const iconEl = document.createElement("span");
      iconEl.className = "binding-config-macro-menu-icon";
      iconEl.innerHTML = icon;
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      item.appendChild(iconEl);
      item.appendChild(labelEl);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        menu.classList.add("hidden");
        handler();
      });
      menu.appendChild(item);
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const opening = menu.classList.contains("hidden");
      d.bindingConfigMacroSection?.querySelectorAll(".binding-config-macro-overflow-menu").forEach((existing) => {
        if (existing !== menu) {
          existing.classList.add("hidden");
          existing.classList.remove("is-open-up");
        }
      });
      menu.classList.toggle("hidden", !opening);
      if (opening) {
        requestAnimationFrame(() => positionMacroOverflowMenu(menu, button));
      } else {
        menu.classList.remove("is-open-up");
      }
    });
    wrap.appendChild(button);
    wrap.appendChild(menu);
    return wrap;
  }

  function renderMacroStepCard(parent, binding, step, path, { child = false } = {}) {
    const row = document.createElement("div");
    row.className = child ? "binding-config-macro-action binding-config-macro-step-card" : "binding-config-macro-step binding-config-macro-step-card";
    row.classList.toggle("is-selected", macroPathsEqual(path, configMacroSelectedPath));
    row.dataset.path = macroPathKey(path);
    row.addEventListener("click", (event) => {
      if (event.target?.closest?.(".binding-config-macro-drag, .binding-config-macro-overflow, .binding-config-macro-overflow-menu")) return;
      configMacroSelectedPath = path;
      renderMacroEditor(binding);
    });

    const dragInfo = child
      ? { type: "parallel", groupIndex: path.groupIndex, index: path.index }
      : { type: "top", index: path.index };
    row.appendChild(createMacroDragHandle(child ? "Drag parallel action" : "Drag step", dragInfo));

    const number = document.createElement("button");
    number.type = "button";
    number.className = "binding-config-macro-step-number";
    number.textContent = macroStepOrdinalLabel(path);
    number.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      configMacroSelectedPath = path;
      renderMacroEditor(binding);
    });
    row.appendChild(number);

    const icon = document.createElement("span");
    icon.className = `binding-config-macro-step-icon binding-config-macro-step-icon--${step?.kind || "action"}`;
    icon.innerHTML = macroIconSvg(step?.kind || "action");
    row.appendChild(icon);

    const copy = document.createElement("div");
    copy.className = "binding-config-macro-step-copy";
    const title = document.createElement("span");
    title.className = "binding-config-macro-row-title";
    title.textContent = macroStepTitle(step);
    const meta = document.createElement("span");
    meta.className = "binding-config-macro-row-summary";
    meta.textContent = macroStepMeta(step);
    copy.appendChild(title);
    copy.appendChild(meta);
    row.appendChild(copy);

    row.appendChild(renderMacroOverflow(row, path));
    parent.appendChild(row);
  }

  function createMacroField(labelText) {
    const field = document.createElement("label");
    field.className = "binding-config-macro-property-field";
    const label = document.createElement("span");
    label.className = "binding-config-macro-property-label";
    label.textContent = labelText;
    field.appendChild(label);
    return field;
  }

  function macroActionOptionMatchesStep(option, step) {
    if (!option || !step) return false;
    if (String(option.value || "") !== String(step.action || "")) return false;
    if (String(step.action || "") === "Volume") {
      return String(option.role || "") === macroActionRole(step);
    }
    const stepLabel = String(step.action_label || "").trim();
    return !stepLabel || String(option.label || "").trim() === stepLabel;
  }

  function macroActionOptionBadge(option) {
    const role = String(option?.role || "").trim().toLowerCase();
    if (role === "value") return { text: "Value", kind: "mix" };
    if (role === "state") return { text: "State", kind: "state" };
    return null;
  }

  function renderMacroActionOptionLabel(container, option, placeholder = t("macro.chooseAction")) {
    if (!container) return;
    container.innerHTML = "";
    if (!option) {
      const label = document.createElement("span");
      label.className = "target-placeholder";
      label.textContent = placeholder;
      container.appendChild(label);
      return;
    }
    renderLabelWithBadges(container, {
      text: option.label || option.value || t("macro.step.action"),
      badges: [macroActionOptionBadge(option)].filter(Boolean),
      truncate: true,
    });
  }

  function renderMacroActionTypeDropdown(slot, {
    options = [],
    selectedOption = null,
    disabled = false,
    placeholder = t("macro.chooseAction"),
    emptyLabel = t("macro.noActionsAvailable"),
    onSelect = null,
  } = {}) {
    if (!slot) return;
    slot.innerHTML = "";

    const root = document.createElement("div");
    root.className = "target-dropdown binding-config-macro-action-dropdown";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "target-button";
    button.disabled = disabled;
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const display = document.createElement("span");
    display.className = "target-display";
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "\u25be";
    button.appendChild(display);
    button.appendChild(caret);

    const menu = document.createElement("div");
    menu.className = "target-menu hidden";
    menu.setAttribute("role", "listbox");

    renderMacroActionOptionLabel(display, selectedOption, placeholder);

    if (!disabled && options.length > 0) {
      options.forEach((option) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "target-option";
        item.setAttribute("role", "option");
        if (macroActionOptionMatchesStep(option, { action: selectedOption?.value, action_role: selectedOption?.role, action_label: selectedOption?.label })) {
          item.classList.add("selected");
          item.setAttribute("aria-selected", "true");
        }
        const label = document.createElement("span");
        label.className = "target-label";
        renderMacroActionOptionLabel(label, option);
        item.appendChild(label);
        item.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          root.classList.remove("open");
          menu.classList.add("hidden");
          button.setAttribute("aria-expanded", "false");
          onSelect?.(option);
        });
        menu.appendChild(item);
      });
    } else {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "target-option is-disabled";
      empty.disabled = true;
      empty.textContent = disabled ? placeholder : emptyLabel;
      menu.appendChild(empty);
    }

    root.__positionDropdownMenu = () => {
      positionFloatingDropdownMenu({
        menu,
        trigger: button,
        minHeight: 120,
        maxHeight: 260,
      });
    };

    if (!disabled) {
      wireDropdownToggle({ root, menu, trigger: button });
    }
    root.appendChild(button);
    root.appendChild(menu);
    slot.appendChild(root);
  }

  function renderMacroActionProperties(panel, binding, step, path) {
    const targetField = createMacroField(t("macro.target"));
    const targetSelect = buildTarget(
      step.targets,
      true,
      step.action || "",
      step.hotkey?.display || "",
      step.open_application || null,
      step.autohotkey_script || null,
      {
        allowEmptyInitial: true,
        excludeMacroTarget: true,
        includeValueAction: true,
        includeWindowFocusAction: true,
        overConfigModal: true,
        targetOnly: true,
        suppressActionTags: true,
        currentActionRole: step.action_role || "",
        currentActionLabel: step.action_label || "",
        currentValueKind: step.value_kind || "",
      },
    );
    targetSelect.addEventListener("change", async () => {
      const previous = clonePlain(step);
      const changed = setMacroActionTargetFromTargetSelect(step, targetSelect, previous);
      if (!changed) {
        commitMacroDraftEdit(binding);
        return;
      }
      const newlyHotkey = step.action === "Hotkey" && !previous.hotkey;
      if (newlyHotkey) {
        const learned = await startHotkeyLearn({ id: `${binding.id}-macro-${macroStepOrdinalLabel(path)}` });
        if (learned) step.hotkey = learned;
        else Object.assign(step, previous);
      }
      commitMacroDraftEdit(binding);
    });
    targetField.appendChild(targetSelect);
    panel.appendChild(targetField);

    const actionField = createMacroField(t("macro.actionType"));
    const hasTarget = macroActionHasTarget(step);
    const actionSlot = document.createElement("div");
    actionSlot.className = "binding-config-macro-action-type-slot";
    renderMacroActionTypeDropdown(actionSlot, {
      disabled: true,
      placeholder: hasTarget ? t("macro.loadingActions") : t("macro.selectTargetFirst"),
    });
    actionField.appendChild(actionSlot);
    panel.appendChild(actionField);

    if (hasTarget) {
      targetSelect.getActionOptions?.().then((loadedOptions = []) => {
        if (!actionSlot.isConnected) return;
        const options = [...loadedOptions];
        if (
          step.action
          && !macroActionIsLegacyTriggerPlaceholder(step)
          && !options.some((option) => macroActionOptionMatchesStep(option, step))
        ) {
          options.unshift({
            label: macroActionTitle(step.action, step),
            value: step.action,
            kind: "action",
            role: macroActionRole(step) || "command",
            value_kind: step.value_kind || "",
          });
        }
        renderMacroActionTypeDropdown(actionSlot, {
          options,
          selectedOption: options.find((option) => macroActionOptionMatchesStep(option, step)) || null,
          disabled: options.length === 0,
          placeholder: options.length === 0 ? t("macro.noActionsAvailable") : t("macro.chooseAction"),
          onSelect: (option) => {
            targetSelect.setActionOption?.(option, false);
            const selectedTargets = Array.isArray(targetSelect.__selectedTargets)
              ? targetSelect.__selectedTargets.filter((target) => target && target !== "Unset" && !isMacroTarget(target))
              : [];
            if (selectedTargets.length > 0) step.targets = selectedTargets;
            applyMacroActionOptionToStep(step, option, targetSelect);
            commitMacroDraftEdit(binding);
          },
        });
      }).catch(() => {
        if (actionSlot.isConnected) {
          renderMacroActionTypeDropdown(actionSlot, {
            disabled: true,
            placeholder: t("macro.noActionsAvailable"),
          });
        }
      });
    }

    if (macroActionUsesValue(step)) {
      const valueField = createMacroField(t("macro.value"));
      const control = document.createElement("div");
      control.className = "binding-config-macro-value-editor";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = "100";
      input.step = "1";
      input.value = String(Math.round(Math.min(1, Math.max(0, Number(step.value ?? 1))) * 100));
      const suffix = document.createElement("span");
      suffix.textContent = "%";
      const range = document.createElement("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.step = "1";
      range.value = input.value;
      const syncValue = (raw) => {
        const value = Math.min(100, Math.max(0, Number(raw) || 0));
        input.value = String(Math.round(value));
        range.value = String(Math.round(value));
        step.value = value / 100;
        commitMacroDraftEdit(binding, { rerender: false });
      };
      input.addEventListener("input", () => syncValue(input.value));
      range.addEventListener("input", () => syncValue(range.value));
      input.addEventListener("change", () => renderMacroEditor(binding));
      range.addEventListener("change", () => renderMacroEditor(binding));
      control.appendChild(input);
      control.appendChild(suffix);
      valueField.appendChild(control);
      valueField.appendChild(range);
      panel.appendChild(valueField);
    }

    if (step.action === "ToggleMute" || step.action === "ToggleEffect") {
      const stateField = createMacroField(t("macro.state"));
      stateField.appendChild(buildMacroStateSelect(step, () => commitMacroDraftEdit(binding)));
      panel.appendChild(stateField);
    }

    if (step.action === "Hotkey") {
      const hotkeyButton = createBindingConfigButton("", step.hotkey?.display ? t("macro.changeHotkey") : t("macro.learnHotkey"), "secondary");
      hotkeyButton.addEventListener("click", async () => {
        const learned = await startHotkeyLearn({ id: `${binding.id}-macro-${macroStepOrdinalLabel(path)}` });
        if (!learned) return;
        step.hotkey = learned;
        commitMacroDraftEdit(binding);
      });
      panel.appendChild(hotkeyButton);
    }
  }

  function renderMacroWaitProperties(panel, binding, step) {
    const secondsField = createMacroField(t("macro.seconds"));
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "60";
    input.step = "0.1";
    input.value = String((Number(step.duration_ms) || 0) / 1000);
    input.addEventListener("input", () => {
      step.duration_ms = Math.min(MACRO_MAX_WAIT_MS, Math.max(0, Math.round((Number(input.value) || 0) * 1000)));
      commitMacroDraftEdit(binding, { rerender: false });
    });
    input.addEventListener("change", () => renderMacroEditor(binding));
    secondsField.appendChild(input);
    panel.appendChild(secondsField);
  }

  function renderMacroParallelProperties(panel, binding, step, path) {
    const count = Array.isArray(step.steps) ? step.steps.length : 0;
    const summary = document.createElement("div");
    summary.className = "binding-config-macro-info-box";
    summary.textContent = t(
      count === 1 ? "macro.parallelInfoOne" : "macro.parallelInfoOther",
      { count },
    );
    panel.appendChild(summary);
    const addChild = createBindingConfigButton("", t("macro.addAction"), "secondary");
    addChild.disabled = count >= MACRO_MAX_PARALLEL_STEPS;
    addChild.addEventListener("click", () => updateMacroDraft((steps) => {
      const group = steps[path.index];
      if (!group || group.kind !== "parallel") return;
      group.steps = Array.isArray(group.steps) ? group.steps : [];
      if (group.steps.length >= MACRO_MAX_PARALLEL_STEPS) return;
      group.steps.push(defaultMacroParallelActionStep());
      configMacroSelectedPath = { type: "parallel", groupIndex: path.index, index: group.steps.length - 1 };
    }, { scrollSelected: true }));
    panel.appendChild(addChild);
  }

  function renderMacroProperties(panel, binding) {
    panel.innerHTML = "";
    const path = normalizeMacroSelectedPath(binding);
    const step = getMacroStepAtPath(binding, path);
    const paths = macroSelectablePaths(binding);

    const header = document.createElement("div");
    header.className = "binding-config-macro-properties-header";
    const title = document.createElement("span");
    title.textContent = t("macro.stepProperties");
    const nav = document.createElement("div");
    nav.className = "binding-config-macro-properties-nav";
    const currentIndex = macroPathListIndex(binding, path);
    const position = document.createElement("span");
    position.textContent = currentIndex >= 0
      ? t("macro.stepPosition", { current: currentIndex + 1, total: paths.length })
      : t("macro.noStep");
    const prev = createMacroIconButton(t("macro.previousStep"), '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 6-6 6 6 6"></path></svg>');
    const next = createMacroIconButton(t("macro.nextStep"), '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6"></path></svg>');
    prev.disabled = currentIndex <= 0;
    next.disabled = currentIndex < 0 || currentIndex >= paths.length - 1;
    prev.addEventListener("click", () => {
      configMacroSelectedPath = paths[currentIndex - 1];
      renderMacroEditor(binding);
    });
    next.addEventListener("click", () => {
      configMacroSelectedPath = paths[currentIndex + 1];
      renderMacroEditor(binding);
    });
    nav.appendChild(position);
    nav.appendChild(prev);
    nav.appendChild(next);
    header.appendChild(title);
    header.appendChild(nav);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "binding-config-macro-properties-body";
    if (!step) {
      const empty = document.createElement("div");
      empty.className = "binding-config-macro-empty";
      empty.textContent = t("macro.addStepToConfigure");
      body.appendChild(empty);
      panel.appendChild(body);
      return;
    }

    const type = document.createElement("div");
    type.className = "binding-config-macro-selected-type";
    type.innerHTML = `<span class="binding-config-macro-step-icon binding-config-macro-step-icon--${step.kind || "action"}">${macroIconSvg(step.kind || "action")}</span><span>${macroStepTitle(step)} ${macroStepOrdinalLabel(path)}</span>`;
    body.appendChild(type);
    if (step.kind === "wait") renderMacroWaitProperties(body, binding, step, path);
    else if (step.kind === "parallel") renderMacroParallelProperties(body, binding, step, path);
    else renderMacroActionProperties(body, binding, step, path);
    panel.appendChild(body);
  }

  function renderMacroEditor(binding) {
    const section = d.bindingConfigMacroSection;
    if (!section) return;
    prepareMacroDraftBinding(binding, { preservePlaceholders: true });
    normalizeMacroSelectedPath(binding, configMacroSelectedPath || macroPathForFirstStep(binding));
    section.innerHTML = "";

    const shell = document.createElement("div");
    shell.className = "binding-config-macro-designer";

    const header = document.createElement("div");
    header.className = "binding-config-macro-designer-header";
    const nameField = document.createElement("label");
    nameField.className = "binding-config-macro-name-field";
    const nameLabel = document.createElement("span");
    nameLabel.textContent = t("macro.name");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 80;
    nameInput.value = ensureMacroName(binding, { defaultIfBlank: true });
    nameInput.addEventListener("input", () => {
      binding.macro_name = normalizeMacroName(nameInput.value);
      renderConfigPreview();
    });
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);
    header.appendChild(nameField);

    const addGroup = document.createElement("div");
    addGroup.className = "binding-config-macro-add-group";
    const addLabel = document.createElement("span");
    addLabel.className = "binding-config-macro-add-label";
    addLabel.textContent = t("macro.addStep");
    addGroup.appendChild(addLabel);

    const addActions = document.createElement("div");
    addActions.className = "binding-config-title-actions binding-config-macro-add-actions";
    [
      [t("macro.addAction"), defaultMacroActionStep],
      [t("macro.addWait"), defaultMacroWaitStep],
      [t("macro.addParallel"), defaultMacroParallelStep],
    ].forEach(([label, factory]) => {
      const button = createBindingConfigButton("", label, "secondary");
      button.disabled = binding.macro_steps.length >= MACRO_MAX_TOP_LEVEL_STEPS;
      button.addEventListener("click", () => updateMacroDraft((steps) => {
        if (steps.length >= MACRO_MAX_TOP_LEVEL_STEPS) return;
        steps.push(factory());
        configMacroSelectedPath = { type: "top", index: steps.length - 1 };
      }, { scrollSelected: true }));
      addActions.appendChild(button);
    });
    addGroup.appendChild(addActions);
    header.appendChild(addGroup);
    shell.appendChild(header);

    const body = document.createElement("div");
    body.className = "binding-config-macro-designer-body";
    const stepsPanel = document.createElement("div");
    stepsPanel.className = "binding-config-macro-steps-panel";
    const stepsTitle = document.createElement("div");
    stepsTitle.className = "binding-config-macro-panel-title";
    const titleText = document.createElement("span");
    titleText.textContent = t("macro.steps");
    const count = document.createElement("span");
    count.className = "binding-config-macro-count";
    count.textContent = String(binding.macro_steps.length);
    stepsTitle.appendChild(titleText);
    stepsTitle.appendChild(count);
    stepsPanel.appendChild(stepsTitle);
    const list = document.createElement("div");
    list.id = "binding-config-macro-list";
    list.className = "binding-config-macro-list binding-config-macro-timeline";
    d.bindingConfigMacroList = list;

    binding.macro_steps.forEach((step, index) => {
      const path = { type: "top", index };
      renderMacroStepCard(list, binding, step, path);
      if (step.kind === "parallel" && Array.isArray(step.steps) && step.steps.length > 0) {
        const children = document.createElement("div");
        children.className = "binding-config-macro-parallel-children";
        step.steps.forEach((child, childIndex) => {
          renderMacroStepCard(children, binding, child, { type: "parallel", groupIndex: index, index: childIndex }, { child: true });
        });
        list.appendChild(children);
      }
    });
    if (binding.macro_steps.length === 0) {
      const empty = document.createElement("div");
      empty.className = "binding-config-macro-empty-state";
      empty.textContent = t("macro.noStepsYet");
      list.appendChild(empty);
    }
    stepsPanel.appendChild(list);

    const propertiesPanel = document.createElement("div");
    propertiesPanel.className = "binding-config-macro-properties-panel";
    renderMacroProperties(propertiesPanel, binding);

    body.appendChild(stepsPanel);
    body.appendChild(propertiesPanel);
    shell.appendChild(body);
    section.appendChild(shell);
    scrollSelectedMacroStepIntoView();
  }

  function stopHotkeyLearn(result = null) {
    if (hotkeyLearnCleanup) {
      hotkeyLearnCleanup();
      hotkeyLearnCleanup = null;
    }
    hotkeyLearnBindingId = null;
    hideLearnPanel();
    return result;
  }

  async function startHotkeyLearn(binding) {
    if (!binding || transferPrompt || configLearnField || hotkeyLearnBindingId) {
      return null;
    }

    hotkeyLearnBindingId = binding.id;
    if (d.learnPanelTitle) d.learnPanelTitle.textContent = t("bindings.pressHotkey");
    if (d.learnPanelMessage) {
      d.learnPanelMessage.textContent = t("bindings.pressHotkeyMessage");
    }
    if (d.learnPanelSpinner) d.learnPanelSpinner.classList.add("hidden");
    if (d.learnPanelActions) d.learnPanelActions.classList.remove("hidden");
    if (d.learnPanelCancel) d.learnPanelCancel.textContent = t("common.cancel");
    if (d.learnPanelConfirm) d.learnPanelConfirm.classList.add("hidden");
    showLearnPanel();

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (mapping) => {
        if (settled) return;
        settled = true;
        stopHotkeyLearn(mapping);
        resolve(mapping);
      };

      const onCancel = () => finish(null);
      const onOverlay = (event) => {
        if (event.target === d.learnPanel) finish(null);
      };
      const onKeydown = (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (event.key === "Escape") {
          finish(null);
          return;
        }

        const mapping = buildHotkeyMappingFromEvent(event);
        if (!mapping) return;
        finish(mapping);
      };

      window.addEventListener("keydown", onKeydown, true);
      d.learnPanelCancel?.addEventListener("click", onCancel);
      d.learnPanelClose?.addEventListener("click", onCancel);
      d.learnPanel?.addEventListener("click", onOverlay);

      hotkeyLearnCleanup = () => {
        window.removeEventListener("keydown", onKeydown, true);
        d.learnPanelCancel?.removeEventListener("click", onCancel);
        d.learnPanelClose?.removeEventListener("click", onCancel);
        d.learnPanel?.removeEventListener("click", onOverlay);
      };
    });
  }

  function updateAuxLearnUi() {
    const muteLearn = d.bindingConfigMuteLearn;
    const assignLearn = d.bindingConfigAssignLearn;
    const indicatorLearn = d.bindingConfigIndicatorLearn;
    const feedbackLearn = d.bindingConfigFeedbackLearn;
    const muteClear = d.bindingConfigMuteClear;
    const assignClear = d.bindingConfigAssignClear;
    const indicatorClear = d.bindingConfigIndicatorClear;
    const feedbackClear = d.bindingConfigFeedbackClear;
    const previewLearnButton = d.bindingConfigPreviewLearnButton;
    const buttonLearnButton = d.bindingConfigButtonLearnButton;
    const transferLocked = Boolean(transferPrompt);
    const learningPrimary = configLearnField === "control";
    const binding = getConfigBinding();
    const isButton = effectiveIsButton(binding);

    if (muteLearn) {
      const active = configLearnField === "mute_control";
      const label = active ? t("bindings.listening") : t("common.learn");
      muteLearn.classList.toggle("is-learning", active);
      muteLearn.title = label;
      muteLearn.setAttribute("aria-label", label);
      muteLearn.disabled = transferLocked || Boolean(configLearnField && !active);
    }
    if (assignLearn) {
      const active = configLearnField === "assign_control";
      const label = active ? t("bindings.listening") : t("common.learn");
      assignLearn.classList.toggle("is-learning", active);
      assignLearn.title = label;
      assignLearn.setAttribute("aria-label", label);
      assignLearn.disabled = transferLocked || Boolean(configLearnField && !active);
    }
    if (indicatorLearn) {
      const active = configLearnField === "indicator_control";
      const label = active ? t("bindings.listening") : t("bindings.learnIndicatorOutput");
      indicatorLearn.classList.toggle("is-learning", active);
      indicatorLearn.title = label;
      indicatorLearn.setAttribute("aria-label", label);
      indicatorLearn.disabled = transferLocked || Boolean(configLearnField && !active);
    }
    if (feedbackLearn) {
      const active = configLearnField === "indicator_control";
      const label = active ? t("bindings.listening") : t("bindings.learnFeedbackOutput");
      feedbackLearn.classList.toggle("is-learning", active);
      feedbackLearn.title = label;
      feedbackLearn.setAttribute("aria-label", label);
      feedbackLearn.disabled = transferLocked || Boolean(configLearnField && !active);
    }

    const lockClear = transferLocked || Boolean(configLearnField);
    if (muteClear) muteClear.disabled = lockClear;
    if (assignClear) assignClear.disabled = lockClear;
    if (indicatorClear) indicatorClear.disabled = lockClear;
    if (feedbackClear) feedbackClear.disabled = lockClear;
    if (d.bindingConfigIndicatorMsgType) d.bindingConfigIndicatorMsgType.disabled = lockClear;
    if (d.bindingConfigIndicatorChannel) d.bindingConfigIndicatorChannel.disabled = lockClear;
    if (d.bindingConfigIndicatorController) d.bindingConfigIndicatorController.disabled = lockClear;
    if (d.bindingConfigFeedbackMsgType) d.bindingConfigFeedbackMsgType.disabled = lockClear;
    if (d.bindingConfigFeedbackChannel) d.bindingConfigFeedbackChannel.disabled = lockClear;
    syncFeedbackControllerInputState(lockClear);
    if (d.bindingConfigMuteModeButton) d.bindingConfigMuteModeButton.disabled = lockClear;
    if (d.bindingConfigAssignModeButton) d.bindingConfigAssignModeButton.disabled = lockClear;
    for (const learnButton of [previewLearnButton, buttonLearnButton]) {
      if (!learnButton) continue;
      const label = isButton ? t("bindings.learnButton") : t("bindings.learnFader");
      learnButton.classList.remove("is-learning");
      learnButton.textContent = label;
      learnButton.title = label;
      learnButton.setAttribute("aria-label", label);
      learnButton.disabled = transferLocked || Boolean(configLearnField && !learningPrimary);
    }
  }

  function stopAuxLearn(options = {}) {
    const closePanel = options.closePanel !== false;
    if (configLearnTimer) {
      clearInterval(configLearnTimer);
      configLearnTimer = null;
    }
    configLearnField = null;
    updateAuxLearnUi();
    renderConfigPreview();
    if (closePanel) {
      hideLearnPanel();
    }
  }

  function formatMidiControlLabel(control) {
    if (!control) return "Not mapped";
    const msg = control.msg_type === "PitchBend"
      ? "PB"
      : (control.msg_type === "Note" ? "Note" : (control.msg_type === "ProgramChange" ? "Program" : "CC"));
    return `Ch ${control.channel} ${msg} ${control.controller}`;
  }

  function renderMidiMappingSummary(element, deviceId, control, controlText) {
    if (!element) return;
    element.innerHTML = "";
    if (!control) {
      element.textContent = t("bindings.notMapped");
      return;
    }

    const deviceLabel = labelForMidiDevice(deviceId) || String(deviceId || "").trim();
    const wrapper = document.createElement("span");
    wrapper.className = "binding-config-midi-stack";
    wrapper.title = deviceLabel ? `${deviceLabel} - ${controlText}` : controlText;

    const device = document.createElement("span");
    device.className = "binding-config-midi-device";
    device.textContent = deviceLabel || t("bindings.notMapped");

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
    if (!d.bindingConfigAssignLabel) return;
    const mode = binding?.assign_mode === "Replace" ? "Replace" : "Add";
    const mappingText = formatMidiControlLabel(binding?.assign_control);
    d.bindingConfigAssignLabel.innerHTML = "";

    const main = document.createElement("span");
    main.className = "binding-config-label-main";
    main.textContent = mappingText;

    const badge = document.createElement("span");
    badge.className = "binding-config-inline-badge";
    badge.textContent = mode;
    badge.title = assignModeTooltip(mode);
    badge.setAttribute("aria-label", badge.title);

    d.bindingConfigAssignLabel.appendChild(main);
    d.bindingConfigAssignLabel.appendChild(badge);
  }

  function renderMuteMappingLabel(binding) {
    if (!d.bindingConfigMuteLabel) return;
    const behavior = muteBehaviorLabel(binding?.mute_control?.mute_behavior || binding?.mute_behavior);
    const mappingText = formatMidiControlLabel(binding?.mute_control);
    d.bindingConfigMuteLabel.innerHTML = "";

    const main = document.createElement("span");
    main.className = "binding-config-label-main";
    main.textContent = mappingText;

    const badge = document.createElement("span");
    badge.className = "binding-config-inline-badge";
    badge.textContent = behavior;
    badge.title = muteBehaviorTooltip(binding?.mute_control?.mute_behavior || binding?.mute_behavior);
    badge.setAttribute("aria-label", badge.title);

    d.bindingConfigMuteLabel.appendChild(main);
    d.bindingConfigMuteLabel.appendChild(badge);
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

  function controlsEqual(a, b) {
    if (!a || !b) return false;
    return String(a.device_id || "") === String(b.device_id || "")
      && Number(a.channel) === Number(b.channel)
      && Number(a.controller) === Number(b.controller)
      && String(a.msg_type || "ControlChange") === String(b.msg_type || "ControlChange");
  }

  function getConfigBinding() {
    return configDraft;
  }

  function cloneBindingsList(list) {
    return (Array.isArray(list) ? list : [])
      .map((binding) => cloneBindingDraft(binding))
      .filter(Boolean);
  }

  function rememberConfigPreviewOriginalBindings() {
    if (!configPreviewOriginalBindings) {
      configPreviewOriginalBindings = cloneBindingsList(getB());
    }
  }

  function bindingSnapshotKey(binding) {
    try {
      return JSON.stringify(binding);
    } catch {
      return "";
    }
  }

  function applyPrimaryPreviewFields(baseBinding, draftBinding) {
    const next = cloneBindingDraft(baseBinding) || cloneBindingDraft(draftBinding);
    if (!next || !draftBinding) return next;
    next.device_id = draftBinding.device_id;
    next.control = draftBinding.control && typeof draftBinding.control === "object"
      ? { ...draftBinding.control }
      : draftBinding.control;
    next.control_kind = normalizeControlKind(draftBinding.control_kind);
    next.mode = draftBinding.mode === "Relative" ? "Relative" : "Absolute";
    next.relative_format = normalizeRelativeFormat(draftBinding.relative_format);
    if (Number.isFinite(Number(draftBinding.deadzone))) {
      next.deadzone = Number(draftBinding.deadzone);
    }
    if (Number.isFinite(Number(draftBinding.debounce_ms))) {
      next.debounce_ms = Number(draftBinding.debounce_ms);
    }
    ensureBindingShape(next);
    return next;
  }

  function applyPreviewConflict(nextBindings, conflict) {
    if (!conflict?.binding?.id || !conflict.field) return nextBindings;
    const conflictId = conflict.binding.id;
    if (conflict.field === "control") {
      return nextBindings.filter((binding) => binding.id !== conflictId);
    }
    return nextBindings.map((binding) => {
      if (binding.id !== conflictId) return binding;
      const next = cloneBindingDraft(binding);
      next[conflict.field] = null;
      return next;
    });
  }

  function buildPrimaryControlPreviewBindings() {
    const draft = getConfigBinding();
    if (!draft || !configBindingId) return null;
    rememberConfigPreviewOriginalBindings();
    let nextBindings = cloneBindingsList(configPreviewOriginalBindings);
    for (const entry of configAcceptedTransfers.values()) {
      if (entry.field === "control") {
        nextBindings = applyPreviewConflict(nextBindings, entry.conflict);
      }
    }
    const bindingIndex = nextBindings.findIndex((binding) => binding.id === configBindingId);
    if (bindingIndex < 0) return null;
    nextBindings[bindingIndex] = applyPrimaryPreviewFields(nextBindings[bindingIndex], draft);
    return nextBindings;
  }

  async function persistBindingsDiff(previousBindings, nextBindings, reason) {
    const previous = cloneBindingsList(previousBindings);
    const next = cloneBindingsList(nextBindings);
    const nextById = new Map(next.map((binding) => [binding.id, binding]));
    const previousById = new Map(previous.map((binding) => [binding.id, binding]));

    for (const binding of previous) {
      if (!nextById.has(binding.id)) {
        await invoke("remove_binding", { binding });
      }
    }

    for (const binding of next) {
      const previousBinding = previousById.get(binding.id);
      if (!previousBinding || bindingSnapshotKey(previousBinding) !== bindingSnapshotKey(binding)) {
        await persistBindingBackend(binding);
      }
    }
  }

  async function applyPrimaryControlPreview() {
    const nextBindings = buildPrimaryControlPreviewBindings();
    if (!nextBindings) return;
    const previousBindings = cloneBindingsList(getB());
    setB(cloneBindingsList(nextBindings));
    renderBindings();
    syncPluginHostBindings();
    try {
      await persistBindingsDiff(previousBindings, nextBindings, "control preview");
    } catch (err) {
      console.error("Failed to apply control preview:", err);
    }
  }

  async function restoreConfigPreviewBindings() {
    if (!configPreviewOriginalBindings) return;
    const previousBindings = cloneBindingsList(getB());
    const restoredBindings = cloneBindingsList(configPreviewOriginalBindings);
    setB(restoredBindings);
    renderBindings();
    syncPluginHostBindings();
    try {
      await persistBindingsDiff(previousBindings, restoredBindings, "control preview rollback");
    } catch (err) {
      console.error("Failed to restore control preview:", err);
    }
  }

  function stopConfigPreviewTimer() {
    if (!configPreviewTimer) return;
    cancelAnimationFrame(configPreviewTimer);
    configPreviewTimer = null;
  }

  function startConfigPreviewTimer() {
    stopConfigPreviewTimer();
    const tick = () => {
      if (!configBindingId || !getConfigBinding()) {
        stopConfigPreviewTimer();
        return;
      }
      renderConfigPreview();
      configPreviewTimer = requestAnimationFrame(tick);
    };
    configPreviewTimer = requestAnimationFrame(tick);
  }

  function parseDisplayTags(rawLabel) {
    const label = String(rawLabel || "");
    const tags = [];
    const matchAll = label.match(/\(([^()]+)\)/g) || [];
    matchAll.forEach((tag) => {
      const text = tag.replace(/[()]/g, "").trim();
      if (text) tags.push(text);
    });
    return tags;
  }

  function renderPreviewTarget(binding) {
    const target = getPrimaryTarget(binding);
    const display = resolveTargetDisplay(target) || { label: "Target", icon_data: null };
    if (d.bindingConfigPreviewTargetLabel) {
      const baseLabel = String(display.label || "Target").replace(/\s*\([^()]+\)/g, "").trim();
      d.bindingConfigPreviewTargetLabel.textContent = baseLabel || "Target";
    }
    if (d.bindingConfigPreviewTargetTags) {
      d.bindingConfigPreviewTargetTags.innerHTML = "";
      parseDisplayTags(display.label).forEach((tag) => {
        const badge = document.createElement("span");
        badge.className = "binding-config-preview-tag";
        badge.textContent = tag;
        d.bindingConfigPreviewTargetTags.appendChild(badge);
      });
    }
    if (d.bindingConfigPreviewTargetIcon) {
      d.bindingConfigPreviewTargetIcon.innerHTML = "";
      const icon = iconForTarget(display);
      if (icon) d.bindingConfigPreviewTargetIcon.appendChild(icon);
    }
  }

  function renderConfigPreview() {
    const binding = getConfigBinding();
    if (!binding) return;
    const bindingId = configBindingId;
    const isButton = effectiveIsButton(binding);
    const target = getPrimaryTarget(binding);
    const liveMidiValue = getLiveMidiValue(binding.device_id, binding.control);
    const mappedLightValue = mappedButtonLightFeedbackValue(binding);
    const storedBindingValue = bindingId != null && bindingLastValues[bindingId] != null
      ? Number(bindingLastValues[bindingId])
      : null;
    const targetVolume = getVol(target);
    const resolvedVolume = resolveBindingVolumeValue({
      bindingId,
      targetVolume,
      cachedVolume: storedBindingValue,
      interactionTimes: bindingInteractionTimes,
    });
    const liveValue = liveMidiValue != null
      ? applyCurveToNormalized(binding, liveMidiValue)
      : (resolvedVolume.value ?? 0);
    const muted = bindingId != null && bindingMuteValues[bindingId] != null
      ? Boolean(bindingMuteValues[bindingId])
      : Boolean(getMuted(target));
    const visualBehavior = buttonVisualBehavior(binding);
    const buttonActive = isButton
      ? (mappedLightValue != null ? mappedLightValue > 0.5 : resolveButtonVisualActive(binding, {
          inputValue: liveMidiValue != null
            ? liveMidiValue
            : (visualBehavior === "momentary" ? storedBindingValue : null),
          stateValue: visualBehavior === "stateful" && binding.action !== "ToggleMute"
            ? storedBindingValue
            : null,
          muted,
          fallbackMuted: muted,
        }))
      : false;
    const previewValue = isButton
      ? (buttonActive ? 1 : 0)
      : Math.min(1, Math.max(0, Number(liveValue) || 0));
    const fillPercent = Math.round(Math.min(1, Math.max(0, previewValue)) * 100);
    const learningPrimary = configLearnField === "control";

    renderPreviewTarget(binding);
    const faderPreview = d.bindingConfigPreviewFill?.closest?.(".binding-config-preview-fader");
    if (faderPreview) {
      faderPreview.classList.toggle("hidden", isButton);
      faderPreview.setAttribute("aria-hidden", String(isButton));
    }
    if (d.bindingConfigPreviewButton) {
      d.bindingConfigPreviewButton.classList.toggle("hidden", !isButton);
      d.bindingConfigPreviewButton.setAttribute("aria-hidden", String(!isButton));
    }
    if (d.bindingConfigPreviewButtonFace) {
      d.bindingConfigPreviewButtonFace.classList.toggle("is-active", buttonActive);
      d.bindingConfigPreviewButtonFace.classList.toggle("is-mapped", mappedLightValue != null && mappedLightValue > 0.5);
    }
    if (d.bindingConfigPreviewButtonLabel) {
      d.bindingConfigPreviewButtonLabel.textContent = buttonActive ? t("bindings.on") : t("bindings.off");
    }
    if (d.bindingConfigPreviewValue) {
      d.bindingConfigPreviewValue.textContent = isButton
        ? (buttonActive ? t("bindings.on") : t("bindings.off"))
        : `${fillPercent}%`;
    }
    if (d.bindingConfigPreviewFill) d.bindingConfigPreviewFill.style.height = `${fillPercent}%`;
    if (d.bindingConfigPreviewThumb) d.bindingConfigPreviewThumb.style.bottom = `calc(${fillPercent}% - 18px)`;
    renderMidiMappingSummary(
      d.bindingConfigPreviewMainMidi,
      binding.device_id,
      binding.control,
      labelForControl(binding.control || {}),
    );
    if (d.bindingConfigPreviewMuteRow) d.bindingConfigPreviewMuteRow.classList.toggle("hidden", isButton);
    if (d.bindingConfigPreviewAssignRow) d.bindingConfigPreviewAssignRow.classList.toggle("hidden", isButton);
    if (d.bindingConfigPreviewCurveRow) d.bindingConfigPreviewCurveRow.classList.toggle("hidden", isButton);
    renderMidiMappingSummary(
      d.bindingConfigPreviewMute,
      binding.mute_control?.device_id,
      binding.mute_control,
      formatMidiControlLabel(binding.mute_control),
    );
    renderMidiMappingSummary(
      d.bindingConfigPreviewAssign,
      binding.assign_control?.device_id,
      binding.assign_control,
      formatMidiControlLabel(binding.assign_control),
    );
    if (d.bindingConfigPreviewCurve) d.bindingConfigPreviewCurve.textContent = curveDisplayName(binding.fader_curve);
    if (d.bindingConfigPreviewMidiValue) {
      d.bindingConfigPreviewMidiValue.textContent = formatPreviewMidiValue(binding, previewValue, liveMidiValue);
    }
    if (d.bindingConfigPreviewStatus) {
      if (learningPrimary) {
        d.bindingConfigPreviewStatus.textContent = isButton
          ? t("bindings.waitingForNewButtonInput")
          : t("bindings.waitingForNewFaderInput");
      } else if (isButton && mappedLightValue != null && mappedLightValue > 0.5) {
        d.bindingConfigPreviewStatus.textContent = t("bindings.mappedLightOn");
      } else if (muted) {
        d.bindingConfigPreviewStatus.textContent = t("bindings.targetMuted");
      } else if ((bindingId != null && bindingLastValues[bindingId] != null) || liveMidiValue != null) {
        d.bindingConfigPreviewStatus.textContent = t("bindings.receivingLiveFeedback");
      } else {
        d.bindingConfigPreviewStatus.textContent = t("bindings.waitingForLiveInput");
      }
    }
    if (d.bindingConfigPreviewLearnIndicator) {
      d.bindingConfigPreviewLearnIndicator.classList.add("hidden");
      d.bindingConfigPreviewLearnIndicator.classList.remove("is-learning");
    }
    if (d.bindingConfigPreviewLearnStatus) {
      d.bindingConfigPreviewLearnStatus.textContent = t("bindings.waitingMidiInput");
    }
    if (d.bindingConfigButtonLearnIndicator) {
      d.bindingConfigButtonLearnIndicator.classList.add("hidden");
      d.bindingConfigButtonLearnIndicator.classList.remove("is-learning");
    }
    if (d.bindingConfigButtonLearnStatus) {
      d.bindingConfigButtonLearnStatus.textContent = t("bindings.waitingMidiInput");
    }
  }

  function currentCurvePresets() {
    return normalizeFaderCurvePresets(getCurvePresets());
  }

  function activeCustomCurvePreset(binding = getConfigBinding()) {
    const presets = currentCurvePresets();
    const selected = presets.find((preset) => preset.id === selectedCustomCurvePresetId);
    if (
      selected
      && normalizeFaderCurve(binding?.fader_curve) === "Custom"
      && curvePresetPointsEqual(binding?.custom_curve, selected.points)
    ) {
      return selected;
    }
    return findMatchingFaderCurvePreset(binding, presets);
  }

  function setCurvePresetMenuOpen(open) {
    curvePresetMenuOpen = Boolean(open);
    if (d.bindingConfigCurvePresetMenu) {
      d.bindingConfigCurvePresetMenu.classList.toggle("hidden", !curvePresetMenuOpen);
    }
    if (d.bindingConfigCurvePresetButton) {
      d.bindingConfigCurvePresetButton.setAttribute("aria-expanded", String(curvePresetMenuOpen));
    }
    if (curvePresetMenuOpen) {
      renderCurvePresetMenu();
      requestAnimationFrame(() => d.bindingConfigCurvePresetSearch?.focus?.({ preventScroll: true }));
    }
  }

  function closeCurvePresetMenu() {
    setCurvePresetMenuOpen(false);
  }

  function closeCurvePresetForm() {
    curvePresetFormMode = null;
    curvePresetFormPresetId = null;
    if (d.bindingConfigCurvePresetForm) {
      d.bindingConfigCurvePresetForm.classList.add("hidden");
    }
  }

  function openCurvePresetForm(mode, preset = null) {
    curvePresetFormMode = mode === "rename" ? "rename" : "save";
    curvePresetFormPresetId = preset?.id || null;
    if (d.bindingConfigCurvePresetForm) {
      d.bindingConfigCurvePresetForm.classList.remove("hidden");
      d.bindingConfigCurvePresetForm.dataset.mode = curvePresetFormMode;
    }
    if (d.bindingConfigCurvePresetFormTitle) {
      d.bindingConfigCurvePresetFormTitle.textContent = curvePresetFormMode === "rename"
        ? t("bindings.curvePresetRenameTitle")
        : t("bindings.curvePresetSaveTitle");
    }
    if (d.bindingConfigCurvePresetName) {
      d.bindingConfigCurvePresetName.value = preset?.name || nextCurvePresetName(currentCurvePresets());
      requestAnimationFrame(() => {
        d.bindingConfigCurvePresetName?.focus?.({ preventScroll: true });
        d.bindingConfigCurvePresetName?.select?.();
      });
    }
    closeCurvePresetMenu();
  }

  function syncCurvePresetToolbar(binding) {
    const presets = currentCurvePresets();
    const activeCustom = activeCustomCurvePreset(binding);
    selectedCustomCurvePresetId = activeCustom?.id || null;
    if (d.bindingConfigCurvePresetButton) {
      const label = activeCustom?.name || t("bindings.myCurves");
      d.bindingConfigCurvePresetButton.textContent = label || t("bindings.presets");
    }
    if (d.bindingConfigCurvePresetSave) {
      d.bindingConfigCurvePresetSave.disabled = false;
    }
    if (d.bindingConfigCurvePresetForm) {
      d.bindingConfigCurvePresetForm.classList.toggle("hidden", !curvePresetFormMode);
    }
    renderCurvePresetMenu();
  }

  function appendCurvePresetGroup(container, title, items, renderItem, emptyText = "") {
    if (!container || (!items.length && !emptyText)) return;
    const group = document.createElement("div");
    group.className = "binding-config-curve-preset-group";
    const heading = document.createElement("div");
    heading.className = "binding-config-curve-preset-heading";
    heading.textContent = title;
    group.appendChild(heading);
    if (items.length) {
      items.forEach((item) => group.appendChild(renderItem(item)));
    } else {
      const empty = document.createElement("div");
      empty.className = "binding-config-curve-preset-empty";
      empty.textContent = emptyText;
      group.appendChild(empty);
    }
    container.appendChild(group);
  }

  function renderCurvePresetMenu() {
    if (!d.bindingConfigCurvePresetList) return;
    const binding = getConfigBinding();
    const presets = currentCurvePresets();
    const query = curvePresetSearchQuery.trim().toLowerCase();
    const activeCustom = activeCustomCurvePreset(binding);
    d.bindingConfigCurvePresetList.innerHTML = "";
    if (d.bindingConfigCurvePresetSearch && d.bindingConfigCurvePresetSearch.value !== curvePresetSearchQuery) {
      d.bindingConfigCurvePresetSearch.value = curvePresetSearchQuery;
    }

    const customPresets = presets
      .filter((preset) => !query || preset.name.toLowerCase().includes(query));

    const renderCustom = (preset) => {
      const row = document.createElement("div");
      row.className = "binding-config-curve-preset-custom-row";
      row.classList.toggle("is-selected", activeCustom?.id === preset.id);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "binding-config-curve-preset-option";
      button.dataset.curvePresetKind = "custom";
      button.dataset.curvePresetId = preset.id;
      button.textContent = preset.name;
      button.classList.toggle("is-selected", activeCustom?.id === preset.id);
      button.addEventListener("click", () => {
        applyCurvePresetToDraft(preset);
      });
      row.appendChild(button);

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "binding-config-curve-preset-action";
      setActionIcon(editButton, "edit", t("bindings.renameCurvePreset"));
      editButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openCurvePresetForm("rename", preset);
      });
      row.appendChild(editButton);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "binding-config-curve-preset-action binding-config-curve-preset-action--danger";
      setActionIcon(deleteButton, "delete", t("bindings.deleteCurvePreset"));
      deleteButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await deleteCurvePreset(preset);
      });
      row.appendChild(deleteButton);

      return row;
    };

    appendCurvePresetGroup(
      d.bindingConfigCurvePresetList,
      t("bindings.myCurves"),
      customPresets,
      renderCustom,
      query ? t("bindings.curvePresetNoSearchResults") : t("bindings.curvePresetEmpty"),
    );
  }

  function applyCurvePresetToDraft(preset) {
    const binding = getConfigBinding();
    if (!binding || !preset) return;
    binding.fader_curve = "Custom";
    binding.custom_curve = normalizeCurvePresetPoints(preset.points);
    selectedCustomCurvePresetId = preset.id;
    closeCurvePresetForm();
    closeCurvePresetMenu();
    renderConfigModal();
  }

  async function submitCurvePresetForm() {
    const binding = getConfigBinding();
    if (!binding) return;
    const name = normalizeCurvePresetName(d.bindingConfigCurvePresetName?.value || "");
    if (!name) {
      alertAction(t("bindings.curvePresetInvalidTitle"), t("bindings.curvePresetInvalidName"));
      return;
    }

    const presets = currentCurvePresets();
    if (curvePresetFormMode === "rename") {
      const preset = presets.find((item) => item.id === curvePresetFormPresetId)
        || activeCustomCurvePreset(binding);
      if (!preset) return;
      const duplicate = presets.find((item) => (
        item.id !== preset.id && item.name.toLowerCase() === name.toLowerCase()
      ));
      if (duplicate) {
        alertAction(t("bindings.curvePresetDuplicateTitle"), t("bindings.curvePresetDuplicateName"));
        return;
      }
      const saved = await saveCurvePresets(presets.map((item) => (
        item.id === preset.id ? { ...item, name } : item
      )));
      selectedCustomCurvePresetId = normalizeFaderCurvePresets(saved)
        .find((item) => item.name.toLowerCase() === name.toLowerCase())?.id || preset.id;
      closeCurvePresetForm();
      renderConfigModal();
      return;
    }

    const points = normalizeCurvePresetPoints(curvePointsForBinding(binding));
    if (points.length < 2) {
      alertAction(t("bindings.curvePresetInvalidTitle"), t("bindings.curvePresetInvalidCurve"));
      return;
    }
    const existing = presets.find((item) => item.name.toLowerCase() === name.toLowerCase());
    let nextPresets;
    if (existing) {
      const confirmed = await confirmAction({
        title: t("bindings.curvePresetReplaceTitle"),
        message: t("bindings.curvePresetReplaceMessage", { name }),
        confirmLabel: t("common.save"),
        cancelLabel: t("common.cancel"),
        overlayClass: "target-panel--over-config",
      });
      if (!confirmed) return;
      nextPresets = presets.map((item) => (
        item.id === existing.id ? { ...item, name, points } : item
      ));
    } else {
      if (presets.length >= MAX_FADER_CURVE_PRESETS) {
        alertAction(
          t("bindings.curvePresetLimitTitle"),
          t("bindings.curvePresetLimitMessage", { count: MAX_FADER_CURVE_PRESETS }),
        );
        return;
      }
      nextPresets = [...presets, { id: "", name, points }];
    }
    const saved = normalizeFaderCurvePresets(await saveCurvePresets(nextPresets));
    selectedCustomCurvePresetId = saved.find((item) => item.name.toLowerCase() === name.toLowerCase())?.id || null;
    closeCurvePresetForm();
    renderConfigModal();
  }

  async function deleteCurvePreset(preset) {
    if (!preset) return;
    const confirmed = await confirmAction({
      title: t("bindings.curvePresetDeleteTitle"),
      message: t("bindings.curvePresetDeleteMessage", { name: preset.name }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      confirmVariant: "danger",
      overlayClass: "target-panel--over-config",
    });
    if (!confirmed) return;
    await saveCurvePresets(currentCurvePresets().filter((item) => item.id !== preset.id));
    if (selectedCustomCurvePresetId === preset.id) {
      selectedCustomCurvePresetId = null;
    }
    closeCurvePresetForm();
    renderConfigModal();
  }

  function curveSvgX(value) {
    return CUSTOM_CURVE_PADDING + (Math.min(1, Math.max(0, Number(value) || 0)) * CUSTOM_CURVE_PLOT_SIZE);
  }

  function curveSvgY(value) {
    return CUSTOM_CURVE_VIEWBOX_SIZE
      - CUSTOM_CURVE_PADDING
      - (Math.min(1, Math.max(0, Number(value) || 0)) * CUSTOM_CURVE_PLOT_SIZE);
  }

  function clampSegmentCurve(start, end, curve) {
    const midpointY = ((Number(start?.y) || 0) + (Number(end?.y) || 0)) / 2;
    return Math.min(1 - midpointY, Math.max(-midpointY, Number(curve) || 0));
  }

  function curvePathData(points) {
    const safePoints = normalizeCustomCurve(points);
    if (!safePoints.length) return "";
    const commands = [`M${curveSvgX(safePoints[0].x)} ${curveSvgY(safePoints[0].y)}`];
    for (let index = 0; index < safePoints.length - 1; index += 1) {
      const start = safePoints[index];
      const end = safePoints[index + 1];
      const curve = clampSegmentCurve(start, end, start.curve || 0);
      if (Math.abs(curve) > CUSTOM_CURVE_EPSILON) {
        const controlX = (start.x + end.x) / 2;
        const controlY = ((start.y + end.y) / 2) + curve;
        commands.push(`Q${curveSvgX(controlX)} ${curveSvgY(controlY)} ${curveSvgX(end.x)} ${curveSvgY(end.y)}`);
      } else {
        commands.push(`L${curveSvgX(end.x)} ${curveSvgY(end.y)}`);
      }
    }
    return commands.join(" ");
  }

  function buildCurveCardSvg(binding, curve) {
    const pathMap = {
      Linear: "M10 110 L110 10",
      Exponential: "M10 110 C35 110, 75 86, 110 10",
      Logarithmic: "M10 110 C18 42, 64 16, 110 10",
      SCurve: "M10 110 C42 110, 42 12, 110 10",
      Custom: "M10 88 L34 76 L60 28 L86 88 L110 72",
    };
    if (curve === "Custom") {
      const points = curveEditorPoints(binding);
      return `
        <svg class="binding-config-curve-editor-svg" viewBox="0 0 ${CUSTOM_CURVE_VIEWBOX_SIZE} ${CUSTOM_CURVE_VIEWBOX_SIZE}" aria-hidden="true" focusable="false">
          <path class="binding-config-curve-editor-path" d="${curvePathData(points)}" />
        </svg>
      `;
    }
    return `<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false"><path d="${pathMap[curve] || pathMap.Linear}" /></svg>`;
  }

  function setDraftCurve(curve) {
    const binding = getConfigBinding();
    if (!binding) return;
    if (binding.fader_curve === normalizeFaderCurve(curve)) {
      return;
    }
    selectedCustomCurvePresetId = null;
    closeCurvePresetForm();
    binding.fader_curve = normalizeFaderCurve(curve);
    binding.custom_curve = customCurvePoints(binding);
    renderConfigModal();
  }

  function renderCurveCards() {
    if (!d.bindingConfigCurveCards) return;
    const binding = getConfigBinding();
    if (!binding) return;
    d.bindingConfigCurveCards.innerHTML = "";
    ["Linear", "Exponential", "Logarithmic", "SCurve", "Custom"].forEach((curve) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "binding-config-curve-card";
      button.dataset.curve = curve;
      if (curve === "Custom") button.classList.add("binding-config-curve-card--custom");
      if (binding.fader_curve === curve) button.classList.add("is-selected");
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(binding.fader_curve === curve));
      button.innerHTML = `
        <span class="binding-config-curve-card-title">${curveDisplayName(curve)}</span>
        <span class="binding-config-curve-card-visual">${buildCurveCardSvg(binding, curve)}</span>
      `;
      button.addEventListener("click", () => setDraftCurve(curve));
      if (curve === "Custom") {
        const svg = button.querySelector("svg");
        const visual = button.querySelector(".binding-config-curve-card-visual");
        const points = curveEditorPoints(binding);
        if (svg && visual) {
          points.forEach((point, index) => {
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            const x = curveSvgX(point.x);
            const y = curveSvgY(point.y);
            circle.setAttribute("cx", String(x));
            circle.setAttribute("cy", String(y));
            circle.setAttribute("r", "5.5");
            circle.dataset.pointIndex = String(index);
            circle.classList.add("binding-config-curve-card-point");
            circle.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
            });
            svg.appendChild(circle);
          });
          visual.dataset.curveEditorSurface = "custom";
        }
      }
      d.bindingConfigCurveCards.appendChild(button);
    });
    if (d.bindingConfigCurveHelp) {
      d.bindingConfigCurveHelp.textContent = curveHelpText(binding.fader_curve);
    }
  }

  function renderCustomCurveEditor() {
    // Editing now happens directly inside the Custom curve card.
  }

  function customCurveSurfaceFromEvent(event) {
    if (!(event.target instanceof Element)) return null;
    const surface = event.target.closest('[data-curve-editor-surface="custom"]');
    const card = surface?.closest?.(".binding-config-curve-card");
    return card?.dataset?.curve === "Custom" ? surface : null;
  }

  function localCustomCurvePoint(event, surfaceEl) {
    const svg = surfaceEl?.querySelector?.("svg");
    const rect = (svg || surfaceEl)?.getBoundingClientRect?.();
    if (!rect?.width || !rect.height) return null;
    const svgX = ((event.clientX - rect.left) / rect.width) * CUSTOM_CURVE_VIEWBOX_SIZE;
    const svgY = ((event.clientY - rect.top) / rect.height) * CUSTOM_CURVE_VIEWBOX_SIZE;
    return {
      x: Math.min(1, Math.max(0, (svgX - CUSTOM_CURVE_PADDING) / CUSTOM_CURVE_PLOT_SIZE)),
      y: Math.min(1, Math.max(0, (CUSTOM_CURVE_VIEWBOX_SIZE - CUSTOM_CURVE_PADDING - svgY) / CUSTOM_CURVE_PLOT_SIZE)),
    };
  }

  function segmentIndexForCurveX(points, x) {
    if (!Array.isArray(points) || points.length < 2) return -1;
    for (let index = 0; index < points.length - 1; index += 1) {
      if (x <= points[index + 1].x) return index;
    }
    return points.length - 2;
  }

  function curveYAtSegmentPoint(start, end, t) {
    const linear = start.y + ((end.y - start.y) * t);
    return Math.min(1, Math.max(0, linear + ((Number(start.curve) || 0) * 2 * (1 - t) * t)));
  }

  function segmentCurveFromPointer(start, end, localPoint) {
    const span = end.x - start.x;
    if (Math.abs(span) < CUSTOM_CURVE_EPSILON) return start.curve || 0;
    const t = Math.min(1, Math.max(0, (localPoint.x - start.x) / span));
    const denominator = 2 * (1 - t) * t;
    if (denominator < 0.08) return start.curve || 0;
    const linear = start.y + ((end.y - start.y) * t);
    return clampSegmentCurve(start, end, (localPoint.y - linear) / denominator);
  }

  function refreshCustomCurvePointerSurface() {
    if (!customCurvePointer) return;
    const nextSurface = d.bindingConfigCurveCards?.querySelector('.binding-config-curve-card[data-curve="Custom"] .binding-config-curve-card-visual');
    if (nextSurface) {
      customCurvePointer.surfaceEl = nextSurface;
    }
  }

  function commitCustomCurvePoints(points, { keepPointer = false } = {}) {
    const binding = getConfigBinding();
    if (!binding) return;
    if (binding.fader_curve !== "Custom") {
      binding.fader_curve = "Custom";
    }
    binding.custom_curve = normalizeCustomCurve(points);
    selectedCustomCurvePresetId = null;
    renderCurveCards();
    syncCurvePresetToolbar(binding);
    if (keepPointer) {
      refreshCustomCurvePointerSurface();
    }
    renderConfigPreview();
  }

  function addCustomCurvePoint(event) {
    const binding = getConfigBinding();
    const surfaceEl = customCurveSurfaceFromEvent(event);
    if (!binding || !surfaceEl) return;
    if (event.target instanceof Element && event.target.closest("circle.binding-config-curve-card-point")) return;
    const localPoint = localCustomCurvePoint(event, surfaceEl);
    if (!localPoint) return;
    const points = curveEditorPoints(binding);
    const segmentIndex = segmentIndexForCurveX(points, localPoint.x);
    if (segmentIndex < 0) return;
    const start = points[segmentIndex];
    const end = points[segmentIndex + 1];
    if ((end.x - start.x) < (CUSTOM_CURVE_MIN_POINT_SPACING * 2)) return;

    event.preventDefault();
    event.stopPropagation();
    const span = end.x - start.x;
    const t = Math.min(1, Math.max(0, (localPoint.x - start.x) / span));
    const x = Math.min(end.x - CUSTOM_CURVE_MIN_POINT_SPACING, Math.max(start.x + CUSTOM_CURVE_MIN_POINT_SPACING, localPoint.x));
    const y = localPoint.y == null ? curveYAtSegmentPoint(start, end, t) : localPoint.y;
    const nextPoints = points.map((point) => ({ ...point }));
    nextPoints[segmentIndex] = { ...nextPoints[segmentIndex], curve: 0 };
    nextPoints.splice(segmentIndex + 1, 0, { x, y });
    commitCustomCurvePoints(nextPoints);
  }

  function removeCustomCurvePoint(index, event = null) {
    const binding = getConfigBinding();
    if (!binding) return;
    const points = curveEditorPoints(binding);
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!Number.isInteger(index) || index <= 0 || index >= points.length - 1) return;
    const nextPoints = points.map((point) => ({ ...point }));
    nextPoints.splice(index, 1);
    if (nextPoints[index - 1]) {
      nextPoints[index - 1] = { ...nextPoints[index - 1], curve: 0 };
    }
    commitCustomCurvePoints(nextPoints);
  }

  function updateCustomCurveFromPointer(event) {
    const binding = getConfigBinding();
    if (!binding || !customCurvePointer?.surfaceEl) return;
    const localPoint = localCustomCurvePoint(event, customCurvePointer.surfaceEl);
    if (!localPoint) return;
    const points = curveEditorPoints(binding);
    const index = customCurvePointer.index;

    if (customCurvePointer.mode === "segment") {
      if (index < 0 || index >= points.length - 1) return;
      const start = points[index];
      const end = points[index + 1];
      points[index] = {
        ...start,
        curve: segmentCurveFromPointer(start, end, localPoint),
      };
      commitCustomCurvePoints(points, { keepPointer: true });
      return;
    }

    const isEdge = index === 0 || index === points.length - 1;
    const prevX = index > 0 ? points[index - 1].x + CUSTOM_CURVE_MIN_POINT_SPACING : 0;
    const nextX = index < points.length - 1 ? points[index + 1].x - CUSTOM_CURVE_MIN_POINT_SPACING : 1;
    points[index] = {
      ...points[index],
      x: isEdge ? (index === 0 ? 0 : 1) : Math.min(nextX, Math.max(prevX, localPoint.x)),
      y: localPoint.y,
    };
    if (isEdge) {
      points[index].curve = 0;
    }
    commitCustomCurvePoints(points, { keepPointer: true });
  }

  function cancelSoundboardPreviewFrame() {
    if (soundboardPreviewAnimationFrame == null) return;
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(soundboardPreviewAnimationFrame);
    } else {
      window.clearTimeout(soundboardPreviewAnimationFrame);
    }
    soundboardPreviewAnimationFrame = null;
  }

  function showSoundboardAlreadyConfiguredError() {
    alertAction(
      t("dialogs.soundboardAlreadyConfiguredTitle"),
      t("dialogs.soundboardAlreadyConfiguredMessage"),
    );
  }

  function showSpecialActionConflictError() {
    alertAction(
      t("dialogs.specialActionConflictTitle"),
      t("dialogs.specialActionConflictMessage"),
    );
  }

  function scheduleSoundboardPreviewFrame() {
    cancelSoundboardPreviewFrame();
    const callback = () => {
      soundboardPreviewAnimationFrame = null;
      updateSoundboardPreviewFrame();
    };
    soundboardPreviewAnimationFrame = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(callback)
      : window.setTimeout(callback, 16);
  }

  function currentSoundboardPreviewPosition(mapping) {
    if (!mapping || soundboardPreviewState === "stopped") return null;
    const running = soundboardPreviewState === "playing"
      ? (performance.now() - soundboardPreviewStartedAt) * mapping.speed
      : 0;
    return mapping.trim_start_ms + soundboardPreviewElapsedMs + running;
  }

  function soundboardWaveformColors(canvas) {
    const styles = getComputedStyle(canvas);
    const color = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    return {
      background: color("--soundboard-waveform-background", "#111827"),
      waveform: color("--soundboard-waveform-color", "#9edcff"),
      grid: color("--soundboard-waveform-grid", "rgba(158, 220, 255, .16)"),
      label: color("--soundboard-waveform-label", "rgba(224, 236, 255, .72)"),
      excluded: color("--soundboard-waveform-excluded", "rgba(3, 7, 18, .68)"),
      handle: color("--soundboard-waveform-handle", "#66d9ff"),
      playhead: color("--soundboard-waveform-playhead", "#ffffff"),
    };
  }

  function renderSoundboardPreviewVisual() {
    const binding = getConfigBinding();
    const mapping = normalizeSoundboardMapping(binding?.soundboard);
    const duration = Number(soundboardAnalysis?.duration_ms) || 0;
    const end = mapping ? soundboardEndMs(mapping) : 0;
    const position = currentSoundboardPreviewPosition(mapping);
    if (d.bindingConfigSoundboardPreview) {
      d.bindingConfigSoundboardPreview.dataset.state = soundboardPreviewState;
      const label = soundboardPreviewState === "playing" ? t("soundboard.previewPause") : t("soundboard.previewPlay");
      d.bindingConfigSoundboardPreview.setAttribute("aria-label", label);
      d.bindingConfigSoundboardPreview.title = label;
    }
    if (d.bindingConfigSoundboardPlaybackTime) {
      d.bindingConfigSoundboardPlaybackTime.textContent = formatSoundboardTime(position ?? mapping?.trim_start_ms ?? 0);
    }
    drawSoundboardWaveform(
      d.bindingConfigSoundboardWaveform,
      soundboardAnalysis?.peaks,
      duration,
      mapping?.trim_start_ms || 0,
      end,
      soundboardWaveformColors(d.bindingConfigSoundboardWaveform),
      position,
    );
  }

  function clearSoundboardPreviewState() {
    soundboardPreviewState = "stopped";
    soundboardPreviewStartedAt = 0;
    soundboardPreviewElapsedMs = 0;
    cancelSoundboardPreviewFrame();
    renderSoundboardPreviewVisual();
  }

  function updateSoundboardPreviewFrame() {
    if (soundboardPreviewState !== "playing") return;
    const mapping = normalizeSoundboardMapping(getConfigBinding()?.soundboard);
    if (!mapping) {
      clearSoundboardPreviewState();
      return;
    }
    const position = currentSoundboardPreviewPosition(mapping);
    if (position == null || position >= soundboardEndMs(mapping)) {
      clearSoundboardPreviewState();
      return;
    }
    renderSoundboardPreviewVisual();
    scheduleSoundboardPreviewFrame();
  }

  async function stopSoundboardPreview() {
    clearSoundboardPreviewState();
    try { await invoke("stop_soundboard_preview"); } catch { }
  }

  async function loadSoundboardOutputDevices() {
    soundboardOutputDevicesLoaded = false;
    try {
      const devices = await invoke("list_soundboard_output_devices");
      soundboardOutputDevices = Array.isArray(devices) ? devices : [];
    } catch {
      soundboardOutputDevices = [];
    }
    soundboardOutputDevicesLoaded = true;
    const binding = getConfigBinding();
    if (binding && configSoundboardPageOpen) renderSoundboardEditor(binding);
  }

  function renderSoundboardOutputOptions(mapping) {
    const select = d.bindingConfigSoundboardOutput;
    if (!select) return;
    const systemDefaultValue = "__system_default__";
    if (!soundboardOutputDropdown) {
      soundboardOutputDropdown = createSelectDropdownShell({
        selectEl: select,
        rootClass: "settings-select-dropdown soundboard-output-dropdown",
        title: t("soundboard.outputDevice"),
      });
    }
    select.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = systemDefaultValue;
    defaultOption.textContent = soundboardOutputDevicesLoaded
      ? t("soundboard.systemDefault")
      : t("soundboard.loadingDevices");
    select.append(defaultOption);
    soundboardOutputDevices.forEach((device) => {
      const option = document.createElement("option");
      option.value = String(device.id || "");
      option.textContent = device.is_default
        ? t("soundboard.defaultDevice", { device: device.display })
        : String(device.display || device.id || "");
      select.append(option);
    });
    if (mapping?.output_device_id && !soundboardOutputDevices.some((device) => device.id === mapping.output_device_id)) {
      const unavailable = document.createElement("option");
      unavailable.value = mapping.output_device_id;
      unavailable.textContent = t("soundboard.deviceUnavailable", {
        device: mapping.output_device_display || mapping.output_device_id,
      });
      select.append(unavailable);
    }
    select.value = mapping?.output_device_id || systemDefaultValue;
    renderNativeSelectDropdown({
      entry: soundboardOutputDropdown,
      selectEl: select,
      fallbackText: t("soundboard.systemDefault"),
      formatOptionText: (option) => option.textContent || t("soundboard.systemDefault"),
    });
  }

  function soundboardEndMs(mapping) {
    const duration = Number(soundboardAnalysis?.duration_ms) || 0;
    return mapping?.trim_end_ms == null ? duration : Math.min(duration, Number(mapping.trim_end_ms) || 0);
  }

  function setSoundboardTrim(changed, value) {
    const binding = getConfigBinding();
    const mapping = normalizeSoundboardMapping(binding?.soundboard);
    const duration = Number(soundboardAnalysis?.duration_ms) || 0;
    if (!binding || !mapping || duration <= 0) return;
    const next = clampSoundboardTrim(
      changed === "start" ? value : mapping.trim_start_ms,
      changed === "end" ? value : soundboardEndMs(mapping),
      duration,
      changed,
    );
    mapping.trim_start_ms = next.startMs;
    mapping.trim_end_ms = next.endMs >= duration ? null : next.endMs;
    binding.soundboard = mapping;
    stopSoundboardPreview().catch(() => { });
    renderSoundboardEditor(binding);
  }

  function renderSoundboardSummary(binding) {
    if (!d.bindingConfigSoundboardSummary) return;
    wireSoundboardEditor();
    const mapping = normalizeSoundboardMapping(binding?.soundboard);
    d.bindingConfigSoundboardSummary.innerHTML = "";
    const name = document.createElement("strong");
    name.textContent = mapping?.display || t("soundboard.noFile");
    const detail = document.createElement("span");
    detail.textContent = mapping
      ? t("soundboard.summary", { volume: Math.round(mapping.volume * 100), speed: mapping.speed.toFixed(2) })
      : t("soundboard.unavailable");
    d.bindingConfigSoundboardSummary.append(name, detail);
  }

  async function loadSoundboardAnalysis(binding, { force = false } = {}) {
    const mapping = normalizeSoundboardMapping(binding?.soundboard);
    if (!mapping || (!force && soundboardAnalysis?.path === mapping.path)) return;
    const token = ++soundboardAnalysisToken;
    soundboardAnalysis = null;
    soundboardAnalysisError = "";
    renderSoundboardEditor(binding);
    try {
      const analysis = await invoke("analyze_soundboard_audio", { path: mapping.path });
      if (token !== soundboardAnalysisToken || getConfigBinding()?.soundboard?.path !== mapping.path) return;
      soundboardAnalysis = analysis;
      const draft = getConfigBinding();
      const current = normalizeSoundboardMapping(draft?.soundboard);
      if (draft && current) {
        const duration = Number(analysis.duration_ms) || 0;
        const next = clampSoundboardTrim(
          current.trim_start_ms,
          current.trim_end_ms ?? duration,
          duration,
          "start",
        );
        current.trim_start_ms = next.startMs;
        current.trim_end_ms = next.endMs >= duration ? null : next.endMs;
        draft.soundboard = current;
      }
    } catch (error) {
      if (token !== soundboardAnalysisToken) return;
      soundboardAnalysisError = String(error || t("soundboard.unavailable"));
    }
    renderSoundboardEditor(getConfigBinding());
  }

  function wireSoundboardEditor() {
    if (d.bindingConfigSoundboardEdit) d.bindingConfigSoundboardEdit.onclick = () => {
      configSoundboardPageOpen = true;
      loadSoundboardOutputDevices().catch(() => { });
      renderConfigModal();
    };
    if (d.bindingConfigSoundboardReplace) d.bindingConfigSoundboardReplace.onclick = async () => {
      try {
        const analysis = await invoke("pick_soundboard_audio");
        if (!analysis) return;
        const binding = getConfigBinding();
        if (!binding) return;
        await stopSoundboardPreview();
        binding.soundboard = {
          path: analysis.path,
          display: analysis.display,
          trim_start_ms: 0,
          trim_end_ms: null,
          volume: normalizeSoundboardMapping(binding.soundboard)?.volume ?? 1,
          speed: normalizeSoundboardMapping(binding.soundboard)?.speed ?? 1,
          output_device_id: normalizeSoundboardMapping(binding.soundboard)?.output_device_id ?? null,
          output_device_display: normalizeSoundboardMapping(binding.soundboard)?.output_device_display ?? null,
        };
        soundboardAnalysis = analysis;
        soundboardAnalysisError = "";
        renderSoundboardEditor(binding);
      } catch (error) {
        soundboardAnalysisError = String(error || t("soundboard.unavailable"));
        renderSoundboardEditor(getConfigBinding());
      }
    };
    if (d.bindingConfigSoundboardPreview) d.bindingConfigSoundboardPreview.onclick = async () => {
      const mapping = normalizeSoundboardMapping(getConfigBinding()?.soundboard);
      if (!mapping) return;
      if (soundboardPreviewState === "playing") {
        soundboardPreviewElapsedMs += (performance.now() - soundboardPreviewStartedAt) * mapping.speed;
        soundboardPreviewState = "paused";
        cancelSoundboardPreviewFrame();
        await invoke("set_soundboard_preview_paused", { paused: true });
        renderSoundboardPreviewVisual();
        return;
      }
      if (soundboardPreviewState === "paused") {
        await invoke("set_soundboard_preview_paused", { paused: false });
        soundboardPreviewState = "playing";
        soundboardPreviewStartedAt = performance.now();
        renderSoundboardPreviewVisual();
        scheduleSoundboardPreviewFrame();
        return;
      }
      try {
        await invoke("preview_soundboard_audio", { mapping });
        soundboardPreviewState = "playing";
        soundboardPreviewElapsedMs = 0;
        soundboardPreviewStartedAt = performance.now();
        renderSoundboardPreviewVisual();
        scheduleSoundboardPreviewFrame();
      } catch (error) {
        soundboardAnalysisError = String(error || t("soundboard.unavailable"));
        renderSoundboardEditor(getConfigBinding());
      }
    };
    if (d.bindingConfigSoundboardSpeed) d.bindingConfigSoundboardSpeed.oninput = () => {
      const binding = getConfigBinding();
      const mapping = normalizeSoundboardMapping(binding?.soundboard);
      if (!binding || !mapping) return;
      mapping.speed = Math.min(2, Math.max(0.5, Number(d.bindingConfigSoundboardSpeed.value) / 100));
      binding.soundboard = mapping;
      d.bindingConfigSoundboardSpeedValue.textContent = `${mapping.speed.toFixed(2)}×`;
      updateSliderFill(d.bindingConfigSoundboardSpeed);
      stopSoundboardPreview().catch(() => { });
    };
    if (d.bindingConfigSoundboardOutput) d.bindingConfigSoundboardOutput.onchange = () => {
      const binding = getConfigBinding();
      const mapping = normalizeSoundboardMapping(binding?.soundboard);
      if (!binding || !mapping) return;
      const selectedValue = String(d.bindingConfigSoundboardOutput.value || "");
      const selectedId = selectedValue === "__system_default__" ? "" : selectedValue;
      const selected = soundboardOutputDevices.find((device) => device.id === selectedId);
      mapping.output_device_id = selectedId || null;
      mapping.output_device_display = selectedId ? (selected?.display || mapping.output_device_display || null) : null;
      binding.soundboard = mapping;
      stopSoundboardPreview().catch(() => { });
      renderSoundboardEditor(binding);
    };
    if (d.bindingConfigSoundboardVolume) d.bindingConfigSoundboardVolume.oninput = () => {
      const binding = getConfigBinding();
      const mapping = normalizeSoundboardMapping(binding?.soundboard);
      if (!binding || !mapping) return;
      mapping.volume = Math.min(1, Math.max(0, Number(d.bindingConfigSoundboardVolume.value) / 100));
      binding.soundboard = mapping;
      d.bindingConfigSoundboardVolumeValue.textContent = `${Math.round(mapping.volume * 100)}%`;
      updateSliderFill(d.bindingConfigSoundboardVolume);
      invoke("set_soundboard_preview_volume", { volume: mapping.volume }).catch(() => { });
    };
    [[d.bindingConfigSoundboardStart, "start"], [d.bindingConfigSoundboardEnd, "end"]].forEach(([input, handle]) => {
      if (!input) return;
      input.oninput = () => setSoundboardTrim(handle, Number(input.value));
      input.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
        setSoundboardTrim(handle, Number(input.value) + (direction * soundboardArrowStep(event)));
      };
    });
    const canvas = d.bindingConfigSoundboardWaveform;
    if (canvas && !canvas.dataset.soundboardWired) {
      canvas.dataset.soundboardWired = "true";
      canvas.addEventListener("pointerdown", (event) => {
        const duration = Number(soundboardAnalysis?.duration_ms) || 0;
        const mapping = normalizeSoundboardMapping(getConfigBinding()?.soundboard);
        if (!mapping || duration <= 0) return;
        const time = waveformTimeFromPointer(event, canvas, duration);
        soundboardPointerHandle = Math.abs(time - mapping.trim_start_ms) <= Math.abs(time - soundboardEndMs(mapping)) ? "start" : "end";
        canvas.setPointerCapture(event.pointerId);
        setSoundboardTrim(soundboardPointerHandle, time);
      });
      canvas.addEventListener("pointermove", (event) => {
        if (!soundboardPointerHandle || !canvas.hasPointerCapture(event.pointerId)) return;
        setSoundboardTrim(soundboardPointerHandle, waveformTimeFromPointer(event, canvas, Number(soundboardAnalysis?.duration_ms) || 0));
      });
      const release = (event) => {
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        soundboardPointerHandle = null;
      };
      canvas.addEventListener("pointerup", release);
      canvas.addEventListener("pointercancel", release);
    }
  }

  function renderSoundboardEditor(binding) {
    if (!binding || !d.bindingConfigSoundboardSection) return;
    wireSoundboardEditor();
    const mapping = normalizeSoundboardMapping(binding.soundboard);
    const analysis = soundboardAnalysis?.path === mapping?.path ? soundboardAnalysis : null;
    const duration = Number(analysis?.duration_ms) || 0;
    const end = mapping ? (mapping.trim_end_ms == null ? duration : Math.min(duration, mapping.trim_end_ms)) : 0;
    d.bindingConfigSoundboardSection.classList.toggle("is-empty", !mapping);
    d.bindingConfigSoundboardFile.textContent = mapping?.display || t("soundboard.noFile");
    d.bindingConfigSoundboardStatus.textContent = !mapping
      ? ""
      : soundboardAnalysisError
        ? t("soundboard.unavailableRelink")
        : (analysis ? t("soundboard.ready") : t("soundboard.analyzing"));
    d.bindingConfigSoundboardStatus.classList.toggle("is-error", Boolean(soundboardAnalysisError));
    d.bindingConfigSoundboardPreview.disabled = !analysis || Boolean(soundboardAnalysisError);
    d.bindingConfigSoundboardStart.max = String(duration);
    d.bindingConfigSoundboardStart.value = String(mapping?.trim_start_ms || 0);
    d.bindingConfigSoundboardStart.disabled = !analysis;
    d.bindingConfigSoundboardEnd.max = String(duration);
    d.bindingConfigSoundboardEnd.value = String(end);
    d.bindingConfigSoundboardEnd.disabled = !analysis;
    d.bindingConfigSoundboardStartTime.textContent = formatSoundboardTime(mapping?.trim_start_ms || 0);
    d.bindingConfigSoundboardEndTime.textContent = formatSoundboardTime(end);
    d.bindingConfigSoundboardSelectionTime.textContent = formatSoundboardTime(Math.max(0, end - (mapping?.trim_start_ms || 0)));
    d.bindingConfigSoundboardVolume.value = String(Math.round((mapping?.volume ?? 1) * 100));
    d.bindingConfigSoundboardVolumeValue.textContent = `${Math.round((mapping?.volume ?? 1) * 100)}%`;
    d.bindingConfigSoundboardSpeed.value = String(Math.round((mapping?.speed ?? 1) * 100));
    d.bindingConfigSoundboardSpeedValue.textContent = `${(mapping?.speed ?? 1).toFixed(2)}×`;
    [
      d.bindingConfigSoundboardStart,
      d.bindingConfigSoundboardEnd,
      d.bindingConfigSoundboardSpeed,
      d.bindingConfigSoundboardVolume,
    ].forEach((input) => input && updateSliderFill(input));
    renderSoundboardOutputOptions(mapping);
    renderSoundboardPreviewVisual();
  }

  async function closeConfigModal({ commit = false } = {}) {
    const emptySoundboardBindingToClean = !commit
      && configRemoveEmptySoundboardTargetOnCancel
      && !normalizeSoundboardMapping(configDraft?.soundboard)
      ? cloneBindingDraft(getBindingById(configBindingId))
      : null;
    await stopSoundboardPreview();
    soundboardAnalysisToken += 1;
    soundboardAnalysis = null;
    soundboardAnalysisError = "";
    soundboardPointerHandle = null;
    stopHotkeyLearn();
    stopAuxLearn();
    clearTransferPrompt();
    closeMuteModeMenu();
    closeAssignModeMenu();
    closeCurvePresetMenu();
    stopConfigPreviewTimer();
    customCurvePointer = null;
    curvePresetSearchQuery = "";
    closeCurvePresetForm();
    selectedCustomCurvePresetId = null;
    cancelMacroDrag();
    if (!commit) {
      await restoreConfigPreviewBindings();
    }
    if (emptySoundboardBindingToClean) {
      try {
        setTargets(
          emptySoundboardBindingToClean,
          getTargets(emptySoundboardBindingToClean).filter((target) => !isSoundboardTarget(target)),
        );
        emptySoundboardBindingToClean.soundboard = null;
        if (emptySoundboardBindingToClean.action === "Soundboard") {
          emptySoundboardBindingToClean.action = "ToggleMute";
        }
        ensureBindingShape(emptySoundboardBindingToClean);
        await persistBindingBackend(emptySoundboardBindingToClean);
        setB(getB().map((binding) => (
          binding.id === emptySoundboardBindingToClean.id ? emptySoundboardBindingToClean : binding
        )));
        renderBindings();
        finishBindingUiMutation("cancel empty soundboard target");
      } catch (error) {
        console.error("Failed to remove canceled Soundboard target:", error);
      }
    }
    configPreviewOriginalBindings = null;
    configAcceptedTransfers.clear();
    configDraft = null;
    configBindingId = null;
    configMacroPageOpen = false;
    configSoundboardPageOpen = false;
    configRemoveEmptySoundboardTargetOnCancel = false;
    configMacroSelectedPath = null;
    if (d.bindingConfigPanel) d.bindingConfigPanel.classList.add("hidden");
  }

  function getBindingById(bindingId) {
    return getB().find((binding) => binding.id === bindingId) || null;
  }

  function renderConfigModal() {
    const binding = getConfigBinding();
    if (!binding) {
      closeConfigModal().catch((err) => console.error("Failed to close binding config:", err));
      return;
    }
    closeAssignModeMenu();
    closeMuteModeMenu();
    const preserveMacroDraftSteps = configMacroPageOpen && (binding.action === "Macro" || getTargets(binding).some(isMacroTarget))
      ? clonePlain(binding.macro_steps || [])
      : null;
    ensureAuxShape(binding);
    ensureBindingShape(binding);
    if (preserveMacroDraftSteps) {
      binding.macro_steps = normalizeMacroDraftSteps(preserveMacroDraftSteps);
    }
    ensureMacroConfigDom();
    const isButton = effectiveIsButton(binding);
    const isMacroBinding = isButton && binding.action === "Macro";
    const isSoundboardBinding = isButton && (binding.action === "Soundboard" || getTargets(binding).some(isSoundboardTarget));
    const showMacroPage = isMacroBinding && configMacroPageOpen;
    const showSoundboardPage = isSoundboardBinding && configSoundboardPageOpen;
    const showSpecialPage = showMacroPage || showSoundboardPage;
    if (d.bindingConfigSave) d.bindingConfigSave.disabled = false;
    if (d.bindingConfigTitle) {
      d.bindingConfigTitle.textContent = showMacroPage
        ? t("macro.configure")
        : showSoundboardPage
          ? t("soundboard.configure")
        : (isButton ? t("bindings.buttonConfiguration") : t("bindings.faderConfiguration"));
    }
    if (d.bindingConfigBack) {
      d.bindingConfigBack.classList.add("hidden");
      d.bindingConfigBack.disabled = true;
    }
    if (d.bindingConfigPanel) {
      d.bindingConfigPanel.classList.toggle("binding-config-panel--button", isButton);
      d.bindingConfigPanel.classList.toggle("binding-config-panel--fader", !isButton);
      d.bindingConfigPanel.classList.toggle("binding-config-panel--macro-page", showMacroPage);
      d.bindingConfigPanel.classList.toggle("binding-config-panel--soundboard-page", showSoundboardPage);
    }
    const nameSection = d.bindingConfigName?.closest?.(".binding-config-section");
    if (nameSection) nameSection.classList.toggle("hidden", showSpecialPage);
    if (d.bindingConfigButtonLightSection) d.bindingConfigButtonLightSection.classList.toggle("hidden", !isButton || showSpecialPage);
    if (d.bindingConfigButtonLearnSection) d.bindingConfigButtonLearnSection.classList.toggle("hidden", !isButton || showSpecialPage);
    if (d.bindingConfigMacroSummarySection) d.bindingConfigMacroSummarySection.classList.add("hidden");
    if (d.bindingConfigMacroSection) d.bindingConfigMacroSection.classList.toggle("hidden", !showMacroPage);
    if (d.bindingConfigSoundboardSummarySection) d.bindingConfigSoundboardSummarySection.classList.toggle("hidden", !isSoundboardBinding || showSoundboardPage);
    if (d.bindingConfigSoundboardSection) d.bindingConfigSoundboardSection.classList.toggle("hidden", !showSoundboardPage);
    if (d.bindingConfigPreviewLearnShell) d.bindingConfigPreviewLearnShell.classList.toggle("hidden", isButton || showSpecialPage);
    if (d.bindingConfigCurveSection) d.bindingConfigCurveSection.classList.toggle("hidden", isButton || showSpecialPage);
    if (d.bindingConfigFeedbackOutputSection) d.bindingConfigFeedbackOutputSection.classList.toggle("hidden", isButton || showSpecialPage);
    if (d.bindingConfigMuteSection) d.bindingConfigMuteSection.classList.toggle("hidden", isButton || showSpecialPage);
    if (d.bindingConfigAssignSection) d.bindingConfigAssignSection.classList.toggle("hidden", isButton || showSpecialPage);
    if (d.bindingConfigName) d.bindingConfigName.value = binding.name?.trim() || "";
    if (isButton) {
      syncButtonLightUi(binding);
      if (showMacroPage) {
        renderMacroEditor(binding);
      } else if (showSoundboardPage) {
        renderSoundboardEditor(binding);
        if (soundboardAnalysis?.path !== binding.soundboard?.path && !soundboardAnalysisError) {
          loadSoundboardAnalysis(binding).catch(() => { });
        }
      } else if (d.bindingConfigMacroList) {
        d.bindingConfigMacroList.innerHTML = "";
        if (d.bindingConfigMacroSummary) d.bindingConfigMacroSummary.innerHTML = "";
      }
      if (isSoundboardBinding && !showSoundboardPage) renderSoundboardSummary(binding);
    } else {
      syncCurvePresetToolbar(binding);
      renderCurveCards();
      renderCustomCurveEditor();
      renderMuteMappingLabel(binding);
      renderAssignMappingLabel(binding);
      syncFeedbackOutputUi(binding);
      syncMuteModeUi(binding?.mute_control?.mute_behavior || binding?.mute_behavior || "ToggleOnPress");
      syncAssignModeUi(binding.assign_mode || "Add");
    }
    renderConfigPreview();
    updateAuxLearnUi();
  }

  function syncButtonLightUi(binding) {
    const select = d.bindingConfigButtonLightSelect;
    if (!select) return;
    select.value = buttonLightSelectValue(binding);
    select.disabled = false;
    select.title = t("bindings.toggleMuteLight");
    const row = d.bindingConfigButtonLightSelectRow || select.closest?.(".binding-config-select-row");
    if (row) {
      row.classList.remove("is-disabled");
      row.classList.remove("hidden");
    }
    if (buttonLightDropdown) {
      buttonLightDropdown.button.disabled = false;
      buttonLightDropdown.button.title = t("bindings.toggleMuteLight");
      buttonLightDropdown.button.setAttribute("aria-disabled", "false");
      buttonLightDropdown.root.classList.remove("is-disabled");
      renderButtonLightDropdown();
    }
    syncIndicatorUi(binding);
  }

  function closeMuteModeMenu() {
    if (d.bindingConfigMuteModeMenu) d.bindingConfigMuteModeMenu.classList.add("hidden");
    if (d.bindingConfigMuteModeButton) d.bindingConfigMuteModeButton.setAttribute("aria-expanded", "false");
  }

  function openMuteModeMenu() {
    if (d.bindingConfigMuteModeMenu) d.bindingConfigMuteModeMenu.classList.remove("hidden");
    if (d.bindingConfigMuteModeButton) d.bindingConfigMuteModeButton.setAttribute("aria-expanded", "true");
  }

  function closeAssignModeMenu() {
    if (d.bindingConfigAssignModeMenu) d.bindingConfigAssignModeMenu.classList.add("hidden");
    if (d.bindingConfigAssignModeButton) d.bindingConfigAssignModeButton.setAttribute("aria-expanded", "false");
  }

  function openAssignModeMenu() {
    if (d.bindingConfigAssignModeMenu) d.bindingConfigAssignModeMenu.classList.remove("hidden");
    if (d.bindingConfigAssignModeButton) d.bindingConfigAssignModeButton.setAttribute("aria-expanded", "true");
  }

  function syncAssignModeUi(mode) {
    const currentMode = mode === "Replace" ? "Replace" : "Add";
    const tooltip = assignModeTooltip(currentMode);
    if (d.bindingConfigAssignModeButton) {
      d.bindingConfigAssignModeButton.title = tooltip;
      d.bindingConfigAssignModeButton.setAttribute("aria-label", tooltip);
    }
    if (d.bindingConfigAssignModeAdd) {
      d.bindingConfigAssignModeAdd.classList.toggle("is-selected", currentMode === "Add");
      d.bindingConfigAssignModeAdd.title = assignModeTooltip("Add");
    }
    if (d.bindingConfigAssignModeReplace) {
      d.bindingConfigAssignModeReplace.classList.toggle("is-selected", currentMode === "Replace");
      d.bindingConfigAssignModeReplace.title = assignModeTooltip("Replace");
    }
  }

  function syncMuteModeUi(mode) {
    const currentMode = normalizeMuteBehavior(mode);
    const tooltip = muteBehaviorTooltip(currentMode);
    if (d.bindingConfigMuteModeButton) {
      d.bindingConfigMuteModeButton.title = tooltip;
      d.bindingConfigMuteModeButton.setAttribute("aria-label", tooltip);
    }
    if (d.bindingConfigMuteModeToggle) {
      d.bindingConfigMuteModeToggle.classList.toggle("is-selected", currentMode === "ToggleOnPress");
      d.bindingConfigMuteModeToggle.title = muteBehaviorTooltip("ToggleOnPress");
    }
    if (d.bindingConfigMuteModeValue) {
      d.bindingConfigMuteModeValue.classList.toggle("is-selected", currentMode === "SetFromValue");
      d.bindingConfigMuteModeValue.title = muteBehaviorTooltip("SetFromValue");
    }
  }

  async function persistBindingBackend(binding) {
    ensureBindingShape(binding);
    await invoke("add_binding", { binding });
  }

  function syncPluginHostBindings() {
    try {
      getHost()?.setBindings?.(getB());
    } catch { }
  }

  function scheduleProfileSave(reason = "binding update") {
    const promise = saveProfile();
    promise.catch((err) => {
      console.error(`Failed to save profile after ${reason}:`, err);
    });
    return promise;
  }

  function finishBindingUiMutation(reason = "binding update") {
    syncPluginHostBindings();
    scheduleProfileSave(reason);
  }

  function findMappingConflict(bindingId, field, mapping) {
    const bindings = configPreviewOriginalBindings || getB();
    for (const binding of bindings) {
      if (binding.id === bindingId && field !== "control" && controlsEqual(binding[field], mapping)) {
        continue;
      }
      if (binding.id !== bindingId && controlsEqual({
        device_id: binding.device_id,
        channel: binding.control?.channel,
        controller: binding.control?.controller,
        msg_type: binding.control?.msg_type || "ControlChange",
      }, mapping)) {
        return { binding, field: "control" };
      }
      if (controlsEqual(binding.mute_control, mapping)) {
        return { binding, field: "mute_control" };
      }
      if (controlsEqual(binding.assign_control, mapping)) {
        return { binding, field: "assign_control" };
      }
      if (controlsEqual(binding.indicator_control, mapping)) {
        return { binding, field: "indicator_control" };
      }
    }
    return null;
  }

  function conflictFieldLabel(field, binding) {
    if (field === "control") return "Primary";
    if (field === "mute_control") return "Mute";
    if (field === "assign_control") return "Assign";
    if (field === "indicator_control") {
      return effectiveIsButton(binding) ? "Indicator" : "Feedback output";
    }
    return "Mapping";
  }

  async function commitTransferPrompt() {
    if (!transferPrompt) return;
    const { field, mapping, conflict } = transferPrompt;
    clearTransferPrompt();
    const binding = getConfigBinding();
    if (!binding) return;
    if (!conflict || !conflict.binding) return;
    if (field === "control") {
      binding.device_id = mapping.device_id;
      binding.control = {
        channel: mapping.channel,
        controller: mapping.controller,
        msg_type: mapping.msg_type || "ControlChange",
      };
      binding.control_kind = normalizeControlKind(mapping.control_kind);
      binding.mode = mapping.mode || binding.mode || "Absolute";
    } else {
      if (field === "mute_control" && mapping && typeof mapping === "object") {
        mapping.mute_behavior = normalizeMuteBehavior(mapping.mute_behavior || binding.mute_behavior);
      }
      binding[field] = mapping;
    }
    configAcceptedTransfers.set(field, { field, mapping, conflict });
    if (field === "control") {
      await applyPrimaryControlPreview();
    }
    hideLearnPanel();
    renderConfigModal();
  }

  async function applyAuxMapping(field, mapping) {
    const binding = getConfigBinding();
    if (!binding) return;
    ensureAuxShape(binding);

    const conflict = findMappingConflict(binding.id, field, mapping);
    if (conflict) {
      const ownerName = conflict.binding.name || "Binding";
      const ownerSlot = conflictFieldLabel(conflict.field, conflict.binding);
      const message = conflict.field === "control"
        ? `This control is the primary mapping on "${ownerName}". Transferring it here will delete that binding. Continue?`
        : `This control is already mapped as ${ownerSlot} on "${ownerName}". Transfer it here?`;
      setTransferPrompt({
        field,
        mapping,
        conflict,
        message,
      });
      setLearnPanelTransfer(message);
      return;
    }

    if (field === "control") {
      binding.device_id = mapping.device_id;
      binding.control = {
        channel: mapping.channel,
        controller: mapping.controller,
        msg_type: mapping.msg_type || "ControlChange",
      };
      binding.control_kind = normalizeControlKind(mapping.control_kind);
      binding.mode = mapping.mode || binding.mode || "Absolute";
    } else {
      if (field === "mute_control" && mapping && typeof mapping === "object") {
        mapping.mute_behavior = normalizeMuteBehavior(mapping.mute_behavior || binding.mute_behavior);
      }
      binding[field] = mapping;
    }
    configAcceptedTransfers.delete(field);
    if (field === "control") {
      await applyPrimaryControlPreview();
    }
    hideLearnPanel();
    renderConfigModal();
  }

  async function startPrimaryLearn() {
    const binding = getBindingById(configBindingId);
    if (!binding) return;
    if (transferPrompt || configLearnField) return;
    configLearnField = "control";
    renderConfigPreview();
    updateAuxLearnUi();
    setLearnPanelWaiting();
    await invoke("start_midi_learn");
    if (configLearnTimer) clearInterval(configLearnTimer);
    configLearnTimer = setInterval(async () => {
      try {
        const learned = await invoke("consume_learned_control");
        if (!learned) return;
        const targetField = configLearnField;
        stopAuxLearn({ closePanel: false });
        if (targetField !== "control") return;
        const mapping = normalizeAuxControl(learned);
        await applyAuxMapping("control", mapping);
      } catch {
        stopAuxLearn();
        renderConfigModal();
      }
    }, 200);
  }

  async function startAuxLearn(field) {
    const binding = getBindingById(configBindingId);
    if (!binding) return;
    if (transferPrompt) return;
    if (configLearnField) return;
    configLearnField = field;
    updateAuxLearnUi();
    setLearnPanelWaiting();
    await invoke("start_midi_learn");
    if (configLearnTimer) clearInterval(configLearnTimer);
    configLearnTimer = setInterval(async () => {
      try {
        const learned = await invoke("consume_learned_control");
        if (!learned) return;
        const targetField = configLearnField;
        stopAuxLearn({ closePanel: false });
        if (!targetField) return;
        const isFaderFeedbackOutput = targetField === "indicator_control" && !effectiveIsButton(getConfigBinding());
        const mapping = targetField === "indicator_control"
          ? normalizeIndicatorControl(learned, {
            allowPitchBend: isFaderFeedbackOutput,
            controlKind: isFaderFeedbackOutput ? "Continuous" : "Button",
          })
          : normalizeAuxControl(learned);
        if (!mapping) {
          renderConfigModal();
          return;
        }
        if (targetField === "indicator_control" && !effectiveIsButton(getConfigBinding())) {
          mapping.control_kind = "Continuous";
        }
        await applyAuxMapping(targetField, mapping);
      } catch {
        stopAuxLearn();
      }
    }, 200);
  }

  function openConfigModal(bindingId, options = {}) {
    const binding = getBindingById(bindingId);
    if (!binding) return;
    configBindingId = bindingId;
    configDraft = cloneBindingDraft(binding);
    ensureBindingShape(configDraft);
    configMacroPageOpen = Boolean(
      options.macroPage && (configDraft?.action === "Macro" || getTargets(configDraft).some(isMacroTarget)),
    );
    configMacroSelectedPath = configMacroPageOpen ? macroPathForFirstStep(configDraft) : null;
    configSoundboardPageOpen = Boolean(
      options.soundboardPage && (configDraft?.action === "Soundboard" || getTargets(configDraft).some(isSoundboardTarget)),
    );
    configRemoveEmptySoundboardTargetOnCancel = Boolean(
      options.removeEmptySoundboardTargetOnCancel
      && configSoundboardPageOpen
      && !normalizeSoundboardMapping(configDraft.soundboard),
    );
    soundboardAnalysis = options.soundboardAnalysis || null;
    soundboardAnalysisError = "";
    soundboardOutputDevicesLoaded = false;
    configAcceptedTransfers.clear();
    if (d.bindingConfigPanel) d.bindingConfigPanel.classList.remove("hidden");
    startConfigPreviewTimer();
    renderConfigModal();
    if (configSoundboardPageOpen) loadSoundboardOutputDevices().catch(() => { });
  }

  async function saveConfigModal() {
    if (transferPrompt) return;
    const original = getBindingById(configBindingId);
    const draft = getConfigBinding();
    if (!original || !draft) return;

    let nextBindings = [...getB()];
    for (const entry of configAcceptedTransfers.values()) {
      const { conflict } = entry;
      if (!conflict?.binding) continue;
      const conflictIndex = nextBindings.findIndex((binding) => binding.id === conflict.binding.id);
      if (conflictIndex < 0) continue;
      if (conflict.field === "control") {
        await invoke("remove_binding", { binding: nextBindings[conflictIndex] });
        nextBindings.splice(conflictIndex, 1);
        continue;
      }
      const nextConflictBinding = cloneBindingDraft(nextBindings[conflictIndex]);
      nextConflictBinding[conflict.field] = null;
      nextBindings[conflictIndex] = nextConflictBinding;
      setB(nextBindings);
      await persistBindingBackend(nextConflictBinding);
    }

    const bindingIndex = nextBindings.findIndex((binding) => binding.id === configBindingId);
    if (bindingIndex < 0) return;
    const nextBinding = cloneBindingDraft(draft);
    nextBindings[bindingIndex] = nextBinding;
    setB(nextBindings);
    await persistBindingBackend(nextBinding);
    renderBindings();
    await closeConfigModal({ commit: true });
    finishBindingUiMutation("config save");
  }

  function beginBindingEdit(bindingId, forceInline = false) {
    const binding = getBindingById(bindingId);
    if (!binding) return;
    if (!forceInline) {
      openConfigModal(bindingId);
      return;
    }
    suppressPendingFocusClearUntil = Date.now() + 250;
    setEditingId(bindingId);
    setPendingFocusId(bindingId);
    renderBindings();
  }

  function focusBindingNameInput(nameInput, bindingId, { select = false } = {}) {
    if (!nameInput) return;
    const applyFocus = () => {
      if (bindingId !== getEditingId()) return;
      if (!nameInput.isConnected) return;
      if (typeof window.focus === "function") {
        window.focus();
      }
      nameInput.focus({ preventScroll: true });
      if (select) {
        nameInput.select();
      }
    };
    applyFocus();
    requestAnimationFrame(applyFocus);
    requestAnimationFrame(() => requestAnimationFrame(applyFocus));
    setTimeout(applyFocus, 0);
    setTimeout(applyFocus, 32);
  }

  function isInlineNameEditingActive() {
    return Boolean(getEditingId());
  }

  function isBindingDragActive() {
    return Boolean(getDrag());
  }

  function requestSafeRerender(_reason = "") {
    if (isInlineNameEditingActive() || isBindingDragActive()) {
      pendingRerender = true;
      return;
    }
    renderBindings();
  }

  function flushPendingRerender({ fallbackRender = false } = {}) {
    if (pendingRerender) {
      pendingRerender = false;
      renderBindings();
      return true;
    }
    if (fallbackRender) {
      renderBindings();
      return true;
    }
    return false;
  }

  function renderBindings() {
    if (isBindingDragActive()) {
      pendingRerender = true;
      return;
    }

    const editingIdAtRenderStart = getEditingId();
    const activeEl = document.activeElement;
    const activeIsNameInput = Boolean(activeEl && activeEl.classList?.contains("binding-name-input"));
    const activeBindingId = activeIsNameInput ? String(activeEl.dataset?.bindingId || "") : "";
    const shouldRestoreEditingFocus = Boolean(
      editingIdAtRenderStart
      && activeBindingId
      && activeBindingId === String(editingIdAtRenderStart),
    );
    const selectionStart = shouldRestoreEditingFocus ? activeEl.selectionStart : null;
    const selectionEnd = shouldRestoreEditingFocus ? activeEl.selectionEnd : null;

    const bindings = getB();
    d.bindingsContainer.innerHTML = "";
    const searchQuery = getSearchQuery();
    const typeFilter = getBindingTypeFilter();
    const visibleBindingIds = [];
    let renderedCount = 0;

    if (!Array.isArray(bindings) || bindings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bindings-empty";
      empty.textContent = t("bindings.noBindings");
      d.bindingsContainer.appendChild(empty);
      queueBindingsScrollLayoutSync();
      return;
    }

    bindings.forEach((binding, index) => {
      try {
        ensureBindingShape(binding);
        setTargets(binding, getTargets(binding));
        binding.hotkey = normalizeHotkeyMapping(binding.hotkey);
        binding.open_application = normalizeOpenApplicationMapping(binding.open_application);
        binding.autohotkey_script = normalizeAutoHotkeyScriptMapping(binding.autohotkey_script);
        if (!bindingMatchesTypeFilter(binding, typeFilter)) {
          return;
        }
        if (searchQuery && !bindingSearchText(binding, index).includes(searchQuery)) {
          return;
        }
        const visibleIndex = visibleBindingIds.length;
        const bindingId = String(binding.id || "");
        visibleBindingIds.push(bindingId);
        renderedCount += 1;
        const item = document.createElement("div");
        item.className = "list-item binding-item";

        const row = document.createElement("div");
        row.className = "binding-row";

        item.dataset.index = index;
        item.dataset.visibleIndex = String(visibleIndex);
        item.dataset.bindingId = bindingId;

        const fallbackName = fallbackNameFor(binding, index);
        const isEditing = binding.id === getEditingId();
        let nameInput = null;
        let nameField = null;

        if (isEditing) {
          nameInput = document.createElement("input");
          nameInput.className = "binding-name-input";
          nameInput.dataset.bindingId = String(binding.id || "");
          nameInput.name = `binding-name-${binding.id || "new"}`;
          nameInput.autocomplete = "new-password";
          nameInput.autocorrect = "off";
          nameInput.autocapitalize = "off";
          nameInput.spellcheck = false;
          nameInput.setAttribute("data-lpignore", "true");
          nameInput.value = (nameDrafts.get(binding.id) ?? binding.name?.trim()) || fallbackName;
          ["pointerdown", "mousedown", "click"].forEach((eventName) => {
            nameInput.addEventListener(eventName, (event) => {
              event.stopPropagation();
            });
          });
          nameInput.addEventListener("input", () => {
            nameDrafts.set(binding.id, nameInput.value);
            if (binding.id === getPendingFocusId()) {
              setPendingFocusId(null);
            }
          });
          nameInput.addEventListener("keydown", (event) => {
            if (binding.id === getPendingFocusId() && event.key.length === 1) {
              setPendingFocusId(null);
            }
            if (event.key === "Enter") {
              event.preventDefault();
              nameInput.blur();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              nameDrafts.delete(binding.id);
              setEditingId(null);
              setPendingFocusId(null);
              flushPendingRerender({ fallbackRender: true });
            }
          });
          nameInput.addEventListener("blur", async () => {
            if (binding.id !== getEditingId()) {
              return;
            }
            // While pending auto-focus is active for a newly created binding,
            // ignore transient blur events from background rerenders/feedback updates.
            if (binding.id === getPendingFocusId()) {
              return;
            }
            // A rerender can briefly blur/recreate the input. Wait one tick and
            // only commit if we are no longer editing a binding-name input.
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (binding.id !== getEditingId()) {
              return;
            }
            if (binding.id === getPendingFocusId()) {
              return;
            }
            const activeEl = document.activeElement;
            if (activeEl && activeEl.classList?.contains("binding-name-input")) {
              return;
            }
            const draftValue = nameDrafts.get(binding.id);
            const trimmedName = (draftValue ?? nameInput.value).trim();
            nameDrafts.delete(binding.id);
            binding.name = trimmedName || fallbackName;
            setEditingId(null);
            setPendingFocusId(null);
            await invoke("add_binding", { binding });
            flushPendingRerender({ fallbackRender: true });
            finishBindingUiMutation("rename binding");
          });
          nameField = nameInput;
        } else {
          const nameLabel = document.createElement("div");
          nameLabel.className = "binding-name";
          nameLabel.textContent = binding.name?.trim() || fallbackName;
          nameLabel.title = t("bindings.doubleClickRename");
          nameLabel.addEventListener("mousedown", (event) => {
            event.stopPropagation();
          });
          nameLabel.addEventListener("dblclick", (event) => {
            event.preventDefault();
            event.stopPropagation();
            beginBindingEdit(binding.id, true);
          });
          nameField = nameLabel;
        }

        const rowNumber = document.createElement("button");
        rowNumber.type = "button";
        rowNumber.className = "binding-index binding-drag";
        rowNumber.title = t("bindings.dragToReorder");
        rowNumber.setAttribute("aria-label", t("bindings.dragToReorder"));
        const dragGrip = document.createElement("span");
        dragGrip.className = "drag-grip";
        dragGrip.setAttribute("aria-hidden", "true");
        rowNumber.appendChild(dragGrip);
        rowNumber.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          rowNumber.setPointerCapture(event.pointerId);
          startBindingDrag(item, {
            bindingId,
            visibleIndex,
            visibleBindingIds: visibleBindingIds.slice(),
          }, event);
        });
        rowNumber.addEventListener("pointerup", (event) => {
          rowNumber.releasePointerCapture(event.pointerId);
        });

        const isButton = effectiveIsButton(binding);

        const modeDropdown = document.createElement("div");
        modeDropdown.className = "target-dropdown mode-dropdown";
        const modeButton = document.createElement("button");
        modeButton.type = "button";
        modeButton.className = "target-button";
        modeButton.title = t("bindings.controlMode");
        modeButton.setAttribute("aria-haspopup", "listbox");
        modeButton.setAttribute("aria-expanded", "false");
        const modeDisplay = document.createElement("span");
        modeDisplay.className = "target-display";
        const modeCaret = document.createElement("span");
        modeCaret.className = "caret";
        modeCaret.textContent = "\u25be";
        modeButton.appendChild(modeDisplay);
        modeButton.appendChild(modeCaret);
        const modeMenu = document.createElement("div");
        modeMenu.className = "target-menu hidden";

        const modeOptions = [
          { value: "fader_abs", label: t("bindings.absolute"), badge: t("bindings.fader"), title: "" },
          { value: "fader_rel", label: t("bindings.relative"), badge: t("bindings.fader"), title: "" },
          { value: "button_toggle", label: t("bindings.toggle"), badge: t("bindings.button"), title: modeTooltip("button_toggle") },
          { value: "button_match", label: t("common.match"), badge: t("bindings.button"), title: modeTooltip("button_match") },
        ];

        let modeValue = "fader_abs";
        if (effectiveIsButton(binding)) {
          modeValue = buttonModeValue(binding);
        } else if (binding.mode === "Relative") {
          modeValue = "fader_rel";
        }

        const renderModeLabel = (container, option) => {
          renderLabelWithBadges(container, {
            text: option?.label || "",
            badges: option?.badge ? [{ text: option.badge, kind: "neutral" }] : [],
            truncate: false,
          });
        };

        const applyModeSelection = async (nextModeValue) => {
          if (nextModeValue === "button_toggle" || nextModeValue === "button_match") {
            const keepButtonAction = effectiveIsButton(binding) && binding.action !== "ToggleMute";
            binding.control_kind = "Button";
            if (!keepButtonAction) {
              binding.action = "ToggleMute";
            }
            binding.mute_behavior = nextModeValue === "button_match" ? "SetFromValue" : "ToggleOnPress";
            if (binding.mute_control && typeof binding.mute_control === "object") {
              binding.mute_control.mute_behavior = binding.mute_behavior;
            }
          } else if (nextModeValue === "fader_rel") {
            binding.control_kind = "Continuous";
            binding.mode = "Relative";
            binding.relative_format = normalizeRelativeFormat(binding.relative_format);
            binding.action = "Volume";
          } else {
            binding.control_kind = "Continuous";
            binding.mode = "Absolute";
            binding.relative_format = normalizeRelativeFormat(binding.relative_format);
            binding.action = "Volume";
          }

          await invoke("add_binding", { binding });
          renderBindings();
          finishBindingUiMutation("mode change");
        };

        modeOptions.forEach((option) => {
          const optionButton = document.createElement("button");
          optionButton.type = "button";
          optionButton.className = "target-option";
          if (option.value === modeValue) {
            optionButton.classList.add("selected");
          }
          const optionLabel = document.createElement("span");
          optionLabel.className = "target-label";
          renderModeLabel(optionLabel, option);
          if (option.title) {
            optionButton.title = option.title;
            optionButton.setAttribute("aria-label", option.title);
          }
          optionButton.appendChild(optionLabel);
          optionButton.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            modeDropdown.classList.remove("open");
            modeMenu.classList.add("hidden");
            modeButton.setAttribute("aria-expanded", "false");
            await applyModeSelection(option.value);
          });
          modeMenu.appendChild(optionButton);
        });

        const activeModeOption = modeOptions.find((option) => option.value === modeValue) || modeOptions[0];
        renderModeLabel(modeDisplay, activeModeOption);
        if (activeModeOption.title) {
          modeButton.title = activeModeOption.title;
          modeButton.setAttribute("aria-label", activeModeOption.title);
        }

        modeDropdown.__positionDropdownMenu = () => {
          positionFloatingDropdownMenu({
            menu: modeMenu,
            trigger: modeButton,
            minHeight: 132,
            maxHeight: 240,
          });
        };

        wireDropdownToggle({ root: modeDropdown, menu: modeMenu, trigger: modeButton });

        modeDropdown.appendChild(modeButton);
        modeDropdown.appendChild(modeMenu);

        const targetSelect = buildTarget(
          getTargets(binding),
          isButton,
          binding.action,
          binding.hotkey?.display || "",
          binding.open_application,
          binding.autohotkey_script,
          {
            macroDisplayName: binding.macro_name,
            macroAlreadyConfigured: isButton && (
              binding.action === "Macro" || getTargets(binding).some(isMacroTarget)
            ),
            onMacroAlreadyConfigured: showMacroAlreadyConfiguredError,
            soundboardAlreadyConfigured: isButton && (
              binding.action === "Soundboard" || getTargets(binding).some(isSoundboardTarget)
            ),
            onSoundboardAlreadyConfigured: showSoundboardAlreadyConfiguredError,
            macroBlockedBySoundboard: isButton && getTargets(binding).some(isSoundboardTarget),
            soundboardBlockedByMacro: isButton && getTargets(binding).some(isMacroTarget),
            onSpecialActionConflict: showSpecialActionConflictError,
          },
        );
        targetSelect.addEventListener("change", async () => {
          const previousTargets = getTargets(binding);
          const previousHadHotkeyTarget = previousTargets.some(isHotkeyTarget);
          const previousHadOpenApplicationTarget = previousTargets.some(isOpenApplicationTarget);
          const previousHadAutoHotkeyScriptTarget = previousTargets.some(isAutoHotkeyScriptTarget);
          const previousHadMacroTarget = previousTargets.some(isMacroTarget);
          const previousHadSoundboardTarget = previousTargets.some(isSoundboardTarget);
          const selectedTargets = Array.isArray(targetSelect.__selectedTargets)
            ? targetSelect.__selectedTargets
            : (targetSelect.__selectedTarget ? [targetSelect.__selectedTarget] : []);
          const hasSelectedTarget = selectedTargets.some((target) => target && target !== "Unset");
          const hasHotkeyTarget = selectedTargets.some(isHotkeyTarget);
          const hasOpenApplicationTarget = selectedTargets.some(isOpenApplicationTarget);
          const hasAutoHotkeyScriptTarget = selectedTargets.some(isAutoHotkeyScriptTarget);
          const hasMacroTarget = selectedTargets.some(isMacroTarget);
          const hasSoundboardTarget = selectedTargets.some(isSoundboardTarget);
          const hasRegularTarget = selectedTargets.some((target) => !isMacroTarget(target) && !isSoundboardTarget(target));
          const previousAction = binding.action;
          const previousHotkey = normalizeHotkeyMapping(binding.hotkey);
          const previousOpenApplication = normalizeOpenApplicationMapping(binding.open_application);
          const previousAutoHotkeyScript = normalizeAutoHotkeyScriptMapping(binding.autohotkey_script);
          const previousSoundboard = normalizeSoundboardMapping(binding.soundboard);

          if (isButton && hasMacroTarget && hasSoundboardTarget) {
            showSpecialActionConflictError();
            renderBindings();
            finishBindingUiMutation("special action conflict");
            return;
          }

          setTargets(binding, selectedTargets);

          if (isButton) {
            if (!hasSelectedTarget) {
              binding.action = "ToggleMute";
            } else if (hasRegularTarget) {
              const requestedAction = targetSelect.dataset.action || binding.action || "ToggleMute";
              binding.action = requestedAction === "Macro" || requestedAction === "Soundboard"
                ? ((previousAction === "Macro" || previousAction === "Soundboard") ? "ToggleMute" : previousAction)
                : requestedAction;
            } else if (hasMacroTarget) {
              binding.action = "Macro";
            } else if (hasSoundboardTarget) {
              binding.action = "Soundboard";
            } else {
              binding.action = targetSelect.dataset.action || binding.action || "ToggleMute";
            }
          } else {
            binding.action = "Volume";
          }

          if (isButton && hasMacroTarget) {
            binding.macro_steps = previousHadMacroTarget
              ? normalizeMacroSteps(binding.macro_steps)
              : [];
            ensureMacroName(binding, { defaultIfBlank: !previousHadMacroTarget });
          }

          if (isButton && hasSoundboardTarget) {
            binding.soundboard = previousSoundboard;
          } else if (previousHadSoundboardTarget || previousAction === "Soundboard") {
            binding.soundboard = null;
          }

          if (isButton && previousHadMacroTarget && !hasMacroTarget) {
            binding.macro_steps = [];
            binding.macro_name = "";
          }

          if (isButton && !hasHotkeyTarget && previousHadHotkeyTarget) {
            binding.hotkey = null;
            targetSelect?.setHotkeyDisplay?.("");
            if (binding.action === "Hotkey") {
              binding.action = targetSelect.dataset.action || "ToggleMute";
            }
          }

          if (isButton && !hasOpenApplicationTarget && previousHadOpenApplicationTarget) {
            binding.open_application = null;
            if (binding.action === "OpenApplication") {
              binding.action = targetSelect.dataset.action || "ToggleMute";
            }
          }

          if (isButton && !hasAutoHotkeyScriptTarget && previousHadAutoHotkeyScriptTarget) {
            binding.autohotkey_script = null;
            if (binding.action === "RunAutoHotkeyScript") {
              binding.action = targetSelect.dataset.action || "ToggleMute";
            }
          }

          if (isButton && hasHotkeyTarget && !previousHadHotkeyTarget) {
            const learnedHotkey = await startHotkeyLearn(binding);
            if (!learnedHotkey) {
              setTargets(binding, previousTargets);
              binding.action = previousAction || "ToggleMute";
              binding.hotkey = previousHotkey;
              binding.open_application = previousOpenApplication;
              binding.autohotkey_script = previousAutoHotkeyScript;
              binding.soundboard = previousSoundboard;
              await invoke("add_binding", { binding });
              renderBindings();
              finishBindingUiMutation("target rollback");
              return;
            }
            binding.hotkey = learnedHotkey;
            targetSelect?.setHotkeyDisplay?.(binding.hotkey?.display || "");
          }

          if (isButton && binding.action === "OpenApplication") {
            binding.open_application = normalizeOpenApplicationMapping(
              targetSelect?.getOpenApplication?.() || targetSelect?.__openApplication,
            );
          } else {
            binding.open_application = null;
          }

          if (isButton && binding.action === "RunAutoHotkeyScript") {
            binding.autohotkey_script = normalizeAutoHotkeyScriptMapping(
              targetSelect?.getAutoHotkeyScript?.() || targetSelect?.__autoHotkeyScript,
            );
          } else {
            binding.autohotkey_script = null;
          }

          if (isButton && !hasHotkeyTarget && !hasOpenApplicationTarget && !hasAutoHotkeyScriptTarget && binding.action === "OpenApplication" && !binding.open_application) {
            setTargets(binding, previousTargets);
            binding.action = previousAction || "ToggleMute";
            binding.hotkey = previousHotkey;
            binding.open_application = previousOpenApplication;
            binding.autohotkey_script = previousAutoHotkeyScript;
            await invoke("add_binding", { binding });
            renderBindings();
            finishBindingUiMutation("target rollback");
            return;
          }

          if (isButton && !hasHotkeyTarget && !hasOpenApplicationTarget && !hasAutoHotkeyScriptTarget && binding.action === "RunAutoHotkeyScript" && !binding.autohotkey_script) {
            setTargets(binding, previousTargets);
            binding.action = previousAction || "ToggleMute";
            binding.hotkey = previousHotkey;
            binding.open_application = previousOpenApplication;
            binding.autohotkey_script = previousAutoHotkeyScript;
            await invoke("add_binding", { binding });
            renderBindings();
            finishBindingUiMutation("target rollback");
            return;
          }

          if (!isButton) {
            const primaryTarget = getPrimaryTarget(binding);
            const newVolume = resolveTargetChangeVolumeValue({
              targetVolume: getVol(primaryTarget),
              cachedVolume: bindingLastValues[binding.id],
            });
            if (volumeSlider) {
              // Keep current slider position if the new primary target cannot report
              // a concrete volume (common for some integration targets).
              // This prevents motorized faders from jumping when removing targets.
              if (typeof newVolume === "number" && Number.isFinite(newVolume)) {
                setSliderVolume(volumeSlider, newVolume, { bindingId: binding.id });
              }
              volumeSlider.dataset.targetJson = JSON.stringify(primaryTarget);
            }

            const newMuted = (bindingMuteValues[binding.id] != null)
              ? Boolean(bindingMuteValues[binding.id])
              : getMuted(primaryTarget);
            if (muteButton) {
              setMuteButtonState(muteButton, newMuted);
              muteButton.dataset.targetJson = JSON.stringify(primaryTarget);
            }
          }

          await invoke("add_binding", { binding });
          renderBindings();
          finishBindingUiMutation("target change");
          if (isButton && hasMacroTarget && !previousHadMacroTarget) {
            openConfigModal(binding.id, { macroPage: true });
          } else if (isButton && hasSoundboardTarget && !previousHadSoundboardTarget) {
            openConfigModal(binding.id, {
              soundboardPage: true,
              removeEmptySoundboardTargetOnCancel: true,
            });
          }
        });

        const volumeSlider = document.createElement("input");
        volumeSlider.type = "range";
        volumeSlider.className = "binding-volume-slider";
        volumeSlider.min = "0";
        volumeSlider.max = "1";
        volumeSlider.step = "0.01";
        volumeSlider.title = "Volume";

        if (isButton) {
          volumeSlider.disabled = true;
          volumeSlider.style.visibility = "hidden";
        } else {
          const primaryTarget = getPrimaryTarget(binding);
          const resolvedVolume = resolveRenderedBindingVolume(binding.id, primaryTarget);
          const v = resolvedVolume.value;

          if (v !== null && resolvedVolume.source === "target") {
            bindingLastValues[binding.id] = v;
          }
          volumeSlider.value = v ?? 0;
          updateSliderFill(volumeSlider);

          const targetJson = JSON.stringify(primaryTarget);
          volumeSlider.dataset.targetJson = targetJson;
          volumeSlider.dataset.bindingId = binding.id;

          volumeSlider.addEventListener("input", async (e) => {
            bindingInteractionTimes[binding.id] = Date.now();
            const vol = parseFloat(e.target.value);
            const sourceSequence = (sliderIntentSequenceByBinding[binding.id] || 0) + 1;
            sliderIntentSequenceByBinding[binding.id] = sourceSequence;
            setSliderVolume(e.target, vol, { bindingId: binding.id, markMidiUpdate: true });
            queueSliderAction(binding.id, vol, sourceSequence);
          });
        }

        const muteButton = document.createElement("button");
        muteButton.type = "button";
        muteButton.className = "binding-mute-button";
        const primaryTarget = getPrimaryTarget(binding);
        const isMuted = (bindingMuteValues[binding.id] != null)
          ? Boolean(bindingMuteValues[binding.id])
          : Boolean(getMuted(primaryTarget));
        const visualBehavior = buttonVisualBehavior(binding);
        setMuteButtonState(muteButton, isMuted);
        muteButton.dataset.targetJson = JSON.stringify(primaryTarget);
        muteButton.dataset.bindingId = binding.id;

        if (isButton) {
          muteButton.classList.add("visually-hidden");
          muteButton.tabIndex = -1;
          muteButton.setAttribute("aria-hidden", "true");
        }

        muteButton.addEventListener("click", async () => {
          bindingInteractionTimes[binding.id] = Date.now();
          const currentlyMuted = muteButton.classList.contains("muted");
          const newMuted = !currentlyMuted;
          setMuteButtonState(muteButton, newMuted);
          bindingMuteValues[binding.id] = newMuted;

          try {
            await invoke("apply_binding_action", {
              bindingId: binding.id,
              action: "ToggleMute",
              value: newMuted ? 1.0 : 0.0,
              silent: false,
            });
          } catch (err) {
            setMuteButtonState(muteButton, currentlyMuted);
            bindingMuteValues[binding.id] = currentlyMuted;
            console.error("Failed to toggle mute:", err);
          }
        });

        const actions = document.createElement("div");
        actions.className = "binding-actions";

        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "binding-action";
        setActionIcon(editButton, "edit", isButton ? t("bindings.configureButton") : t("bindings.configureFader"));
        editButton.addEventListener("click", () => {
          beginBindingEdit(binding.id);
        });

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "binding-action delete";
        setActionIcon(deleteButton, "delete", t("bindings.deleteBinding"));
        deleteButton.addEventListener("click", async () => {
          const confirmed = await confirmAction({
            title: t("bindings.deleteBindingTitle"),
            message: t("bindings.deleteBindingMessage", { name: binding.name || t("bindings.title") }),
            confirmLabel: t("common.delete"),
            cancelLabel: t("common.cancel"),
            confirmVariant: "danger",
          });
          if (!confirmed) {
            return;
          }
          try {
            await invoke("remove_binding", { binding });
            const next = getB();
            next.splice(index, 1);
            setB(next);
            renderBindings();
            finishBindingUiMutation("delete binding");
          } catch (err) {
            console.error("Failed to remove binding:", err);
          }
        });

        actions.appendChild(editButton);
        actions.appendChild(deleteButton);

        const valueGroup = document.createElement("div");
        valueGroup.className = "binding-value-cell";
        if (isButton) {
          valueGroup.classList.add("binding-value-cell--button");
          const pulse = document.createElement("button");
          pulse.type = "button";
          pulse.className = "binding-momentary-value";
          const isStatefulButton = visualBehavior === "stateful";
          const isMomentaryPress = visualBehavior === "momentary";
          const usesPressReleaseCommand = buttonUsesPressReleaseCommand(binding);
          pulse.classList.add(
            "binding-button-value",
            isStatefulButton ? "binding-button-value--stateful" : "binding-button-value--momentary",
          );
          pulse.classList.toggle("is-active", buttonVisualActive(binding, { fallbackMuted: isMuted }));
          pulse.dataset.bindingId = binding.id;
          pulse.title = isStatefulButton ? t("bindings.toggleBinding") : t("bindings.triggerBinding");
          pulse.setAttribute("aria-label", pulse.title);

          const invokeButtonValue = async (value) => {
            await invoke("apply_binding_action", {
              bindingId: binding.id,
              action: binding.action || "Volume",
              value,
              silent: false,
              source: "ui_button",
            });
          };

          const releaseMomentary = async () => {
            if (!pulse.__buttonPressed) return;
            pulse.__buttonPressed = false;
            pulse.classList.remove("is-active");
            if (!usesPressReleaseCommand) return;
            try {
              await invokeButtonValue(0.0);
            } catch (err) {
              console.error("Failed to release binding:", err);
            }
          };

          if (isStatefulButton) {
            pulse.addEventListener("click", async () => {
              bindingInteractionTimes[binding.id] = Date.now();
              if (binding.action === "ToggleMute") {
                muteButton.click();
                return;
              }
              const currentlyOn = pulse.classList.contains("is-active");
              pulse.classList.toggle("is-active", !currentlyOn);
              bindingLastValues[binding.id] = currentlyOn ? 0.0 : 1.0;
              try {
                await invokeButtonValue(1.0);
              } catch (err) {
                pulse.classList.toggle("is-active", currentlyOn);
                bindingLastValues[binding.id] = currentlyOn ? 1.0 : 0.0;
                console.error("Failed to trigger toggle action:", err);
              }
            });
          } else if (usesPressReleaseCommand) {
            pulse.addEventListener("pointerdown", async (event) => {
              event.preventDefault();
              if (pulse.__buttonPressed) return;
              pulse.__buttonPressed = true;
              bindingInteractionTimes[binding.id] = Date.now();
              pulse.classList.add("is-active");
              try {
                pulse.setPointerCapture?.(event.pointerId);
              } catch {}
              try {
                await invokeButtonValue(1.0);
              } catch (err) {
                pulse.__buttonPressed = false;
                pulse.classList.remove("is-active");
                console.error("Failed to trigger binding:", err);
              }
            });
            pulse.addEventListener("pointerup", releaseMomentary);
            pulse.addEventListener("pointercancel", releaseMomentary);
            pulse.addEventListener("lostpointercapture", releaseMomentary);
          } else if (isMomentaryPress) {
            pulse.addEventListener("click", async () => {
              bindingInteractionTimes[binding.id] = Date.now();
              pulseMomentaryValue(pulse);
              try {
                await invokeButtonValue(1.0);
              } catch (err) {
                console.error("Failed to trigger binding:", err);
              }
            });
          }
          pulse.addEventListener("keydown", async (event) => {
            if (event.key !== " " && event.key !== "Enter") return;
            if (!usesPressReleaseCommand || pulse.__buttonPressed) return;
            event.preventDefault();
            bindingInteractionTimes[binding.id] = Date.now();
            pulse.__buttonPressed = true;
            pulse.classList.add("is-active");
            try {
              await invokeButtonValue(1.0);
            } catch (err) {
              pulse.__buttonPressed = false;
              pulse.classList.remove("is-active");
              console.error("Failed to trigger binding:", err);
            }
          });
          pulse.addEventListener("keyup", async (event) => {
            if (event.key !== " " && event.key !== "Enter") return;
            if (!usesPressReleaseCommand) return;
            event.preventDefault();
            await releaseMomentary();
          });
          valueGroup.appendChild(pulse);
          if (getTargets(binding).some(isMacroTarget)) {
            valueGroup.classList.add("binding-value-cell--macro");
            const editMacroButton = document.createElement("button");
            editMacroButton.type = "button";
            editMacroButton.className = "binding-macro-edit-button";
            editMacroButton.textContent = t("macro.edit");
            editMacroButton.title = t("macro.edit");
            editMacroButton.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              openConfigModal(binding.id, { macroPage: true });
            });
            valueGroup.appendChild(editMacroButton);
          }
          if (getTargets(binding).some(isSoundboardTarget)) {
            valueGroup.classList.add("binding-value-cell--soundboard");
            const editSoundButton = document.createElement("button");
            editSoundButton.type = "button";
            editSoundButton.className = "binding-macro-edit-button binding-soundboard-edit-button";
            editSoundButton.textContent = t("soundboard.edit");
            editSoundButton.title = t("soundboard.edit");
            editSoundButton.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              openConfigModal(binding.id, { soundboardPage: true });
            });
            valueGroup.appendChild(editSoundButton);
          }
          if (binding.action === "ToggleMute") {
            valueGroup.appendChild(muteButton);
          }
        } else {
          const sliderWrap = document.createElement("div");
          sliderWrap.className = "binding-slider-wrap";

          const percent = document.createElement("span");
          percent.className = "binding-volume-percent";
          const updatePercent = () => {
            percent.textContent = `${Math.round((Number(volumeSlider.value) || 0) * 100)}%`;
          };
          updatePercent();
          volumeSlider.addEventListener("input", updatePercent);
          sliderWrap.appendChild(volumeSlider);
          valueGroup.appendChild(sliderWrap);
          valueGroup.appendChild(percent);
          valueGroup.appendChild(muteButton);
        }

        row.appendChild(rowNumber);
        row.appendChild(nameField);
        row.appendChild(modeDropdown);
        row.appendChild(targetSelect);
        row.appendChild(valueGroup);
        row.appendChild(actions);
        item.appendChild(row);
        d.bindingsContainer.appendChild(item);

        if (nameInput && shouldRestoreEditingFocus && String(binding.id) === String(editingIdAtRenderStart)) {
          focusBindingNameInput(nameInput, binding.id);
          if (Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) {
            const max = nameInput.value.length;
            const safeStart = Math.max(0, Math.min(selectionStart, max));
            const safeEnd = Math.max(safeStart, Math.min(selectionEnd, max));
            nameInput.setSelectionRange(safeStart, safeEnd);
          }
        } else if (binding.id === getPendingFocusId() && nameInput) {
          setEditingId(binding.id);
          focusBindingNameInput(nameInput, binding.id, { select: true });
        }
      } catch (err) {
        const errorItem = document.createElement("div");
        errorItem.className = "list-item binding-item error-binding";
        errorItem.textContent = t("bindings.errorPrefix", { message: err.message || err });
        errorItem.style.color = "red";
        errorItem.style.padding = "10px";

        const delBtn = document.createElement("button");
        delBtn.textContent = "\ud83d\uddd1";
        delBtn.className = "icon-button danger";
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          const confirmed = await confirmAction({
            title: t("bindings.deleteBrokenTitle"),
            message: t("bindings.deleteBrokenMessage"),
            confirmLabel: t("common.delete"),
            cancelLabel: t("common.cancel"),
            confirmVariant: "danger",
          });
          if (!confirmed) {
            return;
          }
          try {
            await invoke("remove_binding", { binding });
          } catch { }
          renderBindings();
          finishBindingUiMutation("delete broken binding");
        };
        errorItem.appendChild(delBtn);

        d.bindingsContainer.appendChild(errorItem);
      }
    });

    if (renderedCount === 0) {
      const empty = document.createElement("div");
      empty.className = "bindings-empty";
      empty.textContent = searchQuery
        ? t("bindings.noSearchResults")
        : (typeFilter === "all" ? t("bindings.noSearchResults") : t("bindings.noFilterResults"));
      d.bindingsContainer.appendChild(empty);
    }

    queueBindingsScrollLayoutSync();
    flushQueuedBindingReveal();
  }

  function startBindingDrag(item, dragInfo, event) {
    const rect = item.getBoundingClientRect();
    const ghost = item.cloneNode(true);
    ghost.classList.add("binding-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.opacity = "0";

    const placeholder = document.createElement("div");
    placeholder.className = "binding-placeholder";
    placeholder.style.height = `${rect.height}px`;

    document.body.appendChild(ghost);

    const bindingId = String(dragInfo?.bindingId || item.dataset?.bindingId || "");
    const visibleIndex = Number.isInteger(dragInfo?.visibleIndex)
      ? dragInfo.visibleIndex
      : Number(item.dataset?.visibleIndex || 0);
    const visibleBindingIds = Array.isArray(dragInfo?.visibleBindingIds)
      ? dragInfo.visibleBindingIds.map((id) => String(id || ""))
      : Array.from(d.bindingsContainer.querySelectorAll(".binding-item[data-binding-id]"))
        .map((bindingItem) => String(bindingItem.dataset?.bindingId || ""))
        .filter(Boolean);

    setDrag({
      bindingId,
      visibleIndex,
      visibleBindingIds,
      item,
      ghost,
      placeholder,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    });

    item.classList.add("dragging");
    document.body.classList.add("dragging-binding");
  }

  function updateBindingDrag(event) {
    const dragState = getDrag();
    if (!dragState) return;

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (!dragState.active) {
      if (Math.hypot(deltaX, deltaY) < 6) {
        return;
      }
      dragState.active = true;
      dragState.item.style.display = "none";
      d.bindingsContainer.insertBefore(dragState.placeholder, dragState.item.nextSibling);
      dragState.ghost.style.opacity = "0.85";
    }

    dragState.ghost.style.left = `${event.clientX - dragState.offsetX}px`;
    dragState.ghost.style.top = `${event.clientY - dragState.offsetY}px`;

    const target = document.elementFromPoint(event.clientX, event.clientY);
    const bindingItem = target?.closest(".binding-item");
    if (!bindingItem || bindingItem === dragState.item) {
      return;
    }

    const rect = bindingItem.getBoundingClientRect();
    const insertBefore = event.clientY < rect.top + rect.height / 2;
    const reference = insertBefore ? bindingItem : bindingItem.nextSibling;
    if (reference !== dragState.placeholder) {
      d.bindingsContainer.insertBefore(dragState.placeholder, reference);
    }
  }

  function placeholderVisibleIndex(visibleBindingIds = []) {
    const visibleIdSet = new Set(visibleBindingIds.map((id) => String(id || "")));
    const children = Array.from(d.bindingsContainer.children);
    let index = 0;
    for (const child of children) {
      if (child.classList.contains("binding-placeholder")) {
        return index;
      }
      if (
        child.classList.contains("binding-item")
        && visibleIdSet.has(String(child.dataset?.bindingId || ""))
      ) {
        index += 1;
      }
    }
    return null;
  }

  async function endBindingDrag() {
    const dragState = getDrag();
    if (!dragState) return;
    const { bindingId, visibleIndex, visibleBindingIds, item, ghost, placeholder, active } = dragState;
    const newIndex = active ? placeholderVisibleIndex(visibleBindingIds) : null;
    setDrag(null);

    item.style.display = "";
    item.classList.remove("dragging");
    ghost.remove();
    if (active) {
      placeholder.remove();
    }
    document.body.classList.remove("dragging-binding");

    if (active && newIndex !== null) {
      const destinationVisibleIndex = (newIndex > visibleIndex) ? (newIndex - 1) : newIndex;
      const result = reorderVisibleBindings(
        getB(),
        visibleBindingIds,
        bindingId,
        destinationVisibleIndex,
      );
      if (result.changed) {
        setB(result.bindings);
        renderBindings();
        finishBindingUiMutation("reorder bindings");
      }
    }

    flushPendingRerender();
  }

  function cancelBindingDrag() {
    const dragState = getDrag();
    if (!dragState) return;
    dragState.item.style.display = "";
    dragState.item.classList.remove("dragging");
    dragState.ghost.remove();
    if (dragState.active) {
      dragState.placeholder.remove();
    }
    setDrag(null);
    document.body.classList.remove("dragging-binding");
    flushPendingRerender();
  }

  function bindConfigModalUi() {
    const cancelAuxLearnFlow = () => {
      if (!configBindingId) return;
      clearTransferPrompt();
      stopAuxLearn();
      renderConfigModal();
    };

    if (d.bindingConfigButtonLightSelect && !buttonLightDropdown) {
      buttonLightDropdown = createSelectDropdownShell({
        selectEl: d.bindingConfigButtonLightSelect,
        rootClass: "binding-config-light-dropdown settings-select-dropdown",
        title: t("bindings.toggleMuteLight"),
      });
      renderButtonLightDropdown();
    }
    if (d.bindingConfigIndicatorMsgType && !indicatorMsgTypeDropdown) {
      indicatorMsgTypeDropdown = createSelectDropdownShell({
        selectEl: d.bindingConfigIndicatorMsgType,
        rootClass: "binding-config-light-dropdown settings-select-dropdown",
        title: "Indicator message type",
      });
    }
    if (d.bindingConfigFeedbackMsgType && !feedbackOutputMsgTypeDropdown) {
      feedbackOutputMsgTypeDropdown = createSelectDropdownShell({
        selectEl: d.bindingConfigFeedbackMsgType,
        rootClass: "binding-config-light-dropdown settings-select-dropdown",
        title: t("bindings.feedbackMessageType"),
      });
    }
    renderIndicatorDropdowns();

    if (d.bindingConfigPanel) {
      d.bindingConfigPanel.addEventListener("click", (event) => {
        if (event.target === d.bindingConfigPanel) {
          closeConfigModal().catch((err) => console.error("Failed to close binding config:", err));
        }
      });
    }
    if (d.bindingConfigClose) {
      d.bindingConfigClose.addEventListener("click", () => {
        closeConfigModal().catch((err) => console.error("Failed to close binding config:", err));
      });
    }
    ensureMacroConfigDom();
    if (d.bindingConfigCancel) {
      d.bindingConfigCancel.addEventListener("click", () => {
        closeConfigModal().catch((err) => console.error("Failed to close binding config:", err));
      });
    }
    if (d.bindingConfigSave) {
      d.bindingConfigSave.addEventListener("click", async () => {
        await saveConfigModal();
      });
    }
    if (d.bindingConfigName) {
      d.bindingConfigName.addEventListener("input", () => {
        const binding = getConfigBinding();
        if (!binding) return;
        binding.name = d.bindingConfigName.value;
        renderConfigPreview();
      });
    }
    if (d.bindingConfigButtonLightSelect) {
      d.bindingConfigButtonLightSelect.addEventListener("change", () => {
        const binding = getConfigBinding();
        if (!binding) return;
        const nextMode = d.bindingConfigButtonLightSelect.value;
        if (nextMode === "MappedWhenAssigned") {
          binding.button_light_mode = "MappedWhenAssigned";
          binding.button_light_behavior = normalizeButtonLightBehavior(binding.button_light_behavior);
        } else {
          binding.button_light_mode = "Activity";
          binding.button_light_behavior = normalizeButtonLightBehavior(nextMode);
        }
        syncButtonLightUi(binding);
        renderConfigPreview();
      });
    }
    d.bindingConfigIndicatorMsgType?.addEventListener("change", updateIndicatorFromFields);
    d.bindingConfigIndicatorChannel?.addEventListener("input", updateIndicatorFromFields);
    d.bindingConfigIndicatorController?.addEventListener("input", updateIndicatorFromFields);
    d.bindingConfigFeedbackMsgType?.addEventListener("change", updateFeedbackOutputFromFields);
    d.bindingConfigFeedbackChannel?.addEventListener("input", updateFeedbackOutputFromFields);
    d.bindingConfigFeedbackController?.addEventListener("input", updateFeedbackOutputFromFields);
    if (d.bindingConfigPreviewLearnButton) {
      d.bindingConfigPreviewLearnButton.addEventListener("click", async () => {
        await startPrimaryLearn();
      });
    }
    if (d.bindingConfigButtonLearnButton) {
      d.bindingConfigButtonLearnButton.addEventListener("click", async () => {
        await startPrimaryLearn();
      });
    }
    document.addEventListener("keydown", (event) => {
      if (!configBindingId || event.key !== "Escape") return;
      if (transferPrompt || configLearnField || hotkeyLearnBindingId) return;
      closeConfigModal().catch((err) => console.error("Failed to close binding config:", err));
    });
    if (d.bindingConfigCustomReset) {
      d.bindingConfigCustomReset.addEventListener("click", () => {
        const binding = getConfigBinding();
        if (!binding) return;
        binding.custom_curve = presetCurvePoints(binding.fader_curve);
        selectedCustomCurvePresetId = null;
        closeCurvePresetForm();
        renderConfigModal();
      });
    }
    if (d.bindingConfigCurvePresetButton) {
      d.bindingConfigCurvePresetButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setCurvePresetMenuOpen(!curvePresetMenuOpen);
      });
    }
    if (d.bindingConfigCurvePresetSearch) {
      d.bindingConfigCurvePresetSearch.addEventListener("input", () => {
        curvePresetSearchQuery = d.bindingConfigCurvePresetSearch.value || "";
        renderCurvePresetMenu();
      });
      d.bindingConfigCurvePresetSearch.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    }
    if (d.bindingConfigCurvePresetSave) {
      d.bindingConfigCurvePresetSave.addEventListener("click", () => {
        const binding = getConfigBinding();
        if (!binding) return;
        openCurvePresetForm("save", activeCustomCurvePreset(binding));
      });
    }
    if (d.bindingConfigCurvePresetFormSave) {
      d.bindingConfigCurvePresetFormSave.addEventListener("click", async () => {
        await submitCurvePresetForm();
      });
    }
    if (d.bindingConfigCurvePresetFormCancel) {
      d.bindingConfigCurvePresetFormCancel.addEventListener("click", () => {
        closeCurvePresetForm();
      });
    }
    if (d.bindingConfigCurvePresetForm) {
      d.bindingConfigCurvePresetForm.addEventListener("click", (event) => {
        if (event.target === d.bindingConfigCurvePresetForm) {
          closeCurvePresetForm();
        }
      });
    }
    if (d.bindingConfigCurvePresetName) {
      d.bindingConfigCurvePresetName.addEventListener("keydown", async (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          await submitCurvePresetForm();
        } else if (event.key === "Escape") {
          event.preventDefault();
          closeCurvePresetForm();
        }
      });
    }
    if (d.bindingConfigMuteLearn) {
      d.bindingConfigMuteLearn.addEventListener("click", async () => {
        await startAuxLearn("mute_control");
      });
    }
    if (d.bindingConfigAssignLearn) {
      d.bindingConfigAssignLearn.addEventListener("click", async () => {
        await startAuxLearn("assign_control");
      });
    }
    if (d.bindingConfigIndicatorLearn) {
      d.bindingConfigIndicatorLearn.addEventListener("click", async () => {
        await startAuxLearn("indicator_control");
      });
    }
    if (d.bindingConfigFeedbackLearn) {
      d.bindingConfigFeedbackLearn.addEventListener("click", async () => {
        await startAuxLearn("indicator_control");
      });
    }
    if (d.bindingConfigMuteClear) {
      d.bindingConfigMuteClear.addEventListener("click", () => {
        if (transferPrompt) return;
        const binding = getConfigBinding();
        if (!binding) return;
        binding.mute_control = null;
        configAcceptedTransfers.delete("mute_control");
        renderConfigModal();
      });
    }
    if (d.bindingConfigMuteModeButton) {
      d.bindingConfigMuteModeButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const menu = d.bindingConfigMuteModeMenu;
        if (!menu) return;
        if (menu.classList.contains("hidden")) {
          openMuteModeMenu();
        } else {
          closeMuteModeMenu();
        }
      });
    }
    if (d.bindingConfigAssignClear) {
      d.bindingConfigAssignClear.addEventListener("click", () => {
        if (transferPrompt) return;
        const binding = getConfigBinding();
        if (!binding) return;
        binding.assign_control = null;
        configAcceptedTransfers.delete("assign_control");
        renderConfigModal();
      });
    }
    if (d.bindingConfigIndicatorClear) {
      d.bindingConfigIndicatorClear.addEventListener("click", () => {
        if (transferPrompt) return;
        const binding = getConfigBinding();
        if (!binding) return;
        binding.indicator_control = null;
        configAcceptedTransfers.delete("indicator_control");
        syncIndicatorUi(binding);
        renderConfigPreview();
      });
    }
    if (d.bindingConfigFeedbackClear) {
      d.bindingConfigFeedbackClear.addEventListener("click", () => {
        if (transferPrompt) return;
        const binding = getConfigBinding();
        if (!binding) return;
        binding.indicator_control = null;
        configAcceptedTransfers.delete("indicator_control");
        syncFeedbackOutputUi(binding);
        renderConfigPreview();
      });
    }
    const onMuteModeOptionClick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      const mode = normalizeMuteBehavior(button?.dataset?.mode);
      const binding = getConfigBinding();
      if (!binding) return;
      binding.mute_behavior = mode;
      if (binding.mute_control && typeof binding.mute_control === "object") {
        binding.mute_control.mute_behavior = mode;
      }
      renderMuteMappingLabel(binding);
      syncMuteModeUi(mode);
      closeMuteModeMenu();
      renderConfigPreview();
    };
    if (d.bindingConfigMuteModeToggle) {
      d.bindingConfigMuteModeToggle.addEventListener("click", onMuteModeOptionClick);
    }
    if (d.bindingConfigMuteModeValue) {
      d.bindingConfigMuteModeValue.addEventListener("click", onMuteModeOptionClick);
    }
    if (d.bindingConfigAssignModeButton) {
      d.bindingConfigAssignModeButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const menu = d.bindingConfigAssignModeMenu;
        if (!menu) return;
        if (menu.classList.contains("hidden")) {
          openAssignModeMenu();
        } else {
          closeAssignModeMenu();
        }
      });
    }
    const onAssignModeOptionClick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      const mode = button?.dataset?.mode === "Replace" ? "Replace" : "Add";
      const binding = getConfigBinding();
      if (!binding) return;
      binding.assign_mode = mode;
      renderAssignMappingLabel(binding);
      syncAssignModeUi(binding.assign_mode);
      closeAssignModeMenu();
      renderConfigPreview();
    };
    if (d.bindingConfigAssignModeAdd) {
      d.bindingConfigAssignModeAdd.addEventListener("click", onAssignModeOptionClick);
    }
    if (d.bindingConfigAssignModeReplace) {
      d.bindingConfigAssignModeReplace.addEventListener("click", onAssignModeOptionClick);
    }

    if (d.learnPanel) {
      d.learnPanel.addEventListener("click", (event) => {
        if (event.target !== d.learnPanel) return;
        if (hotkeyLearnBindingId) return;
        if (!configBindingId) return;
        cancelAuxLearnFlow();
      });
    }
    if (d.learnPanelClose) {
      d.learnPanelClose.addEventListener("click", () => {
        if (hotkeyLearnBindingId) return;
        if (!configBindingId) return;
        cancelAuxLearnFlow();
      });
    }
    if (d.learnPanelCancel) {
      d.learnPanelCancel.addEventListener("click", () => {
        if (hotkeyLearnBindingId) return;
        if (!configBindingId) return;
        cancelAuxLearnFlow();
      });
    }
    if (d.learnPanelConfirm) {
      d.learnPanelConfirm.addEventListener("click", async () => {
        if (!configBindingId || !transferPrompt) return;
        await commitTransferPrompt();
      });
    }

    if (d.bindingConfigCurveCards) {
      d.bindingConfigCurveCards.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        const target = event.target instanceof Element
          ? event.target.closest("circle.binding-config-curve-card-point")
          : null;
        if (target) {
          const card = target.closest(".binding-config-curve-card");
          if (!card || card.dataset.curve !== "Custom") return;
          const index = Number(target.dataset.pointIndex);
          if (!Number.isFinite(index)) return;
          event.preventDefault();
          event.stopPropagation();
          const surfaceEl = target.closest(".binding-config-curve-card-visual");
          if (!surfaceEl) return;
          customCurvePointer = { mode: "point", index, surfaceEl };
          target.setPointerCapture?.(event.pointerId);
          updateCustomCurveFromPointer(event);
          return;
        }

        const surfaceEl = customCurveSurfaceFromEvent(event);
        if (!surfaceEl || !event.altKey) return;
        const binding = getConfigBinding();
        const localPoint = binding ? localCustomCurvePoint(event, surfaceEl) : null;
        if (!binding || !localPoint) return;
        const points = curveEditorPoints(binding);
        const index = segmentIndexForCurveX(points, localPoint.x);
        if (index < 0) return;
        event.preventDefault();
        event.stopPropagation();
        customCurvePointer = { mode: "segment", index, surfaceEl };
        surfaceEl.setPointerCapture?.(event.pointerId);
        updateCustomCurveFromPointer(event);
      });

      d.bindingConfigCurveCards.addEventListener("dblclick", (event) => {
        addCustomCurvePoint(event);
      });

      d.bindingConfigCurveCards.addEventListener("contextmenu", (event) => {
        const target = event.target instanceof Element
          ? event.target.closest("circle.binding-config-curve-card-point")
          : null;
        if (!target) return;
        const card = target.closest(".binding-config-curve-card");
        if (!card || card.dataset.curve !== "Custom") return;
        const index = Number(target.dataset.pointIndex);
        if (!Number.isFinite(index)) return;
        removeCustomCurvePoint(index, event);
      });
    }

    document.addEventListener("click", (event) => {
      if (!configBindingId) return;
      const muteRoot = d.bindingConfigMuteModeRoot;
      if (muteRoot && !muteRoot.contains(event.target)) {
        closeMuteModeMenu();
      }
      const curvePresetRoot = d.bindingConfigCurvePresetRoot;
      if (d.alertOverlay?.contains?.(event.target)) {
        return;
      }
      if (curvePresetRoot && !curvePresetRoot.contains(event.target)) {
        closeCurvePresetMenu();
      }
      const root = d.bindingConfigAssignModeRoot;
      if (!root || root.contains(event.target)) return;
      closeAssignModeMenu();
    });

    document.addEventListener("pointermove", (event) => {
      updateMacroDrag(event);
      if (!customCurvePointer) return;
      updateCustomCurveFromPointer(event);
    });

    document.addEventListener("pointerup", () => {
      endMacroDrag();
      customCurvePointer = null;
    });

    document.addEventListener("pointercancel", () => {
      cancelMacroDrag();
      customCurvePointer = null;
    });
  }

  document.addEventListener("pointerdown", (event) => {
    const pendingId = getPendingFocusId();
    if (!pendingId) return;
    if (Date.now() < suppressPendingFocusClearUntil) {
      return;
    }
    const target = event.target;
    if (target && target.classList?.contains("binding-name-input")) {
      return;
    }
    setPendingFocusId(null);
  }, true);

  bindConfigModalUi();
  bindBindingTypeFilterUi();
  bindBindingDensityUi();
  if (d.bindingSearchInput) {
    d.bindingSearchInput.addEventListener("input", () => {
      renderBindings();
    });
  }
  window.addEventListener("resize", () => {
    bindingsScrollbarWidth = 0;
    queueBindingsScrollLayoutSync();
  });
  window.addEventListener("midimaster:locale-changed", () => {
    updateBindingTypeFilterUi();
    renderBindings();
    resetLearnPanelUi();
    renderConfigModal();
  });
  queueBindingsScrollLayoutSync();
  updateAuxLearnUi();

  return {
    updateSliderFill,
    setSliderVolume,
    isBindingInteractionActive,
    isInlineNameEditingActive,
    requestSafeRerender,
    flushPendingRerender,
    updateBindingValues,
    updateBindingTargetDisplays,
    setMuteButtonState,
    syncButtonVisualState,
    setButtonVisualState,
    queueBindingReveal,
    openBindingTargetPicker,
    beginBindingEdit,
    setCompactBindings,
    renderBindings,
    startBindingDrag,
    updateBindingDrag,
    endBindingDrag,
    cancelBindingDrag,
  };
}

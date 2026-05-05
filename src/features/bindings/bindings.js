import {
  renderLabelWithBadges,
  wireDropdownToggle,
} from "../ui/dropdown_badges.js";
import {
  applyCurveToNormalized,
  assignModeTooltip,
  buttonModeValue,
  cloneBindingDraft,
  curveDisplayName,
  curveEditorPoints,
  curveHelpText,
  customCurvePoints,
  effectiveIsButton,
  ensureAuxShape,
  ensureBindingShape,
  getPrimaryTarget,
  getTargets,
  isHotkeyTarget,
  isOpenApplicationTarget,
  modeTooltip,
  muteBehaviorLabel,
  muteBehaviorTooltip,
  normalizeControlKind,
  normalizeCustomCurve,
  normalizeFaderCurve,
  normalizeMuteBehavior,
  normalizeRelativeFormat,
  presetCurvePoints,
  setTargets,
} from "./shape_helpers.js";

export function createBindingsFeature({
  invoke,
  dom,
  getPlaybackDevices,
  getRecordingDevices,
  getBindings,
  setBindings,
  bindingFallbackName,
  controlLabel,
  buildTargetSelect,
  getVolumeForTarget,
  getMuteForTarget,
  triggerIntegration,
  extractIntegrationTarget,
  i18n,
  showVolumeOsd,
  showMuteOsd,
  saveBindingsForProfile,
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

  const getPlayback = (typeof getPlaybackDevices === "function") ? getPlaybackDevices : (() => []);
  const getRecording = (typeof getRecordingDevices === "function") ? getRecordingDevices : (() => []);

  const fallbackNameFor = (typeof bindingFallbackName === "function")
    ? bindingFallbackName
    : ((_b, i) => `Binding ${i + 1}`);
  const labelForControl = (typeof controlLabel === "function")
    ? controlLabel
    : ((c) => `Ch ${c?.channel ?? "?"} CC ${c?.controller ?? "?"}`);

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
  const getEditingId = (typeof getEditingBindingId === "function") ? getEditingBindingId : (() => null);
  const setEditingId = (typeof setEditingBindingId === "function") ? setEditingBindingId : (() => { });
  const getPendingFocusId = (typeof getPendingFocusBindingId === "function") ? getPendingFocusBindingId : (() => null);
  const setPendingFocusId = (typeof setPendingFocusBindingId === "function") ? setPendingFocusBindingId : (() => { });

  const getDrag = (typeof getDragState === "function") ? getDragState : (() => null);
  const setDrag = (typeof setDragState === "function") ? setDragState : (() => { });
  const getSearchQuery = () => String(d.bindingSearchInput?.value || "").trim().toLowerCase();
  const bindingsCard = d.bindingsContainer.closest?.(".bindings-card") || null;
  let bindingsScrollbarWidth = 0;
  let bindingsLayoutSyncQueued = false;

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

  function displayModeName(binding) {
    if (effectiveIsButton(binding) && binding?.action === "ToggleMute") {
      return muteBehaviorLabel(binding?.mute_behavior);
    }
    if (effectiveIsButton(binding)) return muteBehaviorLabel(binding?.mute_behavior);
    return binding?.mode === "Relative" ? "Relative" : "Absolute";
  }

  function isMomentaryButtonBinding(binding) {
    if (!effectiveIsButton(binding)) return false;
    const target = getPrimaryTarget(binding);
    const integration = target?.Integration || target?.integration;
    const data = integration?.data || {};
    if (
      String(integration?.integration_id || "").toLowerCase() === "obs"
      && String(integration?.kind || "").toLowerCase() === "action"
      && String(data.action || "").startsWith("Toggle")
    ) {
      return false;
    }
    const actionKind = String(data.action_kind || "").toLowerCase();
    if (actionKind === "momentary") return true;
    if (actionKind === "stateful") return false;
    return binding?.action !== "ToggleMute";
  }

  function obsButtonBehavior(binding) {
    if (!effectiveIsButton(binding)) return null;
    const target = getPrimaryTarget(binding);
    const integration = target?.Integration || target?.integration;
    if (String(integration?.integration_id || "").toLowerCase() !== "obs") return null;
    const kind = String(integration?.kind || "").toLowerCase();
    const data = integration?.data || {};
    const actionKind = String(data.action_kind || "").toLowerCase();
    if (actionKind === "stateful" || actionKind === "momentary") return actionKind;
    if (binding?.action === "ToggleMute") return "stateful";
    if (kind === "action" && String(data.action || "").startsWith("Toggle")) return "stateful";
    if (kind === "action" || kind === "scene" || kind === "media") return "momentary";
    return null;
  }

  function buttonFillActive(binding, fallbackMuted = false) {
    if (!binding) return false;
    if (binding.action === "ToggleMute") {
      if (bindingMuteValues[binding.id] != null) return Boolean(bindingMuteValues[binding.id]);
      return Boolean(fallbackMuted);
    }
    if (bindingLastValues[binding.id] != null) return Number(bindingLastValues[binding.id]) > 0.5;
    if (bindingMuteValues[binding.id] != null) return Boolean(bindingMuteValues[binding.id]);
    return Boolean(fallbackMuted);
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
    const fill = row?.querySelector(".binding-momentary-value");
    if (fill) {
      fill.classList.toggle("is-active", nextMuted);
    }
  }

  function updateSliderFill(slider) {
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 1;
    const val = parseFloat(slider.value) || 0;
    const percent = ((val - min) / (max - min)) * 100;
    slider.style.backgroundSize = `${percent}% 100%`;
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

      const vol = getVol(target);
      if (vol !== null && Math.abs(Number(slider.value) - vol) > 0.01) {
        setSliderVolume(slider, vol);
        invoke("update_midi_feedback", { target, value: vol, action: "Volume" });
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

  let configBindingId = null;
  let configDraft = null;
  let configLearnField = null;
  let configLearnTimer = null;
  let transferPrompt = null;
  const configAcceptedTransfers = new Map();
  let configPreviewTimer = null;
  let customCurvePointer = null;
  let hotkeyLearnBindingId = null;
  let hotkeyLearnCleanup = null;
  const hotkeyModifiers = ["Ctrl", "Shift", "Alt", "Meta"];
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

  function normalizeHotkeyKey(event) {
    const key = String(event?.key || "").trim();
    if (!key) return null;
    const lower = key.toLowerCase();
    if (lower === "control") return "Ctrl";
    if (lower === "shift") return "Shift";
    if (lower === "alt") return "Alt";
    if (lower === "meta") return "Meta";
    if (lower === " ") return "Space";
    if (lower === "escape") return "Esc";
    if (lower === "arrowup") return "Up";
    if (lower === "arrowdown") return "Down";
    if (lower === "arrowleft") return "Left";
    if (lower === "arrowright") return "Right";
    if (key.length === 1) return key.toUpperCase();
    if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase();
    return key.length <= 16 ? key[0].toUpperCase() + key.slice(1) : null;
  }

  function isHotkeyModifier(key) {
    return hotkeyModifiers.includes(key);
  }

  function buildHotkeyMappingFromEvent(event) {
    const key = normalizeHotkeyKey(event);
    if (!key || isHotkeyModifier(key)) return null;

    const keys = [];
    if (event.ctrlKey) keys.push("Ctrl");
    if (event.shiftKey) keys.push("Shift");
    if (event.altKey) keys.push("Alt");
    if (event.metaKey) keys.push("Meta");
    if (!keys.includes(key)) keys.push(key);

    return {
      keys,
      display: keys.join("+"),
    };
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
    const muteClear = d.bindingConfigMuteClear;
    const assignClear = d.bindingConfigAssignClear;
    const previewLearnButton = d.bindingConfigPreviewLearnButton;
    const transferLocked = Boolean(transferPrompt);
    const learningPrimary = configLearnField === "control";

    if (muteLearn) {
      const active = configLearnField === "mute_control";
      muteLearn.classList.remove("is-learning");
      muteLearn.textContent = "Learn";
      muteLearn.disabled = transferLocked || Boolean(configLearnField && !active);
    }
    if (assignLearn) {
      const active = configLearnField === "assign_control";
      assignLearn.classList.remove("is-learning");
      assignLearn.textContent = t("common.learn");
      assignLearn.disabled = transferLocked || Boolean(configLearnField && !active);
    }

    const lockClear = transferLocked || Boolean(configLearnField);
    if (muteClear) muteClear.disabled = lockClear;
    if (assignClear) assignClear.disabled = lockClear;
    if (d.bindingConfigMuteModeButton) d.bindingConfigMuteModeButton.disabled = lockClear;
    if (d.bindingConfigAssignModeButton) d.bindingConfigAssignModeButton.disabled = lockClear;
    if (previewLearnButton) {
      previewLearnButton.classList.toggle("is-learning", learningPrimary);
      previewLearnButton.textContent = learningPrimary ? t("bindings.listening") : t("bindings.learnFader");
      previewLearnButton.disabled = transferLocked || Boolean(configLearnField && !learningPrimary);
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
      : (control.msg_type === "Note" ? "Note" : "CC");
    return `Ch ${control.channel} ${msg} ${control.controller}`;
  }

  function formatPreviewMidiValue(binding, normalizedValue) {
    const clamped = Math.min(1, Math.max(0, Number(normalizedValue) || 0));
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
    const target = getPrimaryTarget(binding);
    const liveMidiValue = getLiveMidiValue(binding.device_id, binding.control);
    const liveValue = liveMidiValue != null
      ? applyCurveToNormalized(binding, liveMidiValue)
      : (bindingId != null && bindingLastValues[bindingId] != null
          ? Number(bindingLastValues[bindingId])
          : (getVol(target) ?? 0));
    const muted = bindingId != null && bindingMuteValues[bindingId] != null
      ? Boolean(bindingMuteValues[bindingId])
      : Boolean(getMuted(target));
    const previewValue = Math.min(1, Math.max(0, Number(liveValue) || 0));
    const fillPercent = Math.round(Math.min(1, Math.max(0, previewValue)) * 100);
    const learningPrimary = configLearnField === "control";

    renderPreviewTarget(binding);
    if (d.bindingConfigPreviewValue) d.bindingConfigPreviewValue.textContent = `${fillPercent}%`;
    if (d.bindingConfigPreviewFill) d.bindingConfigPreviewFill.style.height = `${fillPercent}%`;
    if (d.bindingConfigPreviewThumb) d.bindingConfigPreviewThumb.style.bottom = `calc(${fillPercent}% - 18px)`;
    if (d.bindingConfigPreviewMainMidi) d.bindingConfigPreviewMainMidi.textContent = labelForControl(binding.control || {});
    if (d.bindingConfigPreviewMute) d.bindingConfigPreviewMute.textContent = formatMidiControlLabel(binding.mute_control);
    if (d.bindingConfigPreviewAssign) d.bindingConfigPreviewAssign.textContent = formatMidiControlLabel(binding.assign_control);
    if (d.bindingConfigPreviewCurve) d.bindingConfigPreviewCurve.textContent = curveDisplayName(binding.fader_curve);
    if (d.bindingConfigPreviewMidiValue) d.bindingConfigPreviewMidiValue.textContent = formatPreviewMidiValue(binding, previewValue);
    if (d.bindingConfigPreviewStatus) {
      if (learningPrimary) {
        d.bindingConfigPreviewStatus.textContent = t("bindings.waitingForNewFaderInput");
      } else if (muted) {
        d.bindingConfigPreviewStatus.textContent = t("bindings.targetMuted");
      } else if ((bindingId != null && bindingLastValues[bindingId] != null) || liveMidiValue != null) {
        d.bindingConfigPreviewStatus.textContent = t("bindings.receivingLiveFeedback");
      } else {
        d.bindingConfigPreviewStatus.textContent = t("bindings.waitingForLiveInput");
      }
    }
    if (d.bindingConfigPreviewLearnIndicator) {
      d.bindingConfigPreviewLearnIndicator.classList.toggle("hidden", !learningPrimary);
      d.bindingConfigPreviewLearnIndicator.classList.toggle("is-learning", learningPrimary);
    }
    if (d.bindingConfigPreviewLearnStatus) {
      d.bindingConfigPreviewLearnStatus.textContent = t("bindings.waitingMidiInput");
    }
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
      const width = 120;
      const height = 120;
      const padding = 10;
      const toX = (point) => padding + (point.x * (width - (padding * 2)));
      const toY = (point) => height - padding - (point.y * (height - (padding * 2)));
      const polyline = points.map((point) => `${toX(point)},${toY(point)}`).join(" ");
      return `
        <svg class="binding-config-curve-editor-svg" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
          <polyline points="${polyline}" />
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
            const x = 10 + (point.x * 100);
            const y = 110 - (point.y * 100);
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

  function updateCustomCurveFromPointer(event) {
    const binding = getConfigBinding();
    if (!binding || !customCurvePointer?.surfaceEl) return;
    const rect = customCurvePointer.surfaceEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const points = curveEditorPoints(binding);
    const index = customCurvePointer.index;
    const isEdge = index === 0 || index === points.length - 1;
    const localX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const localY = Math.min(1, Math.max(0, 1 - ((event.clientY - rect.top) / rect.height)));
    const prevX = index > 0 ? points[index - 1].x + 0.04 : 0;
    const nextX = index < points.length - 1 ? points[index + 1].x - 0.04 : 1;
    points[index] = {
      x: isEdge ? (index === 0 ? 0 : 1) : Math.min(nextX, Math.max(prevX, localX)),
      y: localY,
    };
    if (binding.fader_curve !== "Custom") {
      binding.fader_curve = "Custom";
    }
    binding.custom_curve = normalizeCustomCurve(points);
    renderCurveCards();
    if (customCurvePointer) {
      const nextSurface = d.bindingConfigCurveCards?.querySelector('.binding-config-curve-card[data-curve="Custom"] .binding-config-curve-card-visual');
      if (nextSurface) {
        customCurvePointer.surfaceEl = nextSurface;
      }
    }
    renderConfigPreview();
  }

  function closeConfigModal() {
    stopHotkeyLearn();
    stopAuxLearn();
    clearTransferPrompt();
    closeMuteModeMenu();
    closeAssignModeMenu();
    stopConfigPreviewTimer();
    customCurvePointer = null;
    configAcceptedTransfers.clear();
    configDraft = null;
    configBindingId = null;
    if (d.bindingConfigPanel) d.bindingConfigPanel.classList.add("hidden");
  }

  function getBindingById(bindingId) {
    return getB().find((binding) => binding.id === bindingId) || null;
  }

  function renderConfigModal() {
    const binding = getConfigBinding();
    if (!binding) {
      closeConfigModal();
      return;
    }
    closeAssignModeMenu();
    closeMuteModeMenu();
    ensureAuxShape(binding);
    ensureBindingShape(binding);
    if (d.bindingConfigName) d.bindingConfigName.value = binding.name?.trim() || "";
    renderCurveCards();
    renderCustomCurveEditor();
    renderMuteMappingLabel(binding);
    renderAssignMappingLabel(binding);
    syncMuteModeUi(binding?.mute_control?.mute_behavior || binding?.mute_behavior || "ToggleOnPress");
    syncAssignModeUi(binding.assign_mode || "Add");
    renderConfigPreview();
    updateAuxLearnUi();
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

  async function persistBinding(binding) {
    ensureBindingShape(binding);
    await invoke("add_binding", { binding });
    await saveProfile();
    try {
      getHost()?.setBindings?.(getB());
    } catch { }
  }

  function findMappingConflict(bindingId, field, mapping) {
    const bindings = getB();
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
    }
    return null;
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
      const ownerSlot = conflict.field === "control"
        ? "Primary"
        : (conflict.field === "mute_control" ? "Mute" : "Assign");
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
        stopAuxLearn({ closePanel: false });
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
        const mapping = normalizeAuxControl(learned);
        await applyAuxMapping(targetField, mapping);
      } catch {
        stopAuxLearn();
      }
    }, 200);
  }

  function openConfigModal(bindingId) {
    const binding = getBindingById(bindingId);
    if (!binding) return;
    configBindingId = bindingId;
    configDraft = cloneBindingDraft(binding);
    configAcceptedTransfers.clear();
    if (d.bindingConfigPanel) d.bindingConfigPanel.classList.remove("hidden");
    startConfigPreviewTimer();
    renderConfigModal();
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
      await persistBinding(nextConflictBinding);
    }

    const bindingIndex = nextBindings.findIndex((binding) => binding.id === configBindingId);
    if (bindingIndex < 0) return;
    const nextBinding = cloneBindingDraft(draft);
    nextBindings[bindingIndex] = nextBinding;
    setB(nextBindings);
    await persistBinding(nextBinding);
    renderBindings();
    closeConfigModal();
  }

  function beginBindingEdit(bindingId, forceInline = false) {
    const binding = getBindingById(bindingId);
    if (!binding) return;
    if (!forceInline && !effectiveIsButton(binding)) {
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
        if (searchQuery && !bindingSearchText(binding, index).includes(searchQuery)) {
          return;
        }
        renderedCount += 1;
        const item = document.createElement("div");
        item.className = "list-item binding-item";

        const row = document.createElement("div");
        row.className = "binding-row";

        item.dataset.index = index;
        item.dataset.bindingId = String(binding.id || "");

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
            await saveProfile();
            flushPendingRerender({ fallbackRender: true });
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
          startBindingDrag(item, index, event);
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
            binding.relative_format = "Auto";
            binding.action = "Volume";
          } else {
            binding.control_kind = "Continuous";
            binding.mode = "Absolute";
            binding.relative_format = "Auto";
            binding.action = "Volume";
          }

          await invoke("add_binding", { binding });
          await saveProfile();
          renderBindings();
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

        wireDropdownToggle({ root: modeDropdown, menu: modeMenu, trigger: modeButton });

        modeDropdown.appendChild(modeButton);
        modeDropdown.appendChild(modeMenu);

        const targetSelect = buildTarget(
          getTargets(binding),
          isButton,
          binding.action,
          binding.hotkey?.display || "",
          binding.open_application,
        );
        targetSelect.addEventListener("change", async () => {
          const previousTargets = getTargets(binding);
          const previousHadHotkeyTarget = previousTargets.some(isHotkeyTarget);
          const previousHadOpenApplicationTarget = previousTargets.some(isOpenApplicationTarget);
          const selectedTargets = Array.isArray(targetSelect.__selectedTargets)
            ? targetSelect.__selectedTargets
            : (targetSelect.__selectedTarget ? [targetSelect.__selectedTarget] : []);
          setTargets(binding, selectedTargets);
          const hasSelectedTarget = selectedTargets.some((target) => target && target !== "Unset");
          const hasHotkeyTarget = selectedTargets.some(isHotkeyTarget);
          const hasOpenApplicationTarget = selectedTargets.some(isOpenApplicationTarget);
          const previousAction = binding.action;
          const previousHotkey = normalizeHotkeyMapping(binding.hotkey);
          const previousOpenApplication = normalizeOpenApplicationMapping(binding.open_application);

          if (isButton) {
            binding.action = !hasSelectedTarget
              ? "ToggleMute"
              : hasHotkeyTarget
              ? "Hotkey"
              : hasOpenApplicationTarget
                ? "OpenApplication"
              : (targetSelect.dataset.action || binding.action || "ToggleMute");
          } else {
            binding.action = "Volume";
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

          if (isButton && hasHotkeyTarget && !previousHadHotkeyTarget) {
            const learnedHotkey = await startHotkeyLearn(binding);
            if (!learnedHotkey) {
              setTargets(binding, previousTargets);
              binding.action = previousAction || "ToggleMute";
              binding.hotkey = previousHotkey;
              binding.open_application = previousOpenApplication;
              await invoke("add_binding", { binding });
              await saveProfile();
              renderBindings();
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

          if (isButton && !hasHotkeyTarget && !hasOpenApplicationTarget && binding.action === "OpenApplication" && !binding.open_application) {
            setTargets(binding, previousTargets);
            binding.action = previousAction || "ToggleMute";
            binding.hotkey = previousHotkey;
            binding.open_application = previousOpenApplication;
            await invoke("add_binding", { binding });
            await saveProfile();
            renderBindings();
            return;
          }

          if (!isButton) {
            const primaryTarget = getPrimaryTarget(binding);
            const newVolume = (bindingLastValues[binding.id] != null)
              ? Number(bindingLastValues[binding.id])
              : getVol(primaryTarget);
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
          await saveProfile();

          try {
            getHost()?.setBindings?.(getB());
          } catch { }

          // Hotkey target UX: force a fresh row render so the chip label updates
          // immediately from "Not Set" to the learned combo.
          if (isButton && hasHotkeyTarget) {
            renderBindings();
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
          const v = (bindingLastValues[binding.id] != null)
            ? Number(bindingLastValues[binding.id])
            : getVol(primaryTarget);

          if (v !== null) bindingLastValues[binding.id] = v;
          volumeSlider.value = v ?? bindingLastValues[binding.id] ?? 0;
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
        const obsBehavior = obsButtonBehavior(binding);
        const isMomentaryButton = obsBehavior ? obsBehavior === "momentary" : isMomentaryButtonBinding(binding);
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
        setActionIcon(editButton, "edit", isButton ? t("bindings.editName") : t("bindings.configureFader"));
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
            await saveProfile();
            renderBindings();
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
          const isObsStateful = obsBehavior === "stateful";
          const isObsMomentary = obsBehavior === "momentary";
          const isStatefulButton = isObsStateful || (!obsBehavior && !isMomentaryButton);
          const isMomentaryPress = isObsMomentary || (!obsBehavior && isMomentaryButton);
          pulse.classList.add(
            "binding-button-value",
            isStatefulButton ? "binding-button-value--stateful" : "binding-button-value--momentary",
          );
          pulse.classList.toggle("is-active", isStatefulButton && buttonFillActive(binding, isMuted));
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
            if (!isObsMomentary) return;
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
          } else if (isObsMomentary) {
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
            if (!isObsMomentary || pulse.__buttonPressed) return;
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
            if (!isObsMomentary) return;
            event.preventDefault();
            await releaseMomentary();
          });
          valueGroup.appendChild(pulse);
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
          await saveProfile();
          renderBindings();
        };
        errorItem.appendChild(delBtn);

        d.bindingsContainer.appendChild(errorItem);
      }
    });

    if (renderedCount === 0) {
      const empty = document.createElement("div");
      empty.className = "bindings-empty";
      empty.textContent = t("bindings.noSearchResults");
      d.bindingsContainer.appendChild(empty);
    }

    queueBindingsScrollLayoutSync();
  }

  function startBindingDrag(item, index, event) {
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

    setDrag({
      index,
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

  function placeholderIndex() {
    const children = Array.from(d.bindingsContainer.children);
    let index = 0;
    for (const child of children) {
      if (child.classList.contains("binding-placeholder")) {
        return index;
      }
      if (child.classList.contains("binding-item")) {
        index += 1;
      }
    }
    return null;
  }

  async function endBindingDrag() {
    const dragState = getDrag();
    if (!dragState) return;
    const { index, item, ghost, placeholder, active } = dragState;
    const newIndex = active ? placeholderIndex() : null;
    setDrag(null);

    item.style.display = "";
    item.classList.remove("dragging");
    ghost.remove();
    if (active) {
      placeholder.remove();
    }
    document.body.classList.remove("dragging-binding");

    if (active && newIndex !== null && newIndex !== index) {
      const insertIndex = (newIndex > index) ? (newIndex - 1) : newIndex;
      const next = getB();
      const [moved] = next.splice(index, 1);
      next.splice(insertIndex, 0, moved);
      setB(next);
      renderBindings();
      await saveProfile();
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

    if (d.bindingConfigPanel) {
      d.bindingConfigPanel.addEventListener("click", (event) => {
        if (event.target === d.bindingConfigPanel) {
          closeConfigModal();
        }
      });
    }
    if (d.bindingConfigClose) {
      d.bindingConfigClose.addEventListener("click", closeConfigModal);
    }
    if (d.bindingConfigCancel) {
      d.bindingConfigCancel.addEventListener("click", closeConfigModal);
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
    if (d.bindingConfigPreviewLearnButton) {
      d.bindingConfigPreviewLearnButton.addEventListener("click", async () => {
        await startPrimaryLearn();
      });
    }
    document.addEventListener("keydown", (event) => {
      if (!configBindingId || event.key !== "Escape") return;
      if (transferPrompt || configLearnField || hotkeyLearnBindingId) return;
      closeConfigModal();
    });
    if (d.bindingConfigCustomReset) {
      d.bindingConfigCustomReset.addEventListener("click", () => {
        const binding = getConfigBinding();
        if (!binding) return;
        binding.custom_curve = presetCurvePoints(binding.fader_curve);
        renderConfigModal();
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
        const target = event.target instanceof Element
          ? event.target.closest("circle.binding-config-curve-card-point")
          : null;
        if (!target) return;
        const card = target.closest(".binding-config-curve-card");
        if (!card || card.dataset.curve !== "Custom") return;
        const index = Number(target.dataset.pointIndex);
        if (!Number.isFinite(index)) return;
        event.preventDefault();
        event.stopPropagation();
        const surfaceEl = target.closest(".binding-config-curve-card-visual");
        if (!surfaceEl) return;
        customCurvePointer = { index, surfaceEl };
        target.setPointerCapture?.(event.pointerId);
        updateCustomCurveFromPointer(event);
      });
    }

    document.addEventListener("click", (event) => {
      if (!configBindingId) return;
      const muteRoot = d.bindingConfigMuteModeRoot;
      if (muteRoot && !muteRoot.contains(event.target)) {
        closeMuteModeMenu();
      }
      const root = d.bindingConfigAssignModeRoot;
      if (!root || root.contains(event.target)) return;
      closeAssignModeMenu();
    });

    document.addEventListener("pointermove", (event) => {
      if (!customCurvePointer) return;
      updateCustomCurveFromPointer(event);
    });

    document.addEventListener("pointerup", () => {
      customCurvePointer = null;
    });

    document.addEventListener("pointercancel", () => {
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
    setMuteButtonState,
    beginBindingEdit,
    renderBindings,
    startBindingDrag,
    updateBindingDrag,
    endBindingDrag,
    cancelBindingDrag,
  };
}

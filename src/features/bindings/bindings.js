import {
  renderLabelWithBadges,
  wireDropdownToggle,
} from "../ui/dropdown_badges.js";
import {
  createSelectDropdownShell,
  renderNativeSelectDropdown,
} from "../ui/dropdown_select.js";

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
}) {
  if (typeof invoke !== "function") {
    throw new Error("createBindingsFeature: invoke is required");
  }

  const SLIDER_ACTION_FLUSH_MS = 16;
  const sliderIntentSequenceByBinding = {};
  const pendingSliderActionsByBinding = new Map();
  const d = (dom && typeof dom === "object") ? dom : {};
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
  const saveProfile = (typeof saveBindingsForProfile === "function") ? saveBindingsForProfile : (async () => { });
  const getHost = (typeof getPluginHost === "function") ? getPluginHost : (() => null);

  const getEditingId = (typeof getEditingBindingId === "function") ? getEditingBindingId : (() => null);
  const setEditingId = (typeof setEditingBindingId === "function") ? setEditingBindingId : (() => { });
  const getPendingFocusId = (typeof getPendingFocusBindingId === "function") ? getPendingFocusBindingId : (() => null);
  const setPendingFocusId = (typeof setPendingFocusBindingId === "function") ? setPendingFocusBindingId : (() => { });

  const getDrag = (typeof getDragState === "function") ? getDragState : (() => null);
  const setDrag = (typeof setDragState === "function") ? setDragState : (() => { });
  const getSearchQuery = () => String(d.bindingSearchInput?.value || "").trim().toLowerCase();

  function displayModeName(binding) {
    if (effectiveIsButton(binding)) return "Toggle";
    return binding?.mode === "Relative" ? "Relative" : "Absolute";
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
    const label = nextMuted ? "Unmute binding target" : "Mute binding target";
    button.title = label;
    button.setAttribute("aria-label", label);

    const row = button.closest(".binding-row");
    const toggle = row?.querySelector(".binding-toggle-value");
    if (toggle) {
      toggle.classList.toggle("on", nextMuted);
      toggle.title = label;
      toggle.setAttribute("aria-label", label);
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

  function normalizeControlKind(raw) {
    const value = String(raw || "Auto");
    if (value === "Button" || value === "Continuous" || value === "Auto") {
      return value;
    }
    return "Auto";
  }

  function normalizeRelativeFormat(raw) {
    const value = String(raw || "Auto");
    if (value === "Auto") return value;
    return "Auto";
  }

  function normalizeFaderCurve(raw) {
    return raw === "Logarithmic" ? "Logarithmic" : "Linear";
  }

  function ensureBindingShape(binding) {
    if (!binding || typeof binding !== "object") return;
    if (!binding.mode || (binding.mode !== "Absolute" && binding.mode !== "Relative")) {
      binding.mode = "Absolute";
    }
    // Backend auto-detect is always used for relative controls.
    binding.relative_format = "Auto";
    binding.fader_curve = normalizeFaderCurve(binding.fader_curve);
  }

  function effectiveIsButton(binding) {
    const controlKind = normalizeControlKind(binding?.control_kind);
    if (controlKind === "Button") return true;
    if (controlKind === "Continuous") return false;
    return binding?.control?.msg_type === "Note";
  }

  function isHotkeyTarget(target) {
    return target === "Hotkey";
  }

  function isOpenApplicationTarget(target) {
    return target === "OpenApplication";
  }

  function getTargets(binding) {
    if (!binding || typeof binding !== "object") return [];
    if (Array.isArray(binding.targets) && binding.targets.length > 0) {
      const normalized = binding.targets.filter(Boolean).filter((t) => t !== "Unset").slice(0, 8);
      if (normalized.length > 0) return normalized;
    }
    if (binding.target != null) {
      return [binding.target];
    }
    return [];
  }

  function setTargets(binding, targets) {
    const normalized = Array.isArray(targets) ? targets.filter(Boolean).slice(0, 8) : [];
    if (normalized.length === 0) normalized.push("Unset");
    binding.targets = normalized;
    binding.target = normalized[0] || "Unset";
  }

  function getPrimaryTarget(binding) {
    return getTargets(binding)[0] || "Unset";
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
  let configLearnField = null;
  let configLearnTimer = null;
  let transferPrompt = null;
  let hotkeyLearnBindingId = null;
  let hotkeyLearnCleanup = null;
  const hotkeyModifiers = ["Ctrl", "Shift", "Alt", "Meta"];
  const nameDrafts = new Map();
  let pendingRerender = false;
  let suppressPendingFocusClearUntil = 0;
  let curveDropdownEntry = null;
  const defaultLearnPanelTitle = "Waiting for MIDI Input";
  const defaultLearnPanelMessage = "Move a control on your MIDI device to create a binding.";

  function renderCurveDropdown() {
    if (!d.bindingConfigCurve) return;
    if (!curveDropdownEntry || !curveDropdownEntry.root?.isConnected) {
      curveDropdownEntry = createSelectDropdownShell({
        selectEl: d.bindingConfigCurve,
        rootClass: "midi-device-dropdown",
        title: "Fader curve",
      });
    }
    if (!curveDropdownEntry) return;
    renderNativeSelectDropdown({
      entry: curveDropdownEntry,
      selectEl: d.bindingConfigCurve,
      fallbackText: "Linear",
      truncateMenuLabels: false,
      truncateDisplayLabel: false,
      onOptionSelected: () => {
        renderCurveDropdown();
      },
    });
  }

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
    if (d.learnPanelTitle) d.learnPanelTitle.textContent = defaultLearnPanelTitle;
    if (d.learnPanelMessage) d.learnPanelMessage.textContent = defaultLearnPanelMessage;
    if (d.learnPanelSpinner) d.learnPanelSpinner.classList.remove("hidden");
    if (d.learnPanelActions) d.learnPanelActions.classList.add("hidden");
    if (d.learnPanelCancel) d.learnPanelCancel.textContent = "Cancel";
    if (d.learnPanelConfirm) {
      d.learnPanelConfirm.textContent = "Transfer";
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
    if (d.learnPanelTitle) d.learnPanelTitle.textContent = defaultLearnPanelTitle;
    if (d.learnPanelMessage) d.learnPanelMessage.textContent = defaultLearnPanelMessage;
    if (d.learnPanelSpinner) d.learnPanelSpinner.classList.remove("hidden");
    if (d.learnPanelActions) d.learnPanelActions.classList.add("hidden");
    showLearnPanel();
  }

  function setLearnPanelTransfer(message) {
    if (!hasLearnPanelSupport()) return;
    if (d.learnPanelTitle) d.learnPanelTitle.textContent = "Transfer Mapping";
    if (d.learnPanelMessage) d.learnPanelMessage.textContent = message || "";
    if (d.learnPanelSpinner) d.learnPanelSpinner.classList.add("hidden");
    if (d.learnPanelActions) d.learnPanelActions.classList.remove("hidden");
    if (d.learnPanelCancel) d.learnPanelCancel.textContent = "Cancel";
    if (d.learnPanelConfirm) {
      d.learnPanelConfirm.textContent = "Transfer";
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
    if (d.learnPanelTitle) d.learnPanelTitle.textContent = "Press Hotkey";
    if (d.learnPanelMessage) {
      d.learnPanelMessage.textContent = "Press a key or combo (example: Ctrl+Shift+S).";
    }
    if (d.learnPanelSpinner) d.learnPanelSpinner.classList.add("hidden");
    if (d.learnPanelActions) d.learnPanelActions.classList.remove("hidden");
    if (d.learnPanelCancel) d.learnPanelCancel.textContent = "Cancel";
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
    const transferLocked = Boolean(transferPrompt);

    if (muteLearn) {
      const active = configLearnField === "mute_control";
      muteLearn.classList.remove("is-learning");
      muteLearn.textContent = "Learn";
      muteLearn.disabled = transferLocked || Boolean(configLearnField && !active);
    }
    if (assignLearn) {
      const active = configLearnField === "assign_control";
      assignLearn.classList.remove("is-learning");
      assignLearn.textContent = "Learn";
      assignLearn.disabled = transferLocked || Boolean(configLearnField && !active);
    }

    const lockClear = transferLocked || Boolean(configLearnField);
    if (muteClear) muteClear.disabled = lockClear;
    if (assignClear) assignClear.disabled = lockClear;
    if (d.bindingConfigAssignModeButton) d.bindingConfigAssignModeButton.disabled = lockClear;
  }

  function stopAuxLearn(options = {}) {
    const closePanel = options.closePanel !== false;
    if (configLearnTimer) {
      clearInterval(configLearnTimer);
      configLearnTimer = null;
    }
    configLearnField = null;
    updateAuxLearnUi();
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

    d.bindingConfigAssignLabel.appendChild(main);
    d.bindingConfigAssignLabel.appendChild(badge);
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
    };
  }

  function controlsEqual(a, b) {
    if (!a || !b) return false;
    return String(a.device_id || "") === String(b.device_id || "")
      && Number(a.channel) === Number(b.channel)
      && Number(a.controller) === Number(b.controller)
      && String(a.msg_type || "ControlChange") === String(b.msg_type || "ControlChange");
  }

  function closeConfigModal() {
    stopHotkeyLearn();
    stopAuxLearn();
    clearTransferPrompt();
    closeAssignModeMenu();
    configBindingId = null;
    if (d.bindingConfigPanel) d.bindingConfigPanel.classList.add("hidden");
  }

  function getBindingById(bindingId) {
    return getB().find((binding) => binding.id === bindingId) || null;
  }

  function ensureAuxShape(binding) {
    if (!binding) return;
    if (!("mute_control" in binding)) binding.mute_control = null;
    if (!("assign_control" in binding)) binding.assign_control = null;
    if (binding.assign_mode !== "Replace") binding.assign_mode = "Add";
  }

  function renderConfigModal() {
    const binding = getBindingById(configBindingId);
    if (!binding) {
      closeConfigModal();
      return;
    }
    closeAssignModeMenu();
    ensureAuxShape(binding);
    ensureBindingShape(binding);
    if (d.bindingConfigName) d.bindingConfigName.value = binding.name?.trim() || "";
    if (d.bindingConfigCurve) {
      d.bindingConfigCurve.value = binding.fader_curve;
      renderCurveDropdown();
    }
    if (d.bindingConfigMuteLabel) d.bindingConfigMuteLabel.textContent = formatMidiControlLabel(binding.mute_control);
    renderAssignMappingLabel(binding);
    syncAssignModeUi(binding.assign_mode || "Add");
    updateAuxLearnUi();
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
    if (d.bindingConfigAssignModeButton) {
      d.bindingConfigAssignModeButton.title = `Assign mode: ${currentMode}`;
      d.bindingConfigAssignModeButton.setAttribute("aria-label", `Assign mode: ${currentMode}`);
    }
    if (d.bindingConfigAssignModeAdd) {
      d.bindingConfigAssignModeAdd.classList.toggle("is-selected", currentMode === "Add");
    }
    if (d.bindingConfigAssignModeReplace) {
      d.bindingConfigAssignModeReplace.classList.toggle("is-selected", currentMode === "Replace");
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
    const binding = getBindingById(configBindingId);
    if (!binding) return;
    if (!conflict || !conflict.binding) return;

    if (conflict.field === "control") {
      await invoke("remove_binding", { binding: conflict.binding });
      const nextBindings = getB().filter((b) => b.id !== conflict.binding.id);
      setB(nextBindings);
      await saveProfile();
    } else {
      conflict.binding[conflict.field] = null;
      await persistBinding(conflict.binding);
    }

    binding[field] = mapping;
    await persistBinding(binding);
    hideLearnPanel();
    renderConfigModal();
    renderBindings();
  }

  async function applyAuxMapping(field, mapping) {
    const binding = getBindingById(configBindingId);
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

    binding[field] = mapping;
    await persistBinding(binding);
    hideLearnPanel();
    renderConfigModal();
    renderBindings();
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
    configBindingId = bindingId;
    if (d.bindingConfigPanel) d.bindingConfigPanel.classList.remove("hidden");
    renderConfigModal();
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
      empty.textContent = "No bindings yet. Use the button below to add one.";
      d.bindingsContainer.appendChild(empty);
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
          nameLabel.title = "Double-click to rename";
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
        rowNumber.title = "Drag to reorder binding";
        rowNumber.setAttribute("aria-label", "Drag to reorder binding");
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
        modeButton.title = "Control Mode";
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
          { value: "button", label: "Toggle", badge: null },
          { value: "fader_abs", label: "Absolute", badge: null },
          { value: "fader_rel", label: "Relative", badge: null },
        ];

        let modeValue = "fader_abs";
        if (effectiveIsButton(binding)) {
          modeValue = "button";
        } else if (binding.mode === "Relative") {
          modeValue = "fader_rel";
        }

        const renderModeLabel = (container, option) => {
          container.innerHTML = "";
          const label = document.createElement("span");
          label.className = "mode-label";
          label.textContent = option?.label || "";
          container.appendChild(label);
        };

        const applyModeSelection = async (nextModeValue) => {
          if (nextModeValue === "button") {
            binding.control_kind = "Button";
            binding.action = "ToggleMute";
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
          const hasHotkeyTarget = selectedTargets.some(isHotkeyTarget);
          const hasOpenApplicationTarget = selectedTargets.some(isOpenApplicationTarget);
          const previousAction = binding.action;
          const previousHotkey = normalizeHotkeyMapping(binding.hotkey);
          const previousOpenApplication = normalizeOpenApplicationMapping(binding.open_application);

          if (isButton) {
            binding.action = hasHotkeyTarget
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
        setActionIcon(editButton, "edit", isButton ? "Edit name" : "Configure fader");
        editButton.addEventListener("click", () => {
          beginBindingEdit(binding.id);
        });

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "binding-action delete";
        setActionIcon(deleteButton, "delete", "Delete binding");
        deleteButton.addEventListener("click", async () => {
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
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "binding-toggle-value";
          toggle.classList.toggle("on", isMuted);
          toggle.title = isMuted ? "Unmute binding target" : "Mute binding target";
          toggle.setAttribute("aria-label", toggle.title);
          toggle.addEventListener("click", async () => {
            muteButton.click();
          });
          valueGroup.appendChild(toggle);
          valueGroup.appendChild(muteButton);
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
        errorItem.textContent = `Error: ${err.message || err}`;
        errorItem.style.color = "red";
        errorItem.style.padding = "10px";

        const delBtn = document.createElement("button");
        delBtn.textContent = "\ud83d\uddd1";
        delBtn.className = "icon-button danger";
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          if (confirm("Delete broken binding?")) {
            try {
              await invoke("remove_binding", { binding });
            } catch { }
            await saveProfile();
            renderBindings();
          }
        };
        errorItem.appendChild(delBtn);

        d.bindingsContainer.appendChild(errorItem);
      }
    });

    if (renderedCount === 0) {
      const empty = document.createElement("div");
      empty.className = "bindings-empty";
      empty.textContent = "No bindings match your search.";
      d.bindingsContainer.appendChild(empty);
    }
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
    if (d.bindingConfigName) {
      d.bindingConfigName.addEventListener("change", async () => {
        const binding = getBindingById(configBindingId);
        if (!binding) return;
        binding.name = d.bindingConfigName.value.trim() || binding.name;
        await persistBinding(binding);
        renderBindings();
      });
    }
    if (d.bindingConfigCurve) {
      d.bindingConfigCurve.addEventListener("change", async () => {
        const binding = getBindingById(configBindingId);
        if (!binding) return;
        binding.fader_curve = normalizeFaderCurve(d.bindingConfigCurve.value);
        d.bindingConfigCurve.value = binding.fader_curve;
        renderCurveDropdown();
        await persistBinding(binding);
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
      d.bindingConfigMuteClear.addEventListener("click", async () => {
        if (transferPrompt) return;
        const binding = getBindingById(configBindingId);
        if (!binding) return;
        binding.mute_control = null;
        await persistBinding(binding);
        renderConfigModal();
      });
    }
    if (d.bindingConfigAssignClear) {
      d.bindingConfigAssignClear.addEventListener("click", async () => {
        if (transferPrompt) return;
        const binding = getBindingById(configBindingId);
        if (!binding) return;
        binding.assign_control = null;
        await persistBinding(binding);
        renderConfigModal();
      });
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
      const binding = getBindingById(configBindingId);
      if (!binding) return;
      binding.assign_mode = mode;
      await persistBinding(binding);
      renderAssignMappingLabel(binding);
      syncAssignModeUi(binding.assign_mode);
      closeAssignModeMenu();
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

    document.addEventListener("click", (event) => {
      if (!configBindingId) return;
      const root = d.bindingConfigAssignModeRoot;
      if (!root || root.contains(event.target)) return;
      closeAssignModeMenu();
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

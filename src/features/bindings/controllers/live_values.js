import { bindingActionIconSvg, muteIconSvg } from "../icons.js";
import { resolveBindingVolumeValue } from "../value_sync.js";

/** live values workflow. */
export function createLiveValues({
  SLIDER_ACTION_FLUSH_MS,
  bindingInteractionTimes,
  bindingLastValues,
  bindingMuteValues,
  elements,
  editorState,
  getBindingById,
  getConfigBinding,
  getMuted,
  getVol,
  invoke,
  pendingSliderActionsByBinding,
  renderPreviewTarget,
  renderedBindings,
  syncButtonVisualState,
  t,
}) {
  function pulseMomentaryValue(button) {
    if (!button) return;
    button.classList.add("is-active");
    clearTimeout(button.__momentaryPulseTimer);
    button.__momentaryPulseTimer = setTimeout(() => {
      button.classList.remove("is-active");
    }, 160);
  }

  function setActionIcon(button, name, label) {
    button.innerHTML = bindingActionIconSvg(name);
    button.title = label;
    button.setAttribute("aria-label", label);
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
      syncButtonVisualState(
        binding || bindingId,
        binding?.action === "ToggleMute"
          ? { muted: nextMuted, stateValue: nextMuted ? 1 : 0 }
          : { muted: nextMuted },
      );
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
    return Boolean(elements.bindingConfigPanel && !elements.bindingConfigPanel.classList.contains("hidden"));
  }

  function isBindingInteractionActive() {
    return (
      isBindingTargetMenuOpen() ||
      isTargetPanelOpen() ||
      isBindingNameEditing() ||
      isBindingSelectEditing() ||
      isBindingConfigOpen()
    );
  }

  function updateBindingValues() {
    updateBindingTargetDisplays();

    renderedBindings.values().forEach(({ slider, target }) => {
      if (!slider) return;
      const lastMidiUpdate = Number(slider.dataset.lastMidiUpdate || 0);
      if (Date.now() - lastMidiUpdate < 1000) return;

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

    renderedBindings.values().forEach(({ muteButton: btn, target }) => {
      if (!btn) return;
      const muted = Boolean(getMuted(target));
      const currentlyMuted = btn.classList.contains("muted");
      const bindingId = btn.dataset.bindingId;
      const nextMuted =
        bindingId != null && bindingMuteValues[bindingId] != null
          ? Boolean(bindingMuteValues[bindingId])
          : muted;
      if (nextMuted !== currentlyMuted) {
        setMuteButtonState(btn, nextMuted);
      }
    });
  }

  function updateBindingTargetDisplays() {
    renderedBindings.values().forEach(({ targetDropdown }) => {
      if (typeof targetDropdown?.refreshTargetDisplay === "function") {
        targetDropdown.refreshTargetDisplay();
      }
    });

    if (editorState.bindingId) {
      const binding = getConfigBinding();
      if (binding) {
        renderPreviewTarget(binding);
      }
    }
  }

  return {
    pulseMomentaryValue,
    setActionIcon,
    setMuteButtonState,
    updateSliderFill,
    setSliderVolume,
    resolveRenderedBindingVolume,
    queueSliderAction,
    isBindingInteractionActive,
    updateBindingValues,
    updateBindingTargetDisplays,
  };
}

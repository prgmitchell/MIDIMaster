import { normalizeSoundboardMapping } from "../../../core/binding_model.js";
import { formatSoundboardTime, drawSoundboardWaveform, clampSoundboardTrim } from "../soundboard_editor.js";
import { createSelectDropdownShell, renderNativeSelectDropdown } from "../../ui/dropdown_select.js";

/** soundboard preview workflow. */
export function createSoundboardPreview({
  alertAction,
  elements,
  editorState,
  getConfigBinding,
  invoke,
  renderSoundboardEditor,
  soundboardState,
  t,
}) {
  function cancelSoundboardPreviewFrame() {
    if (soundboardState.previewAnimationFrame == null) return;
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(soundboardState.previewAnimationFrame);
    } else {
      window.clearTimeout(soundboardState.previewAnimationFrame);
    }
    soundboardState.previewAnimationFrame = null;
  }

  function showSoundboardAlreadyConfiguredError() {
    alertAction(
      t("dialogs.soundboardAlreadyConfiguredTitle"),
      t("dialogs.soundboardAlreadyConfiguredMessage"),
    );
  }

  function showSpecialActionConflictError() {
    alertAction(t("dialogs.specialActionConflictTitle"), t("dialogs.specialActionConflictMessage"));
  }

  function scheduleSoundboardPreviewFrame() {
    cancelSoundboardPreviewFrame();
    const callback = () => {
      soundboardState.previewAnimationFrame = null;
      updateSoundboardPreviewFrame();
    };
    soundboardState.previewAnimationFrame =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(callback)
        : window.setTimeout(callback, 16);
  }

  function currentSoundboardPreviewPosition(mapping) {
    if (!mapping || soundboardState.previewState === "stopped") return null;
    const running =
      soundboardState.previewState === "playing"
        ? (performance.now() - soundboardState.previewStartedAt) * mapping.speed
        : 0;
    return mapping.trim_start_ms + soundboardState.previewElapsedMs + running;
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
    const duration = Number(soundboardState.analysis?.duration_ms) || 0;
    const end = mapping ? soundboardEndMs(mapping) : 0;
    const position = currentSoundboardPreviewPosition(mapping);
    if (elements.bindingConfigSoundboardPreview) {
      elements.bindingConfigSoundboardPreview.dataset.state = soundboardState.previewState;
      const label =
        soundboardState.previewState === "playing"
          ? t("soundboard.previewPause")
          : t("soundboard.previewPlay");
      elements.bindingConfigSoundboardPreview.setAttribute("aria-label", label);
      elements.bindingConfigSoundboardPreview.title = label;
    }
    if (elements.bindingConfigSoundboardPlaybackTime) {
      elements.bindingConfigSoundboardPlaybackTime.textContent = formatSoundboardTime(
        position ?? mapping?.trim_start_ms ?? 0,
      );
    }
    drawSoundboardWaveform(
      elements.bindingConfigSoundboardWaveform,
      soundboardState.analysis?.peaks,
      duration,
      mapping?.trim_start_ms || 0,
      end,
      soundboardWaveformColors(elements.bindingConfigSoundboardWaveform),
      position,
    );
  }

  function clearSoundboardPreviewState() {
    soundboardState.previewState = "stopped";
    soundboardState.previewStartedAt = 0;
    soundboardState.previewElapsedMs = 0;
    cancelSoundboardPreviewFrame();
    renderSoundboardPreviewVisual();
  }

  function updateSoundboardPreviewFrame() {
    if (soundboardState.previewState !== "playing") return;
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
    try {
      await invoke("stop_soundboard_preview");
    } catch {}
  }

  async function loadSoundboardOutputDevices() {
    soundboardState.outputDevicesLoaded = false;
    try {
      const devices = await invoke("list_soundboard_output_devices");
      soundboardState.outputDevices = Array.isArray(devices) ? devices : [];
    } catch {
      soundboardState.outputDevices = [];
    }
    soundboardState.outputDevicesLoaded = true;
    const binding = getConfigBinding();
    if (binding && editorState.soundboardPageOpen) renderSoundboardEditor(binding);
  }

  async function loadSoundboardVirtualAudioStatus() {
    const token = ++soundboardState.virtualAudioStatusToken;
    soundboardState.virtualAudioState = "loading";
    const loadingBinding = getConfigBinding();
    if (loadingBinding && editorState.soundboardPageOpen) renderSoundboardEditor(loadingBinding);
    try {
      const status = await invoke("get_virtual_audio_status");
      if (token !== soundboardState.virtualAudioStatusToken) return;
      soundboardState.virtualAudioState =
        String(status?.install_state || status?.state || "") === "ready" ? "ready" : "unavailable";
    } catch {
      if (token !== soundboardState.virtualAudioStatusToken) return;
      soundboardState.virtualAudioState = "unavailable";
    }
    const binding = getConfigBinding();
    if (binding && editorState.soundboardPageOpen) renderSoundboardEditor(binding);
  }

  function renderSoundboardOutputOptions(mapping) {
    const select = elements.bindingConfigSoundboardOutput;
    if (!select) return;
    const systemDefaultValue = "__system_default__";
    if (!soundboardState.outputDropdown) {
      soundboardState.outputDropdown = createSelectDropdownShell({
        selectEl: select,
        rootClass: "settings-select-dropdown soundboard-output-dropdown",
        title: t("soundboard.outputDevice"),
      });
    }
    select.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = systemDefaultValue;
    defaultOption.textContent = soundboardState.outputDevicesLoaded
      ? t("soundboard.systemDefault")
      : t("soundboard.loadingDevices");
    select.append(defaultOption);
    soundboardState.outputDevices.forEach((device) => {
      const option = document.createElement("option");
      option.value = String(device.id || "");
      option.textContent = device.is_default
        ? t("soundboard.defaultDevice", { device: device.display })
        : String(device.display || device.id || "");
      select.append(option);
    });
    if (
      mapping?.output_device_id &&
      !soundboardState.outputDevices.some((device) => device.id === mapping.output_device_id)
    ) {
      const unavailable = document.createElement("option");
      unavailable.value = mapping.output_device_id;
      unavailable.textContent = t("soundboard.deviceUnavailable", {
        device: mapping.output_device_display || mapping.output_device_id,
      });
      select.append(unavailable);
    }
    select.value = mapping?.output_device_id || systemDefaultValue;
    renderNativeSelectDropdown({
      entry: soundboardState.outputDropdown,
      selectEl: select,
      fallbackText: t("soundboard.systemDefault"),
      formatOptionText: (option) => option.textContent || t("soundboard.systemDefault"),
    });
  }

  function soundboardEndMs(mapping) {
    const duration = Number(soundboardState.analysis?.duration_ms) || 0;
    return mapping?.trim_end_ms == null ? duration : Math.min(duration, Number(mapping.trim_end_ms) || 0);
  }

  function setSoundboardTrim(changed, value) {
    const binding = getConfigBinding();
    const mapping = normalizeSoundboardMapping(binding?.soundboard);
    const duration = Number(soundboardState.analysis?.duration_ms) || 0;
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
    stopSoundboardPreview().catch(() => {});
    renderSoundboardEditor(binding);
  }

  return {
    cancelSoundboardPreviewFrame,
    showSoundboardAlreadyConfiguredError,
    showSpecialActionConflictError,
    scheduleSoundboardPreviewFrame,
    renderSoundboardPreviewVisual,
    stopSoundboardPreview,
    loadSoundboardOutputDevices,
    loadSoundboardVirtualAudioStatus,
    renderSoundboardOutputOptions,
    soundboardEndMs,
    setSoundboardTrim,
  };
}

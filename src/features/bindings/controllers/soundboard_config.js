import { normalizeSoundboardMapping } from "../../../core/binding_model.js";
import {
  clampSoundboardTrim,
  soundboardArrowStep,
  waveformTimeFromPointer,
  formatSoundboardTime,
} from "../soundboard_editor.js";

/** soundboard config workflow. */
export function createSoundboardConfig({
  cancelSoundboardPreviewFrame,
  elements,
  getConfigBinding,
  invoke,
  renderSoundboardOutputOptions,
  renderSoundboardPreviewVisual,
  scheduleSoundboardPreviewFrame,
  setSoundboardTrim,
  soundboardEndMs,
  soundboardState,
  stopSoundboardPreview,
  t,
  updateSliderFill,
}) {
  async function loadSoundboardAnalysis(binding, { force = false } = {}) {
    const mapping = normalizeSoundboardMapping(binding?.soundboard);
    if (!mapping || (!force && soundboardState.analysis?.path === mapping.path)) return;
    const token = ++soundboardState.analysisToken;
    soundboardState.analysis = null;
    soundboardState.analysisError = "";
    renderSoundboardEditor(binding);
    try {
      const analysis = await invoke("analyze_soundboard_audio", { path: mapping.path });
      if (token !== soundboardState.analysisToken || getConfigBinding()?.soundboard?.path !== mapping.path)
        return;
      soundboardState.analysis = analysis;
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
      if (token !== soundboardState.analysisToken) return;
      soundboardState.analysisError = String(error || t("soundboard.unavailable"));
    }
    renderSoundboardEditor(getConfigBinding());
  }

  function wireSoundboardEditor() {
    if (elements.bindingConfigSoundboardReplace)
      elements.bindingConfigSoundboardReplace.onclick = async () => {
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
            output_device_display:
              normalizeSoundboardMapping(binding.soundboard)?.output_device_display ?? null,
            send_to_monitor: normalizeSoundboardMapping(binding.soundboard)?.send_to_monitor ?? true,
            send_to_virtual_mic: normalizeSoundboardMapping(binding.soundboard)?.send_to_virtual_mic ?? false,
          };
          soundboardState.analysis = analysis;
          soundboardState.analysisError = "";
          renderSoundboardEditor(binding);
        } catch (error) {
          soundboardState.analysisError = String(error || t("soundboard.unavailable"));
          renderSoundboardEditor(getConfigBinding());
        }
      };
    if (elements.bindingConfigSoundboardPreview)
      elements.bindingConfigSoundboardPreview.onclick = async () => {
        const mapping = normalizeSoundboardMapping(getConfigBinding()?.soundboard);
        if (!mapping) return;
        if (soundboardState.previewState === "playing") {
          soundboardState.previewElapsedMs +=
            (performance.now() - soundboardState.previewStartedAt) * mapping.speed;
          soundboardState.previewState = "paused";
          cancelSoundboardPreviewFrame();
          await invoke("set_soundboard_preview_paused", { paused: true });
          renderSoundboardPreviewVisual();
          return;
        }
        if (soundboardState.previewState === "paused") {
          await invoke("set_soundboard_preview_paused", { paused: false });
          soundboardState.previewState = "playing";
          soundboardState.previewStartedAt = performance.now();
          renderSoundboardPreviewVisual();
          scheduleSoundboardPreviewFrame();
          return;
        }
        try {
          await invoke("preview_soundboard_audio", { mapping });
          soundboardState.previewState = "playing";
          soundboardState.previewElapsedMs = 0;
          soundboardState.previewStartedAt = performance.now();
          renderSoundboardPreviewVisual();
          scheduleSoundboardPreviewFrame();
        } catch (error) {
          soundboardState.analysisError = String(error || t("soundboard.unavailable"));
          renderSoundboardEditor(getConfigBinding());
        }
      };
    if (elements.bindingConfigSoundboardSpeed)
      elements.bindingConfigSoundboardSpeed.oninput = () => {
        const binding = getConfigBinding();
        const mapping = normalizeSoundboardMapping(binding?.soundboard);
        if (!binding || !mapping) return;
        mapping.speed = Math.min(2, Math.max(0.5, Number(elements.bindingConfigSoundboardSpeed.value) / 100));
        binding.soundboard = mapping;
        elements.bindingConfigSoundboardSpeedValue.textContent = `${mapping.speed.toFixed(2)}×`;
        updateSliderFill(elements.bindingConfigSoundboardSpeed);
        stopSoundboardPreview().catch(() => {});
      };
    if (elements.bindingConfigSoundboardOutput)
      elements.bindingConfigSoundboardOutput.onchange = () => {
        const binding = getConfigBinding();
        const mapping = normalizeSoundboardMapping(binding?.soundboard);
        if (!binding || !mapping) return;
        const selectedValue = String(elements.bindingConfigSoundboardOutput.value || "");
        const selectedId = selectedValue === "__system_default__" ? "" : selectedValue;
        const selected = soundboardState.outputDevices.find((device) => device.id === selectedId);
        mapping.output_device_id = selectedId || null;
        mapping.output_device_display = selectedId
          ? selected?.display || mapping.output_device_display || null
          : null;
        binding.soundboard = mapping;
        stopSoundboardPreview().catch(() => {});
        renderSoundboardEditor(binding);
      };
    if (elements.bindingConfigSoundboardMonitor)
      elements.bindingConfigSoundboardMonitor.onchange = () => {
        const binding = getConfigBinding();
        const mapping = normalizeSoundboardMapping(binding?.soundboard);
        if (!binding || !mapping) return;
        mapping.send_to_monitor = elements.bindingConfigSoundboardMonitor.checked;
        if (!mapping.send_to_monitor && !mapping.send_to_virtual_mic) {
          if (soundboardState.virtualAudioState === "ready") mapping.send_to_virtual_mic = true;
          else mapping.send_to_monitor = true;
        }
        binding.soundboard = mapping;
        renderSoundboardEditor(binding);
      };
    if (elements.bindingConfigSoundboardVirtualMic)
      elements.bindingConfigSoundboardVirtualMic.onchange = () => {
        const binding = getConfigBinding();
        const mapping = normalizeSoundboardMapping(binding?.soundboard);
        if (!binding || !mapping) return;
        mapping.send_to_virtual_mic = elements.bindingConfigSoundboardVirtualMic.checked;
        if (!mapping.send_to_virtual_mic && !mapping.send_to_monitor) mapping.send_to_monitor = true;
        binding.soundboard = mapping;
        renderSoundboardEditor(binding);
      };
    if (elements.bindingConfigSoundboardVolume)
      elements.bindingConfigSoundboardVolume.oninput = () => {
        const binding = getConfigBinding();
        const mapping = normalizeSoundboardMapping(binding?.soundboard);
        if (!binding || !mapping) return;
        mapping.volume = Math.min(1, Math.max(0, Number(elements.bindingConfigSoundboardVolume.value) / 100));
        binding.soundboard = mapping;
        elements.bindingConfigSoundboardVolumeValue.textContent = `${Math.round(mapping.volume * 100)}%`;
        updateSliderFill(elements.bindingConfigSoundboardVolume);
        invoke("set_soundboard_preview_volume", { volume: mapping.volume }).catch(() => {});
      };
    [
      [elements.bindingConfigSoundboardStart, "start"],
      [elements.bindingConfigSoundboardEnd, "end"],
    ].forEach(([input, handle]) => {
      if (!input) return;
      input.oninput = () => setSoundboardTrim(handle, Number(input.value));
      input.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
        setSoundboardTrim(handle, Number(input.value) + direction * soundboardArrowStep(event));
      };
    });
    const canvas = elements.bindingConfigSoundboardWaveform;
    if (canvas && !canvas.dataset.soundboardWired) {
      canvas.dataset.soundboardWired = "true";
      canvas.addEventListener("pointerdown", (event) => {
        const duration = Number(soundboardState.analysis?.duration_ms) || 0;
        const mapping = normalizeSoundboardMapping(getConfigBinding()?.soundboard);
        if (!mapping || duration <= 0) return;
        const time = waveformTimeFromPointer(event, canvas, duration);
        soundboardState.pointerHandle =
          Math.abs(time - mapping.trim_start_ms) <= Math.abs(time - soundboardEndMs(mapping))
            ? "start"
            : "end";
        canvas.setPointerCapture(event.pointerId);
        setSoundboardTrim(soundboardState.pointerHandle, time);
      });
      canvas.addEventListener("pointermove", (event) => {
        if (!soundboardState.pointerHandle || !canvas.hasPointerCapture(event.pointerId)) return;
        setSoundboardTrim(
          soundboardState.pointerHandle,
          waveformTimeFromPointer(event, canvas, Number(soundboardState.analysis?.duration_ms) || 0),
        );
      });
      const release = (event) => {
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        soundboardState.pointerHandle = null;
      };
      canvas.addEventListener("pointerup", release);
      canvas.addEventListener("pointercancel", release);
    }
  }

  function renderSoundboardEditor(binding) {
    if (!binding || !elements.bindingConfigSoundboardSection) return;
    wireSoundboardEditor();
    const mapping = normalizeSoundboardMapping(binding.soundboard);
    const analysis = soundboardState.analysis?.path === mapping?.path ? soundboardState.analysis : null;
    const duration = Number(analysis?.duration_ms) || 0;
    const end = mapping
      ? mapping.trim_end_ms == null
        ? duration
        : Math.min(duration, mapping.trim_end_ms)
      : 0;
    elements.bindingConfigSoundboardSection.classList.toggle("is-empty", !mapping);
    elements.bindingConfigSoundboardFile.textContent = mapping?.display || t("soundboard.noFile");
    elements.bindingConfigSoundboardStatus.textContent = !mapping
      ? ""
      : soundboardState.analysisError
        ? t("soundboard.unavailableRelink")
        : analysis
          ? t("soundboard.ready")
          : t("soundboard.analyzing");
    elements.bindingConfigSoundboardStatus.classList.toggle(
      "is-error",
      Boolean(soundboardState.analysisError),
    );
    elements.bindingConfigSoundboardPreview.disabled = !analysis || Boolean(soundboardState.analysisError);
    elements.bindingConfigSoundboardStart.max = String(duration);
    elements.bindingConfigSoundboardStart.value = String(mapping?.trim_start_ms || 0);
    elements.bindingConfigSoundboardStart.disabled = !analysis;
    elements.bindingConfigSoundboardEnd.max = String(duration);
    elements.bindingConfigSoundboardEnd.value = String(end);
    elements.bindingConfigSoundboardEnd.disabled = !analysis;
    elements.bindingConfigSoundboardStartTime.textContent = formatSoundboardTime(mapping?.trim_start_ms || 0);
    elements.bindingConfigSoundboardEndTime.textContent = formatSoundboardTime(end);
    elements.bindingConfigSoundboardSelectionTime.textContent = formatSoundboardTime(
      Math.max(0, end - (mapping?.trim_start_ms || 0)),
    );
    elements.bindingConfigSoundboardVolume.value = String(Math.round((mapping?.volume ?? 1) * 100));
    elements.bindingConfigSoundboardVolumeValue.textContent = `${Math.round((mapping?.volume ?? 1) * 100)}%`;
    elements.bindingConfigSoundboardSpeed.value = String(Math.round((mapping?.speed ?? 1) * 100));
    elements.bindingConfigSoundboardSpeedValue.textContent = `${(mapping?.speed ?? 1).toFixed(2)}×`;
    if (elements.bindingConfigSoundboardMonitor) {
      elements.bindingConfigSoundboardMonitor.checked = mapping?.send_to_monitor ?? true;
      elements.bindingConfigSoundboardMonitor.disabled = !mapping;
    }
    if (elements.bindingConfigSoundboardVirtualMic) {
      elements.bindingConfigSoundboardVirtualMic.checked = mapping?.send_to_virtual_mic ?? false;
      elements.bindingConfigSoundboardVirtualMic.disabled =
        !mapping || soundboardState.virtualAudioState !== "ready";
    }
    if (elements.bindingConfigSoundboardVirtualMicOption) {
      const unavailable = soundboardState.virtualAudioState !== "ready";
      elements.bindingConfigSoundboardVirtualMicOption.classList.toggle("is-unavailable", unavailable);
      elements.bindingConfigSoundboardVirtualMicOption.setAttribute("aria-disabled", String(unavailable));
      elements.bindingConfigSoundboardVirtualMicOption.title = unavailable
        ? t(
            soundboardState.virtualAudioState === "loading"
              ? "virtualAudio.checking"
              : "virtualAudio.setupTitle",
          )
        : "";
    }
    if (elements.bindingConfigSoundboardVirtualMicHelp) {
      elements.bindingConfigSoundboardVirtualMicHelp.textContent =
        soundboardState.virtualAudioState === "loading"
          ? t("virtualAudio.checking")
          : soundboardState.virtualAudioState === "ready"
            ? t("soundboard.virtualMicrophoneHelp")
            : t("virtualAudio.setupTitle");
    }
    if (elements.bindingConfigSoundboardOutput)
      elements.bindingConfigSoundboardOutput.disabled = !mapping || mapping.send_to_monitor === false;
    if (soundboardState.outputDropdown?.button)
      soundboardState.outputDropdown.button.disabled = !mapping || mapping.send_to_monitor === false;
    [
      elements.bindingConfigSoundboardStart,
      elements.bindingConfigSoundboardEnd,
      elements.bindingConfigSoundboardSpeed,
      elements.bindingConfigSoundboardVolume,
    ].forEach((input) => input && updateSliderFill(input));
    renderSoundboardOutputOptions(mapping);
    renderSoundboardPreviewVisual();
  }

  return { loadSoundboardAnalysis, renderSoundboardEditor };
}

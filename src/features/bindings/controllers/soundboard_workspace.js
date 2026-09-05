import { createSoundboardPreview } from "./soundboard_preview.js";
import { createSoundboardConfig } from "./soundboard_config.js";

/** soundboard workspace workflow. */
export function createSoundboardWorkspace({
  alertAction,
  elements,
  editorState,
  getConfigBinding,
  invoke,
  soundboardState,
  t,
  updateSliderFill,
}) {
  const {
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
  } = createSoundboardPreview({
    alertAction,
    elements,
    editorState,
    getConfigBinding,
    invoke,
    renderSoundboardEditor: (...args) => renderSoundboardEditor(...args),
    soundboardState,
    t,
  });

  const { loadSoundboardAnalysis, renderSoundboardEditor } = createSoundboardConfig({
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
  });
  return {
    cancelSoundboardPreviewFrame,
    showSoundboardAlreadyConfiguredError,
    showSpecialActionConflictError,
    stopSoundboardPreview,
    loadSoundboardOutputDevices,
    loadSoundboardVirtualAudioStatus,
    loadSoundboardAnalysis,
    renderSoundboardEditor,
  };
}

import { createMacroTree } from "./macro_tree.js";
import { createMacroConfig } from "./macro_config.js";
import { createMacroDrag } from "./macro_drag.js";
import { createMacroActionControls } from "./macro_action_controls.js";

import { createMacroCards } from "./macro_cards.js";
import { createMacroActionProperties } from "./macro_action_properties.js";
import { createMacroProperties } from "./macro_properties.js";
import { createMacroEditor } from "./macro_editor.js";

/** macro workspace workflow. */
export function createMacroWorkspace({
  buildTarget,
  elements,
  getConfigBinding,
  lifetime,
  macroState,
  renderConfigModal,
  renderConfigPreview,
  resolveTargetDisplay,
  startHotkeyLearn,
  t,
}) {
  const {
    macroActionTitle,
    macroTargetTitle,
    macroStepSummary,
    macroWaitDurationLabel,
    macroActionCountLabel,
    macroPathKey,
    macroPathsEqual,
    macroPathForFirstStep,
    normalizeMacroSelectedPath,
    getMacroStepAtPath,
    scrollSelectedMacroStepIntoView,
    findMacroPathForStep,
    macroStepOrdinalLabel,
    createBindingConfigButton,
    wireMacroButton,
  } = createMacroTree({
    elements,
    macroState,
    resolveTargetDisplay,
    t,
  });

  const {
    ensureMacroConfigDom,
    updateMacroDraft,
    commitMacroDraftEdit,
    setMacroActionFromTargetSelect,
    setMacroActionTargetFromTargetSelect,
    applyMacroActionOptionToStep,
    buildMacroStateSelect,
  } = createMacroConfig({
    lifetime,
    createBindingConfigButton,
    elements,
    getConfigBinding: (...args) => getConfigBinding(...args),
    macroPathForFirstStep,
    macroState,
    normalizeMacroSelectedPath,
    renderConfigModal: (...args) => renderConfigModal(...args),
    renderConfigPreview: (...args) => renderConfigPreview(...args),
    renderMacroEditor: (...args) => renderMacroEditor(...args),
    t,
    wireMacroButton,
  });

  const { cancelMacroDrag, endMacroDrag, updateMacroDrag, createMacroDragHandle } = createMacroDrag({
    elements,
    findMacroPathForStep,
    getConfigBinding: (...args) => getConfigBinding(...args),
    getMacroStepAtPath,
    macroState,
    updateMacroDraft,
  });

  const { buildMacroActionControls } = createMacroActionControls({
    buildMacroStateSelect,
    getConfigBinding: (...args) => getConfigBinding(...args),
    startHotkeyLearn,
  });

  const {
    macroSelectablePaths,
    macroPathListIndex,
    macroStepTitle,
    macroIconSvg,
    createMacroIconButton,
    renderMacroStepCard,
  } = createMacroCards({
    createMacroDragHandle,
    elements,
    macroActionCountLabel,
    macroActionTitle,
    macroPathKey,
    macroPathsEqual,
    macroState,
    macroStepOrdinalLabel,
    macroTargetTitle,
    macroWaitDurationLabel,
    renderMacroEditor: (...args) => renderMacroEditor(...args),
    t,
    updateMacroDraft,
  });

  const { createMacroField, renderMacroActionProperties } = createMacroActionProperties({
    applyMacroActionOptionToStep,
    buildMacroStateSelect,
    buildTarget,
    commitMacroDraftEdit,
    createBindingConfigButton,
    macroActionTitle,
    macroStepOrdinalLabel,
    renderMacroEditor: (...args) => renderMacroEditor(...args),
    setMacroActionTargetFromTargetSelect,
    startHotkeyLearn,
    t,
  });

  const { renderMacroProperties } = createMacroProperties({
    commitMacroDraftEdit,
    createBindingConfigButton,
    createMacroField,
    createMacroIconButton,
    getMacroStepAtPath,
    macroIconSvg,
    macroPathListIndex,
    macroSelectablePaths,
    macroState,
    macroStepOrdinalLabel,
    macroStepTitle,
    normalizeMacroSelectedPath,
    renderMacroActionProperties,
    renderMacroEditor: (...args) => renderMacroEditor(...args),
    t,
    updateMacroDraft,
  });

  const { renderMacroEditor } = createMacroEditor({
    createBindingConfigButton,
    elements,
    macroPathForFirstStep,
    macroState,
    normalizeMacroSelectedPath,
    renderConfigPreview: (...args) => renderConfigPreview(...args),
    renderMacroProperties,
    renderMacroStepCard,
    scrollSelectedMacroStepIntoView,
    t,
    updateMacroDraft,
  });
  return {
    macroPathForFirstStep,
    ensureMacroConfigDom,
    cancelMacroDrag,
    endMacroDrag,
    updateMacroDrag,
    renderMacroEditor,
  };
}

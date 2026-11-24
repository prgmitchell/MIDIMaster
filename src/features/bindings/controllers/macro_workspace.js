import { createMacroTree } from "./macro_tree.js";
import { createMacroConfig } from "./macro_config.js";
import { createMacroDrag } from "./macro_drag.js";

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
    setMacroActionTargetFromTargetSelect,
    applyMacroActionOptionToStep,
    buildMacroStateSelect,
  } = createMacroConfig({
    lifetime,
    createBindingConfigButton,
    elements,
    getConfigBinding,
    macroPathForFirstStep,
    macroState,
    normalizeMacroSelectedPath,
    renderConfigModal,
    renderConfigPreview,
    renderMacroEditor: (...args) => renderMacroEditor(...args),
    t,
    wireMacroButton,
  });

  const { cancelMacroDrag, endMacroDrag, updateMacroDrag, createMacroDragHandle } = createMacroDrag({
    elements,
    findMacroPathForStep,
    getConfigBinding,
    getMacroStepAtPath,
    macroState,
    updateMacroDraft,
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
    renderConfigPreview,
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

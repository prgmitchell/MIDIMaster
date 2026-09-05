import { createCurvePresets } from "./curve_presets.js";
import { createCurveEditor } from "./curve_editor.js";

/** curve workspace workflow. */
export function createCurveWorkspace({
  alertAction,
  confirmAction,
  curveState,
  elements,
  getConfigBinding,
  getCurvePresets,
  renderConfigModal,
  renderConfigPreview,
  saveCurvePresets,
  setActionIcon,
  t,
}) {
  const {
    activeCustomCurvePreset,
    setCurvePresetMenuOpen,
    closeCurvePresetMenu,
    closeCurvePresetForm,
    openCurvePresetForm,
    syncCurvePresetToolbar,
    renderCurvePresetMenu,
    submitCurvePresetForm,
  } = createCurvePresets({
    alertAction,
    confirmAction,
    curveState,
    elements,
    getConfigBinding,
    getCurvePresets,
    renderConfigModal: (...args) => renderConfigModal(...args),
    saveCurvePresets,
    setActionIcon,
    t,
  });

  const {
    renderCurveCards,
    renderCustomCurveEditor,
    customCurveSurfaceFromEvent,
    addCustomCurvePoint,
    removeCustomCurvePoint,
    updateCustomCurveFromPointer,
  } = createCurveEditor({
    closeCurvePresetForm,
    curveState,
    elements,
    getConfigBinding,
    renderConfigModal: (...args) => renderConfigModal(...args),
    renderConfigPreview,
    syncCurvePresetToolbar,
  });
  return {
    activeCustomCurvePreset,
    setCurvePresetMenuOpen,
    closeCurvePresetMenu,
    closeCurvePresetForm,
    openCurvePresetForm,
    syncCurvePresetToolbar,
    renderCurvePresetMenu,
    submitCurvePresetForm,
    renderCurveCards,
    renderCustomCurveEditor,
    customCurveSurfaceFromEvent,
    addCustomCurvePoint,
    removeCustomCurvePoint,
    updateCustomCurveFromPointer,
  };
}

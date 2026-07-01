import {
  applyCustomFaderCurve,
  applyFaderCurve,
  buildHotkeyMappingFromEvent,
  buttonVisualBehavior as coreButtonVisualBehavior,
  effectiveButtonLightMode as coreEffectiveButtonLightMode,
  getBindingTargets,
  getPrimaryBindingTarget,
  MACRO_MAX_PARALLEL_STEPS,
  MACRO_MAX_TOP_LEVEL_STEPS,
  MACRO_MAX_WAIT_MS,
  normalizeButtonLightMode as normalizeCoreButtonLightMode,
  normalizeButtonLightBehavior as normalizeCoreButtonLightBehavior,
  normalizeButtonLightFields as normalizeCoreButtonLightFields,
  normalizeCustomCurvePoints,
  normalizeFaderCurve as normalizeCoreFaderCurve,
  normalizeMacroActionState,
  normalizeMacroActionStep,
  normalizeMacroDraftStep,
  normalizeMacroDraftSteps,
  normalizeMacroStep,
  normalizeMacroSteps,
  normalizeHotkeyKeyFromEvent,
  normalizeRelativeFormat as normalizeCoreRelativeFormat,
  presetCurvePoints as corePresetCurvePoints,
  resolveButtonVisualActive as coreResolveButtonVisualActive,
  setBindingTargets,
} from "../../core/binding_model.js";

export {
  MACRO_MAX_PARALLEL_STEPS,
  MACRO_MAX_TOP_LEVEL_STEPS,
  MACRO_MAX_WAIT_MS,
  buildHotkeyMappingFromEvent,
  normalizeMacroActionState,
  normalizeMacroActionStep,
  normalizeMacroDraftStep,
  normalizeMacroDraftSteps,
  normalizeMacroStep,
  normalizeMacroSteps,
  normalizeHotkeyKeyFromEvent,
};

export function normalizeControlKind(raw) {
  const value = String(raw || "Auto");
  if (value === "Button" || value === "Continuous" || value === "Auto") {
    return value;
  }
  return "Auto";
}

export function normalizeRelativeFormat(raw) {
  return normalizeCoreRelativeFormat(raw);
}

export function normalizeMuteBehavior(raw) {
  return raw === "SetFromValue" ? "SetFromValue" : "ToggleOnPress";
}

export function normalizeButtonLightMode(raw) {
  return normalizeCoreButtonLightMode(raw);
}

export function normalizeButtonLightBehavior(raw) {
  return normalizeCoreButtonLightBehavior(raw);
}

export function effectiveButtonLightMode(binding) {
  return coreEffectiveButtonLightMode(binding);
}

export function buttonVisualBehavior(binding) {
  return coreButtonVisualBehavior(binding);
}

export function resolveButtonVisualActive(binding, options = {}) {
  return coreResolveButtonVisualActive(binding, options);
}

export function muteBehaviorLabel(raw) {
  return normalizeMuteBehavior(raw) === "SetFromValue" ? "Match" : "Toggle";
}

export function muteBehaviorTooltip(raw) {
  return normalizeMuteBehavior(raw) === "SetFromValue"
    ? "Match: for latched buttons, toggle mute whenever the button changes between off and on states."
    : "Toggle: each button press flips mute on or off; button release does nothing.";
}

export function buttonModeValue(binding) {
  return normalizeMuteBehavior(binding?.mute_behavior) === "SetFromValue"
    ? "button_match"
    : "button_toggle";
}

export function modeTooltip(raw) {
  if (raw === "button_match") {
    return muteBehaviorTooltip("SetFromValue");
  }
  if (raw === "button_toggle") {
    return muteBehaviorTooltip("ToggleOnPress");
  }
  return "";
}

export function assignModeTooltip(raw) {
  return raw === "Replace"
    ? "Replace: assigning a focused app replaces the current target list."
    : "Add: assigning a focused app appends it to the current target list.";
}

export function normalizeFaderCurve(raw) {
  return normalizeCoreFaderCurve(raw);
}

export function defaultCustomCurve() {
  return [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 1 },
  ];
}

export function presetCurvePoints(curve) {
  return corePresetCurvePoints(curve);
}

export function normalizeCustomCurve(points) {
  const normalized = normalizeCustomCurvePoints(points);
  if (normalized.length < 2) {
    return defaultCustomCurve();
  }
  return normalized;
}

export function customCurvePoints(binding) {
  const points = normalizeCustomCurve(binding?.custom_curve);
  if (Array.isArray(points) && points.length >= 2) {
    return points;
  }
  return defaultCustomCurve();
}

export function curveEditorPoints(binding) {
  return customCurvePoints(binding);
}

export function cloneBindingDraft(binding) {
  if (!binding || typeof binding !== "object") return null;
  const clone = JSON.parse(JSON.stringify(binding));
  ensureBindingShape(clone);
  ensureAuxShape(clone);
  return clone;
}

export function curveHelpText(curve) {
  const current = normalizeFaderCurve(curve);
  if (current === "Exponential") {
    return "Exponential response. Small movements rise faster for more sensitivity near the bottom of the throw.";
  }
  if (current === "Logarithmic") {
    return "Logarithmic response. Small movements stay gentler for finer low-end control.";
  }
  if (current === "SCurve") {
    return "S-Curve response. Soft at the edges with a more assertive response through the center.";
  }
  if (current === "Custom") {
    return "Custom response. Drag dots, double-click line to add, right-click dot to delete, Alt-drag line to curve.";
  }
  return "Linear response. Output value changes at the same rate as the fader movement.";
}

export function curveDisplayName(curve) {
  return normalizeFaderCurve(curve) === "SCurve" ? "S-Curve" : normalizeFaderCurve(curve);
}

export function applyCurveToNormalized(binding, normalized) {
  const clamped = Math.min(1, Math.max(0, Number(normalized) || 0));
  return normalizeFaderCurve(binding?.fader_curve) === "Custom"
    ? applyCustomFaderCurve(normalizeCustomCurve(binding?.custom_curve), clamped)
    : applyFaderCurve(binding?.fader_curve, clamped);
}

export function ensureBindingShape(binding) {
  if (!binding || typeof binding !== "object") return;
  binding.macro_name = String(binding.macro_name || "").trim().slice(0, 80);
  if (!binding.mode || (binding.mode !== "Absolute" && binding.mode !== "Relative")) {
    binding.mode = "Absolute";
  }
  binding.relative_format = normalizeRelativeFormat(binding.relative_format);
  binding.fader_curve = normalizeFaderCurve(binding.fader_curve);
  binding.custom_curve = customCurvePoints(binding);
  binding.mute_behavior = normalizeMuteBehavior(binding.mute_behavior);
  normalizeCoreButtonLightFields(binding);
  delete binding.toggle_mute_light_mode;
  if (binding.mute_control && typeof binding.mute_control === "object") {
    binding.mute_control.mute_behavior = normalizeMuteBehavior(binding.mute_control.mute_behavior);
  }
  if (binding.indicator_control && typeof binding.indicator_control === "object") {
    const isFeedbackOutput = !effectiveIsButton(binding);
    const rawMsgType = binding.indicator_control.msg_type;
    const msgType = rawMsgType === "Note"
      ? "Note"
      : (isFeedbackOutput && rawMsgType === "PitchBend" ? "PitchBend" : "ControlChange");
    binding.indicator_control = {
      ...binding.indicator_control,
      device_id: String(binding.indicator_control.device_id || "").trim(),
      channel: Math.min(15, Math.max(0, Math.trunc(Number(binding.indicator_control.channel) || 0))),
      controller: msgType === "PitchBend"
        ? 0
        : Math.min(127, Math.max(0, Math.trunc(Number(binding.indicator_control.controller) || 0))),
      msg_type: msgType,
      control_kind: isFeedbackOutput ? "Continuous" : normalizeControlKind(binding.indicator_control.control_kind),
      mode: binding.indicator_control.mode === "Relative" ? "Relative" : "Absolute",
      deadzone: Number.isFinite(Number(binding.indicator_control.deadzone)) ? Number(binding.indicator_control.deadzone) : 0,
      debounce_ms: Number.isFinite(Number(binding.indicator_control.debounce_ms)) ? Number(binding.indicator_control.debounce_ms) : 0,
      mute_behavior: normalizeMuteBehavior(binding.indicator_control.mute_behavior),
    };
    if (!binding.indicator_control.device_id) binding.indicator_control = null;
  } else {
    binding.indicator_control = null;
  }
  if (getBindingTargets(binding).some(isMacroTarget)) {
    binding.action = "Macro";
  }
  if (binding.action === "Macro" && !getBindingTargets(binding).some(isMacroTarget)) {
    setBindingTargets(binding, ["Macro"]);
  }
  binding.macro_steps = binding.action === "Macro" || getBindingTargets(binding).some(isMacroTarget)
    ? normalizeMacroDraftSteps(binding.macro_steps)
    : normalizeMacroSteps(binding.macro_steps);
}

export function effectiveIsButton(binding) {
  const controlKind = normalizeControlKind(binding?.control_kind);
  if (controlKind === "Button") return true;
  if (controlKind === "Continuous") return false;
  return binding?.control?.msg_type === "Note" || binding?.control?.msg_type === "ProgramChange";
}

export function isHotkeyTarget(target) {
  return target === "Hotkey";
}

export function isOpenApplicationTarget(target) {
  return target === "OpenApplication";
}

export function isAutoHotkeyScriptTarget(target) {
  return target === "AutoHotkeyScript";
}

export function isMacroTarget(target) {
  return target === "Macro";
}

export function getTargets(binding) {
  return getBindingTargets(binding);
}

export function setTargets(binding, targets) {
  setBindingTargets(binding, targets);
}

export function getPrimaryTarget(binding) {
  return getPrimaryBindingTarget(binding);
}

export function ensureAuxShape(binding) {
  if (!binding) return;
  if (!("mute_control" in binding)) binding.mute_control = null;
  if (!("assign_control" in binding)) binding.assign_control = null;
  if (!("indicator_control" in binding)) binding.indicator_control = null;
  if (binding.mute_control && typeof binding.mute_control === "object") {
    binding.mute_control.mute_behavior = normalizeMuteBehavior(binding.mute_control.mute_behavior);
  }
  if (binding.assign_mode !== "Replace") binding.assign_mode = "Add";
}


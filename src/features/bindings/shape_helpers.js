import {
  applyCustomFaderCurve,
  applyFaderCurve,
  buttonVisualBehavior as coreButtonVisualBehavior,
  getBindingTargets,
  getPrimaryBindingTarget,
  normalizeButtonLightMode as normalizeCoreButtonLightMode,
  normalizeCustomCurvePoints,
  normalizeFaderCurve as normalizeCoreFaderCurve,
  normalizeRelativeFormat as normalizeCoreRelativeFormat,
  presetCurvePoints as corePresetCurvePoints,
  resolveButtonVisualActive as coreResolveButtonVisualActive,
  setBindingTargets,
} from "../../core/binding_model.js";

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
  if (Array.isArray(points) && points.length >= 3) {
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
    return "Custom response. Drag the control points to shape how MIDI movement maps to output.";
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
  if (!binding.mode || (binding.mode !== "Absolute" && binding.mode !== "Relative")) {
    binding.mode = "Absolute";
  }
  binding.relative_format = normalizeRelativeFormat(binding.relative_format);
  binding.fader_curve = normalizeFaderCurve(binding.fader_curve);
  binding.custom_curve = customCurvePoints(binding);
  binding.mute_behavior = normalizeMuteBehavior(binding.mute_behavior);
  binding.button_light_mode = normalizeButtonLightMode(binding.button_light_mode);
  if (binding.mute_control && typeof binding.mute_control === "object") {
    binding.mute_control.mute_behavior = normalizeMuteBehavior(binding.mute_control.mute_behavior);
  }
}

export function effectiveIsButton(binding) {
  const controlKind = normalizeControlKind(binding?.control_kind);
  if (controlKind === "Button") return true;
  if (controlKind === "Continuous") return false;
  return binding?.control?.msg_type === "Note";
}

export function isHotkeyTarget(target) {
  return target === "Hotkey";
}

export function isOpenApplicationTarget(target) {
  return target === "OpenApplication";
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
  if (binding.mute_control && typeof binding.mute_control === "object") {
    binding.mute_control.mute_behavior = normalizeMuteBehavior(binding.mute_control.mute_behavior);
  }
  if (binding.assign_mode !== "Replace") binding.assign_mode = "Add";
}


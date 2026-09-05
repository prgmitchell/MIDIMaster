import { bindingLooksLikeButton as effectiveIsButton } from "../../core/binding_model.js";
export { effectiveIsButton };
import { normalizeControlKind } from "../../core/binding_model.js";
import {
  applyCustomFaderCurve,
  applyFaderCurve,
  getBindingTargets,
  normalizeButtonLightFields,
  normalizeCustomCurvePoints,
  normalizeFaderCurve,
  normalizeMacroDraftSteps,
  normalizeMacroSteps,
  normalizeRelativeFormat,
  normalizeSoundboardMapping,
  setBindingTargets,
} from "../../core/binding_model.js";

export { normalizeControlKind } from "../../core/binding_model.js";

export function normalizeMuteBehavior(raw) {
  return raw === "SetFromValue" ? "SetFromValue" : "ToggleOnPress";
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
  return normalizeMuteBehavior(binding?.mute_behavior) === "SetFromValue" ? "button_match" : "button_toggle";
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
  if (raw === "Replace") {
    return "Replace: assigning a focused app replaces the current target list.";
  }
  if (raw === "Clear") {
    return "Clear: removes all targets; when empty, assigns the focused app.";
  }
  return "Add: assigning a focused app appends it to the current target list.";
}

export function defaultCustomCurve() {
  return [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 1 },
  ];
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
  binding.feedback_enabled = binding.feedback_enabled !== false;
  binding.macro_name = String(binding.macro_name || "")
    .trim()
    .slice(0, 80);
  if (!binding.mode || (binding.mode !== "Absolute" && binding.mode !== "Relative")) {
    binding.mode = "Absolute";
  }
  binding.relative_format = normalizeRelativeFormat(binding.relative_format);
  binding.fader_curve = normalizeFaderCurve(binding.fader_curve);
  binding.custom_curve = customCurvePoints(binding);
  binding.mute_behavior = normalizeMuteBehavior(binding.mute_behavior);
  normalizeButtonLightFields(binding);
  delete binding.toggle_mute_light_mode;
  if (binding.mute_control && typeof binding.mute_control === "object") {
    binding.mute_control.mute_behavior = normalizeMuteBehavior(binding.mute_control.mute_behavior);
  }
  if (binding.indicator_control && typeof binding.indicator_control === "object") {
    const isFeedbackOutput = !effectiveIsButton(binding);
    const rawMsgType = binding.indicator_control.msg_type;
    const msgType =
      rawMsgType === "Note"
        ? "Note"
        : isFeedbackOutput && rawMsgType === "PitchBend"
          ? "PitchBend"
          : "ControlChange";
    binding.indicator_control = {
      ...binding.indicator_control,
      device_id: String(binding.indicator_control.device_id || "").trim(),
      channel: Math.min(15, Math.max(0, Math.trunc(Number(binding.indicator_control.channel) || 0))),
      controller:
        msgType === "PitchBend"
          ? 0
          : Math.min(127, Math.max(0, Math.trunc(Number(binding.indicator_control.controller) || 0))),
      msg_type: msgType,
      control_kind: isFeedbackOutput
        ? "Continuous"
        : normalizeControlKind(binding.indicator_control.control_kind),
      mode: binding.indicator_control.mode === "Relative" ? "Relative" : "Absolute",
      deadzone: Number.isFinite(Number(binding.indicator_control.deadzone))
        ? Number(binding.indicator_control.deadzone)
        : 0,
      debounce_ms: Number.isFinite(Number(binding.indicator_control.debounce_ms))
        ? Number(binding.indicator_control.debounce_ms)
        : 0,
      mute_behavior: normalizeMuteBehavior(binding.indicator_control.mute_behavior),
    };
    if (!binding.indicator_control.device_id) binding.indicator_control = null;
  } else {
    binding.indicator_control = null;
  }
  if (binding.action === "Macro" && !getBindingTargets(binding).some(isMacroTarget)) {
    setBindingTargets(binding, [...getBindingTargets(binding), "Macro"]);
  }
  if (binding.action === "Soundboard" && !getBindingTargets(binding).some(isSoundboardTarget)) {
    setBindingTargets(binding, [...getBindingTargets(binding), "Soundboard"]);
  }
  const specialTargets = getBindingTargets(binding).filter(
    (target) => isMacroTarget(target) || isSoundboardTarget(target),
  );
  if (specialTargets.length > 1) {
    const preferred =
      binding.action === "Macro" || binding.action === "Soundboard" ? binding.action : specialTargets[0];
    setBindingTargets(
      binding,
      getBindingTargets(binding).filter(
        (target) => (!isMacroTarget(target) && !isSoundboardTarget(target)) || target === preferred,
      ),
    );
    if (preferred !== "Macro") {
      binding.macro_name = "";
      binding.macro_steps = [];
    }
    if (preferred !== "Soundboard") binding.soundboard = null;
  }
  binding.soundboard = normalizeSoundboardMapping(binding.soundboard);
  binding.macro_steps =
    binding.action === "Macro" || getBindingTargets(binding).some(isMacroTarget)
      ? normalizeMacroDraftSteps(binding.macro_steps)
      : normalizeMacroSteps(binding.macro_steps);
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

export function isSoundboardTarget(target) {
  return target === "Soundboard";
}

export function ensureAuxShape(binding) {
  if (!binding) return;
  if (!("mute_control" in binding)) binding.mute_control = null;
  if (!("assign_control" in binding)) binding.assign_control = null;
  if (!("indicator_control" in binding)) binding.indicator_control = null;
  if (binding.mute_control && typeof binding.mute_control === "object") {
    binding.mute_control.mute_behavior = normalizeMuteBehavior(binding.mute_control.mute_behavior);
  }
  if (binding.assign_mode !== "Replace" && binding.assign_mode !== "Clear") {
    binding.assign_mode = "Add";
  }
}

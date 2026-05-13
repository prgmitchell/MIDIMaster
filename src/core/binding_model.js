export function getBindingTargets(binding) {
  if (!binding || typeof binding !== "object") return [];
  if (Array.isArray(binding.targets) && binding.targets.length > 0) {
    const normalized = binding.targets.filter(Boolean).filter((t) => t !== "Unset").slice(0, 8);
    if (normalized.length > 0) return normalized;
  }
  if (binding.target != null) {
    return [binding.target];
  }
  return [];
}

export function setBindingTargets(binding, targets) {
  if (!binding || typeof binding !== "object") return;
  const normalized = Array.isArray(targets) ? targets.filter(Boolean).slice(0, 8) : [];
  if (normalized.length === 0) normalized.push("Unset");
  binding.targets = normalized;
  binding.target = normalized[0] || "Unset";
}

export function getPrimaryBindingTarget(binding) {
  return getBindingTargets(binding)[0] || "Unset";
}

export function bindingHasIntegrationTarget(binding) {
  return getBindingTargets(binding).some((target) => {
    const integ = target?.Integration || target?.integration;
    return Boolean(integ && typeof integ === "object" && integ.integration_id);
  });
}

export function normalizeBinding(binding) {
  if (!binding || typeof binding !== "object") return binding;
  const out = { ...binding };
  setBindingTargets(out, getBindingTargets(out));
  out.mode = (out.mode === "Relative") ? "Relative" : "Absolute";
  out.relative_format = "Auto";
  out.fader_curve = normalizeFaderCurve(out.fader_curve);
  out.custom_curve = normalizeCustomCurvePoints(out.custom_curve);
  if (out.custom_curve.length < 2) {
    out.custom_curve = presetCurvePoints(out.fader_curve);
  }
  out.mute_behavior = out.mute_behavior === "SetFromValue" ? "SetFromValue" : "ToggleOnPress";
  if (out.mute_control && typeof out.mute_control === "object") {
    out.mute_control = {
      ...out.mute_control,
      mute_behavior: out.mute_control.mute_behavior === "SetFromValue" ? "SetFromValue" : "ToggleOnPress",
    };
  }
  if (out.assign_mode !== "Replace") out.assign_mode = "Add";
  out.button_light_mode = normalizeButtonLightMode(out.button_light_mode);
  if (!out.hotkey || typeof out.hotkey !== "object") out.hotkey = null;
  if (!out.open_application || typeof out.open_application !== "object") {
    out.open_application = null;
  } else {
    const path = String(out.open_application.path || "").trim();
    const display = String(out.open_application.display || "").trim();
    const icon_data = typeof out.open_application.icon_data === "string" && out.open_application.icon_data.trim()
      ? out.open_application.icon_data.trim()
      : null;
    out.open_application = path ? { path, display: display || path, icon_data } : null;
  }
  return out;
}

export function normalizeRelativeFormat(raw) {
  const value = String(raw || "Auto");
  if (
    value === "Auto"
    || value === "TwosComplement"
    || value === "BinaryOffset"
    || value === "SignMagnitude"
  ) {
    return value;
  }
  return "Auto";
}

export function normalizeButtonLightMode(raw) {
  return raw === "MappedWhenAssigned" ? "MappedWhenAssigned" : "Activity";
}

export function decodeRelativeTwosComplement(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return value;
  if (value >= 65 && value <= 127) return value - 128;
  return null;
}

export function decodeRelativeBinaryOffset(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return -(64 - value);
  if (value >= 65 && value <= 127) return value - 64;
  return null;
}

export function decodeRelativeSignMagnitude(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return value;
  if (value >= 65 && value <= 127) return -(value - 64);
  return null;
}

export function detectRelativeFormatAuto(value, previousFormat) {
  if (previousFormat && previousFormat !== "Auto") {
    return previousFormat;
  }
  if (value >= 96 && value <= 127) return "TwosComplement";
  if (value === 63) return "BinaryOffset";
  if (value >= 65 && value <= 95) return "SignMagnitude";
  return null;
}

export function decodeRelativeDelta(binding, value, autoFormatByBinding = null) {
  const configured = normalizeRelativeFormat(binding?.relative_format);
  let format = configured;
  if (format === "Auto") {
    const key = String(binding?.id || "");
    const previouslyDetected = key && autoFormatByBinding ? autoFormatByBinding.get(key) : null;
    const detected = detectRelativeFormatAuto(value, previouslyDetected);
    if (detected && key && autoFormatByBinding) {
      autoFormatByBinding.set(key, detected);
    }
    format = detected || previouslyDetected || "TwosComplement";
  }

  if (format === "TwosComplement") return decodeRelativeTwosComplement(value);
  if (format === "BinaryOffset") return decodeRelativeBinaryOffset(value);
  if (format === "SignMagnitude") return decodeRelativeSignMagnitude(value);
  return null;
}

export function normalizeFaderCurve(raw) {
  const value = String(raw || "Linear");
  return ["Linear", "Exponential", "Logarithmic", "SCurve", "Custom"].includes(value)
    ? value
    : "Linear";
}

export function presetCurvePoints(curve) {
  switch (normalizeFaderCurve(curve)) {
    case "Exponential":
      return [
        { x: 0, y: 0 },
        { x: 0.18, y: 0.04 },
        { x: 0.42, y: 0.16 },
        { x: 0.72, y: 0.5 },
        { x: 1, y: 1 },
      ];
    case "Logarithmic":
      return [
        { x: 0, y: 0 },
        { x: 0.08, y: 0.34 },
        { x: 0.24, y: 0.58 },
        { x: 0.52, y: 0.8 },
        { x: 1, y: 1 },
      ];
    case "SCurve":
      return [
        { x: 0, y: 0 },
        { x: 0.18, y: 0.06 },
        { x: 0.5, y: 0.5 },
        { x: 0.82, y: 0.94 },
        { x: 1, y: 1 },
      ];
    case "Custom":
      return [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ];
    case "Linear":
    default:
      return [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ];
  }
}

export function normalizeCustomCurvePoints(points) {
  const normalized = Array.isArray(points)
    ? points
        .map((point) => ({
          x: Math.min(1, Math.max(0, Number(point?.x) || 0)),
          y: Math.min(1, Math.max(0, Number(point?.y) || 0)),
        }))
        .sort((a, b) => a.x - b.x)
    : [];
  if (normalized.length >= 2) {
    normalized[0].x = 0;
    normalized[normalized.length - 1].x = 1;
  }
  return normalized;
}

export function applyCustomFaderCurve(points, normalized) {
  const clamped = Math.min(1, Math.max(0, Number(normalized) || 0));
  const normalizedPoints = normalizeCustomCurvePoints(points);
  if (normalizedPoints.length < 2) return clamped;
  if (clamped <= normalizedPoints[0].x) return normalizedPoints[0].y;
  for (let index = 0; index < normalizedPoints.length - 1; index += 1) {
    const start = normalizedPoints[index];
    const end = normalizedPoints[index + 1];
    if (clamped > end.x) continue;
    const span = end.x - start.x;
    if (Math.abs(span) < 0.00001) return end.y;
    const t = Math.min(1, Math.max(0, (clamped - start.x) / span));
    return start.y + ((end.y - start.y) * t);
  }
  return normalizedPoints[normalizedPoints.length - 1].y;
}

export function applyFaderCurve(curve, normalized) {
  const clamped = Math.min(1, Math.max(0, Number(normalized) || 0));
  switch (normalizeFaderCurve(curve)) {
    case "Exponential":
      return Math.pow(clamped, 0.55);
    case "Logarithmic":
      return Math.pow(clamped, 2.2);
    case "SCurve":
      return clamped * clamped * (3 - (2 * clamped));
    default:
      return clamped;
  }
}

import {
  normalizeCustomCurvePoints,
  normalizeFaderCurve,
  presetCurvePoints,
} from "../../core/binding_model.js";

export const MAX_FADER_CURVE_PRESETS = 50;
export const BUILT_IN_FADER_CURVES = ["Linear", "Exponential", "Logarithmic", "SCurve"];

const MAX_PRESET_NAME_LENGTH = 64;
const POINT_EPSILON = 0.0001;

export function normalizeCurvePresetName(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .trim()
    .slice(0, MAX_PRESET_NAME_LENGTH);
}

export function curvePresetIdFromName(value, fallback = "curve-preset") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  let output = "";
  let lastDash = false;
  for (const ch of normalized) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_") {
      output += ch;
      lastDash = false;
    } else if ((ch === "-" || /\s/.test(ch)) && output && !lastDash) {
      output += "-";
      lastDash = true;
    }
  }
  output = output.replace(/-+$/g, "").slice(0, MAX_PRESET_NAME_LENGTH);
  return output || fallback;
}

function uniqueId(candidate, usedIds) {
  const base = curvePresetIdFromName(candidate);
  let id = base;
  let counter = 2;
  while (usedIds.has(id)) {
    const suffix = `-${counter}`;
    id = `${base.slice(0, Math.max(1, MAX_PRESET_NAME_LENGTH - suffix.length))}${suffix}`;
    counter += 1;
  }
  usedIds.add(id);
  return id;
}

function uniqueName(candidate, usedNames) {
  const base = normalizeCurvePresetName(candidate);
  if (!base) return "";
  let name = base;
  let counter = 2;
  while (usedNames.has(name.toLowerCase())) {
    const suffix = ` ${counter}`;
    name = `${base.slice(0, Math.max(1, MAX_PRESET_NAME_LENGTH - suffix.length))}${suffix}`;
    counter += 1;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

export function normalizeCurvePresetPoints(points) {
  const normalized = normalizeCustomCurvePoints(points);
  return normalized.length >= 2 ? normalized : [];
}

export function normalizeFaderCurvePreset(raw, usedIds = new Set(), usedNames = new Set()) {
  if (!raw || typeof raw !== "object") return null;
  const name = uniqueName(raw.name, usedNames);
  if (!name) return null;
  const points = normalizeCurvePresetPoints(raw.points);
  if (points.length < 2) return null;
  return {
    id: uniqueId(raw.id || name, usedIds),
    name,
    points,
  };
}

export function normalizeFaderCurvePresets(rawPresets) {
  const usedIds = new Set();
  const usedNames = new Set();
  const output = [];
  const input = Array.isArray(rawPresets) ? rawPresets : [];
  for (const raw of input) {
    if (output.length >= MAX_FADER_CURVE_PRESETS) break;
    const preset = normalizeFaderCurvePreset(raw, usedIds, usedNames);
    if (preset) output.push(preset);
  }
  return output;
}

export function curvePointsForBinding(binding) {
  const curve = normalizeFaderCurve(binding?.fader_curve);
  return curve === "Custom"
    ? normalizeCurvePresetPoints(binding?.custom_curve)
    : presetCurvePoints(curve);
}

export function curvePresetPointsEqual(left, right) {
  const a = normalizeCurvePresetPoints(left);
  const b = normalizeCurvePresetPoints(right);
  if (a.length !== b.length || a.length < 2) return false;
  return a.every((point, index) => (
    Math.abs(point.x - b[index].x) <= POINT_EPSILON
    && Math.abs(point.y - b[index].y) <= POINT_EPSILON
    && Math.abs((point.curve || 0) - (b[index].curve || 0)) <= POINT_EPSILON
  ));
}

export function findMatchingFaderCurvePreset(binding, presets) {
  if (normalizeFaderCurve(binding?.fader_curve) !== "Custom") return null;
  const points = normalizeCurvePresetPoints(binding?.custom_curve);
  if (points.length < 2) return null;
  return normalizeFaderCurvePresets(presets).find((preset) => (
    curvePresetPointsEqual(points, preset.points)
  )) || null;
}

export function nextCurvePresetName(presets) {
  const existing = new Set(
    normalizeFaderCurvePresets(presets).map((preset) => preset.name.toLowerCase()),
  );
  let index = existing.size + 1;
  let name = `Custom Curve ${index}`;
  while (existing.has(name.toLowerCase())) {
    index += 1;
    name = `Custom Curve ${index}`;
  }
  return name;
}

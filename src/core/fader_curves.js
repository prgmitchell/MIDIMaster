/** Canonical frontend fader curves rules. Rust validates persisted/runtime data. */
export function normalizeFaderCurve(raw) {
  const value = String(raw || "Linear");
  return ["Linear", "Exponential", "Logarithmic", "SCurve", "Custom"].includes(value) ? value : "Linear";
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
          curve: Math.min(1, Math.max(-1, Number(point?.curve) || 0)),
        }))
        .sort((a, b) => a.x - b.x)
    : [];
  if (normalized.length >= 2) {
    normalized[0].x = 0;
    normalized[normalized.length - 1].x = 1;
    normalized[normalized.length - 1].curve = 0;
  }
  return normalized.map((point) => (Math.abs(point.curve) < 0.0001 ? { x: point.x, y: point.y } : point));
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
    const linear = start.y + (end.y - start.y) * t;
    const curveOffset = (Number(start.curve) || 0) * 2 * (1 - t) * t;
    return Math.min(1, Math.max(0, linear + curveOffset));
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
      return clamped * clamped * (3 - 2 * clamped);
    default:
      return clamped;
  }
}

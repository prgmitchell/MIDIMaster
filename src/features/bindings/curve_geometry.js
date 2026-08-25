import { normalizeCustomCurve } from "./shape_helpers.js";

export const CUSTOM_CURVE_VIEWBOX_SIZE = 120;
export const CUSTOM_CURVE_PADDING = 10;
export const CUSTOM_CURVE_MIN_POINT_SPACING = 0.035;

const CUSTOM_CURVE_PLOT_SIZE = CUSTOM_CURVE_VIEWBOX_SIZE - (CUSTOM_CURVE_PADDING * 2);
const CUSTOM_CURVE_EPSILON = 0.0001;

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

export function curveSvgX(value) {
  return CUSTOM_CURVE_PADDING + (clampUnit(value) * CUSTOM_CURVE_PLOT_SIZE);
}

export function curveSvgY(value) {
  return CUSTOM_CURVE_VIEWBOX_SIZE
    - CUSTOM_CURVE_PADDING
    - (clampUnit(value) * CUSTOM_CURVE_PLOT_SIZE);
}

export function clampSegmentCurve(start, end, curve) {
  const midpointY = ((Number(start?.y) || 0) + (Number(end?.y) || 0)) / 2;
  return Math.min(1 - midpointY, Math.max(-midpointY, Number(curve) || 0));
}

export function curvePathData(points) {
  const safePoints = normalizeCustomCurve(points);
  if (!safePoints.length) return "";
  const commands = [`M${curveSvgX(safePoints[0].x)} ${curveSvgY(safePoints[0].y)}`];
  for (let index = 0; index < safePoints.length - 1; index += 1) {
    const start = safePoints[index];
    const end = safePoints[index + 1];
    const curve = clampSegmentCurve(start, end, start.curve || 0);
    if (Math.abs(curve) > CUSTOM_CURVE_EPSILON) {
      const controlX = (start.x + end.x) / 2;
      const controlY = ((start.y + end.y) / 2) + curve;
      commands.push(`Q${curveSvgX(controlX)} ${curveSvgY(controlY)} ${curveSvgX(end.x)} ${curveSvgY(end.y)}`);
    } else {
      commands.push(`L${curveSvgX(end.x)} ${curveSvgY(end.y)}`);
    }
  }
  return commands.join(" ");
}

export function localCustomCurvePoint(event, surfaceEl) {
  const svg = surfaceEl?.querySelector?.("svg");
  const rect = (svg || surfaceEl)?.getBoundingClientRect?.();
  if (!rect?.width || !rect.height) return null;
  const svgX = ((event.clientX - rect.left) / rect.width) * CUSTOM_CURVE_VIEWBOX_SIZE;
  const svgY = ((event.clientY - rect.top) / rect.height) * CUSTOM_CURVE_VIEWBOX_SIZE;
  return {
    x: clampUnit((svgX - CUSTOM_CURVE_PADDING) / CUSTOM_CURVE_PLOT_SIZE),
    y: clampUnit((CUSTOM_CURVE_VIEWBOX_SIZE - CUSTOM_CURVE_PADDING - svgY) / CUSTOM_CURVE_PLOT_SIZE),
  };
}

export function segmentIndexForCurveX(points, x) {
  if (!Array.isArray(points) || points.length < 2) return -1;
  for (let index = 0; index < points.length - 1; index += 1) {
    if (x <= points[index + 1].x) return index;
  }
  return points.length - 2;
}

export function curveYAtSegmentPoint(start, end, t) {
  const linear = start.y + ((end.y - start.y) * t);
  return clampUnit(linear + ((Number(start.curve) || 0) * 2 * (1 - t) * t));
}

export function segmentCurveFromPointer(start, end, localPoint) {
  const span = end.x - start.x;
  if (Math.abs(span) < CUSTOM_CURVE_EPSILON) return start.curve || 0;
  const t = clampUnit((localPoint.x - start.x) / span);
  const denominator = 2 * (1 - t) * t;
  if (denominator < 0.08) return start.curve || 0;
  const linear = start.y + ((end.y - start.y) * t);
  return clampSegmentCurve(start, end, (localPoint.y - linear) / denominator);
}

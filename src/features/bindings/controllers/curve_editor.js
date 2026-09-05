import {
  curveEditorPoints,
  customCurvePoints,
  curveDisplayName,
  curveHelpText,
  normalizeCustomCurve,
} from "../shape_helpers.js";
import {
  CUSTOM_CURVE_VIEWBOX_SIZE,
  curvePathData,
  curveSvgX,
  curveSvgY,
  localCustomCurvePoint,
  segmentIndexForCurveX,
  CUSTOM_CURVE_MIN_POINT_SPACING,
  curveYAtSegmentPoint,
  segmentCurveFromPointer,
} from "../curve_geometry.js";
import { normalizeFaderCurve } from "../../../core/binding_model.js";

/** curve editor workflow. */
export function createCurveEditor({
  closeCurvePresetForm,
  curveState,
  elements,
  getConfigBinding,
  renderConfigModal,
  renderConfigPreview,
  syncCurvePresetToolbar,
}) {
  function buildCurveCardSvg(binding, curve) {
    const pathMap = {
      Linear: "M10 110 L110 10",
      Exponential: "M10 110 C35 110, 75 86, 110 10",
      Logarithmic: "M10 110 C18 42, 64 16, 110 10",
      SCurve: "M10 110 C42 110, 42 12, 110 10",
      Custom: "M10 88 L34 76 L60 28 L86 88 L110 72",
    };
    if (curve === "Custom") {
      const points = curveEditorPoints(binding);
      return `
        <svg class="binding-config-curve-editor-svg" viewBox="0 0 ${CUSTOM_CURVE_VIEWBOX_SIZE} ${CUSTOM_CURVE_VIEWBOX_SIZE}" aria-hidden="true" focusable="false">
          <path class="binding-config-curve-editor-path" d="${curvePathData(points)}" />
        </svg>
      `;
    }
    return `<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false"><path d="${pathMap[curve] || pathMap.Linear}" /></svg>`;
  }

  function setDraftCurve(curve) {
    const binding = getConfigBinding();
    if (!binding) return;
    if (binding.fader_curve === normalizeFaderCurve(curve)) {
      return;
    }
    curveState.selectedCustomCurvePresetId = null;
    closeCurvePresetForm();
    binding.fader_curve = normalizeFaderCurve(curve);
    binding.custom_curve = customCurvePoints(binding);
    renderConfigModal();
  }

  function renderCurveCards() {
    if (!elements.bindingConfigCurveCards) return;
    const binding = getConfigBinding();
    if (!binding) return;
    elements.bindingConfigCurveCards.innerHTML = "";
    ["Linear", "Exponential", "Logarithmic", "SCurve", "Custom"].forEach((curve) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "binding-config-curve-card";
      button.dataset.curve = curve;
      if (curve === "Custom") button.classList.add("binding-config-curve-card--custom");
      if (binding.fader_curve === curve) button.classList.add("is-selected");
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(binding.fader_curve === curve));
      button.innerHTML = `
        <span class="binding-config-curve-card-title">${curveDisplayName(curve)}</span>
        <span class="binding-config-curve-card-visual">${buildCurveCardSvg(binding, curve)}</span>
      `;
      button.addEventListener("click", () => setDraftCurve(curve));
      if (curve === "Custom") {
        const svg = button.querySelector("svg");
        const visual = button.querySelector(".binding-config-curve-card-visual");
        const points = curveEditorPoints(binding);
        if (svg && visual) {
          points.forEach((point, index) => {
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            const x = curveSvgX(point.x);
            const y = curveSvgY(point.y);
            circle.setAttribute("cx", String(x));
            circle.setAttribute("cy", String(y));
            circle.setAttribute("r", "5.5");
            circle.dataset.pointIndex = String(index);
            circle.classList.add("binding-config-curve-card-point");
            circle.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
            });
            svg.appendChild(circle);
          });
          visual.dataset.curveEditorSurface = "custom";
        }
      }
      elements.bindingConfigCurveCards.appendChild(button);
    });
    if (elements.bindingConfigCurveHelp) {
      elements.bindingConfigCurveHelp.textContent = curveHelpText(binding.fader_curve);
    }
  }

  function renderCustomCurveEditor() {
    // Editing now happens directly inside the Custom curve card.
  }

  function customCurveSurfaceFromEvent(event) {
    if (!(event.target instanceof Element)) return null;
    const surface = event.target.closest('[data-curve-editor-surface="custom"]');
    const card = surface?.closest?.(".binding-config-curve-card");
    return card?.dataset?.curve === "Custom" ? surface : null;
  }

  function refreshCustomCurvePointerSurface() {
    if (!curveState.customCurvePointer) return;
    const nextSurface = elements.bindingConfigCurveCards?.querySelector(
      '.binding-config-curve-card[data-curve="Custom"] .binding-config-curve-card-visual',
    );
    if (nextSurface) {
      curveState.customCurvePointer.surfaceEl = nextSurface;
    }
  }

  function commitCustomCurvePoints(points, { keepPointer = false } = {}) {
    const binding = getConfigBinding();
    if (!binding) return;
    if (binding.fader_curve !== "Custom") {
      binding.fader_curve = "Custom";
    }
    binding.custom_curve = normalizeCustomCurve(points);
    curveState.selectedCustomCurvePresetId = null;
    renderCurveCards();
    syncCurvePresetToolbar(binding);
    if (keepPointer) {
      refreshCustomCurvePointerSurface();
    }
    renderConfigPreview();
  }

  function addCustomCurvePoint(event) {
    const binding = getConfigBinding();
    const surfaceEl = customCurveSurfaceFromEvent(event);
    if (!binding || !surfaceEl) return;
    if (event.target instanceof Element && event.target.closest("circle.binding-config-curve-card-point"))
      return;
    const localPoint = localCustomCurvePoint(event, surfaceEl);
    if (!localPoint) return;
    const points = curveEditorPoints(binding);
    const segmentIndex = segmentIndexForCurveX(points, localPoint.x);
    if (segmentIndex < 0) return;
    const start = points[segmentIndex];
    const end = points[segmentIndex + 1];
    if (end.x - start.x < CUSTOM_CURVE_MIN_POINT_SPACING * 2) return;

    event.preventDefault();
    event.stopPropagation();
    const span = end.x - start.x;
    const t = Math.min(1, Math.max(0, (localPoint.x - start.x) / span));
    const x = Math.min(
      end.x - CUSTOM_CURVE_MIN_POINT_SPACING,
      Math.max(start.x + CUSTOM_CURVE_MIN_POINT_SPACING, localPoint.x),
    );
    const y = localPoint.y == null ? curveYAtSegmentPoint(start, end, t) : localPoint.y;
    const nextPoints = points.map((point) => ({ ...point }));
    nextPoints[segmentIndex] = { ...nextPoints[segmentIndex], curve: 0 };
    nextPoints.splice(segmentIndex + 1, 0, { x, y });
    commitCustomCurvePoints(nextPoints);
  }

  function removeCustomCurvePoint(index, event = null) {
    const binding = getConfigBinding();
    if (!binding) return;
    const points = curveEditorPoints(binding);
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!Number.isInteger(index) || index <= 0 || index >= points.length - 1) return;
    const nextPoints = points.map((point) => ({ ...point }));
    nextPoints.splice(index, 1);
    if (nextPoints[index - 1]) {
      nextPoints[index - 1] = { ...nextPoints[index - 1], curve: 0 };
    }
    commitCustomCurvePoints(nextPoints);
  }

  function updateCustomCurveFromPointer(event) {
    const binding = getConfigBinding();
    if (!binding || !curveState.customCurvePointer?.surfaceEl) return;
    const localPoint = localCustomCurvePoint(event, curveState.customCurvePointer.surfaceEl);
    if (!localPoint) return;
    const points = curveEditorPoints(binding);
    const index = curveState.customCurvePointer.index;

    if (curveState.customCurvePointer.mode === "segment") {
      if (index < 0 || index >= points.length - 1) return;
      const start = points[index];
      const end = points[index + 1];
      points[index] = {
        ...start,
        curve: segmentCurveFromPointer(start, end, localPoint),
      };
      commitCustomCurvePoints(points, { keepPointer: true });
      return;
    }

    const isEdge = index === 0 || index === points.length - 1;
    const prevX = index > 0 ? points[index - 1].x + CUSTOM_CURVE_MIN_POINT_SPACING : 0;
    const nextX = index < points.length - 1 ? points[index + 1].x - CUSTOM_CURVE_MIN_POINT_SPACING : 1;
    points[index] = {
      ...points[index],
      x: isEdge ? (index === 0 ? 0 : 1) : Math.min(nextX, Math.max(prevX, localPoint.x)),
      y: localPoint.y,
    };
    if (isEdge) {
      points[index].curve = 0;
    }
    commitCustomCurvePoints(points, { keepPointer: true });
  }

  return {
    renderCurveCards,
    renderCustomCurveEditor,
    customCurveSurfaceFromEvent,
    addCustomCurvePoint,
    removeCustomCurvePoint,
    updateCustomCurveFromPointer,
  };
}

import assert from "node:assert/strict";
import {
  curvePathData,
  curveSvgX,
  curveSvgY,
  curveYAtSegmentPoint,
  localCustomCurvePoint,
  segmentCurveFromPointer,
  segmentIndexForCurveX,
} from "../src/features/bindings/curve_geometry.js";

assert.equal(curveSvgX(0), 10);
assert.equal(curveSvgX(1), 110);
assert.equal(curveSvgY(0), 110);
assert.equal(curveSvgY(1), 10);
assert.equal(curvePathData([{ x: 0, y: 0 }, { x: 1, y: 1 }]), "M10 110 L110 10");
assert.match(curvePathData([{ x: 0, y: 0, curve: 0.25 }, { x: 1, y: 1 }]), / Q/);
assert.equal(segmentIndexForCurveX([{ x: 0 }, { x: 0.5 }, { x: 1 }], 0.4), 0);
assert.equal(segmentIndexForCurveX([{ x: 0 }, { x: 0.5 }, { x: 1 }], 0.8), 1);
assert.equal(curveYAtSegmentPoint({ y: 0, curve: 0 }, { y: 1 }, 0.5), 0.5);
assert.equal(segmentCurveFromPointer({ x: 0, y: 0, curve: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 0.5 }), 0);

const surface = {
  querySelector: () => null,
  getBoundingClientRect: () => ({ left: 20, top: 40, width: 240, height: 120 }),
};
assert.deepEqual(localCustomCurvePoint({ clientX: 140, clientY: 100 }, surface), { x: 0.5, y: 0.5 });

console.log("Curve geometry tests passed");

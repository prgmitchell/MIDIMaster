import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bindingModelUrl = new URL("../src/core/binding_model.js", import.meta.url).href;

const helperRawSource = await readFile(new URL("../src/features/bindings/fader_curve_presets.js", import.meta.url), "utf8");
const helperSource = helperRawSource.replace(
  /import\s+\{[\s\S]*?\}\s+from\s+"..\/..\/core\/binding_model\.js";/,
  `import {
  normalizeCustomCurvePoints,
  normalizeFaderCurve,
  presetCurvePoints,
} from "${bindingModelUrl}";`,
);
const helperUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`;
const presets = await import(helperUrl);

function testNormalizePresetsClampsSortsAndDeduplicates() {
  const normalized = presets.normalizeFaderCurvePresets([
    {
      id: "Ride Curve",
      name: "  Ride   Curve  ",
      points: [
        { x: 2, y: -1 },
        { x: 0.4, y: 0.9 },
        { x: -4, y: 3 },
      ],
    },
    {
      id: "Ride Curve",
      name: "Ride Curve",
      points: [
        { x: 1, y: 1 },
        { x: 0, y: 0 },
      ],
    },
    { id: "empty", name: "   ", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    { id: "short", name: "Too Short", points: [{ x: 0, y: 0 }] },
  ]);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].id, "ride-curve");
  assert.equal(normalized[0].name, "Ride Curve");
  assert.deepEqual(normalized[0].points, [
    { x: 0, y: 1 },
    { x: 0.4, y: 0.9 },
    { x: 1, y: 0 },
  ]);
  assert.equal(normalized[1].id, "ride-curve-2");
  assert.equal(normalized[1].name, "Ride Curve 2");
}

function testPresetCap() {
  const normalized = presets.normalizeFaderCurvePresets(
    Array.from({ length: 55 }, (_value, index) => ({
      id: `curve-${index}`,
      name: `Curve ${index}`,
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    })),
  );

  assert.equal(normalized.length, presets.MAX_FADER_CURVE_PRESETS);
}

function testMatchingCustomBindingToPreset() {
  const saved = presets.normalizeFaderCurvePresets([
    {
      id: "vocal-fade",
      name: "Vocal Fade",
      points: [{ x: 0, y: 0, curve: 0.25 }, { x: 0.25, y: 0.45 }, { x: 1, y: 1 }],
    },
  ]);
  const binding = {
    fader_curve: "Custom",
    custom_curve: [{ x: 0, y: 0, curve: 0.25001 }, { x: 0.25001, y: 0.45001 }, { x: 1, y: 1 }],
  };

  assert.equal(presets.findMatchingFaderCurvePreset(binding, saved)?.id, "vocal-fade");
}

function testBuiltInBindingPointsUsePresetCurve() {
  const linear = presets.curvePointsForBinding({ fader_curve: "Linear", custom_curve: [] });
  const sCurve = presets.curvePointsForBinding({ fader_curve: "SCurve", custom_curve: [] });

  assert.deepEqual(linear, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  assert.equal(sCurve.length, 5);
  assert.equal(sCurve[2].x, 0.5);
}

testNormalizePresetsClampsSortsAndDeduplicates();
testPresetCap();
testMatchingCustomBindingToPreset();
testBuiltInBindingPointsUsePresetCurve();

console.log("Fader curve preset tests passed");

import assert from "node:assert/strict";
import {
  hexToRgb,
  hsvToRgb,
  normalizeHexColor,
  rgbToHex,
  rgbToHsv,
} from "../src/app/color.js";

assert.equal(normalizeHexColor("#AbC"), "#aabbcc");
assert.equal(normalizeHexColor("abc", "", { allowMissingHash: true }), "#aabbcc");
assert.equal(normalizeHexColor("abc", "fallback"), "fallback");
assert.deepEqual(hexToRgb("#336699"), { r: 51, g: 102, b: 153 });
assert.equal(rgbToHex({ r: 51, g: 102, b: 153 }), "#336699");

const hsv = rgbToHsv(hexToRgb("#ec4899"));
assert.equal(rgbToHex(hsvToRgb(hsv)), "#ec4899");

console.log("Color utility tests passed");

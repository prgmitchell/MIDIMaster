import assert from "node:assert/strict";
import {
  colorPickerAppearancePatch,
  createAppearanceColorPickerState,
  findAppearanceColorControl,
  parseHexColorInput,
  setColorPickerStateFromHex,
} from "../src/features/settings/appearance_controls.js";

assert.equal(findAppearanceColorControl("token", "themeTint").intensityToken, "themeTintIntensity");
assert.equal(parseHexColorInput("5AA7FF"), "#5aa7ff");

const state = createAppearanceColorPickerState();
setColorPickerStateFromHex(state, "#ff0000");
assert.equal(state.color, "#ff0000");
assert.equal(state.hue, 0);
assert.deepEqual(colorPickerAppearancePatch(state), { accentColor: "#ff0000" });
state.target = "token";
state.token = "themeTint";
assert.deepEqual(colorPickerAppearancePatch(state), { tokens: { themeTint: "#ff0000" } });

console.log("Appearance control tests passed");

import { resolveAppearance } from "../../app/appearance.js";
import { hexToRgb, normalizeHexColor, rgbToHsv } from "../../app/color.js";

export const APPEARANCE_COLOR_CONTROLS = Object.freeze([
  {
    target: "accent",
    token: "",
    intensityToken: "accentIntensity",
    labelKey: "settings.appearance.accentColor",
    swatches: ["#5aa7ff", "#2f78d4", "#8b6dff", "#24c8d6", "#69c95a", "#ec4899"],
  },
  {
    target: "token",
    token: "themeTint",
    intensityToken: "themeTintIntensity",
    labelKey: "settings.appearance.themeTint",
    swatches: ["#172334", "#1d4ed8", "#7c3aed", "#0e7490", "#15803d", "#be185d"],
  },
  {
    target: "token",
    token: "controlBorder",
    intensityToken: "controlBorderIntensity",
    labelKey: "settings.appearance.colorBorders",
    swatches: ["#5aa7ff", "#8b6dff", "#24c8d6", "#69c95a", "#f0a12d", "#ec4899"],
  },
  {
    target: "token",
    token: "textPrimary",
    intensityToken: "textPrimaryIntensity",
    labelKey: "settings.appearance.colorText",
    swatches: ["#f3f6fb", "#7fbfff", "#c4b5fd", "#67e8f9", "#bbf7d0", "#f9a8d4"],
  },
  {
    target: "token",
    token: "iconColor",
    intensityToken: "iconColorIntensity",
    labelKey: "settings.appearance.iconColor",
    swatches: ["#5aa7ff", "#2f78d4", "#8b6dff", "#24c8d6", "#69c95a", "#f0a12d"],
  },
]);

const ACCENT_SWATCHES = [
  "#5aa7ff", "#2f78d4", "#8b6dff", "#7c3aed", "#24c8d6", "#14b8a6", "#69c95a",
  "#22c55e", "#f0a12d", "#f97316", "#f25c61", "#dc2626", "#d44aa4", "#ec4899",
];

export const COLOR_PICKER_SWATCHES = Object.freeze([
  ...ACCENT_SWATCHES,
  "#ffffff",
  "#d8dee9",
  "#7b8794",
  "#111820",
]);

export function createAppearanceColorPickerState() {
  return {
    open: false,
    target: "accent",
    token: "",
    name: "",
    color: "#5aa7ff",
    hue: 210,
    saturation: 0.65,
    value: 1,
    anchor: null,
    dragging: false,
  };
}

export function colorInputValue(value, fallback = "#000000") {
  const raw = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : fallback;
}

export function findAppearanceColorControl(target = "accent", token = "") {
  const normalizedTarget = target === "token" ? "token" : "accent";
  const normalizedToken = normalizedTarget === "token" ? String(token || "") : "";
  return APPEARANCE_COLOR_CONTROLS.find((control) => (
    control.target === normalizedTarget && String(control.token || "") === normalizedToken
  )) || APPEARANCE_COLOR_CONTROLS[0];
}

export function appearanceColorControlValue(control, appearance, resolvedOrOptions = null) {
  if (control?.target === "token") {
    const resolved = resolvedOrOptions?.resolved ?? resolvedOrOptions;
    const matchMediaSource = resolvedOrOptions?.matchMediaSource ?? globalThis.window;
    const resolvedAppearance = resolved || resolveAppearance(appearance, { matchMediaSource });
    return colorInputValue(appearance?.tokens?.[control.token], colorInputValue(resolvedAppearance.tokens[control.token]));
  }
  return colorInputValue(appearance?.accentColor, "#5aa7ff");
}

export function findAppearanceIntensityControl(intensityToken = "") {
  const normalizedToken = String(intensityToken || "");
  return APPEARANCE_COLOR_CONTROLS.find((control) => control.intensityToken === normalizedToken) || null;
}

export function parseHexColorInput(value) {
  return normalizeHexColor(value, "", { allowMissingHash: true });
}

export function setColorPickerStateFromHex(state, color) {
  const value = colorInputValue(color, state.color);
  const hsv = rgbToHsv(hexToRgb(value));
  Object.assign(state, { color: value, hue: hsv.h, saturation: hsv.s, value: hsv.v });
}

export function colorPickerAppearancePatch(state) {
  return state.target === "token" && state.token
    ? { tokens: { [state.token]: state.color } }
    : { accentColor: state.color };
}

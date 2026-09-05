import { HEX_COLOR_RE, hexToRgb, normalizeHexColor, rgbToHex } from "./color.js";
import {
  BASE_PALETTES,
  TOKEN_TO_VAR,
  CSS_TOKEN_KEYS,
  USER_TOKEN_KEYS,
  INTENSITY_TOKEN_KEYS,
} from "./appearance_catalog.js";

/** Pure palette and token conversions shared by appearance models. */
export function toCamelTokenKey(key) {
  const raw = String(key || "").trim();
  if (!raw) return "";
  if (!raw.startsWith("--")) return raw;
  return raw.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeId(value, fallback = "system") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function normalizeName(value, fallback = "Custom Theme") {
  const name = String(value || fallback)
    .replace(/\s+/g, " ")
    .trim();
  return (name || fallback).slice(0, 64);
}

export function mixHex(left, right, amount) {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  const pct = Math.min(1, Math.max(0, Number(amount) || 0));
  return rgbToHex({
    r: a.r + (b.r - a.r) * pct,
    g: a.g + (b.g - a.g) * pct,
    b: a.b + (b.b - a.b) * pct,
  });
}

export function tokenIntensity(tokens, key, fallback = 100) {
  const source = tokens && typeof tokens === "object" ? tokens : {};
  return clampNumber(source[key], 0, 100, fallback);
}

export function applyColorIntensity(color, scheme, intensity, neutral = "") {
  const safeColor = normalizeHexColor(color, scheme === "light" ? "#2f78d4" : "#5aa7ff");
  const safeNeutral = normalizeHexColor(neutral, scheme === "light" ? "#6e7d8e" : "#929daa");
  return mixHex(safeNeutral, safeColor, clampNumber(intensity, 0, 100, 100) / 100);
}

export function rgbaFromHex(hex, alpha) {
  const color = hexToRgb(hex);
  const safeAlpha = Math.min(1, Math.max(0, Number(alpha) || 0));
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${safeAlpha.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")})`;
}

export function hexToHsl(hex) {
  const { r, g, b } = hexToRgb(hex);
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === red) {
      h = 60 * (((green - blue) / delta) % 6);
    } else if (max === green) {
      h = 60 * ((blue - red) / delta + 2);
    } else {
      h = 60 * ((red - green) / delta + 4);
    }
  }
  if (h < 0) h += 360;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

export function logoFilterForColor(hex, scheme = "dark") {
  const color = normalizeHexColor(hex, "#5aa7ff");
  const { h, s, l } = hexToHsl(color);
  if (scheme === "light") {
    const hueRotate = Math.round(h - 200);
    const saturation = Math.round((0.76 + s * 0.64) * 100);
    const brightness = Math.round((0.94 + l * 0.12) * 100);
    return `hue-rotate(${hueRotate}deg) saturate(${saturation}%) brightness(${brightness}%) contrast(98%)`;
  }
  const hueRotate = Math.round(h - 200);
  const saturation = Math.round((0.9 + s * 1.35) * 100);
  const brightness = Math.round((0.74 + l * 0.62) * 100);
  return `hue-rotate(${hueRotate}deg) saturate(${saturation}%) brightness(${brightness}%)`;
}

export function logoGlowForColor(hex, scheme = "dark", intensity = 50) {
  const baseAlpha = scheme === "light" ? 0.12 : 0.36;
  const multiplier = clampNumber(intensity, 0, 100, 50) / 50;
  return rgbaFromHex(hex, Math.min(0.8, baseAlpha * multiplier));
}

export function shadowForScheme(scheme) {
  return scheme === "light" ? "0 16px 32px rgba(31, 45, 61, 0.14)" : "0 18px 34px rgba(0, 0, 0, 0.46)";
}

export function applyTemperature(palette, temperature) {
  const shift = (clampNumber(temperature, 0, 100, 50) - 50) / 50;
  if (Math.abs(shift) < 0.01) return { ...palette };
  const target = shift > 0 ? "#5c3018" : "#063d5d";
  const amount = Math.abs(shift) * 0.24;
  const surfaceKeys = [
    "appBg",
    "sidebarBg",
    "topbarBg",
    "surface",
    "surfaceRaised",
    "surfaceMuted",
    "surfaceSubtle",
    "controlBg",
    "controlBgHover",
    "controlBorder",
    "controlBorderStrong",
    "chipBg",
    "sliderTrack",
  ];
  const next = { ...palette };
  surfaceKeys.forEach((key) => {
    if (HEX_COLOR_RE.test(next[key])) {
      next[key] = mixHex(next[key], target, amount);
    }
  });
  return next;
}

export function applyThemeTint(palette, tintColor, scheme, intensity = 100) {
  const tint = normalizeHexColor(tintColor, "");
  if (!tint) return { ...palette };
  const multiplier = (scheme === "light" ? 0.48 : 1) * (clampNumber(intensity, 0, 100, 100) / 100);
  const tintWeights = {
    appBg: 0.18,
    sidebarBg: 0.2,
    topbarBg: 0.2,
    surface: 0.18,
    surfaceRaised: 0.12,
    surfaceMuted: 0.24,
    surfaceSubtle: 0.14,
    controlBg: 0.13,
    controlBgHover: 0.18,
    chipBg: 0.18,
    sliderTrack: 0.14,
  };
  const next = { ...palette, themeTint: tint };
  Object.entries(tintWeights).forEach(([key, amount]) => {
    if (HEX_COLOR_RE.test(next[key])) {
      next[key] = mixHex(next[key], tint, amount * multiplier);
    }
  });
  return next;
}

export function applySurfaceContrast(palette, scheme, contrast = 50) {
  const shift = (clampNumber(contrast, 0, 100, 50) - 50) / 50;
  if (Math.abs(shift) < 0.01) return { ...palette };
  const next = { ...palette };
  if (shift < 0) {
    const amount = Math.abs(shift);
    const surfaceKeys = [
      "surface",
      "surfaceRaised",
      "surfaceMuted",
      "surfaceSubtle",
      "controlBg",
      "controlBgHover",
      "chipBg",
      "sliderTrack",
    ];
    surfaceKeys.forEach((key) => {
      if (HEX_COLOR_RE.test(next[key])) {
        next[key] = mixHex(next[key], next.appBg, amount * 0.5);
      }
    });
    ["controlBorder", "controlBorderStrong", "chipBorder"].forEach((key) => {
      if (HEX_COLOR_RE.test(next[key])) {
        next[key] = mixHex(next[key], next.appBg, amount * 0.62);
      }
    });
    return next;
  }

  const amount = shift;
  const pageTarget = scheme === "light" ? "#dfe8f2" : "#04070a";
  const borderTarget = scheme === "light" ? "#172230" : "#ffffff";
  if (HEX_COLOR_RE.test(next.appBg)) {
    next.appBg = mixHex(next.appBg, pageTarget, amount * 0.1);
  }
  [
    "sidebarBg",
    "topbarBg",
    "surface",
    "surfaceRaised",
    "surfaceMuted",
    "surfaceSubtle",
    "controlBg",
    "controlBgHover",
    "chipBg",
  ].forEach((key) => {
    if (HEX_COLOR_RE.test(next[key])) {
      next[key] = mixHex(next[key], "#ffffff", amount * (scheme === "light" ? 0.1 : 0.08));
    }
  });
  ["controlBorder", "controlBorderStrong", "chipBorder", "sliderTrack"].forEach((key) => {
    if (HEX_COLOR_RE.test(next[key])) {
      next[key] = mixHex(next[key], borderTarget, amount * (scheme === "light" ? 0.22 : 0.26));
    }
  });
  return next;
}

export function applyReadableColorOverrides(palette, tokens, scheme) {
  const overrides = normalizeCustomTokens(tokens);
  const next = { ...palette };
  if (overrides.controlBorder) {
    next.controlBorder = mixHex(
      next.controlBorder,
      overrides.controlBorder,
      tokenIntensity(overrides, "controlBorderIntensity") / 100,
    );
    next.controlBorderStrong = mixHex(
      next.controlBorder,
      scheme === "light" ? "#172230" : "#ffffff",
      scheme === "light" ? 0.16 : 0.2,
    );
    next.chipBorder = mixHex(next.controlBorder, next.chipBorder, 0.35);
  }
  if (overrides.textPrimary) {
    next.textPrimary = mixHex(
      next.textPrimary,
      overrides.textPrimary,
      tokenIntensity(overrides, "textPrimaryIntensity") / 100,
    );
    next.textSecondary = mixHex(next.textPrimary, next.appBg, scheme === "light" ? 0.28 : 0.24);
    next.textMuted = mixHex(next.textPrimary, next.appBg, scheme === "light" ? 0.5 : 0.46);
    next.chipText = mixHex(next.textPrimary, next.chipBg, 0.16);
  }
  return next;
}

export function paletteForBase(
  base,
  scheme,
  accentColor,
  temperature,
  tintColor,
  tokens = {},
  surfaceContrast = 50,
) {
  const palette = applyTemperature(BASE_PALETTES[base] || BASE_PALETTES.dark, temperature);
  const accentBase = normalizeHexColor(accentColor, scheme === "light" ? "#2f78d4" : "#5aa7ff");
  const accent = applyColorIntensity(
    accentBase,
    scheme,
    tokenIntensity(tokens, "accentIntensity"),
    scheme === "light" ? "#6e7d8e" : "#929daa",
  );
  const tint = normalizeHexColor(tintColor, palette.surfaceMuted || palette.surface || palette.appBg);
  const tintedPalette = applyThemeTint(palette, tint, scheme, tokenIntensity(tokens, "themeTintIntensity"));
  const contrastedPalette = applySurfaceContrast(tintedPalette, scheme, surfaceContrast);
  return {
    ...contrastedPalette,
    accent,
    accentSoft: rgbaFromHex(accent, scheme === "light" ? 0.14 : 0.18),
    accentStrong: mixHex(accent, scheme === "light" ? "#102f63" : "#ffffff", 0.16),
    dangerSoft: rgbaFromHex(contrastedPalette.danger, scheme === "light" ? 0.13 : 0.16),
    successSoft: rgbaFromHex(contrastedPalette.success, scheme === "light" ? 0.13 : 0.16),
    sliderFill: accent,
    shadowRaised: shadowForScheme(scheme),
  };
}

export function normalizeCustomTokens(tokens = {}) {
  const source = tokens && typeof tokens === "object" ? tokens : {};
  const next = {};
  Object.entries(source).forEach(([key, value]) => {
    const cssKey = String(key || "").startsWith("--")
      ? String(key || "").trim()
      : TOKEN_TO_VAR[toCamelTokenKey(key)];
    const camel = toCamelTokenKey(cssKey);
    if (!CSS_TOKEN_KEYS.has(cssKey) || !TOKEN_TO_VAR[camel] || !USER_TOKEN_KEYS.has(camel)) return;
    const raw = String(value ?? "").trim();
    if (!raw || raw.length > 128 || /[;{}<>\r\n]/.test(raw) || /url\s*\(/i.test(raw)) return;
    if (INTENSITY_TOKEN_KEYS.has(camel)) {
      next[camel] = String(Math.round(clampNumber(raw, 0, 100, 100)));
      return;
    }
    const color = normalizeHexColor(raw, "");
    if (!color) return;
    next[camel] = color;
  });
  return next;
}

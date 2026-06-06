export const APPEARANCE_THEME_FILE_KIND = "midimaster.appearance.theme.v1";

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const BUILT_IN_IDS = new Set(["system", "dark", "light", "midnight", "ocean", "forest", "sunset"]);
const DEFAULT_FONT_FAMILY = "bahnschrift";
const DEFAULT_TEXT_RENDERING = "auto";

const FONT_STACKS = {
  bahnschrift: {
    label: "Bahnschrift",
    labelKey: "settings.appearance.fontBahnschrift",
    stack: '"Bahnschrift", "Aptos", "Segoe UI", sans-serif',
  },
  aptos: {
    label: "Aptos",
    labelKey: "settings.appearance.fontAptos",
    stack: '"Aptos", "Segoe UI", sans-serif',
  },
  segoe: {
    label: "Segoe UI",
    labelKey: "settings.appearance.fontSegoe",
    stack: '"Segoe UI", "Aptos", sans-serif',
  },
  inter: {
    label: "Inter",
    labelKey: "settings.appearance.fontInter",
    stack: '"Inter", "Segoe UI", "Aptos", sans-serif',
  },
  mono: {
    label: "Monospace",
    labelKey: "settings.appearance.fontMono",
    stack: '"Cascadia Mono", "Consolas", monospace',
  },
};

const TEXT_RENDERING_MODES = {
  auto: {
    label: "Auto",
    labelKey: "settings.appearance.renderingAuto",
    value: "auto",
  },
  legibility: {
    label: "Optimize Legibility",
    labelKey: "settings.appearance.renderingLegibility",
    value: "optimizeLegibility",
  },
  geometric: {
    label: "Geometric Precision",
    labelKey: "settings.appearance.renderingGeometric",
    value: "geometricPrecision",
  },
  speed: {
    label: "Optimize Speed",
    labelKey: "settings.appearance.renderingSpeed",
    value: "optimizeSpeed",
  },
};

const BUILT_IN_PRESETS = {
  system: {
    id: "system",
    labelKey: "settings.appearance.presetSystem",
    scheme: "system",
    accentColor: "#5aa7ff",
    iconColor: "#5aa7ff",
    tintColor: "#172334",
    base: "dark",
    preview: ["#5aa7ff", "#5bd28a"],
  },
  dark: {
    id: "dark",
    labelKey: "settings.appearance.presetDark",
    scheme: "dark",
    accentColor: "#5aa7ff",
    iconColor: "#5aa7ff",
    tintColor: "#172334",
    base: "dark",
    preview: ["#5aa7ff", "#7fbfff"],
  },
  light: {
    id: "light",
    labelKey: "settings.appearance.presetLight",
    scheme: "light",
    accentColor: "#2f78d4",
    iconColor: "#2f78d4",
    tintColor: "#e8f1fa",
    base: "light",
    preview: ["#2f78d4", "#55b7ec"],
  },
  midnight: {
    id: "midnight",
    labelKey: "settings.appearance.presetMidnight",
    scheme: "dark",
    accentColor: "#8b6dff",
    iconColor: "#8b6dff",
    tintColor: "#242044",
    base: "midnight",
    preview: ["#8b6dff", "#6f5cff"],
  },
  ocean: {
    id: "ocean",
    labelKey: "settings.appearance.presetOcean",
    scheme: "dark",
    accentColor: "#24c8d6",
    iconColor: "#24c8d6",
    tintColor: "#123642",
    base: "ocean",
    preview: ["#24c8d6", "#47a7ff"],
  },
  forest: {
    id: "forest",
    labelKey: "settings.appearance.presetForest",
    scheme: "dark",
    accentColor: "#69c95a",
    iconColor: "#69c95a",
    tintColor: "#1e3324",
    base: "forest",
    preview: ["#69c95a", "#9bd35a"],
  },
  sunset: {
    id: "sunset",
    labelKey: "settings.appearance.presetSunset",
    scheme: "dark",
    accentColor: "#f0a12d",
    iconColor: "#f0a12d",
    tintColor: "#3a241f",
    base: "sunset",
    preview: ["#f0a12d", "#f25c61"],
  },
};

const BASE_PALETTES = {
  dark: {
    appBg: "#0b1017",
    sidebarBg: "#0e151d",
    topbarBg: "#101722",
    surface: "#151c24",
    surfaceRaised: "#111820",
    surfaceMuted: "#18212b",
    surfaceSubtle: "#101720",
    controlBg: "#111820",
    controlBgHover: "#151d27",
    controlBorder: "#303945",
    controlBorderStrong: "#3a4654",
    textPrimary: "#f3f6fb",
    textSecondary: "#c8d1dd",
    textMuted: "#929daa",
    danger: "#ff6268",
    success: "#5bd28a",
    chipBg: "#182334",
    chipBorder: "#33445b",
    chipText: "#e8f1ff",
    sliderTrack: "#2b3948",
    sliderThumb: "#f3f6fb",
    overlayBg: "rgba(7, 10, 14, 0.72)",
  },
  light: {
    appBg: "#eef3f8",
    sidebarBg: "#e5edf5",
    topbarBg: "#f6f9fc",
    surface: "#f8fbfe",
    surfaceRaised: "#ffffff",
    surfaceMuted: "#edf4fa",
    surfaceSubtle: "#f2f7fb",
    controlBg: "#fbfdff",
    controlBgHover: "#eef5fb",
    controlBorder: "#c4d0dd",
    controlBorderStrong: "#aab8c8",
    textPrimary: "#172230",
    textSecondary: "#344457",
    textMuted: "#6e7d8e",
    danger: "#c7353c",
    success: "#2f9b61",
    chipBg: "#eaf3fc",
    chipBorder: "#c7d8eb",
    chipText: "#17385c",
    sliderTrack: "#d1dbe7",
    sliderThumb: "#f8fbfe",
    overlayBg: "rgba(23, 34, 48, 0.36)",
  },
  midnight: {
    appBg: "#0b0c17",
    sidebarBg: "#10101f",
    topbarBg: "#121323",
    surface: "#181827",
    surfaceRaised: "#11111e",
    surfaceMuted: "#1c1d30",
    surfaceSubtle: "#10101c",
    controlBg: "#131422",
    controlBgHover: "#1b1c2f",
    controlBorder: "#363650",
    controlBorderStrong: "#464665",
    textPrimary: "#f7f4ff",
    textSecondary: "#d5cef0",
    textMuted: "#9c94b6",
    danger: "#ff657e",
    success: "#65d49c",
    chipBg: "#211e35",
    chipBorder: "#454066",
    chipText: "#f0ebff",
    sliderTrack: "#34344d",
    sliderThumb: "#fbf9ff",
    overlayBg: "rgba(8, 8, 18, 0.74)",
  },
  ocean: {
    appBg: "#061318",
    sidebarBg: "#071920",
    topbarBg: "#09202a",
    surface: "#10262e",
    surfaceRaised: "#0b1d24",
    surfaceMuted: "#12313b",
    surfaceSubtle: "#081820",
    controlBg: "#0c2028",
    controlBgHover: "#12303a",
    controlBorder: "#254b57",
    controlBorderStrong: "#32616f",
    textPrimary: "#effcff",
    textSecondary: "#c5e9f0",
    textMuted: "#87aeb7",
    danger: "#ff646b",
    success: "#54d8aa",
    chipBg: "#12313a",
    chipBorder: "#315c68",
    chipText: "#e7fbff",
    sliderTrack: "#244651",
    sliderThumb: "#effcff",
    overlayBg: "rgba(4, 12, 16, 0.74)",
  },
  forest: {
    appBg: "#0a130e",
    sidebarBg: "#0d1912",
    topbarBg: "#112018",
    surface: "#16251b",
    surfaceRaised: "#101b14",
    surfaceMuted: "#1a2d20",
    surfaceSubtle: "#0e1812",
    controlBg: "#111e16",
    controlBgHover: "#1a2d20",
    controlBorder: "#334a38",
    controlBorderStrong: "#415d48",
    textPrimary: "#f3fbf4",
    textSecondary: "#d0e7d2",
    textMuted: "#94aa98",
    danger: "#ff685f",
    success: "#73d365",
    chipBg: "#1a2d20",
    chipBorder: "#3e5d44",
    chipText: "#effbef",
    sliderTrack: "#314735",
    sliderThumb: "#f5fff6",
    overlayBg: "rgba(5, 12, 8, 0.74)",
  },
  sunset: {
    appBg: "#170f10",
    sidebarBg: "#1d1414",
    topbarBg: "#241819",
    surface: "#2a1d1d",
    surfaceRaised: "#201616",
    surfaceMuted: "#342322",
    surfaceSubtle: "#1a1212",
    controlBg: "#221818",
    controlBgHover: "#322322",
    controlBorder: "#58403a",
    controlBorderStrong: "#6d5048",
    textPrimary: "#fff7f1",
    textSecondary: "#eed5c4",
    textMuted: "#b59a8d",
    danger: "#ff5d62",
    success: "#79d190",
    chipBg: "#35221f",
    chipBorder: "#674d43",
    chipText: "#fff3ea",
    sliderTrack: "#563d36",
    sliderThumb: "#fff7f1",
    overlayBg: "rgba(15, 8, 8, 0.74)",
  },
};

const TOKEN_TO_VAR = {
  appBg: "--app-bg",
  sidebarBg: "--sidebar-bg",
  topbarBg: "--topbar-bg",
  surface: "--surface",
  surfaceRaised: "--surface-raised",
  surfaceMuted: "--surface-muted",
  surfaceSubtle: "--surface-subtle",
  controlBg: "--control-bg",
  controlBgHover: "--control-bg-hover",
  controlBorder: "--control-border",
  controlBorderIntensity: "--control-border-intensity",
  controlBorderStrong: "--control-border-strong",
  textPrimary: "--text-primary",
  textPrimaryIntensity: "--text-primary-intensity",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  themeTint: "--theme-tint",
  themeTintIntensity: "--theme-tint-intensity",
  iconColor: "--icon-color",
  iconColorIntensity: "--icon-color-intensity",
  logoFilter: "--app-logo-filter",
  logoGlow: "--app-logo-glow",
  accent: "--accent",
  accentIntensity: "--accent-intensity",
  accentSoft: "--accent-soft",
  danger: "--danger",
  dangerSoft: "--danger-soft",
  success: "--success",
  successSoft: "--success-soft",
  shadowRaised: "--shadow-raised",
  chipBg: "--chip-bg",
  chipBorder: "--chip-border",
  chipText: "--chip-text",
  sliderTrack: "--slider-track",
  sliderFill: "--slider-fill",
  sliderThumb: "--slider-thumb",
  overlayBg: "--overlay-bg",
  accentStrong: "--accent-strong",
};

const CSS_TOKEN_KEYS = new Set(Object.values(TOKEN_TO_VAR));
const USER_TOKEN_KEYS = new Set([
  "accentIntensity",
  "themeTint",
  "themeTintIntensity",
  "controlBorder",
  "controlBorderIntensity",
  "textPrimary",
  "textPrimaryIntensity",
  "iconColor",
  "iconColorIntensity",
]);
const INTENSITY_TOKEN_KEYS = new Set([
  "accentIntensity",
  "themeTintIntensity",
  "controlBorderIntensity",
  "textPrimaryIntensity",
  "iconColorIntensity",
]);

function toCamelTokenKey(key) {
  const raw = String(key || "").trim();
  if (!raw) return "";
  if (!raw.startsWith("--")) return raw;
  return raw.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeId(value, fallback = "system") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeName(value, fallback = "Custom Theme") {
  const name = String(value || fallback).replace(/\s+/g, " ").trim();
  return (name || fallback).slice(0, 64);
}

function normalizeHexColor(value, fallback) {
  const raw = String(value || "").trim();
  if (HEX_COLOR_RE.test(raw)) return raw.toLowerCase();
  const short = raw.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  }
  return fallback;
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex, "#000000").slice(1);
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((part) => (
    Math.round(Math.min(255, Math.max(0, part))).toString(16).padStart(2, "0")
  )).join("")}`;
}

function mixHex(left, right, amount) {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  const pct = Math.min(1, Math.max(0, Number(amount) || 0));
  return rgbToHex({
    r: a.r + ((b.r - a.r) * pct),
    g: a.g + ((b.g - a.g) * pct),
    b: a.b + ((b.b - a.b) * pct),
  });
}

function tokenIntensity(tokens, key, fallback = 100) {
  const source = tokens && typeof tokens === "object" ? tokens : {};
  return clampNumber(source[key], 0, 100, fallback);
}

function applyColorIntensity(color, scheme, intensity, neutral = "") {
  const safeColor = normalizeHexColor(color, scheme === "light" ? "#2f78d4" : "#5aa7ff");
  const safeNeutral = normalizeHexColor(neutral, scheme === "light" ? "#6e7d8e" : "#929daa");
  return mixHex(safeNeutral, safeColor, clampNumber(intensity, 0, 100, 100) / 100);
}

function rgbaFromHex(hex, alpha) {
  const color = hexToRgb(hex);
  const safeAlpha = Math.min(1, Math.max(0, Number(alpha) || 0));
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${safeAlpha.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")})`;
}

function hexToHsl(hex) {
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
      h = 60 * (((blue - red) / delta) + 2);
    } else {
      h = 60 * (((red - green) / delta) + 4);
    }
  }
  if (h < 0) h += 360;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs((2 * l) - 1));
  return { h, s, l };
}

function logoFilterForColor(hex, scheme = "dark") {
  const color = normalizeHexColor(hex, "#5aa7ff");
  const { h, s, l } = hexToHsl(color);
  if (scheme === "light") {
    const hueRotate = Math.round(h - 200);
    const saturation = Math.round((0.76 + (s * 0.64)) * 100);
    const brightness = Math.round((0.94 + (l * 0.12)) * 100);
    return `hue-rotate(${hueRotate}deg) saturate(${saturation}%) brightness(${brightness}%) contrast(98%)`;
  }
  const hueRotate = Math.round(h - 200);
  const saturation = Math.round((0.9 + (s * 1.35)) * 100);
  const brightness = Math.round((0.74 + (l * 0.62)) * 100);
  return `hue-rotate(${hueRotate}deg) saturate(${saturation}%) brightness(${brightness}%)`;
}

function logoGlowForColor(hex, scheme = "dark", intensity = 50) {
  const baseAlpha = scheme === "light" ? 0.12 : 0.36;
  const multiplier = clampNumber(intensity, 0, 100, 50) / 50;
  return rgbaFromHex(hex, Math.min(0.8, baseAlpha * multiplier));
}

function shadowForScheme(scheme) {
  return scheme === "light"
    ? "0 16px 32px rgba(31, 45, 61, 0.14)"
    : "0 18px 34px rgba(0, 0, 0, 0.46)";
}

function applyTemperature(palette, temperature) {
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

function applyThemeTint(palette, tintColor, scheme, intensity = 100) {
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

function applySurfaceContrast(palette, scheme, contrast = 50) {
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
  ["sidebarBg", "topbarBg", "surface", "surfaceRaised", "surfaceMuted", "surfaceSubtle", "controlBg", "controlBgHover", "chipBg"].forEach((key) => {
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

function applyReadableColorOverrides(palette, tokens, scheme) {
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

function paletteForBase(base, scheme, accentColor, temperature, tintColor, tokens = {}, surfaceContrast = 50) {
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

function normalizeCustomTokens(tokens = {}) {
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

export function getBuiltInAppearancePresets() {
  return Object.values(BUILT_IN_PRESETS).map((preset) => ({ ...preset }));
}

export function getAppearanceFontOptions() {
  return Object.entries(FONT_STACKS).map(([id, config]) => ({ id, ...config }));
}

export function getAppearanceTextRenderingOptions() {
  return Object.entries(TEXT_RENDERING_MODES).map(([id, config]) => ({ id, ...config }));
}

export function defaultAppearanceSettings() {
  return {
    activeThemeId: "system",
    accentColor: BUILT_IN_PRESETS.system.accentColor,
    colorTemperature: 50,
    cornerRadius: 4,
    animations: true,
    backgroundEffects: true,
    effectIntensity: 30,
    surfaceContrast: 50,
    iconGlow: 50,
    transparency: 30,
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: 12,
    textRendering: DEFAULT_TEXT_RENDERING,
    tokens: {},
    customThemes: [],
  };
}

export function appearanceBackgroundGlowValue(appearance) {
  const settings = normalizeAppearanceSettings(appearance);
  return settings.backgroundEffects
    ? Math.round(clampNumber(settings.effectIntensity, 0, 100, 30))
    : 0;
}

export function appearanceBackgroundGlowPatch(value) {
  const glow = Math.round(clampNumber(value, 0, 100, 30));
  return {
    backgroundEffects: glow > 0,
    effectIntensity: glow,
  };
}

export function normalizeCustomTheme(theme, index = 0) {
  const source = theme && typeof theme === "object" ? theme : {};
  const fallbackId = `custom-${index + 1}`;
  const id = normalizeId(source.id || source.theme_id || fallbackId, fallbackId);
  const sourceScheme = String(source.scheme || "dark").trim().toLowerCase();
  const scheme = sourceScheme === "light" ? "light" : "dark";
  return {
    id: BUILT_IN_IDS.has(id) ? `custom-${id}` : id,
    name: normalizeName(source.name, "Custom Theme"),
    scheme,
    basePresetId: normalizeId(source.basePresetId || source.base_preset_id || scheme, scheme),
    accentColor: normalizeHexColor(source.accentColor || source.accent_color, scheme === "light" ? "#2f78d4" : "#5aa7ff"),
    colorTemperature: clampNumber(source.colorTemperature ?? source.color_temperature, 0, 100, 50),
    cornerRadius: clampNumber(source.cornerRadius ?? source.corner_radius, 0, 16, 4),
    animations: normalizeBoolean(source.animations, true),
    backgroundEffects: normalizeBoolean(source.backgroundEffects ?? source.background_effects, true),
    effectIntensity: clampNumber(source.effectIntensity ?? source.effect_intensity, 0, 100, 30),
    surfaceContrast: clampNumber(source.surfaceContrast ?? source.surface_contrast, 0, 100, 50),
    iconGlow: clampNumber(source.iconGlow ?? source.icon_glow, 0, 100, 50),
    transparency: clampNumber(source.transparency, 0, 80, 30),
    fontFamily: FONT_STACKS[source.fontFamily || source.font_family] ? (source.fontFamily || source.font_family) : DEFAULT_FONT_FAMILY,
    fontSize: clampNumber(source.fontSize ?? source.font_size, 11, 18, 12),
    textRendering: TEXT_RENDERING_MODES[source.textRendering || source.text_rendering] ? (source.textRendering || source.text_rendering) : DEFAULT_TEXT_RENDERING,
    tokens: normalizeCustomTokens(source.tokens),
  };
}

export function normalizeAppearanceSettings(source = {}) {
  const current = source && typeof source === "object" ? source : {};
  const defaults = defaultAppearanceSettings();
  const customThemes = (Array.isArray(current.customThemes) ? current.customThemes : current.custom_themes)
    || [];
  const normalizedCustomThemes = [];
  customThemes.forEach((theme, index) => {
    const normalized = normalizeCustomTheme(theme, index);
    if (!normalizedCustomThemes.some((existing) => existing.id === normalized.id)) {
      normalizedCustomThemes.push(normalized);
    }
  });

  const activeThemeId = normalizeId(current.activeThemeId || current.active_theme_id, defaults.activeThemeId);
  const activeExists = BUILT_IN_IDS.has(activeThemeId)
    || normalizedCustomThemes.some((theme) => theme.id === activeThemeId);
  const activePreset = BUILT_IN_PRESETS[activeExists ? activeThemeId : defaults.activeThemeId]
    || BUILT_IN_PRESETS.system;

  return {
    ...defaults,
    activeThemeId: activeExists ? activeThemeId : defaults.activeThemeId,
    accentColor: normalizeHexColor(current.accentColor || current.accent_color, activePreset.accentColor || defaults.accentColor),
    colorTemperature: clampNumber(current.colorTemperature ?? current.color_temperature, 0, 100, defaults.colorTemperature),
    cornerRadius: clampNumber(current.cornerRadius ?? current.corner_radius, 0, 16, defaults.cornerRadius),
    animations: normalizeBoolean(current.animations, defaults.animations),
    backgroundEffects: normalizeBoolean(current.backgroundEffects ?? current.background_effects, defaults.backgroundEffects),
    effectIntensity: clampNumber(current.effectIntensity ?? current.effect_intensity, 0, 100, defaults.effectIntensity),
    surfaceContrast: clampNumber(current.surfaceContrast ?? current.surface_contrast, 0, 100, defaults.surfaceContrast),
    iconGlow: clampNumber(current.iconGlow ?? current.icon_glow, 0, 100, defaults.iconGlow),
    transparency: clampNumber(current.transparency, 0, 80, defaults.transparency),
    fontFamily: FONT_STACKS[current.fontFamily || current.font_family] ? (current.fontFamily || current.font_family) : defaults.fontFamily,
    fontSize: clampNumber(current.fontSize ?? current.font_size, 11, 18, defaults.fontSize),
    textRendering: TEXT_RENDERING_MODES[current.textRendering || current.text_rendering] ? (current.textRendering || current.text_rendering) : defaults.textRendering,
    tokens: normalizeCustomTokens(current.tokens),
    customThemes: normalizedCustomThemes,
  };
}

export function appearanceFromLegacyTheme(theme) {
  const value = String(theme || "").trim().toLowerCase();
  if (value === "dark" || value === "light") {
    return {
      ...defaultAppearanceSettings(),
      activeThemeId: value,
      accentColor: BUILT_IN_PRESETS[value].accentColor,
    };
  }
  return defaultAppearanceSettings();
}

export function resolveSystemScheme(matchMediaSource = globalThis) {
  const matcher = typeof matchMediaSource?.matchMedia === "function"
    ? matchMediaSource.matchMedia("(prefers-color-scheme: dark)")
    : null;
  return matcher?.matches ? "dark" : "light";
}

export function resolveAppearance(appearance, options = {}) {
  const settings = normalizeAppearanceSettings(appearance);
  const activeCustom = settings.customThemes.find((theme) => theme.id === settings.activeThemeId) || null;
  const builtIn = BUILT_IN_PRESETS[settings.activeThemeId] || BUILT_IN_PRESETS.system;
  const systemScheme = options.systemScheme || resolveSystemScheme(options.matchMediaSource);
  const preset = activeCustom || builtIn;
  const scheme = preset.scheme === "system" ? systemScheme : (preset.scheme || "dark");
  const base = preset.scheme === "system"
    ? systemScheme
    : (activeCustom
      ? (BUILT_IN_PRESETS[preset.basePresetId]?.base || preset.scheme || scheme)
      : preset.base);
  const accentColor = activeCustom?.accentColor || settings.accentColor || preset.accentColor;
  const colorTemperature = activeCustom?.colorTemperature ?? settings.colorTemperature;
  const surfaceContrast = activeCustom?.surfaceContrast ?? settings.surfaceContrast;
  const iconGlow = activeCustom?.iconGlow ?? settings.iconGlow;
  const tokenOverrides = {
    ...(settings.tokens || {}),
    ...(activeCustom?.tokens || {}),
  };
  const tintColor = tokenOverrides.themeTint || preset.tintColor || BASE_PALETTES[base]?.surfaceMuted;
  const hasIconColorOverride = Boolean(tokenOverrides.iconColor);
  const presetIconColor = normalizeHexColor(
    preset.iconColor || BUILT_IN_PRESETS[activeCustom?.basePresetId]?.iconColor,
    scheme === "light" ? "#2f78d4" : "#5aa7ff",
  );
  const rawIconColor = tokenOverrides.iconColor || presetIconColor;
  const iconColor = applyColorIntensity(
    rawIconColor,
    scheme,
    tokenIntensity(tokenOverrides, "iconColorIntensity"),
    scheme === "light" ? "#2f78d4" : "#5aa7ff",
  );
  const usesDefaultLogoAsset = !activeCustom
    && (settings.activeThemeId === "system" || settings.activeThemeId === "dark" || settings.activeThemeId === "light");
  const hasIconIntensityOverride = tokenOverrides.iconColorIntensity !== undefined;
  const shouldTintLogo = hasIconColorOverride || hasIconIntensityOverride || !usesDefaultLogoAsset;
  const tokens = applyReadableColorOverrides(
    {
      ...paletteForBase(base, scheme, accentColor, colorTemperature, tintColor, tokenOverrides, surfaceContrast),
      iconColor,
      logoFilter: shouldTintLogo
        ? logoFilterForColor(iconColor, scheme)
        : "hue-rotate(0deg) saturate(100%) brightness(100%)",
      logoGlow: logoGlowForColor(iconColor, scheme, iconGlow),
    },
    tokenOverrides,
    scheme,
  );

  return {
    settings,
    preset,
    scheme,
    tokens,
    fontStack: FONT_STACKS[activeCustom?.fontFamily || settings.fontFamily]?.stack || FONT_STACKS[DEFAULT_FONT_FAMILY].stack,
    fontSize: activeCustom?.fontSize ?? settings.fontSize,
    textRendering: TEXT_RENDERING_MODES[activeCustom?.textRendering || settings.textRendering]?.value || TEXT_RENDERING_MODES.auto.value,
    cornerRadius: activeCustom?.cornerRadius ?? settings.cornerRadius,
    animations: activeCustom?.animations ?? settings.animations,
    backgroundEffects: activeCustom?.backgroundEffects ?? settings.backgroundEffects,
    effectIntensity: activeCustom?.effectIntensity ?? settings.effectIntensity,
    surfaceContrast,
    iconGlow,
    transparency: activeCustom?.transparency ?? settings.transparency,
    accentColor: normalizeHexColor(accentColor, BUILT_IN_PRESETS.system.accentColor),
  };
}

export function applyAppearanceToDocument(appearance, options = {}) {
  const root = options.root || document?.body;
  if (!root) return resolveAppearance(appearance, options);
  const resolved = resolveAppearance(appearance, options);
  root.dataset.theme = resolved.scheme === "light" ? "light" : "dark";
  root.dataset.appearanceTheme = resolved.settings.activeThemeId;
  root.dataset.animations = resolved.animations ? "on" : "off";
  root.dataset.backgroundEffects = resolved.backgroundEffects ? "on" : "off";
  root.classList.toggle("dark-mode", resolved.scheme !== "light");
  Object.entries(resolved.tokens).forEach(([key, value]) => {
    const cssVar = TOKEN_TO_VAR[key];
    if (cssVar) root.style.setProperty(cssVar, value);
  });
  const radius = `${Math.round(resolved.cornerRadius)}px`;
  root.style.setProperty("--radius-control", radius);
  root.style.setProperty("--radius-card", `${Math.min(8, Math.max(2, Math.round(resolved.cornerRadius + 1)))}px`);
  root.style.setProperty("--radius-panel", `${Math.min(8, Math.max(2, Math.round(resolved.cornerRadius + 2)))}px`);
  root.style.setProperty("--app-font-family", resolved.fontStack);
  root.style.setProperty("--app-font-size", `${resolved.fontSize}px`);
  root.style.setProperty("--text-rendering-mode", resolved.textRendering);
  document.documentElement.style.setProperty("--app-font-family", resolved.fontStack);
  document.documentElement.style.setProperty("--app-font-size", `${resolved.fontSize}px`);
  document.documentElement.style.setProperty("--text-rendering-mode", resolved.textRendering);
  root.style.setProperty("--appearance-effect-opacity", resolved.backgroundEffects ? String(resolved.effectIntensity / 100) : "0");
  root.style.setProperty("--appearance-effect-accent", resolved.backgroundEffects ? `${Math.round(resolved.effectIntensity * 0.32)}%` : "0%");
  root.style.setProperty("--appearance-effect-success", resolved.backgroundEffects ? `${Math.round(resolved.effectIntensity * 0.22)}%` : "0%");
  root.style.setProperty("--appearance-surface-opacity", String((100 - resolved.transparency) / 100));
  root.style.setProperty("--appearance-surface-opacity-percent", `${100 - resolved.transparency}%`);
  root.style.setProperty("--appearance-transparency", `${resolved.transparency}%`);
  root.style.setProperty("--motion-fast", resolved.animations ? "120ms" : "0ms");
  root.style.setProperty("--motion-normal", resolved.animations ? "180ms" : "0ms");
  root.style.setProperty("--motion-page", resolved.animations ? "100ms" : "0ms");
  document.documentElement.style.colorScheme = resolved.scheme === "light" ? "light" : "dark";
  try {
    localStorage.setItem("uiTheme", resolved.scheme === "light" ? "light" : "dark");
    localStorage.setItem("midimasterAppearance", JSON.stringify(toBackendAppearanceSettings(resolved.settings)));
  } catch {
    // Storage is a cache only; backend settings remain authoritative.
  }
  return resolved;
}

export function makeCustomThemeFromAppearance(appearance, options = {}) {
  const resolved = resolveAppearance(appearance, options);
  const settings = resolved.settings;
  const existing = Array.isArray(settings.customThemes) ? settings.customThemes : [];
  const baseName = normalizeName(options.name, "Custom Theme");
  let name = baseName;
  let suffix = 1;
  const existingNames = new Set(existing.map((theme) => theme.name.toLowerCase()));
  while (existingNames.has(name.toLowerCase())) {
    suffix += 1;
    name = `${baseName} ${suffix}`;
  }
  const idBase = normalizeId(name, "custom-theme");
  let id = idBase;
  let idSuffix = 1;
  const existingIds = new Set([...Object.keys(BUILT_IN_PRESETS), ...existing.map((theme) => theme.id)]);
  while (existingIds.has(id)) {
    idSuffix += 1;
    id = `${idBase}-${idSuffix}`;
  }
  return {
    id,
    name,
    scheme: resolved.scheme,
    basePresetId: BUILT_IN_PRESETS[settings.activeThemeId]?.base || resolved.scheme,
    accentColor: resolved.accentColor,
    colorTemperature: settings.colorTemperature,
    cornerRadius: settings.cornerRadius,
    animations: settings.animations,
    backgroundEffects: settings.backgroundEffects,
    effectIntensity: settings.effectIntensity,
    surfaceContrast: settings.surfaceContrast,
    iconGlow: settings.iconGlow,
    transparency: settings.transparency,
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    textRendering: settings.textRendering,
    tokens: {},
  };
}

export function ensureEditableAppearance(appearance, options = {}) {
  const settings = normalizeAppearanceSettings(appearance);
  if (!BUILT_IN_IDS.has(settings.activeThemeId)) {
    return settings;
  }
  const preset = BUILT_IN_PRESETS[settings.activeThemeId] || BUILT_IN_PRESETS.system;
  const name = options.name || `${options.t?.(preset.labelKey) || preset.id} Custom`;
  const customTheme = makeCustomThemeFromAppearance(settings, {
    ...options,
    name,
  });
  return {
    ...settings,
    activeThemeId: customTheme.id,
    customThemes: [...settings.customThemes, customTheme],
  };
}

export function applyAppearancePatch(appearance, patch, options = {}) {
  const settings = normalizeAppearanceSettings(appearance);
  const next = normalizeAppearanceSettings({ ...settings, ...(patch || {}) });
  if (next.customThemes.some((theme) => theme.id === next.activeThemeId)) {
    const updatedThemes = next.customThemes.map((theme) => (
      theme.id === next.activeThemeId
        ? normalizeCustomTheme({
            ...theme,
            accentColor: next.accentColor,
            colorTemperature: next.colorTemperature,
            cornerRadius: next.cornerRadius,
            animations: next.animations,
            backgroundEffects: next.backgroundEffects,
            effectIntensity: next.effectIntensity,
            surfaceContrast: next.surfaceContrast,
            iconGlow: next.iconGlow,
            transparency: next.transparency,
            fontFamily: next.fontFamily,
            fontSize: next.fontSize,
            textRendering: next.textRendering,
            tokens: next.tokens,
          })
        : theme
    ));
    return normalizeAppearanceSettings({ ...next, customThemes: updatedThemes });
  }
  return next;
}

export function applyBuiltInPreset(appearance, presetId) {
  const preset = BUILT_IN_PRESETS[presetId] || BUILT_IN_PRESETS.system;
  const defaults = defaultAppearanceSettings();
  return normalizeAppearanceSettings({
    ...defaults,
    activeThemeId: preset.id,
    accentColor: preset.accentColor,
    tokens: {},
    customThemes: normalizeAppearanceSettings(appearance).customThemes,
  });
}

function toBackendTokens(tokens = {}) {
  const normalized = normalizeCustomTokens(tokens);
  const backendTokens = {};
  Object.entries(normalized).forEach(([key, value]) => {
    const cssVar = TOKEN_TO_VAR[key];
    if (cssVar) backendTokens[cssVar] = value;
  });
  return backendTokens;
}

export function toBackendAppearanceSettings(appearance) {
  const settings = normalizeAppearanceSettings(appearance);
  return {
    active_theme_id: settings.activeThemeId,
    accent_color: settings.accentColor,
    color_temperature: settings.colorTemperature,
    corner_radius: settings.cornerRadius,
    animations: settings.animations,
    background_effects: settings.backgroundEffects,
    effect_intensity: settings.effectIntensity,
    surface_contrast: settings.surfaceContrast,
    icon_glow: settings.iconGlow,
    transparency: settings.transparency,
    font_family: settings.fontFamily,
    font_size: settings.fontSize,
    text_rendering: settings.textRendering,
    tokens: toBackendTokens(settings.tokens),
    custom_themes: settings.customThemes.map(toBackendCustomTheme),
  };
}

export function toBackendCustomTheme(theme) {
  const normalized = normalizeCustomTheme(theme);
  return {
    id: normalized.id,
    name: normalized.name,
    scheme: normalized.scheme,
    base_preset_id: normalized.basePresetId,
    accent_color: normalized.accentColor,
    color_temperature: normalized.colorTemperature,
    corner_radius: normalized.cornerRadius,
    animations: normalized.animations,
    background_effects: normalized.backgroundEffects,
    effect_intensity: normalized.effectIntensity,
    surface_contrast: normalized.surfaceContrast,
    icon_glow: normalized.iconGlow,
    transparency: normalized.transparency,
    font_family: normalized.fontFamily,
    font_size: normalized.fontSize,
    text_rendering: normalized.textRendering,
    tokens: toBackendTokens(normalized.tokens),
  };
}

export function exportableThemeFromAppearance(appearance, options = {}) {
  const settings = normalizeAppearanceSettings(appearance);
  const activeCustom = settings.customThemes.find((theme) => theme.id === settings.activeThemeId);
  const preset = BUILT_IN_PRESETS[settings.activeThemeId] || BUILT_IN_PRESETS.system;
  const theme = activeCustom || makeCustomThemeFromAppearance(settings, {
    ...options,
    name: options.name || options.t?.(preset.labelKey) || preset.id,
  });
  return toBackendCustomTheme(theme);
}

export function getCssTokenVarName(key) {
  return TOKEN_TO_VAR[key] || "";
}

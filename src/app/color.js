export const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function normalizeHexColor(value, fallback = "", { allowMissingHash = false } = {}) {
  let raw = String(value || "").trim();
  if (allowMissingHash && raw && !raw.startsWith("#")) raw = `#${raw}`;
  if (HEX_COLOR_RE.test(raw)) return raw.toLowerCase();
  const short = raw.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (!short) return fallback;
  return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
}

export function hexToRgb(hex, fallback = "#000000") {
  const normalized = normalizeHexColor(hex, fallback).slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((part) => (
    Math.round(Math.min(255, Math.max(0, part))).toString(16).padStart(2, "0")
  )).join("")}`;
}

export function rgbToHsv({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * (((blue - red) / delta) + 2);
    else hue = 60 * (((red - green) / delta) + 4);
  }
  if (hue < 0) hue += 360;
  return {
    h: hue,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

export function hsvToRgb({ h, s, v }) {
  const hue = ((Number(h) % 360) + 360) % 360;
  const saturation = Math.min(1, Math.max(0, Number(s) || 0));
  const value = Math.min(1, Math.max(0, Number(v) || 0));
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - chroma;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (hue < 60) {
    red = chroma;
    green = x;
  } else if (hue < 120) {
    red = x;
    green = chroma;
  } else if (hue < 180) {
    green = chroma;
    blue = x;
  } else if (hue < 240) {
    green = x;
    blue = chroma;
  } else if (hue < 300) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }
  return {
    r: (red + m) * 255,
    g: (green + m) * 255,
    b: (blue + m) * 255,
  };
}

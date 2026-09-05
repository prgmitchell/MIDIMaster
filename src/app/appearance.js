import {
  BUILT_IN_IDS,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_TEXT_RENDERING,
  FONT_STACKS,
  TEXT_RENDERING_MODES,
  BUILT_IN_PRESETS,
  BASE_PALETTES,
  TOKEN_TO_VAR,
} from "./appearance_catalog.js";
import {
  clampNumber,
  normalizeBoolean,
  normalizeId,
  normalizeName,
  tokenIntensity,
  applyColorIntensity,
  logoFilterForColor,
  logoGlowForColor,
  applyReadableColorOverrides,
  paletteForBase,
  normalizeCustomTokens,
} from "./appearance_palette.js";
export { APPEARANCE_THEME_FILE_KIND } from "./appearance_catalog.js";
import { normalizeHexColor } from "./color.js";

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
    fontSize: DEFAULT_FONT_SIZE,
    textRendering: DEFAULT_TEXT_RENDERING,
    tokens: {},
    customThemes: [],
  };
}

export function appearanceBackgroundGlowValue(appearance) {
  const settings = normalizeAppearanceSettings(appearance);
  return settings.backgroundEffects ? Math.round(clampNumber(settings.effectIntensity, 0, 100, 30)) : 0;
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
  const sourceScheme = String(source.scheme || "dark")
    .trim()
    .toLowerCase();
  const scheme = sourceScheme === "light" ? "light" : "dark";
  return {
    id: BUILT_IN_IDS.has(id) ? `custom-${id}` : id,
    name: normalizeName(source.name, "Custom Theme"),
    scheme,
    basePresetId: normalizeId(source.basePresetId || source.base_preset_id || scheme, scheme),
    accentColor: normalizeHexColor(
      source.accentColor || source.accent_color,
      scheme === "light" ? "#2f78d4" : "#5aa7ff",
    ),
    colorTemperature: clampNumber(source.colorTemperature ?? source.color_temperature, 0, 100, 50),
    cornerRadius: clampNumber(source.cornerRadius ?? source.corner_radius, 0, 16, 4),
    animations: normalizeBoolean(source.animations, true),
    backgroundEffects: normalizeBoolean(source.backgroundEffects ?? source.background_effects, true),
    effectIntensity: clampNumber(source.effectIntensity ?? source.effect_intensity, 0, 100, 30),
    surfaceContrast: clampNumber(source.surfaceContrast ?? source.surface_contrast, 0, 100, 50),
    iconGlow: clampNumber(source.iconGlow ?? source.icon_glow, 0, 100, 50),
    transparency: clampNumber(source.transparency, 0, 80, 30),
    fontFamily: FONT_STACKS[source.fontFamily || source.font_family]
      ? source.fontFamily || source.font_family
      : DEFAULT_FONT_FAMILY,
    fontSize: clampNumber(source.fontSize ?? source.font_size, 11, 18, DEFAULT_FONT_SIZE),
    textRendering: TEXT_RENDERING_MODES[source.textRendering || source.text_rendering]
      ? source.textRendering || source.text_rendering
      : DEFAULT_TEXT_RENDERING,
    tokens: normalizeCustomTokens(source.tokens),
  };
}

export function normalizeAppearanceSettings(source = {}) {
  const current = source && typeof source === "object" ? source : {};
  const defaults = defaultAppearanceSettings();
  const customThemes =
    (Array.isArray(current.customThemes) ? current.customThemes : current.custom_themes) || [];
  const normalizedCustomThemes = [];
  customThemes.forEach((theme, index) => {
    const normalized = normalizeCustomTheme(theme, index);
    if (!normalizedCustomThemes.some((existing) => existing.id === normalized.id)) {
      normalizedCustomThemes.push(normalized);
    }
  });

  const activeThemeId = normalizeId(current.activeThemeId || current.active_theme_id, defaults.activeThemeId);
  const activeExists =
    BUILT_IN_IDS.has(activeThemeId) || normalizedCustomThemes.some((theme) => theme.id === activeThemeId);
  const activePreset =
    BUILT_IN_PRESETS[activeExists ? activeThemeId : defaults.activeThemeId] || BUILT_IN_PRESETS.system;

  return {
    ...defaults,
    activeThemeId: activeExists ? activeThemeId : defaults.activeThemeId,
    accentColor: normalizeHexColor(
      current.accentColor || current.accent_color,
      activePreset.accentColor || defaults.accentColor,
    ),
    colorTemperature: clampNumber(
      current.colorTemperature ?? current.color_temperature,
      0,
      100,
      defaults.colorTemperature,
    ),
    cornerRadius: clampNumber(current.cornerRadius ?? current.corner_radius, 0, 16, defaults.cornerRadius),
    animations: normalizeBoolean(current.animations, defaults.animations),
    backgroundEffects: normalizeBoolean(
      current.backgroundEffects ?? current.background_effects,
      defaults.backgroundEffects,
    ),
    effectIntensity: clampNumber(
      current.effectIntensity ?? current.effect_intensity,
      0,
      100,
      defaults.effectIntensity,
    ),
    surfaceContrast: clampNumber(
      current.surfaceContrast ?? current.surface_contrast,
      0,
      100,
      defaults.surfaceContrast,
    ),
    iconGlow: clampNumber(current.iconGlow ?? current.icon_glow, 0, 100, defaults.iconGlow),
    transparency: clampNumber(current.transparency, 0, 80, defaults.transparency),
    fontFamily: FONT_STACKS[current.fontFamily || current.font_family]
      ? current.fontFamily || current.font_family
      : defaults.fontFamily,
    fontSize: clampNumber(current.fontSize ?? current.font_size, 11, 18, defaults.fontSize),
    textRendering: TEXT_RENDERING_MODES[current.textRendering || current.text_rendering]
      ? current.textRendering || current.text_rendering
      : defaults.textRendering,
    tokens: normalizeCustomTokens(current.tokens),
    customThemes: normalizedCustomThemes,
  };
}

export function appearanceFromLegacyTheme(theme) {
  const value = String(theme || "")
    .trim()
    .toLowerCase();
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
  const matcher =
    typeof matchMediaSource?.matchMedia === "function"
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
  const scheme = preset.scheme === "system" ? systemScheme : preset.scheme || "dark";
  const base =
    preset.scheme === "system"
      ? systemScheme
      : activeCustom
        ? BUILT_IN_PRESETS[preset.basePresetId]?.base || preset.scheme || scheme
        : preset.base;
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
  const usesDefaultLogoAsset =
    !activeCustom &&
    (settings.activeThemeId === "system" ||
      settings.activeThemeId === "dark" ||
      settings.activeThemeId === "light");
  const hasIconIntensityOverride = tokenOverrides.iconColorIntensity !== undefined;
  const shouldTintLogo = hasIconColorOverride || hasIconIntensityOverride || !usesDefaultLogoAsset;
  const tokens = applyReadableColorOverrides(
    {
      ...paletteForBase(
        base,
        scheme,
        accentColor,
        colorTemperature,
        tintColor,
        tokenOverrides,
        surfaceContrast,
      ),
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
    fontStack:
      FONT_STACKS[activeCustom?.fontFamily || settings.fontFamily]?.stack ||
      FONT_STACKS[DEFAULT_FONT_FAMILY].stack,
    fontSize: activeCustom?.fontSize ?? settings.fontSize,
    textRendering:
      TEXT_RENDERING_MODES[activeCustom?.textRendering || settings.textRendering]?.value ||
      TEXT_RENDERING_MODES.auto.value,
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
  root.querySelectorAll?.("[data-theme-logo]").forEach((image) => {
    const nextSource = resolved.scheme === "light" ? image.dataset.lightSrc : image.dataset.darkSrc;
    if (nextSource && image.getAttribute("src") !== nextSource) {
      image.setAttribute("src", nextSource);
    }
  });
  Object.entries(resolved.tokens).forEach(([key, value]) => {
    const cssVar = TOKEN_TO_VAR[key];
    if (cssVar) root.style.setProperty(cssVar, value);
  });
  const radius = `${Math.round(resolved.cornerRadius)}px`;
  root.style.setProperty("--radius-control", radius);
  root.style.setProperty(
    "--radius-card",
    `${Math.min(8, Math.max(2, Math.round(resolved.cornerRadius + 1)))}px`,
  );
  root.style.setProperty(
    "--radius-panel",
    `${Math.min(8, Math.max(2, Math.round(resolved.cornerRadius + 2)))}px`,
  );
  root.style.setProperty("--app-font-family", resolved.fontStack);
  root.style.setProperty("--app-font-size", `${resolved.fontSize}px`);
  root.style.setProperty("--text-rendering-mode", resolved.textRendering);
  document.documentElement.style.setProperty("--app-font-family", resolved.fontStack);
  document.documentElement.style.setProperty("--app-font-size", `${resolved.fontSize}px`);
  document.documentElement.style.setProperty("--text-rendering-mode", resolved.textRendering);
  root.style.setProperty(
    "--appearance-effect-opacity",
    resolved.backgroundEffects ? String(resolved.effectIntensity / 100) : "0",
  );
  root.style.setProperty(
    "--appearance-effect-accent",
    resolved.backgroundEffects ? `${Math.round(resolved.effectIntensity * 0.32)}%` : "0%",
  );
  root.style.setProperty(
    "--appearance-effect-success",
    resolved.backgroundEffects ? `${Math.round(resolved.effectIntensity * 0.22)}%` : "0%",
  );
  root.style.setProperty("--appearance-surface-opacity", String((100 - resolved.transparency) / 100));
  root.style.setProperty("--appearance-surface-opacity-percent", `${100 - resolved.transparency}%`);
  root.style.setProperty("--appearance-transparency", `${resolved.transparency}%`);
  root.style.setProperty("--motion-fast", resolved.animations ? "120ms" : "0ms");
  root.style.setProperty("--motion-normal", resolved.animations ? "180ms" : "0ms");
  root.style.setProperty("--motion-page", resolved.animations ? "100ms" : "0ms");
  document.documentElement.style.colorScheme = resolved.scheme === "light" ? "light" : "dark";
  try {
    localStorage.setItem("uiTheme", resolved.scheme === "light" ? "light" : "dark");
    localStorage.setItem(
      "midimasterAppearance",
      JSON.stringify(toBackendAppearanceSettings(resolved.settings)),
    );
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
    const updatedThemes = next.customThemes.map((theme) =>
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
        : theme,
    );
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
  const theme =
    activeCustom ||
    makeCustomThemeFromAppearance(settings, {
      ...options,
      name: options.name || options.t?.(preset.labelKey) || preset.id,
    });
  return toBackendCustomTheme(theme);
}

export function getCssTokenVarName(key) {
  return TOKEN_TO_VAR[key] || "";
}

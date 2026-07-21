export function resolveInitialThemeScheme({ storage, matchMediaSource } = {}) {
  const systemScheme = () => (
    matchMediaSource?.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light"
  );
  try {
    const rawAppearance = storage?.getItem?.("midimasterAppearance");
    if (rawAppearance) {
      try {
        const appearance = JSON.parse(rawAppearance);
        const activeThemeId = String(appearance?.activeThemeId || appearance?.active_theme_id || "system");
        if (activeThemeId === "system") return systemScheme();
        if (activeThemeId === "light") return "light";
        const customThemes = Array.isArray(appearance?.customThemes)
          ? appearance.customThemes
          : (Array.isArray(appearance?.custom_themes) ? appearance.custom_themes : []);
        const custom = customThemes.find((theme) => String(theme?.id || theme?.theme_id || "") === activeThemeId);
        if (custom) return String(custom.scheme || "dark") === "light" ? "light" : "dark";
        return "dark";
      } catch {
        // Fall back to the last resolved scheme below.
      }
    }
    const stored = storage?.getItem?.("uiTheme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Fall through to the operating-system preference.
  }
  return systemScheme();
}

export function hydrateThemeLogo({
  root = typeof document !== "undefined" ? document : null,
  storage = typeof localStorage !== "undefined" ? localStorage : null,
  matchMediaSource = typeof window !== "undefined" ? window : null,
} = {}) {
  const image = root?.querySelector?.("[data-theme-logo]");
  if (!image) return null;
  const scheme = resolveInitialThemeScheme({ storage, matchMediaSource });
  const source = scheme === "light" ? image.dataset.lightSrc : image.dataset.darkSrc;
  if (source) image.setAttribute("src", source);
  return source || null;
}

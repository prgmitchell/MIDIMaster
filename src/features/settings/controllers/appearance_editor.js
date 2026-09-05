import {
  resolveAppearance,
  appearanceBackgroundGlowValue,
  normalizeAppearanceSettings,
  toBackendAppearanceSettings,
  applyAppearancePatch,
  defaultAppearanceSettings,
} from "../../../app/appearance.js";
import { appearanceColorControlValue } from "../appearance_controls.js";

/** appearance editor workflow. */
export function createAppearanceEditor({
  appearanceColorControlIntensity,
  appearanceColorControls,
  appearanceEl,
  appendSvgIcon,
  currentAppearance,
  invoke,
  renderAppearancePresets,
  setAppearanceState,
  sliderFillPercent,
  syncRange,
  t,
}) {
  function renderThemeColorControls(appearance) {
    const container = appearanceEl("appearance-theme-colors");
    if (!container) return;
    const resolved = resolveAppearance(appearance, { matchMediaSource: window });
    container.replaceChildren();
    appearanceColorControls.forEach((control) => {
      const value = appearanceColorControlValue(control, appearance, resolved);
      const name = t(control.labelKey);
      const card = document.createElement("div");
      card.className = "appearance-token-color";
      card.style.setProperty("--theme-color", value);

      const header = document.createElement("div");
      header.className = "appearance-token-color-header";

      const label = document.createElement("span");
      label.className = "appearance-token-color-label";
      label.textContent = name;
      header.appendChild(label);

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "appearance-token-color-edit";
      edit.dataset.appearanceColorTrigger = control.target;
      edit.dataset.appearanceColorName = name;
      if (control.token) edit.dataset.appearanceToken = control.token;
      edit.setAttribute("aria-label", t("settings.appearance.themeColorValue", { name, color: value }));
      appendSvgIcon(edit, ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"]);
      header.appendChild(edit);
      card.appendChild(header);

      const swatches = document.createElement("div");
      swatches.className = "appearance-token-swatches";
      const presetSwatches = control.swatches;
      const hasCurrentSwatch = presetSwatches.some((color) => color.toLowerCase() === value.toLowerCase());
      const displaySwatches = hasCurrentSwatch
        ? presetSwatches
        : [value, ...presetSwatches.filter((color) => color.toLowerCase() !== value.toLowerCase())].slice(
            0,
            6,
          );
      displaySwatches.forEach((color) => {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "appearance-token-swatch";
        swatch.dataset.appearanceOptionSwatch = color;
        swatch.dataset.appearanceColorRole = control.target;
        if (control.token) swatch.dataset.appearanceToken = control.token;
        swatch.style.setProperty("--swatch-color", color);
        const selected = color.toLowerCase() === value.toLowerCase();
        swatch.classList.toggle("selected", selected);
        swatch.setAttribute("aria-label", t("settings.appearance.themeColorValue", { name, color }));
        swatch.setAttribute("aria-pressed", String(selected));
        swatches.appendChild(swatch);
      });
      card.appendChild(swatches);

      const intensity = appearanceColorControlIntensity(control, appearance);
      const intensityRow = document.createElement("div");
      intensityRow.className = "appearance-token-intensity";

      const intensityInput = document.createElement("input");
      intensityInput.type = "range";
      intensityInput.min = "0";
      intensityInput.max = "100";
      intensityInput.step = "1";
      intensityInput.value = String(intensity);
      intensityInput.className = "binding-volume-slider appearance-token-intensity-slider";
      intensityInput.dataset.appearanceIntensityToken = control.intensityToken;
      intensityInput.setAttribute("aria-label", `${name} ${t("settings.appearance.intensity")}`);
      intensityInput.style.setProperty("--range-fill", `${sliderFillPercent(intensityInput, intensity)}%`);
      intensityRow.appendChild(intensityInput);

      const intensityValue = document.createElement("span");
      intensityValue.className = "appearance-token-intensity-value";
      intensityValue.textContent = `${intensity}%`;
      intensityRow.appendChild(intensityValue);
      card.appendChild(intensityRow);

      container.appendChild(card);
    });
  }

  function syncAppearanceControls(appearanceOverride = null) {
    const appearance = setAppearanceState(appearanceOverride || currentAppearance(), {
      apply: Boolean(appearanceOverride),
    });
    renderAppearancePresets(appearance);
    renderThemeColorControls(appearance);
    syncRange(
      appearanceEl("appearance-temperature"),
      appearanceEl("appearance-temperature-value"),
      appearance.colorTemperature,
      "%",
    );
    syncRange(
      appearanceEl("appearance-font-size"),
      appearanceEl("appearance-font-size-value"),
      appearance.fontSize,
      "px",
    );
    syncRange(
      appearanceEl("appearance-background-glow"),
      appearanceEl("appearance-background-glow-value"),
      appearanceBackgroundGlowValue(appearance),
      "%",
    );
    syncRange(
      appearanceEl("appearance-surface-contrast"),
      appearanceEl("appearance-surface-contrast-value"),
      appearance.surfaceContrast,
      "%",
    );
    syncRange(
      appearanceEl("appearance-icon-glow"),
      appearanceEl("appearance-icon-glow-value"),
      appearance.iconGlow,
      "%",
    );

    return appearance;
  }

  async function persistAppearanceSettings(appearance = currentAppearance()) {
    const normalized = normalizeAppearanceSettings(appearance);
    try {
      const saved = await invoke("update_appearance_settings", {
        appearance: toBackendAppearanceSettings(normalized),
      });
      if (saved) {
        syncAppearanceControls(saved);
      }
    } catch (error) {
      console.error("Failed to update appearance settings", error);
    }
  }

  function applyAppearanceUpdate(patch, { persist = false, render = true } = {}) {
    const current = currentAppearance();
    const mergedPatch = patch?.tokens
      ? { ...patch, tokens: { ...(current.tokens || {}), ...(patch.tokens || {}) } }
      : patch;
    const next = applyAppearancePatch(current, mergedPatch, { t });
    if (render) {
      syncAppearanceControls(next);
    } else {
      setAppearanceState(next);
    }
    if (persist) {
      persistAppearanceSettings(next);
    }
  }

  function selectCustomAppearanceTheme(id) {
    const current = currentAppearance();
    const theme = current.customThemes.find((item) => item.id === id);
    if (!theme) return current;
    return normalizeAppearanceSettings({
      ...current,
      activeThemeId: theme.id,
      accentColor: theme.accentColor,
      colorTemperature: theme.colorTemperature,
      cornerRadius: theme.cornerRadius,
      animations: theme.animations,
      backgroundEffects: theme.backgroundEffects,
      effectIntensity: theme.effectIntensity,
      surfaceContrast: theme.surfaceContrast,
      iconGlow: theme.iconGlow,
      transparency: theme.transparency,
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSize,
      textRendering: theme.textRendering,
    });
  }

  async function deleteCustomAppearanceTheme(id) {
    const current = currentAppearance();
    const themeId = String(id || current.activeThemeId || "").trim();
    if (!themeId) return;
    const remainingThemes = current.customThemes.filter((theme) => theme.id !== themeId);
    if (remainingThemes.length === current.customThemes.length) return;
    const next =
      current.activeThemeId === themeId
        ? normalizeAppearanceSettings({
            ...defaultAppearanceSettings(),
            customThemes: remainingThemes,
          })
        : normalizeAppearanceSettings({
            ...current,
            customThemes: remainingThemes,
          });
    syncAppearanceControls(next);
    await persistAppearanceSettings(next);
  }

  return {
    syncAppearanceControls,
    persistAppearanceSettings,
    applyAppearanceUpdate,
    selectCustomAppearanceTheme,
    deleteCustomAppearanceTheme,
  };
}

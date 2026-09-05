import {
  appearanceFromLegacyTheme,
  normalizeAppearanceSettings,
  applyAppearanceToDocument,
} from "../../../app/appearance.js";
import { parseHexColorInput } from "../appearance_controls.js";

/** appearance presets workflow. */
export function createAppearancePresets({
  appearanceBuiltInPresetIds,
  appearanceBuiltInPresets,
  applyAppearance,
  applyAppearanceUpdate,
  clampNumber,
  elements,
  getAppSettings,
  setAppSettings,
  sliderFillPercent,
  t,
}) {
  function appearanceEl(id) {
    return elements.settingsPanel?.querySelector?.(`#${id}`) || null;
  }

  function currentAppearance() {
    const settings = typeof getAppSettings === "function" ? getAppSettings() || {} : {};
    const source =
      settings.appearance && typeof settings.appearance === "object"
        ? settings.appearance
        : appearanceFromLegacyTheme(settings.ui_theme ?? settings.uiTheme);
    return normalizeAppearanceSettings(source);
  }

  function setAppearanceState(appearance, { apply = true } = {}) {
    const normalized = normalizeAppearanceSettings(appearance);
    const current = typeof getAppSettings === "function" ? getAppSettings() || {} : {};
    if (typeof setAppSettings === "function") {
      setAppSettings({ ...current, appearance: normalized });
    }
    if (apply) {
      if (typeof applyAppearance === "function") {
        applyAppearance(normalized);
      } else {
        applyAppearanceToDocument(normalized);
      }
    }
    return normalized;
  }

  function syncRange(inputEl, valueEl, value, suffix = "") {
    if (!inputEl) return;
    const rounded = Math.round(Number(value) || 0);
    inputEl.value = String(rounded);
    inputEl.style.setProperty("--range-fill", `${sliderFillPercent(inputEl, rounded)}%`);
    if (valueEl) {
      valueEl.textContent = `${rounded}${suffix}`;
    }
  }

  function appendSvgIcon(button, paths) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    paths.forEach((pathValue) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathValue);
      svg.appendChild(path);
    });
    button.appendChild(svg);
  }

  function renderPresetMini(card, preset, selected) {
    const mini = document.createElement("span");
    mini.className = "appearance-preset-mini";
    mini.setAttribute("aria-hidden", "true");
    const tones = preset.preview || [preset.accentColor || "#5aa7ff", preset.accentColor || "#5aa7ff"];
    mini.style.setProperty("--preset-accent", tones[0]);
    mini.style.setProperty("--preset-accent-2", tones[1] || tones[0]);
    for (let index = 0; index < 5; index += 1) {
      const line = document.createElement("span");
      line.className = `appearance-preset-line appearance-preset-line--${index + 1}`;
      mini.appendChild(line);
    }
    if (selected) {
      const check = document.createElement("span");
      check.className = "appearance-preset-check";
      mini.appendChild(check);
    }
    card.appendChild(mini);
  }

  function renderAppearancePresetCard(container, preset, appearance, isCustom = false) {
    const selected = activeAppearancePresetId(appearance) === preset.id;
    const card = document.createElement("div");
    card.className = "appearance-preset-card";
    card.classList.toggle("selected", selected);
    card.classList.toggle("appearance-preset-card--custom", isCustom);
    card.dataset.appearancePreset = preset.id;
    card.dataset.appearancePresetKind = isCustom ? "custom" : "built-in";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-pressed", String(selected));

    const label = document.createElement("span");
    label.className = "appearance-preset-name";
    label.textContent = isCustom ? preset.name : t(preset.labelKey);
    card.appendChild(label);

    if (isCustom) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "appearance-preset-delete";
      deleteButton.dataset.appearanceDeleteCustom = preset.id;
      const deleteLabel = `${t("common.delete")} ${preset.name}`;
      deleteButton.setAttribute("aria-label", deleteLabel);
      deleteButton.setAttribute("title", deleteLabel);
      appendSvgIcon(deleteButton, ["M3 6h18", "M8 6V4h8v2", "M6 6l1 15h10l1-15", "M10 11v6", "M14 11v6"]);
      card.appendChild(deleteButton);
    }

    renderPresetMini(card, preset, selected);
    container.appendChild(card);
  }

  function renderAppearancePresets(appearance) {
    const container = appearanceEl("appearance-presets");
    if (!container) return;
    container.replaceChildren();
    appearanceBuiltInPresets.forEach((preset) => {
      renderAppearancePresetCard(container, preset, appearance, false);
    });
  }

  function activeAppearancePresetId(appearance) {
    if (appearanceBuiltInPresetIds.has(appearance.activeThemeId)) {
      return appearance.activeThemeId;
    }
    const activeCustom = appearance.customThemes.find((theme) => theme.id === appearance.activeThemeId);
    if (appearanceBuiltInPresetIds.has(activeCustom?.basePresetId)) {
      return activeCustom.basePresetId;
    }
    return activeCustom?.scheme === "light" ? "light" : "dark";
  }

  function appearanceColorControlIntensity(control, appearance) {
    return Math.round(clampNumber(appearance?.tokens?.[control?.intensityToken], 0, 100, 100));
  }

  function applyAppearanceColorControlValue(control, color, { persist = false } = {}) {
    const parsed = parseHexColorInput(color);
    if (!parsed) return;
    if (control?.target === "token" && control.token) {
      applyAppearanceUpdate({ tokens: { [control.token]: parsed } }, { persist });
      return;
    }
    applyAppearanceUpdate({ accentColor: parsed }, { persist });
  }

  function applyAppearanceColorControlIntensity(control, value, { persist = false, render = false } = {}) {
    if (!control?.intensityToken) return;
    const intensity = Math.round(clampNumber(value, 0, 100, 100));
    applyAppearanceUpdate({ tokens: { [control.intensityToken]: String(intensity) } }, { persist, render });
  }

  return {
    appearanceEl,
    currentAppearance,
    setAppearanceState,
    syncRange,
    appendSvgIcon,
    renderAppearancePresets,
    appearanceColorControlIntensity,
    applyAppearanceColorControlValue,
    applyAppearanceColorControlIntensity,
  };
}

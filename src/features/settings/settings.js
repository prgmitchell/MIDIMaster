import {
  closeOpenDropdowns,
  renderLabelWithBadges,
} from "../ui/dropdown_badges.js";
import {
  createSelectDropdownShell,
  renderNativeSelectDropdown,
} from "../ui/dropdown_select.js";
import {
  appearanceBackgroundGlowPatch,
  appearanceBackgroundGlowValue,
  applyAppearancePatch,
  applyBuiltInPreset,
  applyAppearanceToDocument,
  appearanceFromLegacyTheme,
  defaultAppearanceSettings,
  getBuiltInAppearancePresets,
  normalizeAppearanceSettings,
  resolveAppearance,
  toBackendAppearanceSettings,
} from "../../app/appearance.js";
import {
  MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
  normalizeMidiDeviceInventoryConsent,
  normalizeMidiDeviceInventorySettings,
} from "../../app/midi_device_inventory.js";

export function createSettingsFeature({
  invoke,
  listen,
  dom,
  i18n,
  getOsdSettings,
  setOsdSettings,
  getMonitorOptions,
  setMonitorOptions,
  getAppSettings,
  setAppSettings,
  applyAppearance,
  onUpdateAvailableClick,
  onMidiDeviceInventoryConsentChanged,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createSettingsFeature: invoke is required");
  }
  const d = (dom && typeof dom === "object") ? dom : {};
  const t = (key, params = {}) => (i18n && typeof i18n.t === "function") ? i18n.t(key, params) : String(key || "");
  const applyTranslations = () => {
    if (i18n && typeof i18n.applyTranslations === "function") {
      i18n.applyTranslations(d.settingsPanel || document);
    }
  };
  let monitorDropdownEl = null;
  let monitorMenuEl = null;
  let monitorDisplayEl = null;
  let monitorDocClickBound = false;
  let settingsDocClickBound = false;
  const settingsSelectDropdowns = new Map();
  let updaterUnlisten = null;
  let settingsNavIndicatorRaf = 0;
  let osdAppearanceRaf = 0;
  let osdPreviewResizeObserver = null;
  const appearanceColorPickerState = {
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
  const defaultSettingsSection = "startup";
  const defaultOsdAppearance = {
    style: "midnight",
    opacity: 0.96,
    scale: 1,
  };
  const defaultOsdAnchor = "top-right";
  const osdStyles = new Set(["midnight", "glass", "neon", "studio"]);
  const osdAnchors = new Set([
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
  ]);
  const languageOptions = Array.isArray(i18n?.supportedLocales) ? i18n.supportedLocales : [
    { code: "en", label: "English" },
  ];
  const accentSwatches = [
    "#5aa7ff",
    "#2f78d4",
    "#8b6dff",
    "#7c3aed",
    "#24c8d6",
    "#14b8a6",
    "#69c95a",
    "#22c55e",
    "#f0a12d",
    "#f97316",
    "#f25c61",
    "#dc2626",
    "#d44aa4",
    "#ec4899",
  ];
  const colorPickerSwatches = [
    ...accentSwatches,
    "#ffffff",
    "#d8dee9",
    "#7b8794",
    "#111820",
  ];
  const appearanceColorControls = [
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
  ];
  const appearanceBuiltInPresets = getBuiltInAppearancePresets();
  const appearanceBuiltInPresetIds = new Set(appearanceBuiltInPresets.map((preset) => preset.id));
  const updateState = {
    currentVersion: "-",
    latestVersion: "-",
    available: false,
    checking: false,
    downloading: false,
    hasChecked: false,
    body: "",
  };
  let updateCheckPromise = null;

  function setTextContent(target, text, selector = null) {
    const value = String(text ?? "");
    if (!target) return;
    const node = selector ? target.querySelector(selector) : null;
    if (node) {
      node.textContent = value;
      return;
    }
    target.textContent = value;
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function normalizeOsdStyle(style) {
    const value = String(style || defaultOsdAppearance.style).trim().toLowerCase();
    return osdStyles.has(value) ? value : defaultOsdAppearance.style;
  }

  function normalizeOsdAnchor(anchor) {
    const value = String(anchor || defaultOsdAnchor).trim().toLowerCase();
    return osdAnchors.has(value) ? value : defaultOsdAnchor;
  }

  function normalizeOsdAppearance(settings = {}) {
    return {
      style: normalizeOsdStyle(settings.style),
      opacity: clampNumber(settings.opacity, 0.35, 1, defaultOsdAppearance.opacity),
      scale: clampNumber(settings.scale, 0.75, 1.5, defaultOsdAppearance.scale),
    };
  }

  function sliderFillPercent(inputEl, value) {
    if (!inputEl) return 0;
    const min = Number(inputEl.min || 0);
    const max = Number(inputEl.max || 100);
    const range = max - min;
    if (!Number.isFinite(min) || !Number.isFinite(max) || range <= 0) return 0;
    return Math.min(100, Math.max(0, ((Number(value) - min) / range) * 100));
  }

  function appearanceEl(id) {
    return d.settingsPanel?.querySelector?.(`#${id}`) || null;
  }

  function currentAppearance() {
    const settings = (typeof getAppSettings === "function") ? (getAppSettings() || {}) : {};
    const source = settings.appearance && typeof settings.appearance === "object"
      ? settings.appearance
      : appearanceFromLegacyTheme(settings.ui_theme ?? settings.uiTheme);
    return normalizeAppearanceSettings(source);
  }

  function setAppearanceState(appearance, { apply = true } = {}) {
    const normalized = normalizeAppearanceSettings(appearance);
    const current = (typeof getAppSettings === "function") ? (getAppSettings() || {}) : {};
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
      appendSvgIcon(deleteButton, [
        "M3 6h18",
        "M8 6V4h8v2",
        "M6 6l1 15h10l1-15",
        "M10 11v6",
        "M14 11v6",
      ]);
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

  function colorInputValue(value, fallback = "#000000") {
    const raw = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : fallback;
  }

  function findAppearanceColorControl(target = "accent", token = "") {
    const normalizedTarget = target === "token" ? "token" : "accent";
    const normalizedToken = normalizedTarget === "token" ? String(token || "") : "";
    return appearanceColorControls.find((control) => (
      control.target === normalizedTarget && String(control.token || "") === normalizedToken
    )) || appearanceColorControls[0];
  }

  function appearanceColorControlValue(control, appearance, resolved = null) {
    if (control?.target === "token") {
      const resolvedAppearance = resolved || resolveAppearance(appearance, { matchMediaSource: window });
      return colorInputValue(appearance?.tokens?.[control.token], colorInputValue(resolvedAppearance.tokens[control.token]));
    }
    return colorInputValue(appearance?.accentColor, "#5aa7ff");
  }

  function findAppearanceIntensityControl(intensityToken = "") {
    const normalizedToken = String(intensityToken || "");
    return appearanceColorControls.find((control) => control.intensityToken === normalizedToken) || null;
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

  function parseHexColorInput(value) {
    const raw = String(value || "").trim().replace(/^#?/, "#");
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
    const short = raw.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (!short) return "";
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  }

  function hexToRgbColor(hex) {
    const normalized = colorInputValue(hex).slice(1);
    return {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16),
    };
  }

  function rgbToHexColor({ r, g, b }) {
    return `#${[r, g, b].map((part) => (
      Math.round(Math.min(255, Math.max(0, part))).toString(16).padStart(2, "0")
    )).join("")}`;
  }

  function rgbToHsvColor({ r, g, b }) {
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    let hue = 0;
    if (delta > 0) {
      if (max === red) {
        hue = 60 * (((green - blue) / delta) % 6);
      } else if (max === green) {
        hue = 60 * (((blue - red) / delta) + 2);
      } else {
        hue = 60 * (((red - green) / delta) + 4);
      }
    }
    if (hue < 0) hue += 360;
    return {
      h: hue,
      s: max === 0 ? 0 : delta / max,
      v: max,
    };
  }

  function hsvToRgbColor({ h, s, v }) {
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

  function setAppearanceColorPickerFromHex(color) {
    const value = colorInputValue(color, appearanceColorPickerState.color);
    const hsv = rgbToHsvColor(hexToRgbColor(value));
    appearanceColorPickerState.color = value;
    appearanceColorPickerState.hue = hsv.h;
    appearanceColorPickerState.saturation = hsv.s;
    appearanceColorPickerState.value = hsv.v;
  }

  function appearanceColorPickerPatch() {
    if (appearanceColorPickerState.target === "token" && appearanceColorPickerState.token) {
      return { tokens: { [appearanceColorPickerState.token]: appearanceColorPickerState.color } };
    }
    return { accentColor: appearanceColorPickerState.color };
  }

  function syncAppearanceColorPickerAnchor() {
    const { anchor, color, target, name } = appearanceColorPickerState;
    if (!anchor) return;
    if (target === "token") {
      anchor.style.setProperty("--theme-color", color);
      anchor.setAttribute("aria-label", t("settings.appearance.themeColorValue", { name, color }));
    } else {
      anchor.style.setProperty("--picker-color", color);
      anchor.style.setProperty("--theme-color", color);
      anchor.setAttribute("aria-label", t("settings.appearance.accentColorValue", { color }));
    }
  }

  function applyAppearanceColorPickerValue({ persist = false, render = false } = {}) {
    syncAppearanceColorPickerAnchor();
    applyAppearanceUpdate(appearanceColorPickerPatch(), { persist, render });
  }

  function syncAppearanceColorPickerUi({ syncHex = true } = {}) {
    const popover = appearanceEl("appearance-color-popover");
    if (!popover) return;
    const color = appearanceColorPickerState.color;
    popover.style.setProperty("--picker-color", color);
    popover.style.setProperty("--picker-hue", Math.round(appearanceColorPickerState.hue));
    const handle = popover.querySelector(".appearance-color-field-handle");
    if (handle) {
      handle.style.left = `${appearanceColorPickerState.saturation * 100}%`;
      handle.style.top = `${(1 - appearanceColorPickerState.value) * 100}%`;
    }
    const hueInput = appearanceEl("appearance-color-hue");
    if (hueInput) hueInput.value = String(Math.round(appearanceColorPickerState.hue));
    const hexInput = appearanceEl("appearance-color-hex");
    if (hexInput && (syncHex || document.activeElement !== hexInput)) {
      hexInput.value = color;
    }
    const title = appearanceEl("appearance-color-popover-title");
    if (title) {
      title.textContent = appearanceColorPickerState.target === "token"
        ? appearanceColorPickerState.name
        : t("settings.appearance.customAccentColor");
    }
  }

  function renderColorPickerSwatches() {
    const container = appearanceEl("appearance-color-suggestions");
    if (!container || container.childElementCount > 0) return;
    colorPickerSwatches.forEach((color) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "appearance-picker-swatch";
      button.dataset.appearancePickerSwatch = color;
      button.style.setProperty("--swatch-color", color);
      button.setAttribute("aria-label", t("settings.appearance.colorValue", { color }));
      container.appendChild(button);
    });
  }

  function positionAppearanceColorPicker(anchor) {
    const popover = appearanceEl("appearance-color-popover");
    if (!popover || !anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const margin = 10;
    const width = popover.offsetWidth || 264;
    const height = popover.offsetHeight || 278;
    let left = anchorRect.left;
    let top = anchorRect.bottom + 8;
    if (top + height > window.innerHeight - margin) {
      top = anchorRect.top - height - 8;
    }
    left = Math.min(window.innerWidth - width - margin, Math.max(margin, left));
    top = Math.min(window.innerHeight - height - margin, Math.max(margin, top));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function openAppearanceColorPicker({ target = "accent", token = "", name = "", color = "#5aa7ff", anchor = null } = {}) {
    const popover = appearanceEl("appearance-color-popover");
    if (!popover) return;
    appearanceColorPickerState.open = true;
    appearanceColorPickerState.target = target;
    appearanceColorPickerState.token = token;
    appearanceColorPickerState.name = name;
    appearanceColorPickerState.anchor = anchor;
    setAppearanceColorPickerFromHex(color);
    popover.classList.remove("hidden");
    renderColorPickerSwatches();
    syncAppearanceColorPickerUi();
    positionAppearanceColorPicker(anchor);
  }

  function closeAppearanceColorPicker() {
    const popover = appearanceEl("appearance-color-popover");
    if (!popover) return;
    appearanceColorPickerState.open = false;
    appearanceColorPickerState.dragging = false;
    appearanceColorPickerState.anchor = null;
    popover.classList.add("hidden");
  }

  function setAppearanceColorPickerHsv(patch, { persist = false } = {}) {
    const next = {
      h: patch.h ?? appearanceColorPickerState.hue,
      s: patch.s ?? appearanceColorPickerState.saturation,
      v: patch.v ?? appearanceColorPickerState.value,
    };
    appearanceColorPickerState.hue = ((Number(next.h) % 360) + 360) % 360;
    appearanceColorPickerState.saturation = Math.min(1, Math.max(0, Number(next.s) || 0));
    appearanceColorPickerState.value = Math.min(1, Math.max(0, Number(next.v) || 0));
    appearanceColorPickerState.color = rgbToHexColor(hsvToRgbColor({
      h: appearanceColorPickerState.hue,
      s: appearanceColorPickerState.saturation,
      v: appearanceColorPickerState.value,
    }));
    syncAppearanceColorPickerUi();
    applyAppearanceColorPickerValue({ persist, render: false });
  }

  function updateAppearanceColorPickerFromField(event, { persist = false } = {}) {
    const field = appearanceEl("appearance-color-field");
    const rect = field?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const saturation = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const value = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    setAppearanceColorPickerHsv({ s: saturation, v: value }, { persist });
  }

  function setAppearanceColorPickerHex(color, { persist = false, syncHex = true } = {}) {
    const parsed = parseHexColorInput(color);
    if (!parsed) return false;
    setAppearanceColorPickerFromHex(parsed);
    syncAppearanceColorPickerUi({ syncHex });
    applyAppearanceColorPickerValue({ persist, render: false });
    return true;
  }

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
      appendSvgIcon(edit, [
        "M12 20h9",
        "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
      ]);
      header.appendChild(edit);
      card.appendChild(header);

      const swatches = document.createElement("div");
      swatches.className = "appearance-token-swatches";
      const presetSwatches = control.swatches || accentSwatches.slice(0, 6);
      const hasCurrentSwatch = presetSwatches.some((color) => color.toLowerCase() === value.toLowerCase());
      const displaySwatches = hasCurrentSwatch
        ? presetSwatches
        : [value, ...presetSwatches.filter((color) => color.toLowerCase() !== value.toLowerCase())].slice(0, 6);
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
    const appearance = setAppearanceState(appearanceOverride || currentAppearance(), { apply: Boolean(appearanceOverride) });
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
    const next = current.activeThemeId === themeId
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

  function applyOsdAppearanceAttributes(appearance) {
    const previewCard = d.osdPositionPicker?.querySelector(".settings-osd-preview-card");
    const previewScreen = d.osdPositionPicker?.querySelector(".settings-osd-preview-screen");
    const roots = [
      document.body,
      d.settingsPanel,
      d.osdPositionPicker,
      d.osdPositionPicker?.querySelector(".settings-osd-preview"),
    ].filter(Boolean);
    roots.forEach((root) => {
      root.dataset.osdStyle = appearance.style;
      root.style.setProperty("--osd-opacity", String(appearance.opacity));
      root.style.setProperty("--osd-scale", String(appearance.scale));
    });
    if (previewCard) {
      previewCard.style.opacity = String(appearance.opacity);
      previewCard.style.setProperty("--osd-scale", String(appearance.scale));
      const screenRect = previewScreen?.getBoundingClientRect?.();
      const cardWidth = 154;
      const cardHeight = 54;
      const hasMeasuredScreen = Boolean(screenRect && screenRect.width > 0 && screenRect.height > 0);
      const maxPreviewScale = hasMeasuredScreen
        ? Math.min(
            appearance.scale,
            Math.max(0.65, ((screenRect.width / 3) - 12) / cardWidth),
            Math.max(0.65, ((screenRect.height / 3) - 12) / cardHeight),
          )
        : appearance.scale;
      previewCard.style.setProperty("--osd-preview-scale", String(Math.max(0.65, maxPreviewScale)));
    }
  }

  function syncOsdAppearanceUi(settings = {}) {
    const appearance = normalizeOsdAppearance(settings);
    if (typeof setOsdSettings === "function") {
      const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
      setOsdSettings({ ...current, ...(settings || {}), ...appearance });
    }
    applyOsdAppearanceAttributes(appearance);
    if (d.osdStyleSelect) {
      d.osdStyleSelect.value = appearance.style;
      d.osdStyleSelect.classList.add("hidden");
      d.osdStyleSelect.parentElement?.classList.add("has-segmented-style");
      d.osdStyleSelect.parentElement?.querySelectorAll("[data-osd-style-option]").forEach((button) => {
        const selected = button.dataset.osdStyleOption === appearance.style;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      });
    }
    if (d.osdTransparencyInput) {
      const transparency = Math.round(appearance.opacity * 100);
      d.osdTransparencyInput.value = String(transparency);
      d.osdTransparencyInput.style.setProperty("--range-fill", `${sliderFillPercent(d.osdTransparencyInput, transparency)}%`);
      if (d.osdTransparencyValue) {
        d.osdTransparencyValue.textContent = `${transparency}%`;
      }
    }
    if (d.osdScaleInput) {
      const scale = Math.round(appearance.scale * 100);
      d.osdScaleInput.value = String(scale);
      d.osdScaleInput.style.setProperty("--range-fill", `${sliderFillPercent(d.osdScaleInput, scale)}%`);
      if (d.osdScaleValue) {
        d.osdScaleValue.textContent = `${scale}%`;
      }
    }
  }

  function renderSidebarVersion() {
    if (!d.sidebarAppVersion) return;
    const currentVersion = String(updateState.currentVersion || "").trim();
    d.sidebarAppVersion.textContent = currentVersion ? `v${currentVersion}` : "v-";
  }

  function renderAutoCheckButton() {
    if (!d.autoCheckUpdatesButton) return;
    const enabled = (typeof getAppSettings === "function")
      ? ((getAppSettings() || {}).autoCheckUpdates !== false)
      : true;
    d.autoCheckUpdatesButton.checked = enabled;
  }

  function syncMidiDeviceInventoryToggle(settings = null) {
    if (!d.midiDeviceInventoryConsentToggle) return;
    const current = settings || ((typeof getAppSettings === "function") ? (getAppSettings() || {}) : {});
    const inventory = normalizeMidiDeviceInventorySettings(current);
    d.midiDeviceInventoryConsentToggle.checked = inventory.consent === "enabled"
      && inventory.noticeVersion >= MIDI_DEVICE_INVENTORY_NOTICE_VERSION;
  }

  function formatUpdaterError(error) {
    const message = String(error || t("settings.updateCheckFailed"));
    const normalized = message.toLowerCase();
    if (
      normalized.includes("valid release json")
      || normalized.includes("latest.json")
      || normalized.includes("404")
    ) {
      return t("settings.updateMetadataMissing");
    }
    if (normalized.includes("network") || normalized.includes("timeout")) {
      return t("settings.updateNetworkError");
    }
    return message;
  }

  function setUpdateStatus(message, kind = "") {
    if (!d.settingsUpdateStatus) return;
    d.settingsUpdateStatus.querySelector(".settings-status-text")?.removeAttribute("data-i18n");
    setTextContent(d.settingsUpdateStatus, String(message || ""), ".settings-status-text");
    d.settingsUpdateStatus.classList.remove("error", "success");
    if (kind === "error" || kind === "success") {
      d.settingsUpdateStatus.classList.add(kind);
    }
  }

  function setStaticUpdateStatus(key, kind = "") {
    if (!d.settingsUpdateStatus) return;
    const textEl = d.settingsUpdateStatus.querySelector(".settings-status-text");
    if (textEl) {
      textEl.setAttribute("data-i18n", key);
    }
    setTextContent(d.settingsUpdateStatus, t(key), ".settings-status-text");
    d.settingsUpdateStatus.classList.remove("error", "success");
    if (kind === "error" || kind === "success") {
      d.settingsUpdateStatus.classList.add(kind);
    }
  }

  function renderIdleUpdateStatus() {
    if (updateState.checking || updateState.downloading || updateState.hasChecked || updateState.available) return;
    setStaticUpdateStatus(
      shouldAutoCheckUpdates() ? "settings.noUpdateCheckYet" : "settings.autoCheckUpdatesOff",
    );
  }

  function renderUpdateUi() {
    if (d.updateCurrentVersion) {
      d.updateCurrentVersion.textContent = updateState.currentVersion || "-";
    }
    if (d.updateLatestVersion) {
      d.updateLatestVersion.textContent = updateState.latestVersion || "-";
    }
    if (d.checkForUpdatesButton) {
      if (updateState.downloading) {
        setTextContent(d.checkForUpdatesButton, t("settings.downloadingUpdate"), ".settings-button-label");
      } else if (updateState.checking) {
        setTextContent(d.checkForUpdatesButton, t("settings.checkingUpdates"), ".settings-button-label");
      } else if (updateState.available) {
        setTextContent(d.checkForUpdatesButton, t("settings.downloadAndInstall"), ".settings-button-label");
      } else {
        setTextContent(d.checkForUpdatesButton, t("settings.checkForUpdates"), ".settings-button-label");
      }
      d.checkForUpdatesButton.disabled = updateState.checking || updateState.downloading;
    }
    renderSidebarVersion();
    if (d.topbarUpdateButton) {
      const showTopbarUpdate = updateState.available && !updateState.downloading;
      d.topbarUpdateButton.classList.toggle("hidden", !showTopbarUpdate);
      d.topbarUpdateButton.closest(".topbar")?.classList.toggle("has-update", showTopbarUpdate);
      d.topbarUpdateButton.disabled = updateState.checking || updateState.downloading;
      d.topbarUpdateButton.setAttribute("aria-hidden", showTopbarUpdate ? "false" : "true");
      const label = updateState.latestVersion && updateState.latestVersion !== "-"
        ? t("topbar.updateAvailableVersion", { version: updateState.latestVersion })
        : t("topbar.updateAvailable");
      d.topbarUpdateButton.setAttribute("aria-label", label);
      d.topbarUpdateButton.setAttribute("title", label);
      d.topbarUpdateButton.title = label;
    }
    renderAutoCheckButton();
    renderIdleUpdateStatus();
  }

  function normalizeUpdateInfo(updateInfo) {
    const info = (updateInfo && typeof updateInfo === "object") ? updateInfo : {};
    const available = Boolean(info.available);
    const currentVersion = String(info.current_version ?? info.currentVersion ?? updateState.currentVersion ?? "-");
    const latestVersionRaw = info.version ?? null;
    const latestVersion = latestVersionRaw ? String(latestVersionRaw) : currentVersion;
    const body = info.body ? String(info.body) : "";
    return { available, currentVersion, latestVersion, body };
  }

  function shouldAutoCheckUpdates() {
    return (typeof getAppSettings === "function")
      ? ((getAppSettings() || {}).autoCheckUpdates !== false)
      : true;
  }

  function ensureAutoUpdateCheck() {
    if (!shouldAutoCheckUpdates() || updateState.hasChecked) {
      return updateCheckPromise || Promise.resolve(null);
    }
    return checkForUpdates({ silent: true });
  }

  async function checkForUpdates({ silent = false } = {}) {
    if (updateCheckPromise) {
      return updateCheckPromise;
    }
    updateState.checking = true;
    updateState.hasChecked = true;
    renderUpdateUi();
    setUpdateStatus(t("settings.checkingUpdates"));
    updateCheckPromise = (async () => {
      try {
        const updateInfo = await invoke("check_for_updates");
        const normalized = normalizeUpdateInfo(updateInfo);
        updateState.currentVersion = normalized.currentVersion;
        updateState.latestVersion = normalized.latestVersion;
        updateState.available = normalized.available;
        updateState.body = normalized.body;
        if (normalized.available) {
          setUpdateStatus(
            normalized.body
              ? t("settings.updateAvailableNotes", { version: normalized.latestVersion })
              : t("settings.updateAvailable", { version: normalized.latestVersion }),
            "success",
          );
        } else {
          setUpdateStatus(t("settings.upToDate"), "success");
        }
        return normalized;
      } catch (error) {
        updateState.available = false;
        updateState.body = "";
        console.error("Updater check failed:", error);
        setUpdateStatus(formatUpdaterError(error), "error");
        return null;
      } finally {
        updateState.checking = false;
        renderUpdateUi();
        updateCheckPromise = null;
      }
    })();
    return updateCheckPromise;
  }

  async function installAvailableUpdate() {
    updateState.downloading = true;
    renderUpdateUi();
    setUpdateStatus(t("settings.downloadingUpdate"));
    try {
      await invoke("download_and_install_update");
    } catch (error) {
      updateState.available = false;
      updateState.body = "";
      console.error("Updater install failed:", error);
      setUpdateStatus(String(error || t("settings.updateInstallFailed")), "error");
    } finally {
      updateState.downloading = false;
      renderUpdateUi();
    }
  }

  async function bindUpdaterEvents() {
    if (updaterUnlisten || typeof listen !== "function") return;
    updaterUnlisten = await listen("updater_status", (event) => {
      const payload = (event && typeof event.payload === "object") ? event.payload : {};
      const phase = String(payload.phase || "").trim();
      if (payload.current_version) {
        updateState.currentVersion = String(payload.current_version);
      }
      if (payload.version) {
        updateState.latestVersion = String(payload.version);
      }
      if (phase === "checking") {
        updateState.checking = true;
        setUpdateStatus(t("settings.checkingUpdates"));
      } else if (phase === "available") {
        updateState.available = true;
        setUpdateStatus(t("settings.updateAvailable", { version: updateState.latestVersion }), "success");
      } else if (phase === "no_update") {
        updateState.available = false;
        updateState.body = "";
        setUpdateStatus(t("settings.upToDate"), "success");
      } else if (phase === "downloading") {
        updateState.downloading = true;
        const downloaded = Number(payload.downloaded || 0);
        const total = Number(payload.content_length || 0);
        if (total > 0) {
          const pct = Math.min(100, Math.round((downloaded / total) * 100));
          setUpdateStatus(t("settings.downloadingUpdatePercent", { percent: pct }));
        } else {
          setUpdateStatus(t("settings.downloadingUpdate"));
        }
      } else if (phase === "downloaded") {
        setUpdateStatus(t("settings.updateDownloadedInstalling"));
      } else if (phase === "installed") {
        updateState.available = false;
        updateState.body = "";
        setUpdateStatus(t("settings.updateInstalledRestarting"), "success");
      } else if (phase === "failed") {
        updateState.available = false;
        updateState.checking = false;
        updateState.downloading = false;
        if (payload.message) {
          console.error("Updater event failure:", payload.message);
        }
        setUpdateStatus(formatUpdaterError(payload.message || t("settings.updateInstallFailed")), "error");
      }
      if (phase === "available" || phase === "no_update" || phase === "installed") {
        updateState.checking = false;
      }
      if (phase === "installed") {
        updateState.downloading = false;
      }
      renderUpdateUi();
    });
  }

  function closeSettingsPanel() {
    if (!d.settingsPanel) return;
    d.settingsPanel.classList.add("hidden");
  }

  function getActiveSettingsSection() {
    if (!d.settingsPanel) return defaultSettingsSection;
    return d.settingsPanel.querySelector("[data-settings-section].active")?.dataset?.settingsSection
      || defaultSettingsSection;
  }

  function openSettingsPanel() {
    if (!d.settingsPanel) return;
    d.settingsPanel.classList.remove("hidden");
    activateSettingsSection(getActiveSettingsSection());
    scheduleSettingsNavIndicatorSync({ animate: false });
  }

  function activateSettingsSection(sectionName) {
    if (!d.settingsPanel) return;
    const nextSection = String(sectionName || defaultSettingsSection);
    const navItems = Array.from(d.settingsPanel.querySelectorAll("[data-settings-section]"));
    const panels = Array.from(d.settingsPanel.querySelectorAll("[data-settings-panel]"));
    const hasPanel = panels.some((panel) => panel.dataset.settingsPanel === nextSection);
    const activeSection = hasPanel ? nextSection : defaultSettingsSection;

    navItems.forEach((item) => {
      const active = item.dataset.settingsSection === activeSection;
      item.classList.toggle("active", active);
      if (active) {
        item.setAttribute("aria-current", "page");
      } else {
        item.removeAttribute("aria-current");
      }
    });
    panels.forEach((panel) => {
      const active = panel.dataset.settingsPanel === activeSection;
      panel.classList.toggle("active", active);
      panel.classList.toggle("hidden", !active);
    });
    if (activeSection === "osd") {
      syncOsdAppearanceControls();
    } else if (activeSection === "appearance") {
      syncAppearanceControls();
    }
    scheduleSettingsNavIndicatorSync({ animate: true });
  }

  function syncSettingsNavIndicator({ animate = true } = {}) {
    if (!d.settingsPanel) return;
    const sidebar = d.settingsPanel.querySelector(".settings-sidebar");
    const indicator = sidebar?.querySelector(".settings-nav-indicator");
    const active = sidebar?.querySelector(".settings-nav-item.active");
    if (!indicator || !active || !sidebar) {
      if (indicator) indicator.style.opacity = "0";
      return;
    }
    const sidebarRect = sidebar.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    indicator.classList.toggle("is-ready", Boolean(animate));
    indicator.style.width = `${activeRect.width}px`;
    indicator.style.height = `${activeRect.height}px`;
    indicator.style.transform = `translate(${activeRect.left - sidebarRect.left}px, ${activeRect.top - sidebarRect.top}px)`;
    indicator.style.opacity = "1";
    if (!animate) {
      requestAnimationFrame(() => {
        indicator.classList.add("is-ready");
      });
    }
  }

  function scheduleSettingsNavIndicatorSync({ animate = true } = {}) {
    if (settingsNavIndicatorRaf) {
      cancelAnimationFrame(settingsNavIndicatorRaf);
    }
    settingsNavIndicatorRaf = requestAnimationFrame(() => {
      settingsNavIndicatorRaf = 0;
      syncSettingsNavIndicator({ animate });
    });
  }

  function scheduleOsdAppearanceSync() {
    if (osdAppearanceRaf) {
      cancelAnimationFrame(osdAppearanceRaf);
    }
    osdAppearanceRaf = requestAnimationFrame(() => {
      osdAppearanceRaf = 0;
      syncOsdAppearanceControls();
    });
  }

  function updateOsdPositionSelection(anchor) {
    if (!d.osdPositionPicker) return;
    const selectedAnchor = normalizeOsdAnchor(anchor);
    d.osdPositionPicker.dataset.anchor = selectedAnchor;
    d.osdPositionPicker.querySelectorAll(".osd-position-dot").forEach((dot) => {
      dot.classList.toggle("selected", dot.dataset.anchor === selectedAnchor);
    });
  }

  function syncOsdPositionUi(settings = {}) {
    const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
    const anchor = normalizeOsdAnchor(settings.anchor ?? current.anchor);
    if (typeof setOsdSettings === "function") {
      setOsdSettings({ ...current, ...(settings || {}), anchor });
    }
    updateOsdPositionSelection(anchor);
    document.body.setAttribute("data-anchor", anchor);
  }

  function syncOsdSettingsUi(settings = {}) {
    const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
    const merged = {
      ...current,
      ...(settings || {}),
      anchor: normalizeOsdAnchor(settings.anchor ?? current.anchor),
    };

    if (d.osdEnabledToggle) {
      if (d.osdEnabledToggle.type === "checkbox") {
        d.osdEnabledToggle.checked = Boolean(merged.enabled);
        d.osdEnabledToggle.classList.remove("hidden");
      } else {
        d.osdEnabledToggle.value = merged.enabled ? "enabled" : "disabled";
        renderSettingsSelectDropdown(d.osdEnabledToggle);
      }
    }
    if (d.osdMonitorSelect) {
      d.osdMonitorSelect.value = String(merged.monitorIndex ?? 0);
    }

    syncOsdAppearanceUi(merged);
    syncOsdPositionUi(merged);
  }

  async function applyOsdSettings(nextSettings) {
    const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
    const requestedEnabledChange = Boolean(
      nextSettings
      && Object.prototype.hasOwnProperty.call(nextSettings, "enabled")
    );
    const shouldPreviewAfterSave = requestedEnabledChange
      && !Boolean(current.enabled)
      && Boolean(nextSettings.enabled);
    const merged = {
      ...current,
      ...(nextSettings || {}),
      anchor: normalizeOsdAnchor(nextSettings?.anchor ?? current.anchor),
    };
    if (typeof setOsdSettings === "function") {
      setOsdSettings(merged);
    }

    syncOsdSettingsUi(merged);

    try {
      const appearance = normalizeOsdAppearance(merged);
      await invoke("update_osd_settings", {
        enabled: merged.enabled,
        monitorIndex: merged.monitorIndex,
        monitorName: merged.monitorName || null,
        monitorId: merged.monitorId || null,
        anchor: merged.anchor,
        style: appearance.style,
        opacity: appearance.opacity,
        scale: appearance.scale,
      });
      if (shouldPreviewAfterSave) {
        await invoke("preview_osd");
      }
    } catch (error) {
      console.error("Failed to update OSD settings", error);
    }
  }

  async function loadOsdSettings() {
    try {
      const settings = await invoke("get_osd_settings");
      if (settings) {
        const next = {
          enabled: Boolean(settings.enabled),
          monitorIndex: Number(settings.monitor_index ?? settings.monitorIndex ?? 0),
          monitorName: settings.monitor_name ?? settings.monitorName ?? null,
          monitorId: settings.monitor_id ?? settings.monitorId ?? null,
          anchor: normalizeOsdAnchor(settings.anchor),
          style: normalizeOsdStyle(settings.style),
          opacity: clampNumber(settings.opacity, 0.35, 1, defaultOsdAppearance.opacity),
          scale: clampNumber(settings.scale, 0.75, 1.5, defaultOsdAppearance.scale),
        };
        syncOsdSettingsUi(next);
      }
    } catch (error) {
      console.error("Failed to load OSD settings", error);
    }
  }

  function formatMonitorName(name) {
    if (!name) return "Monitor";
    return String(name).trim().replace(/^\\\\\.\\/, "");
  }

  function formatMonitorOptionLabel(monitor, index) {
    const base = formatMonitorName(monitor?.name) || `Monitor ${index + 1}`;
    return base;
  }

  function resolveEffectiveMonitor(monitors, currentSettings) {
    const list = Array.isArray(monitors) ? monitors : [];
    if (list.length === 0) return null;

    const requestedId = String(currentSettings?.monitorId || "").trim();
    if (requestedId) {
      const byId = list.find((monitor) => String(monitor?.stable_id || "").trim() === requestedId);
      if (byId) return byId;
    }

    return list.find((monitor) => Boolean(monitor?.is_primary)) || list[0];
  }

  function closeMonitorDropdown() {
    if (!monitorDropdownEl) return;
    closeOpenDropdowns({ except: null });
  }

  function ensureSettingsSelectDropdown(selectEl, { title = "Select" } = {}) {
    if (!selectEl) return null;

    const existing = settingsSelectDropdowns.get(selectEl);
    if (existing && existing.root?.isConnected) return existing;

    const entry = createSelectDropdownShell({
      selectEl,
      rootClass: "settings-select-dropdown",
      title,
    });
    if (!entry) return null;
    settingsSelectDropdowns.set(selectEl, entry);

    if (!settingsDocClickBound) {
      settingsDocClickBound = true;
      document.addEventListener("click", (event) => {
        const clickedInsideMonitor = Boolean(monitorDropdownEl && monitorDropdownEl.contains(event.target));
        if (clickedInsideMonitor) return;
        const clickedInsideAnySettingsDropdown = Array.from(settingsSelectDropdowns.values())
          .some((item) => item.root && item.root.contains(event.target));
        if (clickedInsideAnySettingsDropdown) return;
        closeOpenDropdowns({ except: null });
      });
    }

    return entry;
  }

  function renderSettingsSelectDropdown(selectEl) {
    if (!selectEl) return;
    const entry = ensureSettingsSelectDropdown(selectEl, { title: selectEl.title || selectEl.id || t("common.select") });
    if (!entry) return;
    selectEl.classList.add("hidden");
    selectEl.parentElement?.classList.add("has-custom-select");
    renderNativeSelectDropdown({
      entry,
      selectEl,
      fallbackText: t("common.select"),
      closeDropdowns: () => closeOpenDropdowns({ except: null }),
      formatOptionText: (opt) => opt.textContent || "",
      getOptionBadges: () => [],
      truncateMenuLabels: false,
      truncateDisplayLabel: true,
    });
  }

  function renderAllSettingsSelectDropdowns() {
    if (d.languageSelect) {
      renderSettingsSelectDropdown(d.languageSelect);
    }
  }

  function scheduleSettingsControlSync() {
    requestAnimationFrame(() => {
      renderAllSettingsSelectDropdowns();
      syncOsdAppearanceControls();
      syncAppearanceControls();
    });
  }

  function syncOsdAppearanceControls() {
    const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
    syncOsdSettingsUi(current);
  }

  function renderMonitorDisplay(option) {
    if (!monitorDisplayEl) return;
    renderLabelWithBadges(monitorDisplayEl, {
      text: option?.label || t("settings.monitor"),
      badges: option?.isPrimary ? [{ text: t("settings.primaryBadge"), kind: "neutral" }] : [],
      truncate: true,
    });
  }

  function ensureMonitorDropdown() {
    if (!d.osdMonitorSelect) return;

    if (monitorDropdownEl && monitorDropdownEl.isConnected) {
      return;
    }

    const entry = createSelectDropdownShell({
      selectEl: d.osdMonitorSelect,
      rootClass: "settings-monitor-dropdown",
      title: t("settings.monitor"),
    });
    if (!entry) return;
    monitorDropdownEl = entry.root;
    monitorMenuEl = entry.menu;
    monitorDisplayEl = entry.display;

    if (!monitorDocClickBound) {
      monitorDocClickBound = true;
      document.addEventListener("click", (event) => {
        if (!monitorDropdownEl) return;
        if (monitorDropdownEl.contains(event.target)) return;
        closeMonitorDropdown();
      });
    }
  }

  function renderMonitorDropdownOptions(monitors) {
    ensureMonitorDropdown();
    if (!monitorMenuEl || !d.osdMonitorSelect) return;
    const list = Array.isArray(monitors) ? monitors : [];
    renderNativeSelectDropdown({
      entry: { root: monitorDropdownEl, menu: monitorMenuEl, display: monitorDisplayEl },
      selectEl: d.osdMonitorSelect,
      fallbackText: t("settings.monitor"),
      closeDropdowns: closeMonitorDropdown,
      formatOptionText: (opt) => opt.textContent || "",
      getOptionBadges: (opt) => (opt.dataset.isPrimary === "true"
        ? [{ text: t("settings.primaryBadge"), kind: "neutral" }]
        : []),
      onOptionSelected: (opt) => {
        renderMonitorDisplay({
          value: String(opt.value || "0"),
          label: opt.textContent || t("settings.monitor"),
          isPrimary: opt.dataset.isPrimary === "true",
        });
      },
      truncateMenuLabels: false,
      truncateDisplayLabel: true,
    });

    if (list.length === 0) {
      renderMonitorDisplay({ value: "0", label: t("settings.monitor"), isPrimary: true });
    }
  }

  async function loadMonitorOptions() {
    let next = [];
    try {
      const monitors = await invoke("list_monitors");
      next = Array.isArray(monitors) ? monitors : [];
    } catch (error) {
      next = [];
      console.error("Failed to load monitors", error);
    }
    if (typeof setMonitorOptions === "function") {
      setMonitorOptions(next);
    }

    // Update dropdown if it exists
    if (d.osdMonitorSelect) {
      const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
      d.osdMonitorSelect.innerHTML = "";
      next.forEach((monitor, index) => {
        const option = document.createElement("option");
        option.value = String(monitor.index ?? index);
        option.dataset.rawName = monitor.name || "";
        option.dataset.stableId = monitor.stable_id || "";
        option.dataset.isPrimary = monitor.is_primary ? "true" : "false";
        option.textContent = formatMonitorOptionLabel(monitor, index);
        d.osdMonitorSelect.appendChild(option);
      });
      if (next.length === 0) {
        const option = document.createElement("option");
        option.value = "0";
        option.textContent = t("settings.primaryMonitor");
        d.osdMonitorSelect.appendChild(option);
        d.osdMonitorSelect.value = "0";
      } else {
        // Mirror backend monitor resolution: prefer stable_id match, else primary monitor.
        const effective = resolveEffectiveMonitor(next, current);
        const fallbackIndex = Math.max(0, Number(current.monitorIndex ?? 0));
        const effectiveValue = String(effective?.index ?? fallbackIndex);
        d.osdMonitorSelect.value = effectiveValue;

        if (typeof setOsdSettings === "function" && effective) {
          setOsdSettings({
            ...current,
            monitorIndex: Number(effectiveValue),
            monitorName: effective.name || null,
            monitorId: effective.stable_id || null,
          });
        }
      }
      renderMonitorDropdownOptions(next);
    }
  }

  function syncAppSettingsUI(nextSettings) {
    const current = (typeof getAppSettings === "function") ? (getAppSettings() || {}) : {};
    const merged = { ...current, ...(nextSettings || {}) };
    if (typeof setAppSettings === "function") {
      setAppSettings(merged);
    }
    if (d.startWithWindowsSelect) {
      d.startWithWindowsSelect.checked = Boolean(merged.startWithWindows);
    }
    if (d.startInTraySelect) {
      d.startInTraySelect.checked = Boolean(merged.startInTray);
    }
    if (d.minimizeToTraySelect) {
      d.minimizeToTraySelect.checked = Boolean(merged.minimizeToTray);
    }
    if (d.exitToTraySelect) {
      d.exitToTraySelect.checked = Boolean(merged.exitToTray);
    }
    if (d.languageSelect) {
      d.languageSelect.value = normalizeLanguage(merged.language);
      renderSettingsSelectDropdown(d.languageSelect);
    }
    syncMidiDeviceInventoryToggle(merged);
    renderUpdateUi();
  }

  function persistAppSettings() {
    const s = (typeof getAppSettings === "function") ? (getAppSettings() || {}) : {};
    return invoke("update_app_settings", {
      startWithWindows: Boolean(s.startWithWindows),
      startInTray: Boolean(s.startInTray),
      minimizeToTray: Boolean(s.minimizeToTray),
      exitToTray: Boolean(s.exitToTray),
      autoCheckUpdates: s.autoCheckUpdates !== false,
      language: normalizeLanguage(s.language),
    }).catch((error) => {
      console.error("Failed to update app settings", error);
    });
  }

  function normalizeLanguage(language) {
    const value = String(language || "en").trim();
    return languageOptions.some((option) => option.code === value) ? value : "en";
  }

  function populateLanguageSelect() {
    if (!d.languageSelect || d.languageSelect.options.length > 0) return;
    languageOptions.forEach((language) => {
      const option = document.createElement("option");
      option.value = language.code;
      option.textContent = language.label;
      d.languageSelect.appendChild(option);
    });
  }

  async function loadAppSettings() {
    try {
      const settings = await invoke("get_app_settings");
      if (settings) {
        const next = {
          startWithWindows: Boolean(settings.start_with_windows ?? settings.startWithWindows),
          startInTray: Boolean(settings.start_in_tray ?? settings.startInTray),
          minimizeToTray: Boolean(settings.minimize_to_tray ?? settings.minimizeToTray),
          exitToTray: Boolean(settings.exit_to_tray ?? settings.exitToTray),
          autoCheckUpdates: Boolean(settings.auto_check_updates ?? settings.autoCheckUpdates ?? true),
          language: normalizeLanguage(settings.language ?? settings.languageCode ?? "en"),
          midiDeviceInventoryConsent: normalizeMidiDeviceInventoryConsent(
            settings.midi_device_inventory_consent ?? settings.midiDeviceInventoryConsent,
          ),
          midiDeviceInventoryNoticeVersion: Number(
            settings.midi_device_inventory_notice_version
            ?? settings.midiDeviceInventoryNoticeVersion
            ?? 0,
          ),
          appearance: settings.appearance && typeof settings.appearance === "object"
            ? normalizeAppearanceSettings(settings.appearance)
            : appearanceFromLegacyTheme(settings.ui_theme ?? settings.uiTheme),
        };
        if (typeof setAppSettings === "function") {
          setAppSettings(next);
        }
        setAppearanceState(next.appearance);
        await i18n?.setLocale?.(next.language).catch((error) => {
          console.error("Failed to apply language setting", error);
        });
        applyTranslations();
      }
    } catch (error) {
      console.error("Failed to load app settings", error);
    }
  }

  function bindUi() {
    bindUpdaterEvents().catch(() => {});
    populateLanguageSelect();
    if (d.settingsPanel) {
      activateSettingsSection(defaultSettingsSection);
      window.addEventListener("resize", () => {
        scheduleSettingsNavIndicatorSync();
        scheduleOsdAppearanceSync();
      });
      if ("ResizeObserver" in window && d.osdPositionPicker && !osdPreviewResizeObserver) {
        osdPreviewResizeObserver = new ResizeObserver(scheduleOsdAppearanceSync);
        osdPreviewResizeObserver.observe(d.osdPositionPicker);
        const previewScreen = d.osdPositionPicker.querySelector(".settings-osd-preview-screen");
        if (previewScreen) {
          osdPreviewResizeObserver.observe(previewScreen);
        }
      }
      d.settingsPanel.addEventListener("click", (event) => {
        const sectionButton = event.target.closest("[data-settings-section]");
        if (sectionButton && d.settingsPanel.contains(sectionButton)) {
          activateSettingsSection(sectionButton.dataset.settingsSection);
          return;
        }
        const colorClose = event.target.closest("[data-appearance-color-close]");
        if (colorClose && d.settingsPanel.contains(colorClose)) {
          closeAppearanceColorPicker();
          return;
        }
        const pickerSwatch = event.target.closest("[data-appearance-picker-swatch]");
        if (pickerSwatch && d.settingsPanel.contains(pickerSwatch)) {
          setAppearanceColorPickerHex(pickerSwatch.dataset.appearancePickerSwatch, { persist: true });
          return;
        }
        const optionSwatch = event.target.closest("[data-appearance-option-swatch]");
        if (optionSwatch && d.settingsPanel.contains(optionSwatch)) {
          const control = findAppearanceColorControl(
            optionSwatch.dataset.appearanceColorRole,
            optionSwatch.dataset.appearanceToken,
          );
          closeAppearanceColorPicker();
          applyAppearanceColorControlValue(control, optionSwatch.dataset.appearanceOptionSwatch, { persist: true });
          return;
        }
        const colorTrigger = event.target.closest("[data-appearance-color-trigger]");
        if (colorTrigger && d.settingsPanel.contains(colorTrigger)) {
          const trigger = colorTrigger.dataset.appearanceColorTrigger;
          if (trigger === "token") {
            const token = colorTrigger.dataset.appearanceToken;
            const name = colorTrigger.dataset.appearanceColorName || "";
            const resolved = resolveAppearance(currentAppearance(), { matchMediaSource: window });
            openAppearanceColorPicker({
              target: "token",
              token,
              name,
              color: colorInputValue(resolved.tokens[token]),
              anchor: colorTrigger,
            });
          } else {
            openAppearanceColorPicker({
              target: "accent",
              name: t("settings.appearance.accentColor"),
              color: currentAppearance().accentColor,
              anchor: colorTrigger,
            });
          }
          return;
        }
        const deleteCustom = event.target.closest("[data-appearance-delete-custom]");
        if (deleteCustom && d.settingsPanel.contains(deleteCustom)) {
          deleteCustomAppearanceTheme(deleteCustom.dataset.appearanceDeleteCustom);
          return;
        }
        const appearancePreset = event.target.closest("[data-appearance-preset]");
        if (appearancePreset && d.settingsPanel.contains(appearancePreset)) {
          const presetId = appearancePreset.dataset.appearancePreset;
          const kind = appearancePreset.dataset.appearancePresetKind;
          const next = kind === "custom"
            ? selectCustomAppearanceTheme(presetId)
            : applyBuiltInPreset(currentAppearance(), presetId);
          closeAppearanceColorPicker();
          syncAppearanceControls(next);
          persistAppearanceSettings(next);
          return;
        }
        const styleButton = event.target.closest("[data-osd-style-option]");
        if (styleButton && d.settingsPanel.contains(styleButton) && d.osdStyleSelect) {
          d.osdStyleSelect.value = normalizeOsdStyle(styleButton.dataset.osdStyleOption);
          d.osdStyleSelect.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        if (d.settingsPanel.classList.contains("target-panel") && event.target === d.settingsPanel) {
          closeSettingsPanel();
        }
        const colorPopover = appearanceEl("appearance-color-popover");
        if (appearanceColorPickerState.open && colorPopover && !colorPopover.contains(event.target)) {
          closeAppearanceColorPicker();
        }
      });
      d.settingsPanel.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && appearanceColorPickerState.open) {
          closeAppearanceColorPicker();
          event.preventDefault();
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        const appearancePreset = event.target.closest("[data-appearance-preset]");
        if (!appearancePreset || !d.settingsPanel.contains(appearancePreset)) return;
        event.preventDefault();
        appearancePreset.click();
      });
      d.settingsPanel.addEventListener("input", (event) => {
        if (event.target === d.osdTransparencyInput) {
          const opacity = clampNumber(Number(d.osdTransparencyInput.value) / 100, 0.35, 1, defaultOsdAppearance.opacity);
          const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
          syncOsdAppearanceUi({ ...current, opacity });
          return;
        }
        if (event.target === d.osdScaleInput) {
          const scale = clampNumber(Number(d.osdScaleInput.value) / 100, 0.75, 1.5, defaultOsdAppearance.scale);
          const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
          syncOsdAppearanceUi({ ...current, scale });
          return;
        }
        if (event.target === appearanceEl("appearance-color-hue")) {
          setAppearanceColorPickerHsv({ h: Number(event.target.value) });
          return;
        }
        if (event.target === appearanceEl("appearance-color-hex")) {
          setAppearanceColorPickerHex(event.target.value, { syncHex: false });
          return;
        }
        if (event.target === appearanceEl("appearance-temperature")) {
          applyAppearanceUpdate({ colorTemperature: Number(event.target.value) });
          return;
        }
        if (event.target === appearanceEl("appearance-font-size")) {
          applyAppearanceUpdate({ fontSize: Number(event.target.value) });
          return;
        }
        if (event.target === appearanceEl("appearance-background-glow")) {
          applyAppearanceUpdate(appearanceBackgroundGlowPatch(event.target.value));
          return;
        }
        if (event.target === appearanceEl("appearance-surface-contrast")) {
          applyAppearanceUpdate({ surfaceContrast: Number(event.target.value) });
          return;
        }
        if (event.target === appearanceEl("appearance-icon-glow")) {
          applyAppearanceUpdate({ iconGlow: Number(event.target.value) });
          return;
        }
        const intensityInput = event.target.closest("[data-appearance-intensity-token]");
        if (intensityInput && d.settingsPanel.contains(intensityInput)) {
          const value = Math.round(clampNumber(intensityInput.value, 0, 100, 100));
          const control = findAppearanceIntensityControl(intensityInput.dataset.appearanceIntensityToken);
          const valueEl = intensityInput.parentElement?.querySelector(".appearance-token-intensity-value");
          intensityInput.style.setProperty("--range-fill", `${sliderFillPercent(intensityInput, value)}%`);
          if (valueEl) valueEl.textContent = `${value}%`;
          applyAppearanceColorControlIntensity(control, value);
        }
      });
      d.settingsPanel.addEventListener("change", (event) => {
        if (event.target === d.osdStyleSelect) {
          const style = normalizeOsdStyle(d.osdStyleSelect.value);
          const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
          syncOsdAppearanceUi({ ...current, style });
          applyOsdSettings({ style });
          return;
        }
        if (event.target === d.osdTransparencyInput) {
          applyOsdSettings({
            opacity: clampNumber(Number(d.osdTransparencyInput.value) / 100, 0.35, 1, defaultOsdAppearance.opacity),
          });
          return;
        }
        if (event.target === d.osdScaleInput) {
          applyOsdSettings({
            scale: clampNumber(Number(d.osdScaleInput.value) / 100, 0.75, 1.5, defaultOsdAppearance.scale),
          });
          return;
        }
        if (event.target === appearanceEl("appearance-color-hue")) {
          setAppearanceColorPickerHsv({ h: Number(event.target.value) }, { persist: true });
          return;
        }
        if (event.target === appearanceEl("appearance-color-hex")) {
          const updated = setAppearanceColorPickerHex(event.target.value, { persist: true });
          if (!updated) syncAppearanceColorPickerUi();
          return;
        }
        if (event.target === appearanceEl("appearance-temperature")) {
          applyAppearanceUpdate({ colorTemperature: Number(event.target.value) }, { persist: true });
          return;
        }
        if (event.target === appearanceEl("appearance-font-size")) {
          applyAppearanceUpdate({ fontSize: Number(event.target.value) }, { persist: true });
          return;
        }
        if (event.target === appearanceEl("appearance-background-glow")) {
          applyAppearanceUpdate(appearanceBackgroundGlowPatch(event.target.value), { persist: true });
          return;
        }
        if (event.target === appearanceEl("appearance-surface-contrast")) {
          applyAppearanceUpdate({ surfaceContrast: Number(event.target.value) }, { persist: true });
          return;
        }
        if (event.target === appearanceEl("appearance-icon-glow")) {
          applyAppearanceUpdate({ iconGlow: Number(event.target.value) }, { persist: true });
          return;
        }
        const intensityInput = event.target.closest("[data-appearance-intensity-token]");
        if (intensityInput && d.settingsPanel.contains(intensityInput)) {
          const value = Math.round(clampNumber(intensityInput.value, 0, 100, 100));
          const control = findAppearanceIntensityControl(intensityInput.dataset.appearanceIntensityToken);
          applyAppearanceColorControlIntensity(control, value, { persist: true, render: false });
          return;
        }
      });
      const colorField = appearanceEl("appearance-color-field");
      if (colorField) {
        colorField.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          appearanceColorPickerState.dragging = true;
          colorField.setPointerCapture?.(event.pointerId);
          updateAppearanceColorPickerFromField(event);
        });
        colorField.addEventListener("pointermove", (event) => {
          if (!appearanceColorPickerState.dragging) return;
          updateAppearanceColorPickerFromField(event);
        });
        const finishColorDrag = (event) => {
          if (!appearanceColorPickerState.dragging) return;
          appearanceColorPickerState.dragging = false;
          updateAppearanceColorPickerFromField(event, { persist: true });
          colorField.releasePointerCapture?.(event.pointerId);
        };
        colorField.addEventListener("pointerup", finishColorDrag);
        colorField.addEventListener("pointercancel", finishColorDrag);
      }
      window.addEventListener("resize", () => {
        if (appearanceColorPickerState.open) {
          positionAppearanceColorPicker(appearanceColorPickerState.anchor);
        }
      });
      scheduleSettingsControlSync();
    }
    if (d.settingsPanelClose) {
      d.settingsPanelClose.addEventListener("click", closeSettingsPanel);
    }

    if (d.settingsButton) {
      d.settingsButton.addEventListener("click", async () => {
        await loadOsdSettings();
        await loadMonitorOptions();
        await loadAppSettings();
        await loadCurrentAppVersion();
        syncAppSettingsUI((typeof getAppSettings === "function") ? (getAppSettings() || {}) : {});
        renderAllSettingsSelectDropdowns();
        if ((getAppSettings?.() || {}).autoCheckUpdates !== false) {
          await checkForUpdates({ silent: true });
        }
        openSettingsPanel();
      });
    }

    if (d.openLogsFolderButton) {
      d.openLogsFolderButton.addEventListener("click", async () => {
        try {
          await invoke("open_logs_folder");
        } catch (error) {
          console.error(`Unable to open logs folder: ${error}`);
        }
      });
    }

    if (d.osdEnabledToggle) {
      d.osdEnabledToggle.addEventListener("change", () => {
        const enabled = d.osdEnabledToggle.type === "checkbox"
          ? d.osdEnabledToggle.checked
          : d.osdEnabledToggle.value === "enabled";
        applyOsdSettings({ enabled });
      });
    }

    if (d.osdMonitorSelect) {
      d.osdMonitorSelect.addEventListener("change", () => {
        const nextIndex = Number(d.osdMonitorSelect.value || 0);
        const selectedOption = d.osdMonitorSelect.options[d.osdMonitorSelect.selectedIndex];
        const monitorName = selectedOption?.dataset?.rawName || null;
        const monitorId = selectedOption?.dataset?.stableId || null;
        applyOsdSettings({ monitorIndex: nextIndex, monitorName, monitorId });
        const currentMonitors = (typeof getMonitorOptions === "function") ? (getMonitorOptions() || []) : [];
        renderMonitorDropdownOptions(currentMonitors);
      });
    }

    if (d.osdPositionPicker) {
      d.osdPositionPicker.addEventListener("click", (event) => {
        const dot = event.target.closest(".osd-position-dot");
        if (!dot) return;
        const anchor = dot.dataset.anchor || "top-right";
        applyOsdSettings({ anchor });
      });
    }

    if (d.startWithWindowsSelect) {
      d.startWithWindowsSelect.addEventListener("change", () => {
        syncAppSettingsUI({ startWithWindows: d.startWithWindowsSelect.checked });
        persistAppSettings();
      });
    }
    if (d.startInTraySelect) {
      d.startInTraySelect.addEventListener("change", () => {
        syncAppSettingsUI({ startInTray: d.startInTraySelect.checked });
        persistAppSettings();
      });
    }
    if (d.minimizeToTraySelect) {
      d.minimizeToTraySelect.addEventListener("change", () => {
        syncAppSettingsUI({ minimizeToTray: d.minimizeToTraySelect.checked });
        persistAppSettings();
      });
    }
    if (d.exitToTraySelect) {
      d.exitToTraySelect.addEventListener("change", () => {
        syncAppSettingsUI({ exitToTray: d.exitToTraySelect.checked });
        persistAppSettings();
      });
    }
    if (d.languageSelect) {
      d.languageSelect.addEventListener("change", async () => {
        const language = normalizeLanguage(d.languageSelect.value);
        syncAppSettingsUI({ language });
        await i18n?.setLocale?.(language).catch((error) => {
          console.error("Failed to apply language setting", error);
        });
        applyTranslations();
        renderUpdateUi();
        persistAppSettings();
      });
    }
    if (d.autoCheckUpdatesButton) {
      d.autoCheckUpdatesButton.addEventListener("change", () => {
        syncAppSettingsUI({ autoCheckUpdates: d.autoCheckUpdatesButton.checked });
        persistAppSettings();
        renderUpdateUi();
        ensureAutoUpdateCheck();
      });
    }
    if (d.midiDeviceInventoryConsentToggle) {
      d.midiDeviceInventoryConsentToggle.addEventListener("change", async () => {
        const consent = d.midiDeviceInventoryConsentToggle.checked ? "enabled" : "disabled";
        const previous = normalizeMidiDeviceInventorySettings(
          (typeof getAppSettings === "function") ? (getAppSettings() || {}) : {},
        );
        syncAppSettingsUI({
          midiDeviceInventoryConsent: consent,
          midiDeviceInventoryNoticeVersion: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
        });
        try {
          const updated = await invoke("update_midi_device_inventory_consent", {
            consent,
            noticeVersion: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
          });
          const normalized = normalizeMidiDeviceInventorySettings(updated || {
            consent,
            noticeVersion: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
          });
          syncAppSettingsUI({
            midiDeviceInventoryConsent: normalized.consent,
            midiDeviceInventoryNoticeVersion: normalized.noticeVersion,
          });
          if (typeof onMidiDeviceInventoryConsentChanged === "function") {
            onMidiDeviceInventoryConsentChanged(normalized);
          }
        } catch (error) {
          console.error("Failed to update MIDI device inventory consent", error);
          syncAppSettingsUI({
            midiDeviceInventoryConsent: previous.consent,
            midiDeviceInventoryNoticeVersion: previous.noticeVersion,
          });
        }
      });
    }
    if (d.checkForUpdatesButton) {
      d.checkForUpdatesButton.addEventListener("click", () => {
        if (updateState.available) {
          installAvailableUpdate();
          return;
        }
        checkForUpdates();
      });
    }
    if (d.topbarUpdateButton) {
      d.topbarUpdateButton.addEventListener("click", () => {
        if (!updateState.available || updateState.downloading) return;
        if (typeof onUpdateAvailableClick === "function") {
          onUpdateAvailableClick({
            currentVersion: updateState.currentVersion,
            latestVersion: updateState.latestVersion,
            body: updateState.body,
          });
        }
      });
    }

    window.addEventListener("midimaster:locale-changed", () => {
      applyTranslations();
      renderAllSettingsSelectDropdowns();
      renderMonitorDropdownOptions((typeof getMonitorOptions === "function") ? (getMonitorOptions() || []) : []);
      renderUpdateUi();
    });

    setStaticUpdateStatus("settings.noUpdateCheckYet");
    renderUpdateUi();
    renderAllSettingsSelectDropdowns();
    scheduleSettingsControlSync();
    loadCurrentAppVersion().catch(() => {});
  }

  async function loadCurrentAppVersion() {
    try {
      const version = await invoke("get_app_version");
      if (version) {
        updateState.currentVersion = String(version);
        if (!updateState.latestVersion || updateState.latestVersion === "-") {
          updateState.latestVersion = updateState.currentVersion;
        }
        renderUpdateUi();
        renderSidebarVersion();
      }
    } catch {
      // ignore version fetch failures
    }
  }

  return {
    bindUi,
    openSettingsPanel,
    closeSettingsPanel,
    loadMonitorOptions,
    loadOsdSettings,
    applyOsdSettings,
    loadAppSettings,
    loadCurrentAppVersion,
    syncAppSettingsUI,
    persistAppSettings,
    checkForUpdates,
    ensureAutoUpdateCheck,
    installAvailableUpdate,
    activateSettingsSection,
    renderAllSettingsSelectDropdowns,
    syncOsdAppearanceControls,
    syncAppearanceControls,
  };
}

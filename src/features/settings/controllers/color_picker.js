import {
  setColorPickerStateFromHex,
  colorPickerAppearancePatch,
  parseHexColorInput,
} from "../appearance_controls.js";
import { rgbToHex, hsvToRgb } from "../../../app/color.js";

/** color picker workflow. */
export function createColorPicker({
  appearanceColorPickerState,
  appearanceEl,
  applyAppearanceUpdate,
  colorPickerSwatches,
  t,
}) {
  function setAppearanceColorPickerFromHex(color) {
    setColorPickerStateFromHex(appearanceColorPickerState, color);
  }

  function appearanceColorPickerPatch() {
    return colorPickerAppearancePatch(appearanceColorPickerState);
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
      title.textContent =
        appearanceColorPickerState.target === "token"
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

  function openAppearanceColorPicker({
    target = "accent",
    token = "",
    name = "",
    color = "#5aa7ff",
    anchor = null,
  } = {}) {
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
    appearanceColorPickerState.color = rgbToHex(
      hsvToRgb({
        h: appearanceColorPickerState.hue,
        s: appearanceColorPickerState.saturation,
        v: appearanceColorPickerState.value,
      }),
    );
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

  return {
    syncAppearanceColorPickerUi,
    positionAppearanceColorPicker,
    openAppearanceColorPicker,
    closeAppearanceColorPicker,
    setAppearanceColorPickerHsv,
    updateAppearanceColorPickerFromField,
    setAppearanceColorPickerHex,
  };
}

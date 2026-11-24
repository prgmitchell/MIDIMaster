import {
  findAppearanceColorControl,
  colorInputValue,
  findAppearanceIntensityControl,
} from "../appearance_controls.js";
import {
  resolveAppearance,
  applyBuiltInPreset,
  appearanceBackgroundGlowPatch,
} from "../../../app/appearance.js";

export function bindAppearanceControls({
  lifetime,
  panel,
  presets,
  editor,
  picker,
  pickerState,
  sliderFillPercent,
  t,
}) {
  if (!panel) return;
  const {
    appearanceEl,
    currentAppearance,
    applyAppearanceColorControlValue,
    applyAppearanceColorControlIntensity,
  } = presets;
  const {
    applyAppearanceUpdate,
    deleteCustomAppearanceTheme,
    selectCustomAppearanceTheme,
    syncAppearanceControls,
    persistAppearanceSettings,
  } = editor;
  const {
    openAppearanceColorPicker,
    closeAppearanceColorPicker,
    setAppearanceColorPickerHex,
    setAppearanceColorPickerHsv,
    syncAppearanceColorPickerUi,
    updateAppearanceColorPickerFromField,
    positionAppearanceColorPicker,
  } = picker;
  lifetime.listen(panel, "click", (event) => {
    const colorClose = event.target.closest("[data-appearance-color-close]");
    if (colorClose && panel.contains(colorClose)) {
      closeAppearanceColorPicker();
      return;
    }
    const pickerSwatch = event.target.closest("[data-appearance-picker-swatch]");
    if (pickerSwatch && panel.contains(pickerSwatch)) {
      setAppearanceColorPickerHex(pickerSwatch.dataset.appearancePickerSwatch, { persist: true });
      return;
    }
    const optionSwatch = event.target.closest("[data-appearance-option-swatch]");
    if (optionSwatch && panel.contains(optionSwatch)) {
      const control = findAppearanceColorControl(
        optionSwatch.dataset.appearanceColorRole,
        optionSwatch.dataset.appearanceToken,
      );
      closeAppearanceColorPicker();
      applyAppearanceColorControlValue(control, optionSwatch.dataset.appearanceOptionSwatch, {
        persist: true,
      });
      return;
    }
    const colorTrigger = event.target.closest("[data-appearance-color-trigger]");
    if (colorTrigger && panel.contains(colorTrigger)) {
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
    if (deleteCustom && panel.contains(deleteCustom)) {
      deleteCustomAppearanceTheme(deleteCustom.dataset.appearanceDeleteCustom);
      return;
    }
    const appearancePreset = event.target.closest("[data-appearance-preset]");
    if (appearancePreset && panel.contains(appearancePreset)) {
      const presetId = appearancePreset.dataset.appearancePreset;
      const kind = appearancePreset.dataset.appearancePresetKind;
      const next =
        kind === "custom"
          ? selectCustomAppearanceTheme(presetId)
          : applyBuiltInPreset(currentAppearance(), presetId);
      closeAppearanceColorPicker();
      syncAppearanceControls(next);
      persistAppearanceSettings(next);
      return;
    }
    const colorPopover = appearanceEl("appearance-color-popover");
    if (pickerState.open && colorPopover && !colorPopover.contains(event.target)) {
      closeAppearanceColorPicker();
    }
  });
  lifetime.listen(panel, "keydown", (event) => {
    if (event.key === "Escape" && pickerState.open) {
      closeAppearanceColorPicker();
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const appearancePreset = event.target.closest("[data-appearance-preset]");
    if (!appearancePreset || !panel.contains(appearancePreset)) return;
    event.preventDefault();
    appearancePreset.click();
  });

  const sliders = new Map([
    ["appearance-temperature", "colorTemperature"],
    ["appearance-font-size", "fontSize"],
    ["appearance-surface-contrast", "surfaceContrast"],
    ["appearance-icon-glow", "iconGlow"],
  ]);
  function editColor(event) {
    const input = event.target;
    const persist = event.type === "change";
    if (input === appearanceEl("appearance-color-hue")) {
      setAppearanceColorPickerHsv({ h: Number(input.value) }, { persist });
    } else if (input === appearanceEl("appearance-color-hex")) {
      const valid = setAppearanceColorPickerHex(input.value, { persist, syncHex: persist });
      if (persist && !valid) syncAppearanceColorPickerUi();
    } else if (input === appearanceEl("appearance-background-glow")) {
      applyAppearanceUpdate(appearanceBackgroundGlowPatch(input.value), { persist });
    } else if (sliders.has(input.id)) {
      applyAppearanceUpdate({ [sliders.get(input.id)]: Number(input.value) }, { persist });
    } else if (input.matches("[data-appearance-intensity-token]")) {
      const value = Math.round(Math.min(100, Math.max(0, Number(input.value))));
      const control = findAppearanceIntensityControl(input.dataset.appearanceIntensityToken);
      input.style.setProperty("--range-fill", `${sliderFillPercent(input, value)}%`);
      const label = input.parentElement?.querySelector(".appearance-token-intensity-value");
      if (label) label.textContent = `${value}%`;
      applyAppearanceColorControlIntensity(control, value, { persist, render: false });
    }
  }
  lifetime.listen(panel, "input", editColor);
  lifetime.listen(panel, "change", editColor);
  const colorField = appearanceEl("appearance-color-field");
  if (colorField) {
    lifetime.listen(colorField, "pointerdown", (event) => {
      event.preventDefault();
      pickerState.dragging = true;
      colorField.setPointerCapture?.(event.pointerId);
      updateAppearanceColorPickerFromField(event);
    });
    lifetime.listen(colorField, "pointermove", (event) => {
      if (!pickerState.dragging) return;
      updateAppearanceColorPickerFromField(event);
    });
    const finishColorDrag = (event) => {
      if (!pickerState.dragging) return;
      pickerState.dragging = false;
      updateAppearanceColorPickerFromField(event, { persist: true });
      colorField.releasePointerCapture?.(event.pointerId);
    };
    lifetime.listen(colorField, "pointerup", finishColorDrag);
    lifetime.listen(colorField, "pointercancel", finishColorDrag);
  }
  lifetime.listen(window, "resize", () => {
    if (pickerState.open) {
      positionAppearanceColorPicker(pickerState.anchor);
    }
  });
}

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
import { normalizeOsdStyle } from "../../../core/osd_settings.js";
import {
  normalizeMidiDeviceInventorySettings,
  MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
} from "../../../app/midi_device_inventory.js";

/** events workflow. */
export function createEvents({
  lifetime,
  activateSettingsSection,
  appearanceColorPickerState,
  appearanceEl,
  applyAppearanceColorControlIntensity,
  applyAppearanceColorControlValue,
  applyAppearanceUpdate,
  applyOsdSettings,
  applyTranslations,
  bindUpdaterEvents,
  checkForUpdates,
  clampNumber,
  closeAppearanceColorPicker,
  closeSettingsPanel,
  currentAppearance,
  elements,
  defaultOsdAppearance,
  defaultSettingsSection,
  deleteCustomAppearanceTheme,
  ensureAutoUpdateCheck,
  getAppSettings,
  getMonitorOptions,
  getOsdSettings,
  i18n,
  installAvailableUpdate,
  invoke,
  loadAppSettings,
  loadCurrentAppVersion,
  loadMonitorOptions,
  loadOsdSettings,
  normalizeLanguage,
  onMidiDeviceInventoryConsentChanged,
  onUpdateAvailableClick,
  openAppearanceColorPicker,
  openSettingsPanel,
  persistAppSettings,
  persistAppearanceSettings,
  populateLanguageSelect,
  positionAppearanceColorPicker,
  renderAllSettingsSelectDropdowns,
  renderMonitorDropdownOptions,
  renderUpdateUi,
  scheduleOsdAppearanceSync,
  scheduleSettingsControlSync,
  scheduleSettingsNavIndicatorSync,
  selectCustomAppearanceTheme,
  setAppearanceColorPickerHex,
  setAppearanceColorPickerHsv,
  setStaticUpdateStatus,
  sliderFillPercent,
  syncAppSettingsUI,
  syncAppearanceColorPickerUi,
  syncAppearanceControls,
  syncOsdAppearanceUi,
  t,
  uiBound,
  updateAppearanceColorPickerFromField,
  updateState,
  viewState,
  virtualAudio,
}) {
  function bindUi() {
    if (uiBound) return;
    uiBound = true;
    bindUpdaterEvents().catch(() => {});
    virtualAudio.bindUi();
    populateLanguageSelect();
    if (elements.settingsPanel) {
      activateSettingsSection(defaultSettingsSection);
      lifetime.listen(window, "resize", () => {
        scheduleSettingsNavIndicatorSync();
        scheduleOsdAppearanceSync();
      });
      if ("ResizeObserver" in window && elements.osdPositionPicker && !viewState.osdPreviewResizeObserver) {
        viewState.osdPreviewResizeObserver = new ResizeObserver(scheduleOsdAppearanceSync);
        viewState.osdPreviewResizeObserver.observe(elements.osdPositionPicker);
        const previewScreen = elements.osdPositionPicker.querySelector(".settings-osd-preview-screen");
        if (previewScreen) {
          viewState.osdPreviewResizeObserver.observe(previewScreen);
        }
      }
      lifetime.listen(elements.settingsPanel, "click", (event) => {
        const sectionButton = event.target.closest("[data-settings-section]");
        if (sectionButton && elements.settingsPanel.contains(sectionButton)) {
          activateSettingsSection(sectionButton.dataset.settingsSection);
          return;
        }
        const colorClose = event.target.closest("[data-appearance-color-close]");
        if (colorClose && elements.settingsPanel.contains(colorClose)) {
          closeAppearanceColorPicker();
          return;
        }
        const pickerSwatch = event.target.closest("[data-appearance-picker-swatch]");
        if (pickerSwatch && elements.settingsPanel.contains(pickerSwatch)) {
          setAppearanceColorPickerHex(pickerSwatch.dataset.appearancePickerSwatch, { persist: true });
          return;
        }
        const optionSwatch = event.target.closest("[data-appearance-option-swatch]");
        if (optionSwatch && elements.settingsPanel.contains(optionSwatch)) {
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
        if (colorTrigger && elements.settingsPanel.contains(colorTrigger)) {
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
        if (deleteCustom && elements.settingsPanel.contains(deleteCustom)) {
          deleteCustomAppearanceTheme(deleteCustom.dataset.appearanceDeleteCustom);
          return;
        }
        const appearancePreset = event.target.closest("[data-appearance-preset]");
        if (appearancePreset && elements.settingsPanel.contains(appearancePreset)) {
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
        const styleButton = event.target.closest("[data-osd-style-option]");
        if (styleButton && elements.settingsPanel.contains(styleButton) && elements.osdStyleSelect) {
          elements.osdStyleSelect.value = normalizeOsdStyle(styleButton.dataset.osdStyleOption);
          elements.osdStyleSelect.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        if (
          elements.settingsPanel.classList.contains("target-panel") &&
          event.target === elements.settingsPanel
        ) {
          closeSettingsPanel();
        }
        const colorPopover = appearanceEl("appearance-color-popover");
        if (appearanceColorPickerState.open && colorPopover && !colorPopover.contains(event.target)) {
          closeAppearanceColorPicker();
        }
      });
      lifetime.listen(elements.settingsPanel, "keydown", (event) => {
        if (event.key === "Escape" && appearanceColorPickerState.open) {
          closeAppearanceColorPicker();
          event.preventDefault();
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        const appearancePreset = event.target.closest("[data-appearance-preset]");
        if (!appearancePreset || !elements.settingsPanel.contains(appearancePreset)) return;
        event.preventDefault();
        appearancePreset.click();
      });
      lifetime.listen(elements.settingsPanel, "input", (event) => {
        if (event.target === elements.osdTransparencyInput) {
          const opacity = clampNumber(
            Number(elements.osdTransparencyInput.value) / 100,
            0.35,
            1,
            defaultOsdAppearance.opacity,
          );
          const current = typeof getOsdSettings === "function" ? getOsdSettings() || {} : {};
          syncOsdAppearanceUi({ ...current, opacity });
          return;
        }
        if (event.target === elements.osdScaleInput) {
          const scale = clampNumber(
            Number(elements.osdScaleInput.value) / 100,
            0.75,
            1.5,
            defaultOsdAppearance.scale,
          );
          const current = typeof getOsdSettings === "function" ? getOsdSettings() || {} : {};
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
        if (intensityInput && elements.settingsPanel.contains(intensityInput)) {
          const value = Math.round(clampNumber(intensityInput.value, 0, 100, 100));
          const control = findAppearanceIntensityControl(intensityInput.dataset.appearanceIntensityToken);
          const valueEl = intensityInput.parentElement?.querySelector(".appearance-token-intensity-value");
          intensityInput.style.setProperty("--range-fill", `${sliderFillPercent(intensityInput, value)}%`);
          if (valueEl) valueEl.textContent = `${value}%`;
          applyAppearanceColorControlIntensity(control, value);
        }
      });
      lifetime.listen(elements.settingsPanel, "change", (event) => {
        if (event.target === elements.osdStyleSelect) {
          const style = normalizeOsdStyle(elements.osdStyleSelect.value);
          const current = typeof getOsdSettings === "function" ? getOsdSettings() || {} : {};
          syncOsdAppearanceUi({ ...current, style });
          applyOsdSettings({ style });
          return;
        }
        if (event.target === elements.osdTransparencyInput) {
          applyOsdSettings({
            opacity: clampNumber(
              Number(elements.osdTransparencyInput.value) / 100,
              0.35,
              1,
              defaultOsdAppearance.opacity,
            ),
          });
          return;
        }
        if (event.target === elements.osdScaleInput) {
          applyOsdSettings({
            scale: clampNumber(
              Number(elements.osdScaleInput.value) / 100,
              0.75,
              1.5,
              defaultOsdAppearance.scale,
            ),
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
        if (intensityInput && elements.settingsPanel.contains(intensityInput)) {
          const value = Math.round(clampNumber(intensityInput.value, 0, 100, 100));
          const control = findAppearanceIntensityControl(intensityInput.dataset.appearanceIntensityToken);
          applyAppearanceColorControlIntensity(control, value, { persist: true, render: false });
          return;
        }
      });
      const colorField = appearanceEl("appearance-color-field");
      if (colorField) {
        lifetime.listen(colorField, "pointerdown", (event) => {
          event.preventDefault();
          appearanceColorPickerState.dragging = true;
          colorField.setPointerCapture?.(event.pointerId);
          updateAppearanceColorPickerFromField(event);
        });
        lifetime.listen(colorField, "pointermove", (event) => {
          if (!appearanceColorPickerState.dragging) return;
          updateAppearanceColorPickerFromField(event);
        });
        const finishColorDrag = (event) => {
          if (!appearanceColorPickerState.dragging) return;
          appearanceColorPickerState.dragging = false;
          updateAppearanceColorPickerFromField(event, { persist: true });
          colorField.releasePointerCapture?.(event.pointerId);
        };
        lifetime.listen(colorField, "pointerup", finishColorDrag);
        lifetime.listen(colorField, "pointercancel", finishColorDrag);
      }
      lifetime.listen(window, "resize", () => {
        if (appearanceColorPickerState.open) {
          positionAppearanceColorPicker(appearanceColorPickerState.anchor);
        }
      });
      scheduleSettingsControlSync();
    }
    if (elements.settingsPanelClose) {
      lifetime.listen(elements.settingsPanelClose, "click", closeSettingsPanel);
    }

    if (elements.settingsButton) {
      lifetime.listen(elements.settingsButton, "click", async () => {
        await loadOsdSettings();
        await loadMonitorOptions();
        await loadAppSettings();
        await loadCurrentAppVersion();
        syncAppSettingsUI(typeof getAppSettings === "function" ? getAppSettings() || {} : {});
        renderAllSettingsSelectDropdowns();
        if ((getAppSettings?.() || {}).autoCheckUpdates !== false) {
          await checkForUpdates({ silent: true });
        }
        openSettingsPanel();
      });
    }

    if (elements.openLogsFolderButton) {
      lifetime.listen(elements.openLogsFolderButton, "click", async () => {
        try {
          await invoke("open_logs_folder");
        } catch (error) {
          console.error(`Unable to open logs folder: ${error}`);
        }
      });
    }

    if (elements.osdEnabledToggle) {
      lifetime.listen(elements.osdEnabledToggle, "change", () => {
        const enabled =
          elements.osdEnabledToggle.type === "checkbox"
            ? elements.osdEnabledToggle.checked
            : elements.osdEnabledToggle.value === "enabled";
        applyOsdSettings({ enabled });
      });
    }

    if (elements.osdMonitorSelect) {
      lifetime.listen(elements.osdMonitorSelect, "change", () => {
        const nextIndex = Number(elements.osdMonitorSelect.value || 0);
        const selectedOption = elements.osdMonitorSelect.options[elements.osdMonitorSelect.selectedIndex];
        const monitorName = selectedOption?.dataset?.rawName || null;
        const monitorId = selectedOption?.dataset?.stableId || null;
        applyOsdSettings({ monitorIndex: nextIndex, monitorName, monitorId });
        const currentMonitors = typeof getMonitorOptions === "function" ? getMonitorOptions() || [] : [];
        renderMonitorDropdownOptions(currentMonitors);
      });
    }

    if (elements.osdLabelModeSelect) {
      lifetime.listen(elements.osdLabelModeSelect, "change", () => {
        applyOsdSettings({ showBindingName: elements.osdLabelModeSelect.value === "binding" });
      });
    }

    if (elements.osdPositionPicker) {
      lifetime.listen(elements.osdPositionPicker, "click", (event) => {
        const dot = event.target.closest(".osd-position-dot");
        if (!dot) return;
        const anchor = dot.dataset.anchor || "top-right";
        applyOsdSettings({ anchor });
      });
    }

    if (elements.startWithWindowsSelect) {
      lifetime.listen(elements.startWithWindowsSelect, "change", () => {
        const previous = typeof getAppSettings === "function" ? { ...(getAppSettings() || {}) } : null;
        syncAppSettingsUI({ startWithWindows: elements.startWithWindowsSelect.checked });
        persistAppSettings({ previousSettings: previous });
      });
    }
    if (elements.startInTraySelect) {
      lifetime.listen(elements.startInTraySelect, "change", () => {
        const previous = typeof getAppSettings === "function" ? { ...(getAppSettings() || {}) } : null;
        syncAppSettingsUI({ startInTray: elements.startInTraySelect.checked });
        persistAppSettings({ previousSettings: previous });
      });
    }
    if (elements.minimizeToTraySelect) {
      lifetime.listen(elements.minimizeToTraySelect, "change", () => {
        const previous = typeof getAppSettings === "function" ? { ...(getAppSettings() || {}) } : null;
        syncAppSettingsUI({ minimizeToTray: elements.minimizeToTraySelect.checked });
        persistAppSettings({ previousSettings: previous });
      });
    }
    if (elements.exitToTraySelect) {
      lifetime.listen(elements.exitToTraySelect, "change", () => {
        const previous = typeof getAppSettings === "function" ? { ...(getAppSettings() || {}) } : null;
        syncAppSettingsUI({ exitToTray: elements.exitToTraySelect.checked });
        persistAppSettings({ previousSettings: previous });
      });
    }
    if (elements.languageSelect) {
      lifetime.listen(elements.languageSelect, "change", async () => {
        const language = normalizeLanguage(elements.languageSelect.value);
        syncAppSettingsUI({ language });
        await i18n?.setLocale?.(language).catch((error) => {
          console.error("Failed to apply language setting", error);
        });
        applyTranslations();
        renderUpdateUi();
        persistAppSettings();
      });
    }
    if (elements.autoCheckUpdatesButton) {
      lifetime.listen(elements.autoCheckUpdatesButton, "change", () => {
        const previous = typeof getAppSettings === "function" ? { ...(getAppSettings() || {}) } : null;
        syncAppSettingsUI({ autoCheckUpdates: elements.autoCheckUpdatesButton.checked });
        persistAppSettings({ previousSettings: previous });
        renderUpdateUi();
        ensureAutoUpdateCheck();
      });
    }
    if (elements.midiDeviceInventoryConsentToggle) {
      lifetime.listen(elements.midiDeviceInventoryConsentToggle, "change", async () => {
        const consent = elements.midiDeviceInventoryConsentToggle.checked ? "enabled" : "disabled";
        const previous = normalizeMidiDeviceInventorySettings(
          typeof getAppSettings === "function" ? getAppSettings() || {} : {},
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
          const normalized = normalizeMidiDeviceInventorySettings(
            updated || {
              consent,
              noticeVersion: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
            },
          );
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
    if (elements.checkForUpdatesButton) {
      lifetime.listen(elements.checkForUpdatesButton, "click", () => {
        if (updateState.available) {
          installAvailableUpdate();
          return;
        }
        checkForUpdates();
      });
    }
    if (elements.topbarUpdateButton) {
      lifetime.listen(elements.topbarUpdateButton, "click", () => {
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

    lifetime.listen(window, "midimaster:locale-changed", () => {
      applyTranslations();
      renderAllSettingsSelectDropdowns();
      renderMonitorDropdownOptions(typeof getMonitorOptions === "function" ? getMonitorOptions() || [] : []);
      renderUpdateUi();
    });

    setStaticUpdateStatus("settings.noUpdateCheckYet");
    renderUpdateUi();
    renderAllSettingsSelectDropdowns();
    scheduleSettingsControlSync();
    loadCurrentAppVersion().catch(() => {});
  }

  return { bindUi };
}

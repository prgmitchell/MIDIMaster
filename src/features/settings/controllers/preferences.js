/** preferences workflow. */
export function createPreferences({
  applyTranslations,
  elements,
  getAppSettings,
  i18n,
  languageOptions,
  renderSettingsSelectDropdown,
  renderUpdateUi,
  setAppSettings,
  setAppearanceState,
  settingsStore,
  showSettingsAlert,
  syncMidiDeviceInventoryToggle,
  t,
}) {
  function syncAppSettingsUI(nextSettings) {
    const current = typeof getAppSettings === "function" ? getAppSettings() || {} : {};
    const merged = { ...current, ...(nextSettings || {}) };
    if (typeof setAppSettings === "function") {
      setAppSettings(merged);
    }
    if (elements.startWithWindowsSelect) {
      elements.startWithWindowsSelect.checked = Boolean(merged.startWithWindows);
    }
    if (elements.startInTraySelect) {
      elements.startInTraySelect.checked = Boolean(merged.startInTray);
    }
    if (elements.minimizeToTraySelect) {
      elements.minimizeToTraySelect.checked = Boolean(merged.minimizeToTray);
    }
    if (elements.exitToTraySelect) {
      elements.exitToTraySelect.checked = Boolean(merged.exitToTray);
    }
    if (elements.languageSelect) {
      elements.languageSelect.value = normalizeLanguage(merged.language);
      renderSettingsSelectDropdown(elements.languageSelect);
    }
    syncMidiDeviceInventoryToggle(merged);
    renderUpdateUi();
  }

  function persistAppSettings({ previousSettings = null } = {}) {
    return settingsStore
      .persist({ previousSettings })
      .then((updated) => {
        syncAppSettingsUI(updated);
      })
      .catch((error) => {
        console.error("Failed to update app settings", error);
        syncAppSettingsUI(settingsStore.get());
        showSettingsAlert?.(
          t("dialogs.actionFailedTitle"),
          String(error || t("dialogs.actionFailedMessage")),
        );
      });
  }

  function normalizeLanguage(language) {
    const value = String(language || "en").trim();
    return languageOptions.some((option) => option.code === value) ? value : "en";
  }

  function populateLanguageSelect() {
    if (!elements.languageSelect || elements.languageSelect.options.length > 0) return;
    languageOptions.forEach((language) => {
      const option = document.createElement("option");
      option.value = language.code;
      option.textContent = language.label;
      elements.languageSelect.appendChild(option);
    });
  }

  async function loadAppSettings({ applyLocale = true } = {}) {
    try {
      const settings = await settingsStore.load();
      if (settings) {
        const next = settingsStore.get();
        setAppearanceState(next.appearance);
        if (applyLocale) {
          await i18n?.setLocale?.(next.language).catch((error) => {
            console.error("Failed to apply language setting", error);
          });
          applyTranslations();
        }
      }
      return settings || null;
    } catch (error) {
      console.error("Failed to load app settings", error);
      return null;
    }
  }

  return {
    syncAppSettingsUI,
    persistAppSettings,
    normalizeLanguage,
    populateLanguageSelect,
    loadAppSettings,
  };
}

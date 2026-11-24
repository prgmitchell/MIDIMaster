import {
  normalizeMidiDeviceInventorySettings,
  MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
} from "../../../app/midi_device_inventory.js";

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
  t,
}) {
  function syncMidiDeviceInventoryToggle(settings = null) {
    if (!elements.midiDeviceInventoryConsentToggle) return;
    const current = settings || (typeof getAppSettings === "function" ? getAppSettings() || {} : {});
    const inventory = normalizeMidiDeviceInventorySettings(current);
    elements.midiDeviceInventoryConsentToggle.checked =
      inventory.consent === "enabled" && inventory.noticeVersion >= MIDI_DEVICE_INVENTORY_NOTICE_VERSION;
  }

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

  function bindUi({ lifetime, invoke, ensureAutoUpdateCheck, onMidiDeviceInventoryConsentChanged }) {
    populateLanguageSelect();
    const toggles = [
      ["startWithWindows", elements.startWithWindowsSelect],
      ["startInTray", elements.startInTraySelect],
      ["minimizeToTray", elements.minimizeToTraySelect],
      ["exitToTray", elements.exitToTraySelect],
      ["autoCheckUpdates", elements.autoCheckUpdatesButton],
    ];
    for (const [key, input] of toggles) {
      lifetime.listen(input, "change", () => {
        const previousSettings = getAppSettings();
        syncAppSettingsUI({ [key]: input.checked });
        persistAppSettings({ previousSettings });
        if (key === "autoCheckUpdates") ensureAutoUpdateCheck();
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
  }

  return {
    bindUi,
    syncAppSettingsUI,
    persistAppSettings,
    normalizeLanguage,
    populateLanguageSelect,
    loadAppSettings,
  };
}

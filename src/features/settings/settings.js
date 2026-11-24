import { createUiLifetime } from "../../app/ui_lifetime.js";
import { bindAppearanceControls } from "./controllers/appearance_events.js";
import { createPreferences } from "./controllers/preferences.js";
import { createMonitors } from "./controllers/monitors.js";
import { createDropdowns } from "./controllers/dropdowns.js";
import { createOsdSettings } from "./controllers/osd_settings.js";
import { createNavigation } from "./controllers/navigation.js";
import { createOsdAppearance } from "./controllers/osd_appearance.js";
import { createAppearanceEditor } from "./controllers/appearance_editor.js";
import { createColorPicker } from "./controllers/color_picker.js";
import { createAppearancePresets } from "./controllers/appearance_presets.js";

import { getBuiltInAppearancePresets } from "../../app/appearance.js";

import { createVirtualAudioSettingsController } from "./virtual_audio.js";
import { createUpdaterController } from "./updater_controller.js";
import {
  APPEARANCE_COLOR_CONTROLS,
  COLOR_PICKER_SWATCHES,
  createAppearanceColorPickerState,
} from "./appearance_controls.js";

export function createSettingsFeature({
  invoke,
  listen,
  dom,
  i18n,
  getOsdSettings,
  setOsdSettings,
  getMonitorOptions,
  setMonitorOptions,
  settingsStore,
  applyAppearance,
  showAlert,
  onUpdateAvailableClick,
  onMidiDeviceInventoryConsentChanged,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createSettingsFeature: invoke is required");
  }
  if (
    !settingsStore ||
    typeof settingsStore.get !== "function" ||
    typeof settingsStore.update !== "function"
  ) {
    throw new Error("createSettingsFeature: settingsStore is required");
  }
  const lifetime = createUiLifetime();
  const elements = dom && typeof dom === "object" ? dom : {};
  const getAppSettings = () => settingsStore.get();
  const setAppSettings = (next) => settingsStore.update(next);
  let uiBound = false;
  const t = (key, params = {}) =>
    i18n && typeof i18n.t === "function" ? i18n.t(key, params) : String(key || "");
  const applyTranslations = () => {
    if (i18n && typeof i18n.applyTranslations === "function") {
      i18n.applyTranslations(elements.settingsPanel || document);
    }
  };
  const showSettingsAlert = typeof showAlert === "function" ? showAlert : null;
  const monitorView = {
    monitorDropdownEl: null,
    monitorMenuEl: null,
    monitorDisplayEl: null,
    monitorDocClickBound: false,
  };

  const viewState = {
    settingsDocClickBound: false,
    settingsNavIndicatorRaf: 0,
    osdAppearanceRaf: 0,
    osdPreviewResizeObserver: null,
  };
  const settingsSelectDropdowns = new Map();

  const appearanceColorPickerState = createAppearanceColorPickerState();
  const defaultSettingsSection = "startup";
  const languageOptions = Array.isArray(i18n?.supportedLocales)
    ? i18n.supportedLocales
    : [{ code: "en", label: "English" }];
  const colorPickerSwatches = COLOR_PICKER_SWATCHES;
  const appearanceColorControls = APPEARANCE_COLOR_CONTROLS;
  const appearanceBuiltInPresets = getBuiltInAppearancePresets();
  const appearanceBuiltInPresetIds = new Set(appearanceBuiltInPresets.map((preset) => preset.id));
  const virtualAudio = createVirtualAudioSettingsController({
    invoke,
    dom: elements,
    i18n,
    showAlert: showSettingsAlert,
    renderSelectDropdown: (select) => renderSettingsSelectDropdown(select),
  });
  const updater = createUpdaterController({
    invoke,
    listen,
    dom: elements,
    translate: t,
    getSettings: getAppSettings,
  });
  const { render: renderUpdateUi, checkForUpdates, ensureAutoUpdateCheck, installAvailableUpdate,
    bindEvents: bindUpdaterEvents, loadCurrentVersion: loadCurrentAppVersion } = updater;

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function sliderFillPercent(inputEl, value) {
    if (!inputEl) return 0;
    const min = Number(inputEl.min || 0);
    const max = Number(inputEl.max || 100);
    const range = max - min;
    if (!Number.isFinite(min) || !Number.isFinite(max) || range <= 0) return 0;
    return Math.min(100, Math.max(0, ((Number(value) - min) / range) * 100));
  }

  const presets = createAppearancePresets({
    appearanceBuiltInPresetIds,
    appearanceBuiltInPresets,
    applyAppearance,
    applyAppearanceUpdate: (...args) => applyAppearanceUpdate(...args),
    clampNumber,
    elements,
    getAppSettings,
    setAppSettings,
    sliderFillPercent,
    t,
  });
  const { appearanceEl, currentAppearance, setAppearanceState, syncRange, appendSvgIcon, renderAppearancePresets, appearanceColorControlIntensity } = presets;

  const picker = createColorPicker({
    appearanceColorPickerState,
    appearanceEl,
    applyAppearanceUpdate: (...args) => applyAppearanceUpdate(...args),
    colorPickerSwatches,
    t,
  });

  const editor = createAppearanceEditor({
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
  });
  const { syncAppearanceControls, applyAppearanceUpdate } = editor;

  const { syncOsdAppearanceUi } = createOsdAppearance({
    elements,
    getOsdSettings,
    setOsdSettings,
    sliderFillPercent,
  });

  const {
    bindUi: bindNavigation,
    closeSettingsPanel,
    openSettingsPanel,
    activateSettingsSection,
  } = createNavigation({
    elements,
    defaultSettingsSection,
    syncAppearanceControls,
    syncOsdAppearanceControls: (...args) => syncOsdAppearanceControls(...args),
    viewState,
    virtualAudio,
  });

  const {
    bindUi: bindOsd,
    syncOsdSettingsUi,
    applyOsdSettings,
    loadOsdSettings,
    formatMonitorOptionLabel,
    resolveEffectiveMonitor,
  } = createOsdSettings({
    elements,
    getOsdSettings,
    invoke,
    renderSettingsSelectDropdown: (...args) => renderSettingsSelectDropdown(...args),
    setOsdSettings,
    syncOsdAppearanceControls: (...args) => syncOsdAppearanceControls(...args),
    syncOsdAppearanceUi,
    viewState,
  });

  const {
    closeMonitorDropdown,
    renderSettingsSelectDropdown,
    renderAllSettingsSelectDropdowns,
    scheduleSettingsControlSync,
    syncOsdAppearanceControls,
  } = createDropdowns({
    lifetime,
    elements,
    getOsdSettings,
    monitorView,
    settingsSelectDropdowns,
    syncAppearanceControls,
    syncOsdSettingsUi,
    t,
    viewState,
  });

  const { renderMonitorDropdownOptions, loadMonitorOptions } = createMonitors({
    lifetime,
    closeMonitorDropdown,
    elements,
    formatMonitorOptionLabel,
    getOsdSettings,
    invoke,
    monitorView,
    resolveEffectiveMonitor,
    setMonitorOptions,
    setOsdSettings,
    t,
  });

  const {
    syncAppSettingsUI,
    persistAppSettings,
    bindUi: bindPreferences,
    loadAppSettings,
  } = createPreferences({
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
  });

  function bindUi() {
    if (uiBound) return;
    uiBound = true;
    virtualAudio.bindUi();
    bindNavigation(lifetime);
    bindOsd({ lifetime, getMonitorOptions, renderMonitorDropdownOptions });
    bindPreferences({ lifetime, invoke, ensureAutoUpdateCheck, onMidiDeviceInventoryConsentChanged });
    bindAppearanceControls({ lifetime, panel: elements.settingsPanel, presets, editor, picker,
      pickerState: appearanceColorPickerState, sliderFillPercent, t });
    updater.bindUi(lifetime, onUpdateAvailableClick);

    if (elements.settingsButton) {
      lifetime.listen(elements.settingsButton, "click", async () => {
        await loadOsdSettings();
        await loadMonitorOptions();
        await loadAppSettings();
        await loadCurrentAppVersion();
        syncAppSettingsUI(getAppSettings());
        renderAllSettingsSelectDropdowns();
        if (getAppSettings().autoCheckUpdates !== false) {
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
    lifetime.listen(window, "midimaster:locale-changed", () => {
      applyTranslations();
      renderAllSettingsSelectDropdowns();
      renderMonitorDropdownOptions(typeof getMonitorOptions === "function" ? getMonitorOptions() || [] : []);
      renderUpdateUi();
    });
    renderAllSettingsSelectDropdowns();
    scheduleSettingsControlSync();
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
    bindUpdaterEvents,
    activateSettingsSection,
    renderAllSettingsSelectDropdowns,
    syncOsdAppearanceControls,
    syncAppearanceControls,
    dispose: () => {
      lifetime.dispose();
      updater.dispose();
      virtualAudio.dispose();
      cancelAnimationFrame(viewState.settingsNavIndicatorRaf);
      cancelAnimationFrame(viewState.osdAppearanceRaf);
      viewState.osdPreviewResizeObserver?.disconnect();
    },
  };
}

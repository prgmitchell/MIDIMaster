import { createUiLifetime } from "../../app/ui_lifetime.js";
import { createEvents } from "./controllers/events.js";
import { createPreferences } from "./controllers/preferences.js";
import { createMonitors } from "./controllers/monitors.js";
import { createDropdowns } from "./controllers/dropdowns.js";
import { createOsdSettings } from "./controllers/osd_settings.js";
import { createNavigation } from "./controllers/navigation.js";
import { createOsdAppearance } from "./controllers/osd_appearance.js";
import { createAppearanceEditor } from "./controllers/appearance_editor.js";
import { createColorPicker } from "./controllers/color_picker.js";
import { createAppearancePresets } from "./controllers/appearance_presets.js";
import { DEFAULT_OSD_SETTINGS, OSD_STYLES, OSD_ANCHORS } from "../../core/osd_settings.js";

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
  const defaultOsdAppearance = DEFAULT_OSD_SETTINGS;
  const defaultOsdAnchor = DEFAULT_OSD_SETTINGS.anchor;
  const osdStyles = new Set(OSD_STYLES);
  const osdAnchors = new Set(OSD_ANCHORS);
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
  const updateState = updater.state;
  const renderUpdateUi = updater.render;
  const renderSidebarVersion = updater.renderSidebarVersion;
  const setStaticUpdateStatus = updater.setStaticStatus;
  const checkForUpdates = updater.checkForUpdates;
  const ensureAutoUpdateCheck = updater.ensureAutoUpdateCheck;
  const installAvailableUpdate = updater.installAvailableUpdate;
  const bindUpdaterEvents = updater.bindEvents;
  const loadCurrentAppVersion = updater.loadCurrentVersion;

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

  function sliderFillPercent(inputEl, value) {
    if (!inputEl) return 0;
    const min = Number(inputEl.min || 0);
    const max = Number(inputEl.max || 100);
    const range = max - min;
    if (!Number.isFinite(min) || !Number.isFinite(max) || range <= 0) return 0;
    return Math.min(100, Math.max(0, ((Number(value) - min) / range) * 100));
  }

  const {
    appearanceEl,
    currentAppearance,
    setAppearanceState,
    syncRange,
    appendSvgIcon,
    renderAppearancePresets,
    appearanceColorControlIntensity,
    applyAppearanceColorControlValue,
    applyAppearanceColorControlIntensity,
  } = createAppearancePresets({
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

  const {
    syncAppearanceColorPickerUi,
    positionAppearanceColorPicker,
    openAppearanceColorPicker,
    closeAppearanceColorPicker,
    setAppearanceColorPickerHsv,
    updateAppearanceColorPickerFromField,
    setAppearanceColorPickerHex,
  } = createColorPicker({
    appearanceColorPickerState,
    appearanceEl,
    applyAppearanceUpdate: (...args) => applyAppearanceUpdate(...args),
    colorPickerSwatches,
    t,
  });

  const {
    syncAppearanceControls,
    persistAppearanceSettings,
    applyAppearanceUpdate,
    selectCustomAppearanceTheme,
    deleteCustomAppearanceTheme,
  } = createAppearanceEditor({
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

  const { syncOsdAppearanceUi } = createOsdAppearance({
    elements,
    getOsdSettings,
    setOsdSettings,
    sliderFillPercent,
  });

  const {
    syncMidiDeviceInventoryToggle,
    closeSettingsPanel,
    openSettingsPanel,
    activateSettingsSection,
    scheduleSettingsNavIndicatorSync,
  } = createNavigation({
    elements,
    defaultSettingsSection,
    getAppSettings,
    syncAppearanceControls,
    syncOsdAppearanceControls: (...args) => syncOsdAppearanceControls(...args),
    viewState,
    virtualAudio,
  });

  const {
    scheduleOsdAppearanceSync,
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
    normalizeLanguage,
    populateLanguageSelect,
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
    syncMidiDeviceInventoryToggle,
    t,
  });

  const { bindUi } = createEvents({
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
  });

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

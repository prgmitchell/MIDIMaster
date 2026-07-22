import {
  appearanceFromLegacyTheme,
  defaultAppearanceSettings,
  normalizeAppearanceSettings,
} from "./appearance.js";
import { normalizeMidiDeviceInventoryConsent } from "./midi_device_inventory.js";

export function defaultAppSettings() {
  return {
    startWithWindows: false,
    startInTray: false,
    minimizeToTray: false,
    exitToTray: false,
    autoCheckUpdates: true,
    compactBindings: false,
    language: "en",
    appearance: defaultAppearanceSettings(),
    faderCurvePresets: [],
    midiDeviceInventoryConsent: "unknown",
    midiDeviceInventoryNoticeVersion: 0,
  };
}

function valueOf(settings, camelKey, snakeKey, fallback) {
  return settings?.[snakeKey] ?? settings?.[camelKey] ?? fallback;
}

export function normalizeAppSettings(
  settings = {},
  current = defaultAppSettings(),
  { normalizeFaderCurvePresets = (value) => value || [], supportedLanguages = ["en"] } = {},
) {
  const language = String(valueOf(settings, "language", "language", current.language) || "en").trim();
  const appearance = settings.appearance && typeof settings.appearance === "object"
    ? normalizeAppearanceSettings(settings.appearance)
    : (settings.ui_theme !== undefined || settings.uiTheme !== undefined)
      ? appearanceFromLegacyTheme(settings.ui_theme ?? settings.uiTheme)
      : normalizeAppearanceSettings(current.appearance);

  return {
    startWithWindows: Boolean(valueOf(settings, "startWithWindows", "start_with_windows", current.startWithWindows)),
    startInTray: Boolean(valueOf(settings, "startInTray", "start_in_tray", current.startInTray)),
    minimizeToTray: Boolean(valueOf(settings, "minimizeToTray", "minimize_to_tray", current.minimizeToTray)),
    exitToTray: Boolean(valueOf(settings, "exitToTray", "exit_to_tray", current.exitToTray)),
    autoCheckUpdates: Boolean(valueOf(settings, "autoCheckUpdates", "auto_check_updates", current.autoCheckUpdates)),
    compactBindings: Boolean(valueOf(settings, "compactBindings", "compact_bindings", current.compactBindings)),
    language: supportedLanguages.includes(language) ? language : "en",
    appearance,
    faderCurvePresets: normalizeFaderCurvePresets(
      valueOf(settings, "faderCurvePresets", "fader_curve_presets", current.faderCurvePresets),
    ),
    midiDeviceInventoryConsent: normalizeMidiDeviceInventoryConsent(
      valueOf(
        settings,
        "midiDeviceInventoryConsent",
        "midi_device_inventory_consent",
        current.midiDeviceInventoryConsent,
      ),
    ),
    midiDeviceInventoryNoticeVersion: Number(valueOf(
      settings,
      "midiDeviceInventoryNoticeVersion",
      "midi_device_inventory_notice_version",
      current.midiDeviceInventoryNoticeVersion,
    )) || 0,
  };
}

export function createSettingsStore({
  invoke,
  normalizeFaderCurvePresets,
  supportedLanguages = ["en"],
  onChange = null,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createSettingsStore: invoke is required");
  }
  const options = { normalizeFaderCurvePresets, supportedLanguages };
  let state = normalizeAppSettings({}, defaultAppSettings(), options);

  function publish(next) {
    state = normalizeAppSettings(next, state, options);
    onChange?.(state);
    return state;
  }

  function get() {
    return state;
  }

  function update(patch = {}) {
    return publish({ ...state, ...patch });
  }

  function hydrate(settings = {}) {
    return publish(settings);
  }

  async function load() {
    const settings = await invoke("get_app_settings");
    if (settings && typeof settings === "object") {
      hydrate(settings);
      return settings;
    }
    return null;
  }

  function generalSettingsUpdate() {
    return {
      startWithWindows: state.startWithWindows,
      startInTray: state.startInTray,
      minimizeToTray: state.minimizeToTray,
      exitToTray: state.exitToTray,
      autoCheckUpdates: state.autoCheckUpdates,
      language: state.language,
    };
  }

  async function persist({ previousSettings = null } = {}) {
    try {
      const updated = await invoke("update_app_settings", generalSettingsUpdate());
      return updated && typeof updated === "object" ? hydrate(updated) : state;
    } catch (error) {
      if (previousSettings && typeof previousSettings === "object") {
        publish(previousSettings);
      }
      throw error;
    }
  }

  return {
    get,
    update,
    hydrate,
    load,
    persist,
    normalize: (settings) => normalizeAppSettings(settings, state, options),
  };
}

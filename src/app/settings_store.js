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
  let confirmed = generalSettingsUpdate();
  let saveTail = Promise.resolve();
  const revisions = {};

  function publish(next) {
    const normalized = normalizeAppSettings(next, state, options);
    for (const key of Object.keys(confirmed)) {
      if (normalized[key] !== state[key]) revisions[key] = (revisions[key] || 0) + 1;
    }
    state = normalized;
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
    publish(settings);
    confirmed = generalSettingsUpdate();
    return state;
  }

  async function load() {
    const settings = await invoke("get_app_settings");
    if (settings && typeof settings === "object") {
      hydrate(settings);
      return settings;
    }
    return null;
  }

  function generalSettingsUpdate(settings = state) {
    return {
      startWithWindows: settings.startWithWindows,
      startInTray: settings.startInTray,
      minimizeToTray: settings.minimizeToTray,
      exitToTray: settings.exitToTray,
      autoCheckUpdates: settings.autoCheckUpdates,
      language: settings.language,
    };
  }

  function persist({ previousSettings = null } = {}) {
    const requested = generalSettingsUpdate();
    const previous = previousSettings && normalizeAppSettings(previousSettings, state, options);
    const patch = Object.fromEntries(Object.entries(requested).filter(
      ([key, value]) => !previous || value !== previous[key],
    ));
    const submittedRevisions = { ...revisions };
    const reconcile = (keys) => update(Object.fromEntries(keys
      .filter((key) => revisions[key] === submittedRevisions[key])
      .map((key) => [key, confirmed[key]])));

    const saving = saveTail.then(async () => {
      try {
        const submitted = { ...confirmed, ...patch };
        const updated = await invoke("update_app_settings", submitted);
        confirmed = generalSettingsUpdate(normalizeAppSettings(updated || submitted, submitted, options));
        // This command owns only general preferences. Its full backend snapshot
        // may predate a separate appearance, density or privacy update.
        return reconcile(Object.keys(requested));
      } catch (error) {
        reconcile(Object.keys(patch));
        throw error;
      }
    });
    saveTail = saving.catch(() => {});
    return saving;
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

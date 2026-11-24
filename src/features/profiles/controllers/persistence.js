import {
  buildPersistedMidiPreference,
  normalizeMidiPreference,
} from "../../../core/midi_preferences.js";

export function createPersistence({
  invoke,
  profileWrites,
  getActiveProfileName,
  getPluginHost,
  getProfilePluginSettings,
  setProfilePluginSettings,
  setActiveProfileMidiPreference,
  setBindings,
  renderBindings,
  setMidiReconciliationBusy,
}) {
  let pending = null;

  function submitPreferenceChanges() {
    if (!pending) return;
    const batch = pending;
    pending = null;
    clearTimeout(batch.timer);
    profileWrites
      .run(() =>
        invoke("update_profile_preferences", {
          expectedProfile: batch.name,
          ...batch.patch,
        }),
      )
      .then(batch.resolve, batch.reject);
  }

  function savePreferences(patch) {
    const name = getActiveProfileName();
    if (pending && pending.name !== name) submitPreferenceChanges();
    if (!pending) {
      const batch = { name, patch: {} };
      batch.promise = new Promise((resolve, reject) => {
        batch.resolve = resolve;
        batch.reject = reject;
      });
      pending = batch;
    }
    Object.assign(pending.patch, patch);
    clearTimeout(pending.timer);
    pending.timer = setTimeout(submitPreferenceChanges, 500);
    return pending.promise;
  }

  async function flushProfileSave() {
    const saving = pending?.promise;
    submitPreferenceChanges();
    await Promise.all([saving, profileWrites.flush()]);
  }

  function reconcileMidiRoutes(args) {
    const expectedProfileName = args.expectedProfileName || getActiveProfileName();
    const saving = pending?.promise;
    submitPreferenceChanges();
    return profileWrites.run(async () => {
      await saving;
      setMidiReconciliationBusy(true);
      try {
        if (expectedProfileName !== getActiveProfileName())
          throw new Error("Active profile changed before MIDI reconciliation");
        const result = await invoke("start_midi_device_routes", { ...args, expectedProfileName });
        const profile = result?.profile;
        if (profile && profile.name === getActiveProfileName()) {
          setBindings(profile.bindings);
          setActiveProfileMidiPreference(
            normalizeMidiPreference({
              ...profile.midi_device_preference,
              configured: profile.midi_device_preference_set,
            }),
          );
          renderBindings();
        }
        return result;
      } finally {
        setMidiReconciliationBusy(false);
      }
    });
  }

  async function updateProfilePluginSettings(pluginId, settings) {
    if (!pluginId || typeof pluginId !== "string") return;
    const merged = {
      ...getProfilePluginSettings(),
      [pluginId]: settings && typeof settings === "object" ? settings : {},
    };
    setProfilePluginSettings(merged);
    try {
      getPluginHost()?.setProfileState?.({ name: getActiveProfileName(), plugin_settings: merged });
    } catch (error) {
      console.error("Failed to publish plugin settings:", error);
    }
    await savePreferences({ pluginSettings: merged });
  }

  async function updateProfileMidiPreference(preference) {
    const next = normalizeMidiPreference(preference);
    setActiveProfileMidiPreference(next);
    await savePreferences({ midiDevicePreference: buildPersistedMidiPreference(next) });
  }

  return {
    reconcileMidiRoutes,
    flushProfileSave,
    updateProfilePluginSettings,
    updateProfileMidiPreference,
  };
}

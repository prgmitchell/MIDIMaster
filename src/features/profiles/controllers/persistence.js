import {
  buildPersistedMidiPreference as buildPersistedMidiDevicePreference,
  normalizeMidiPreference as toClientMidiDevicePreference,
} from "../../../core/midi_preferences.js";

/** persistence workflow. */
export function createPersistence({
  buildPersistedOsdSettings,
  currentProfileSelection,
  getActiveProfileMidiPreference,
  getActiveProfileName,
  getBindings,
  getOsdSettings,
  getPluginHost,
  getProfilePluginSettings,
  invoke,
  saveState,
  setActiveProfileMidiPreference,
  setActiveProfileName,
  setProfilePluginSettings,
  setProfileSelection,
  setBindings,
  renderBindings,
  setMidiReconciliationBusy = () => {},
}) {
  let reconciliationTail = Promise.resolve();

  function reconcileMidiRoutes(args) {
    const expectedProfileName = args.expectedProfileName || getProfileNameForSave();
    const run = reconciliationTail.then(async () => {
      setMidiReconciliationBusy(true);
      try {
        await flushProfileSave();
        let release;
        saveState.reconciliation = new Promise((resolve) => { release = resolve; });
        try {
          if (expectedProfileName !== getProfileNameForSave()) {
            throw new Error("Active profile changed before MIDI reconciliation");
          }
          const result = await invoke("start_midi_device_routes", { ...args, expectedProfileName });
          const profile = result?.profile;
          if (profile && profile.name === getProfileNameForSave()) {
            // The command's snapshot is authoritative. Migration events are no
            // longer applied as deltas, which could replay a swapped address.
            setBindings?.(profile.bindings || []);
            setActiveProfileMidiPreference?.(toClientMidiDevicePreference({
              ...profile.midi_device_preference, configured: profile.midi_device_preference_set,
            }));
            getPluginHost?.()?.setBindings?.(profile.bindings || []);
            renderBindings?.();
          }
          return result;
        } finally {
          saveState.reconciliation = null;
          release();
        }
      } finally {
        setMidiReconciliationBusy(false);
      }
    });
    reconciliationTail = run.catch(() => {});
    return run;
  }
  function getProfileNameForSave() {
    const current = typeof getActiveProfileName === "function" ? getActiveProfileName() || "" : "";
    if (current) return current;
    return currentProfileSelection("Default");
  }

  function ensureSaveProfilePromise() {
    if (!saveState.promise) {
      saveState.promise = new Promise((resolve, reject) => {
        saveState.resolve = resolve;
        saveState.reject = reject;
      });
    }
    return saveState.promise;
  }

  async function persistCurrentProfile() {
    if (saveState.reconciliation) await saveState.reconciliation;
    const name = getProfileNameForSave();
    if (!name) return;

    if (typeof setActiveProfileName === "function") {
      setActiveProfileName(name);
    }
    try {
      localStorage.setItem("activeProfileName", name);
    } catch {}
    await invoke("set_active_profile_preference", { profileName: name }).catch(() => {});
    setProfileSelection(name);

    const bindings = typeof getBindings === "function" ? getBindings() || [] : [];
    const osd = typeof getOsdSettings === "function" ? getOsdSettings() || {} : {};
    const plugin_settings =
      typeof getProfilePluginSettings === "function" ? getProfilePluginSettings() || {} : {};

    const host = typeof getPluginHost === "function" ? getPluginHost() : null;
    if (host) {
      try {
        host.setBindings(bindings);
      } catch {}
    }

    await invoke("save_profile", {
      profile: {
        name,
        bindings,
        osd_settings: buildPersistedOsdSettings(osd),
        plugin_settings,
        midi_device_preference: buildPersistedMidiDevicePreference(
          typeof getActiveProfileMidiPreference === "function" ? getActiveProfileMidiPreference() : null,
        ),
        midi_device_preference_set: true,
      },
    });
  }

  async function settleScheduledProfileSave() {
    const resolve = saveState.resolve;
    const reject = saveState.reject;
    const promise = saveState.promise;
    if (!promise) return;

    saveState.promise = null;
    saveState.resolve = null;
    saveState.reject = null;

    // Reserve our position before yielding: several flushes can arrive while
    // the same disk write is pending. Each must wait for its own predecessor.
    const previous = saveState.running;
    const running = (async () => {
      if (previous) await previous.catch(() => {});
      await persistCurrentProfile();
    })();
    saveState.running = running;
    try {
      await running;
      if (typeof resolve === "function") resolve();
    } catch (error) {
      if (typeof reject === "function") reject(error);
      throw error;
    } finally {
      if (saveState.running === running) saveState.running = null;
    }
  }

  function saveBindingsForProfile() {
    const promise = ensureSaveProfilePromise();
    if (saveState.timer) {
      clearTimeout(saveState.timer);
    }

    saveState.timer = setTimeout(() => {
      saveState.timer = null;
      settleScheduledProfileSave().catch(() => {});
    }, 500);
    return promise;
  }

  async function flushProfileSave() {
    if (saveState.reconciliation) await saveState.reconciliation;
    if (saveState.promise) {
      if (saveState.timer) {
        clearTimeout(saveState.timer);
        saveState.timer = null;
      }
      await settleScheduledProfileSave();
    }
    if (saveState.running) {
      await saveState.running;
    }
  }

  async function updateProfilePluginSettings(pluginId, nextSettings) {
    if (!pluginId || typeof pluginId !== "string") return;
    const safe = nextSettings && typeof nextSettings === "object" ? nextSettings : {};
    const current = typeof getProfilePluginSettings === "function" ? getProfilePluginSettings() || {} : {};
    const merged = { ...current, [pluginId]: safe };
    if (typeof setProfilePluginSettings === "function") {
      setProfilePluginSettings(merged);
    }

    const name =
      typeof getActiveProfileName === "function"
        ? getActiveProfileName() || localStorage.getItem("activeProfileName") || "Default"
        : localStorage.getItem("activeProfileName") || "Default";
    if (typeof setActiveProfileName === "function") {
      setActiveProfileName(name);
    }
    const host = typeof getPluginHost === "function" ? getPluginHost() : null;
    if (host) {
      try {
        host.setProfileState({ name, plugin_settings: merged });
      } catch {}
    }
    await saveBindingsForProfile();
  }

  async function updateProfileMidiPreference(nextPreference) {
    const next = toClientMidiDevicePreference(nextPreference);
    if (typeof setActiveProfileMidiPreference === "function") {
      setActiveProfileMidiPreference(next);
    }
    await saveBindingsForProfile();
  }

  return {
    reconcileMidiRoutes,
    getProfileNameForSave,
    ensureSaveProfilePromise,
    persistCurrentProfile,
    settleScheduledProfileSave,
    saveBindingsForProfile,
    flushProfileSave,
    updateProfilePluginSettings,
    updateProfileMidiPreference,
  };
}

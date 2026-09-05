import {
  normalizeMidiPreference as toClientMidiDevicePreference,
  buildPersistedMidiPreference as buildPersistedMidiDevicePreference,
} from "../../../core/midi_preferences.js";
import { fromOsdSettings, DEFAULT_OSD_SETTINGS } from "../../../core/osd_settings.js";

/** profile loading workflow. */
export function createProfileLoading({
  applyOsdSettings,
  bindingFallbackName,
  buildPersistedOsdSettings,
  closeProfileDropdown,
  defaults,
  flushProfileSave,
  getActiveProfileName,
  getCurrentMidiPreference,
  getOsdSettings,
  getPluginHost,
  invoke,
  normalizeBinding,
  normalizeProfileName,
  onProfileLoaded,
  refreshProfiles,
  renderBindings,
  setActiveProfileMidiPreference,
  setActiveProfileName,
  setBindings,
  setOsdSettings,
  setProfilePluginSettings,
  setProfileSelection,
  startPluginHostIfNeeded,
}) {
  async function loadProfileByName(name, options = {}) {
    const {
      applyOsd = true,
      persistActiveProfile = true,
      render = true,
      startPlugins = true,
      syncMidi = true,
    } = options && typeof options === "object" ? options : {};
    const n = String(name || "").trim();
    if (!n) return;
    await flushProfileSave();
    const profile = await invoke("load_profile", { name: n });

    if (typeof setActiveProfileName === "function") {
      setActiveProfileName(profile.name);
    }
    try {
      localStorage.setItem("activeProfileName", profile.name);
    } catch {}
    if (persistActiveProfile) {
      await invoke("set_active_profile_preference", { profileName: profile.name }).catch(() => {});
    }

    const pps =
      profile.plugin_settings && typeof profile.plugin_settings === "object" ? profile.plugin_settings : {};
    if (typeof setProfilePluginSettings === "function") {
      setProfilePluginSettings(pps);
    }
    const midiPref = toClientMidiDevicePreference({
      ...(profile.midi_device_preference || {}),
      midi_device_preference_set: profile.midi_device_preference_set,
    });
    if (typeof setActiveProfileMidiPreference === "function") {
      setActiveProfileMidiPreference(midiPref);
    }

    const nextBindings = (profile.bindings || []).map((binding, index) => {
      const normalized = typeof normalizeBinding === "function" ? normalizeBinding(binding) : { ...binding };
      normalized.name =
        normalized.name?.trim() ||
        (typeof bindingFallbackName === "function"
          ? bindingFallbackName(normalized, index)
          : normalized.name || "Binding");
      return normalized;
    });
    if (typeof setBindings === "function") {
      setBindings(nextBindings);
    }

    const host = typeof getPluginHost === "function" ? getPluginHost() : null;
    if (host) {
      try {
        host.setBindings(nextBindings);
      } catch {}
      try {
        host.setProfileState({ name: profile.name, plugin_settings: pps });
      } catch {}
    }
    if (startPlugins && typeof startPluginHostIfNeeded === "function") {
      await startPluginHostIfNeeded().catch(() => {});
    }

    if (profile.osd_settings) {
      const nextOsd = fromOsdSettings(profile.osd_settings, {
        ...DEFAULT_OSD_SETTINGS,
        ...defaults,
        enabled: false,
      });
      if (typeof setOsdSettings === "function") {
        setOsdSettings(nextOsd);
      }
      if (applyOsd && typeof applyOsdSettings === "function") {
        await applyOsdSettings(nextOsd);
      }
    }

    if (render && typeof renderBindings === "function") {
      renderBindings();
    }
    setProfileSelection(profile.name);
    if (syncMidi && typeof onProfileLoaded === "function") {
      await onProfileLoaded({
        name: profile.name,
        midiDevicePreference: midiPref,
        midiDevicePreferenceSet: Boolean(profile.midi_device_preference_set || midiPref.configured),
      });
    }
    return profile;
  }

  async function deleteProfileByName(name) {
    const n = String(name || "").trim();
    if (!n || n === "Default") return;
    await invoke("delete_profile", { name: n });

    const current = typeof getActiveProfileName === "function" ? getActiveProfileName() || "" : "";
    if (n === current) {
      let profiles = [];
      try {
        profiles = await invoke("list_profiles");
      } catch {
        profiles = [];
      }

      const hasDefault = profiles.some((p) => p && p.name === "Default");
      if (!hasDefault) {
        await invoke("save_profile", {
          profile: {
            name: "Default",
            bindings: [],
            osd_settings: buildPersistedOsdSettings(
              typeof getOsdSettings === "function" ? getOsdSettings() || defaults : defaults,
            ),
            plugin_settings: {},
            midi_device_preference: buildPersistedMidiDevicePreference(
              typeof getCurrentMidiPreference === "function" ? getCurrentMidiPreference() : null,
            ),
            midi_device_preference_set: true,
          },
        });
        try {
          profiles = await invoke("list_profiles");
        } catch {
          profiles = [{ name: "Default" }];
        }
      }

      const fallbackName =
        profiles.find((p) => p && p.name === "Default")?.name || profiles[0]?.name || "Default";

      await loadProfileByName(fallbackName);
      await refreshProfiles(fallbackName);
      return;
    }
    await refreshProfiles(
      typeof getActiveProfileName === "function" ? getActiveProfileName() || "Default" : "Default",
    );
  }

  async function createProfileByName(rawName) {
    const name = normalizeProfileName(rawName);
    if (!name) return;
    await invoke("save_profile", {
      profile: {
        name,
        bindings: [],
        osd_settings: buildPersistedOsdSettings(
          typeof getOsdSettings === "function" ? getOsdSettings() || defaults : defaults,
        ),
        plugin_settings: {},
        midi_device_preference: buildPersistedMidiDevicePreference({ routes: [] }),
        midi_device_preference_set: true,
      },
    });
    await loadProfileByName(name);
    await refreshProfiles(name);
    closeProfileDropdown();
  }

  return { loadProfileByName, deleteProfileByName, createProfileByName };
}

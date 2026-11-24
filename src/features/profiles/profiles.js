import { buildPersistedMidiPreference } from "../../core/midi_preferences.js";
import { createUiLifetime } from "../../app/ui_lifetime.js";
import { createImportExport } from "./controllers/import_export.js";
import { createProfileMenu } from "./controllers/profile_menu.js";
import { createProfilePage } from "./controllers/profile_page.js";
import { createProfileLoading } from "./controllers/profile_loading.js";
import { createPersistence } from "./controllers/persistence.js";
import { createProfileTargetState } from "./controllers/target_state.js";
import { DEFAULT_OSD_SETTINGS, toPersistedOsdSettings } from "../../core/osd_settings.js";
import { closeAllDropdowns } from "../ui/dropdown_badges.js";

export function createProfilesFeature({
  invoke,
  profileWrites,
  i18n,
  dom,
  defaultOsdSettings,
  getActiveProfileName,
  setActiveProfileName,
  getProfilePluginSettings,
  setProfilePluginSettings,
  getBindings,
  setBindings,
  normalizeBinding,
  bindingFallbackName,
  renderBindings,
  getPluginHost,
  startPluginHostIfNeeded,
  getOsdSettings,
  setOsdSettings,
  applyOsdSettings,
  getCurrentMidiPreference,
  setActiveProfileMidiPreference,
  onProfileLoaded,
  showAlert,
  showChoices,
  setInteractionBusy = () => {},
}) {
  if (typeof invoke !== "function") {
    throw new Error("createProfilesFeature: invoke is required");
  }
  const d = dom && typeof dom === "object" ? dom : {};
  const t = (key, params = {}) =>
    i18n && typeof i18n.t === "function" ? i18n.t(key, params) : String(key || "");
  const defaults =
    defaultOsdSettings && typeof defaultOsdSettings === "object" ? defaultOsdSettings : DEFAULT_OSD_SETTINGS;

  const viewState = {
    pendingDeleteName: null,
  };
  const lifetime = createUiLifetime();
  let uiBound = false;
  const targetState = createProfileTargetState({ invoke, getActiveProfileName, getBindings, getPluginHost });

  function normalizeProfileName(name) {
    return String(name || "").trim();
  }

  function buildImportedProfileName(baseName, existingNamesSet) {
    const cleanBase = normalizeProfileName(baseName) || "Imported Profile";
    const firstCandidate = `${cleanBase} (Imported)`;
    if (!existingNamesSet.has(firstCandidate)) {
      return firstCandidate;
    }
    let i = 2;
    while (i < 1000) {
      const candidate = `${cleanBase} (Imported ${i})`;
      if (!existingNamesSet.has(candidate)) {
        return candidate;
      }
      i += 1;
    }
    return `${cleanBase} (Imported ${Date.now()})`;
  }

  function buildPersistedOsdSettings(source) {
    return toPersistedOsdSettings(source || {}, defaults);
  }

  function emptyProfile(name, midiPreference) {
    return {
      name,
      bindings: [],
      osd_settings: buildPersistedOsdSettings(getOsdSettings?.() || defaults),
      plugin_settings: {},
      midi_device_preference: buildPersistedMidiPreference(midiPreference),
      midi_device_preference_set: true,
    };
  }

  async function listProfilesWithDefault() {
    const profiles = await invoke("list_profiles");
    if (profiles.some((profile) => profile.name === "Default")) return profiles;
    try {
      await invoke("save_profile", {
        profile: emptyProfile("Default", getCurrentMidiPreference?.()),
        activate: false,
        createOnly: true,
      });
    } catch (error) {
      // A second caller may have created Default while this request was in flight.
      const current = await invoke("list_profiles");
      if (current.some((profile) => profile.name === "Default")) return current;
      throw error;
    }
    return invoke("list_profiles");
  }

  function setProfileSelection(name) {
    if (!d.profileCurrent) return;
    d.profileCurrent.textContent = name ? String(name) : t("profiles.selectProfile");
  }

  function currentProfileSelection(fallback = "Default") {
    return (
      (typeof getActiveProfileName === "function" ? getActiveProfileName() || "" : "") ||
      localStorage.getItem("activeProfileName") ||
      fallback ||
      "Default"
    );
  }

  function updateProfileMenuSelection(name) {
    if (!d.profileList) return;
    const selectedName = normalizeProfileName(name) || "Default";
    d.profileList.querySelectorAll(".dropdown-item:not(.create)").forEach((item) => {
      const profileName = item.dataset.profileName || item.querySelector("button")?.textContent || "";
      item.classList.toggle("selected", normalizeProfileName(profileName) === selectedName);
    });
  }

  function closeProfileDropdown() {
    if (d.profileList) {
      d.profileList.classList.add("hidden");
    }
    if (d.profileDropdown) {
      d.profileDropdown.classList.remove("open");
    }
    if (d.profileToggle) {
      d.profileToggle.setAttribute("aria-expanded", "false");
    }
    viewState.pendingDeleteName = null;
  }

  function bindUi() {
    if (uiBound) return;
    uiBound = true;
    if (d.profileToggle) {
      lifetime.listen(d.profileToggle, "click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (d.profileList) {
          const opening = d.profileList.classList.contains("hidden");
          if (opening) {
            await refreshProfiles(currentProfileSelection());
          } else {
            updateProfileMenuSelection(currentProfileSelection());
          }
          closeAllDropdowns({ except: opening ? d.profileDropdown : null });
          d.profileList.classList.toggle("hidden", !opening);
          if (d.profileDropdown) {
            d.profileDropdown.classList.toggle("open", opening);
          }
          d.profileToggle.setAttribute("aria-expanded", String(opening));
        }
      });
    }

    lifetime.listen(document, "click", (event) => {
      if (!d.profileDropdown) return;
      if (!d.profileDropdown.contains(event.target)) {
        closeProfileDropdown();
      }
    });

    if (d.profilePageCreateInput) {
      lifetime.listen(d.profilePageCreateInput, "keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          createProfileByName(d.profilePageCreateInput.value).then((created) => {
            if (created) d.profilePageCreateInput.value = "";
          });
        }
      });
    }
    if (d.profilePageCreateButton) {
      lifetime.listen(d.profilePageCreateButton, "click", () => {
        createProfileByName(d.profilePageCreateInput?.value || "").then((created) => {
          if (created && d.profilePageCreateInput) d.profilePageCreateInput.value = "";
        });
      });
    }
    if (d.profilePageImportButton) {
      lifetime.listen(d.profilePageImportButton, "click", () => {
        importProfileFromFile();
      });
    }
    if (d.profilePageExportCurrentButton) {
      lifetime.listen(d.profilePageExportCurrentButton, "click", () => {
        exportCurrentProfile();
      });
    }
    lifetime.listen(window, "midimaster:locale-changed", () => {
      refreshProfiles(currentProfileSelection()).catch(() => {});
    });
  }

  const { reconcileMidiRoutes, flushProfileSave, updateProfilePluginSettings, updateProfileMidiPreference } =
    createPersistence({
      invoke, profileWrites, getActiveProfileName, getPluginHost, getProfilePluginSettings,
      setProfilePluginSettings, setActiveProfileMidiPreference, setBindings, renderBindings,
      setMidiReconciliationBusy: (busy) => setInteractionBusy("midi", busy),
    });

  const { loadProfileByName, deleteProfileByName, createProfileByName } = createProfileLoading({
    showAlert,
    t,
    setProfileLoadingBusy: (busy) => setInteractionBusy("profile", busy),
    applyOsdSettings,
    bindingFallbackName,
    emptyProfile,
    listProfilesWithDefault,
    closeProfileDropdown,
    defaults,
    flushProfileSave,
    getActiveProfileName,
    getPluginHost,
    invoke,
    normalizeBinding,
    normalizeProfileName,
    onProfileLoaded,
    refreshProfiles: (...args) => refreshProfiles(...args),
    renderBindings,
    setActiveProfileMidiPreference,
    setActiveProfileName,
    setBindings,
    setOsdSettings,
    setProfilePluginSettings,
    setProfileSelection,
    startPluginHostIfNeeded,
    targetState,
  });

  const { renderProfilePage } = createProfilePage({
    d,
    deleteProfileByName,
    exportProfileByName: (...args) => exportProfileByName(...args),
    loadProfileByName,
    refreshProfiles: (...args) => refreshProfiles(...args),
    t,
    viewState,
  });

  const { refreshProfiles } = createProfileMenu({
    listProfilesWithDefault,
    closeProfileDropdown,
    createProfileByName,
    d,
    deleteProfileByName,
    exportProfileByName: (...args) => exportProfileByName(...args),
    getActiveProfileName,
    importProfileFromFile: (...args) => importProfileFromFile(...args),
    loadProfileByName,
    renderProfilePage,
    setProfileSelection,
    t,
    updateProfileMenuSelection,
    viewState,
  });

  const { exportProfileByName, importProfileFromFile, exportCurrentProfile } = createImportExport({
    buildImportedProfileName,
    closeProfileDropdown,
    getActiveProfileName,
    invoke,
    loadProfileByName,
    normalizeProfileName,
    refreshProfiles,
    showAlert,
    showChoices,
    t,
    flushProfileSave,
    targetState,
  });

  return {
    dispose: async () => {
      lifetime.dispose();
      await flushProfileSave();
      await targetState.dispose();
    },
    bindUi,
    refreshProfiles,
    loadProfileByName,
    deleteProfileByName,
    setProfileSelection,
    closeProfileDropdown,
    flushProfileSave,
    reconcileMidiRoutes,
    updateProfilePluginSettings,
    updateProfileMidiPreference,
    exportProfileByName,
    importProfileFromFile,
    exportCurrentProfile,
  };
}

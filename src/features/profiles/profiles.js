import { createUiLifetime } from "../../app/ui_lifetime.js";
import { createImportExport } from "./controllers/import_export.js";
import { createProfileMenu } from "./controllers/profile_menu.js";
import { createProfilePage } from "./controllers/profile_page.js";
import { createProfileLoading } from "./controllers/profile_loading.js";
import { createPersistence } from "./controllers/persistence.js";
import { DEFAULT_OSD_SETTINGS, toPersistedOsdSettings } from "../../core/osd_settings.js";
import { closeAllDropdowns } from "../ui/dropdown_badges.js";

export function createProfilesFeature({
  invoke,
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
  getActiveProfileMidiPreference,
  setActiveProfileMidiPreference,
  onProfileLoaded,
  showAlert,
  showChoices,
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
  const saveState = {
    timer: null,
    promise: null,
    running: null,
    resolve: null,
    reject: null,
  };

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
          createProfileByName(d.profilePageCreateInput.value).then(() => {
            d.profilePageCreateInput.value = "";
          });
        }
      });
    }
    if (d.profilePageCreateButton) {
      lifetime.listen(d.profilePageCreateButton, "click", () => {
        createProfileByName(d.profilePageCreateInput?.value || "").then(() => {
          if (d.profilePageCreateInput) d.profilePageCreateInput.value = "";
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

  const {
    getProfileNameForSave,
    ensureSaveProfilePromise,
    persistCurrentProfile,
    settleScheduledProfileSave,
    saveBindingsForProfile,
    flushProfileSave,
    updateProfilePluginSettings,
    updateProfileMidiPreference,
  } = createPersistence({
    buildPersistedOsdSettings: (...args) => buildPersistedOsdSettings(...args),
    currentProfileSelection: (...args) => currentProfileSelection(...args),
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
    setProfileSelection: (...args) => setProfileSelection(...args),
  });

  const { loadProfileByName, deleteProfileByName, createProfileByName } = createProfileLoading({
    applyOsdSettings,
    bindingFallbackName,
    buildPersistedOsdSettings: (...args) => buildPersistedOsdSettings(...args),
    closeProfileDropdown: (...args) => closeProfileDropdown(...args),
    defaults,
    flushProfileSave: (...args) => flushProfileSave(...args),
    getActiveProfileName,
    getCurrentMidiPreference,
    getOsdSettings,
    getPluginHost,
    invoke,
    normalizeBinding,
    normalizeProfileName: (...args) => normalizeProfileName(...args),
    onProfileLoaded,
    refreshProfiles: (...args) => refreshProfiles(...args),
    renderBindings,
    setActiveProfileMidiPreference,
    setActiveProfileName,
    setBindings,
    setOsdSettings,
    setProfilePluginSettings,
    setProfileSelection: (...args) => setProfileSelection(...args),
    startPluginHostIfNeeded,
  });

  const { renderProfilePage } = createProfilePage({
    d,
    deleteProfileByName: (...args) => deleteProfileByName(...args),
    exportProfileByName: (...args) => exportProfileByName(...args),
    loadProfileByName: (...args) => loadProfileByName(...args),
    refreshProfiles: (...args) => refreshProfiles(...args),
    t: (...args) => t(...args),
    viewState,
  });

  const { refreshProfiles } = createProfileMenu({
    buildPersistedOsdSettings: (...args) => buildPersistedOsdSettings(...args),
    closeProfileDropdown: (...args) => closeProfileDropdown(...args),
    createProfileByName: (...args) => createProfileByName(...args),
    d,
    defaults,
    deleteProfileByName: (...args) => deleteProfileByName(...args),
    exportProfileByName: (...args) => exportProfileByName(...args),
    getActiveProfileName,
    getCurrentMidiPreference,
    getOsdSettings,
    importProfileFromFile: (...args) => importProfileFromFile(...args),
    invoke,
    loadProfileByName: (...args) => loadProfileByName(...args),
    renderProfilePage: (...args) => renderProfilePage(...args),
    setProfileSelection: (...args) => setProfileSelection(...args),
    t: (...args) => t(...args),
    updateProfileMenuSelection: (...args) => updateProfileMenuSelection(...args),
    viewState,
  });

  const { exportProfileByName, importProfileFromFile, exportCurrentProfile } = createImportExport({
    buildImportedProfileName: (...args) => buildImportedProfileName(...args),
    closeProfileDropdown: (...args) => closeProfileDropdown(...args),
    getActiveProfileName,
    invoke,
    loadProfileByName: (...args) => loadProfileByName(...args),
    normalizeProfileName: (...args) => normalizeProfileName(...args),
    refreshProfiles: (...args) => refreshProfiles(...args),
    showAlert,
    showChoices,
    t: (...args) => t(...args),
  });

  return {
    dispose: () => {
      lifetime.dispose();
      return flushProfileSave();
    },
    bindUi,
    refreshProfiles,
    loadProfileByName,
    deleteProfileByName,
    setProfileSelection,
    closeProfileDropdown,
    saveBindingsForProfile,
    flushProfileSave,
    updateProfilePluginSettings,
    updateProfileMidiPreference,
    exportProfileByName,
    importProfileFromFile,
    exportCurrentProfile,
  };
}

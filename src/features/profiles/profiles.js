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
  const d = (dom && typeof dom === "object") ? dom : {};
  const t = (key, params = {}) => (i18n && typeof i18n.t === "function") ? i18n.t(key, params) : String(key || "");
  const defaults = (defaultOsdSettings && typeof defaultOsdSettings === "object") ? defaultOsdSettings : {
    enabled: true,
    monitorIndex: 0,
    anchor: "top-right",
    style: "midnight",
    opacity: 0.96,
    scale: 1,
  };

  let pendingProfileDeleteName = null;
  let saveProfileTimer = null;

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
    const current = (source && typeof source === "object") ? source : {};
    return {
      enabled: Boolean(current.enabled ?? defaults.enabled),
      monitor_index: Number(current.monitorIndex ?? defaults.monitorIndex ?? 0),
      monitor_name: current.monitorName || null,
      monitor_id: current.monitorId || null,
      anchor: current.anchor || defaults.anchor || "top-right",
      style: current.style || defaults.style || "midnight",
      opacity: Number(current.opacity ?? defaults.opacity ?? 0.96),
      scale: Number(current.scale ?? defaults.scale ?? 1),
    };
  }

  function buildPersistedMidiDevicePreference(source) {
    const current = (source && typeof source === "object") ? source : {};
    const inputDeviceId = String(current.inputDeviceId || current.input_device_id || "").trim();
    const outputDeviceId = String(current.outputDeviceId || current.output_device_id || "").trim();
    const inputDeviceName = String(current.inputDeviceName || current.input_device_name || "").trim();
    const outputDeviceName = String(current.outputDeviceName || current.output_device_name || "").trim();

    return {
      input_device_id: inputDeviceId || null,
      output_device_id: outputDeviceId || null,
      input_device_name: inputDeviceName || null,
      output_device_name: outputDeviceName || null,
    };
  }

  function toClientMidiDevicePreference(source) {
    const persisted = buildPersistedMidiDevicePreference(source);
    return {
      inputDeviceId: persisted.input_device_id || "",
      outputDeviceId: persisted.output_device_id || "",
      inputDeviceName: persisted.input_device_name || "",
      outputDeviceName: persisted.output_device_name || "",
    };
  }

  function setProfileSelection(name) {
    if (!d.profileCurrent) return;
    d.profileCurrent.textContent = name ? String(name) : t("profiles.selectProfile");
  }

  function currentProfileSelection(fallback = "Default") {
    return (
      (typeof getActiveProfileName === "function" ? (getActiveProfileName() || "") : "")
      || localStorage.getItem("activeProfileName")
      || fallback
      || "Default"
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
    pendingProfileDeleteName = null;
  }

  async function loadProfileByName(name) {
    const n = String(name || "").trim();
    if (!n) return;
    const profile = await invoke("load_profile", { name: n });

    if (typeof setActiveProfileName === "function") {
      setActiveProfileName(profile.name);
    }
    try {
      localStorage.setItem("activeProfileName", profile.name);
    } catch { }
    await invoke("set_active_profile_preference", { profileName: profile.name }).catch(() => { });

    const pps = (profile.plugin_settings && typeof profile.plugin_settings === "object")
      ? profile.plugin_settings
      : {};
    if (typeof setProfilePluginSettings === "function") {
      setProfilePluginSettings(pps);
    }
    const midiPref = toClientMidiDevicePreference(profile.midi_device_preference);
    if (typeof setActiveProfileMidiPreference === "function") {
      setActiveProfileMidiPreference(midiPref);
    }

    const nextBindings = (profile.bindings || []).map((binding, index) => ({
      ...binding,
      name: binding.name?.trim() || (typeof bindingFallbackName === "function" ? bindingFallbackName(binding, index) : (binding.name || "Binding")),
    }));
    if (typeof setBindings === "function") {
      setBindings(nextBindings);
    }

    const host = (typeof getPluginHost === "function") ? getPluginHost() : null;
    if (host) {
      try { host.setBindings(nextBindings); } catch { }
      try { host.setProfileState({ name: profile.name, plugin_settings: pps }); } catch { }
    }
    if (typeof startPluginHostIfNeeded === "function") {
      await startPluginHostIfNeeded().catch(() => { });
    }

    if (profile.osd_settings) {
      const nextOsd = {
        enabled: Boolean(profile.osd_settings.enabled),
        monitorIndex: Number(profile.osd_settings.monitor_index ?? 0),
        monitorName: profile.osd_settings.monitor_name || null,
        monitorId: profile.osd_settings.monitor_id || null,
        anchor: profile.osd_settings.anchor || "top-right",
        style: profile.osd_settings.style || defaults.style || "midnight",
        opacity: Number(profile.osd_settings.opacity ?? defaults.opacity ?? 0.96),
        scale: Number(profile.osd_settings.scale ?? defaults.scale ?? 1),
      };
      if (typeof setOsdSettings === "function") {
        setOsdSettings(nextOsd);
      }
      if (typeof applyOsdSettings === "function") {
        await applyOsdSettings(nextOsd);
      }
    }

    if (typeof renderBindings === "function") {
      renderBindings();
    }
    setProfileSelection(profile.name);
    if (typeof onProfileLoaded === "function") {
      await onProfileLoaded({
        name: profile.name,
        midiDevicePreference: midiPref,
      });
    }
  }

  async function deleteProfileByName(name) {
    const n = String(name || "").trim();
    if (!n || n === "Default") return;
    await invoke("delete_profile", { name: n });

    const current = (typeof getActiveProfileName === "function") ? (getActiveProfileName() || "") : "";
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
              (typeof getOsdSettings === "function") ? (getOsdSettings() || defaults) : defaults
            ),
            plugin_settings: {},
            midi_device_preference: buildPersistedMidiDevicePreference(
              (typeof getCurrentMidiPreference === "function") ? getCurrentMidiPreference() : null
            ),
          },
        });
        try {
          profiles = await invoke("list_profiles");
        } catch {
          profiles = [{ name: "Default" }];
        }
      }

      const fallbackName = (
        profiles.find((p) => p && p.name === "Default")?.name
        || profiles[0]?.name
        || "Default"
      );

      await loadProfileByName(fallbackName);
      await refreshProfiles(fallbackName);
      return;
    }
    await refreshProfiles((typeof getActiveProfileName === "function") ? (getActiveProfileName() || "Default") : "Default");
  }

  async function createProfileByName(rawName) {
    const name = normalizeProfileName(rawName);
    if (!name) return;
    const inheritedMidi = (typeof getCurrentMidiPreference === "function")
      ? getCurrentMidiPreference()
      : null;
    await invoke("save_profile", {
      profile: {
        name,
        bindings: [],
        osd_settings: buildPersistedOsdSettings(
          (typeof getOsdSettings === "function") ? (getOsdSettings() || defaults) : defaults
        ),
        plugin_settings: {},
        midi_device_preference: buildPersistedMidiDevicePreference(inheritedMidi),
      },
    });
    await loadProfileByName(name);
    await refreshProfiles(name);
    closeProfileDropdown();
  }

  function renderProfilePage(profiles, currentSelection) {
    if (!d.profilePageList) return;
    d.profilePageList.innerHTML = "";

    const safeProfiles = Array.isArray(profiles) ? profiles : [];
    if (!safeProfiles.length) {
      const empty = document.createElement("div");
      empty.className = "profile-page-empty";
      empty.textContent = t("profiles.noProfiles");
      d.profilePageList.appendChild(empty);
      return;
    }

    safeProfiles.forEach((profile) => {
      if (!profile || !profile.name) return;
      const row = document.createElement("div");
      row.className = "profile-page-row";
      row.classList.toggle("active", profile.name === currentSelection);
      if (pendingProfileDeleteName === profile.name) row.classList.add("confirming");

      const details = document.createElement("button");
      details.type = "button";
      details.className = "profile-page-select";
      details.innerHTML = `
        <span class="profile-page-name"></span>
        <span class="profile-page-meta">${profile.name === currentSelection ? t("profiles.activeProfile") : t("profiles.savedProfile")}</span>
      `;
      details.querySelector(".profile-page-name").textContent = profile.name;
      details.addEventListener("click", async () => {
        pendingProfileDeleteName = null;
        await loadProfileByName(profile.name);
        await refreshProfiles(profile.name);
      });

      const actions = document.createElement("div");
      actions.className = "profile-page-row-actions";

      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "secondary-action";
      exportButton.textContent = t("profiles.export");
      exportButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        await exportProfileByName(profile.name);
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "danger-action";
      deleteButton.textContent = profile.name === "Default" ? t("profiles.locked") : t("common.delete");
      deleteButton.disabled = profile.name === "Default";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (profile.name === "Default") return;
        pendingProfileDeleteName = profile.name;
        refreshProfiles(currentSelection || "Default");
      });

      if (pendingProfileDeleteName === profile.name && profile.name !== "Default") {
        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.className = "secondary-action";
        cancelButton.textContent = t("common.cancel");
        cancelButton.addEventListener("click", (event) => {
          event.stopPropagation();
          pendingProfileDeleteName = null;
          refreshProfiles(currentSelection || "Default");
        });

        const confirmButton = document.createElement("button");
        confirmButton.type = "button";
        confirmButton.className = "danger-action";
        confirmButton.textContent = t("common.confirm");
        confirmButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          pendingProfileDeleteName = null;
          await deleteProfileByName(profile.name);
        });

        actions.appendChild(cancelButton);
        actions.appendChild(confirmButton);
      } else {
        actions.appendChild(exportButton);
        actions.appendChild(deleteButton);
      }

      row.appendChild(details);
      row.appendChild(actions);
      d.profilePageList.appendChild(row);
    });
  }

  async function refreshProfiles(preferredName = "") {
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
            (typeof getOsdSettings === "function") ? (getOsdSettings() || defaults) : defaults
          ),
          plugin_settings: {},
          midi_device_preference: buildPersistedMidiDevicePreference(
            (typeof getCurrentMidiPreference === "function") ? getCurrentMidiPreference() : null
          ),
        },
      });
      profiles = await invoke("list_profiles");
    }

    const currentSelection = preferredName
      || (typeof getActiveProfileName === "function" ? (getActiveProfileName() || "") : "")
      || "Default";

    if (!d.profileList) return;
    d.profileList.innerHTML = "";

    const createItem = document.createElement("div");
    createItem.className = "dropdown-item create profile-menu-tools";

    const createInput = document.createElement("input");
    createInput.type = "text";
    createInput.placeholder = t("profiles.newProfileName");
    ["pointerdown", "mousedown", "click"].forEach((eventName) => {
      createInput.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    });

    const createButton = document.createElement("button");
    createButton.type = "button";
    createButton.textContent = t("profiles.create");
    ["pointerdown", "mousedown", "click"].forEach((eventName) => {
      createButton.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    });

    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.className = "icon-action";
    importButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
    importButton.title = t("profiles.importJson");
    importButton.setAttribute("aria-label", t("profiles.importProfile"));
    ["pointerdown", "mousedown", "click"].forEach((eventName) => {
      importButton.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    });
    importButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await importProfileFromFile();
    });

    const exportCurrentButton = document.createElement("button");
    exportCurrentButton.type = "button";
    exportCurrentButton.className = "icon-action";
    exportCurrentButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/></svg>';
    exportCurrentButton.title = t("profiles.exportNamed", { name: currentSelection || "Default" });
    exportCurrentButton.setAttribute("aria-label", t("profiles.exportCurrentNamed", { name: currentSelection || "Default" }));
    ["pointerdown", "mousedown", "click"].forEach((eventName) => {
      exportCurrentButton.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    });
    exportCurrentButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await exportProfileByName(currentSelection || "Default");
    });

    const createProfile = async () => {
      await createProfileByName(createInput.value);
      createInput.value = "";
      if (d.profilePageCreateInput) d.profilePageCreateInput.value = "";
    };

    createInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        createProfile();
      }
    });
    createButton.addEventListener("click", createProfile);

    const createRow = document.createElement("div");
    createRow.className = "profile-menu-create-row";
    ["pointerdown", "mousedown", "click"].forEach((eventName) => {
      createRow.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    });
    createRow.appendChild(createInput);
    createRow.appendChild(createButton);
    createRow.appendChild(importButton);
    createRow.appendChild(exportCurrentButton);

    createItem.appendChild(createRow);
    d.profileList.appendChild(createItem);

    profiles.forEach((profile) => {
      const item = document.createElement("div");
      item.className = "dropdown-item";
      item.dataset.profileName = profile.name;
      if (profile.name === currentSelection) {
        item.classList.add("selected");
      }

      if (pendingProfileDeleteName === profile.name) {
        item.classList.add("confirming");
      }

      const selectButton = document.createElement("button");
      selectButton.type = "button";
      selectButton.textContent = profile.name;
      selectButton.addEventListener("click", async () => {
        pendingProfileDeleteName = null;
        await loadProfileByName(profile.name);
        closeProfileDropdown();
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "delete";
      deleteButton.textContent = "x";
      if (profile.name === "Default") {
        deleteButton.disabled = true;
      }
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (profile.name === "Default") return;
        pendingProfileDeleteName = profile.name;
        refreshProfiles(currentSelection || "Default");
      });

      item.appendChild(selectButton);

      if (pendingProfileDeleteName === profile.name && profile.name !== "Default") {
        const confirmButton = document.createElement("button");
        confirmButton.type = "button";
        confirmButton.className = "delete confirm";
        confirmButton.textContent = t("common.delete");
        confirmButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          pendingProfileDeleteName = null;
          await deleteProfileByName(profile.name);
        });

        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.className = "secondary";
        cancelButton.textContent = t("common.cancel");
        cancelButton.addEventListener("click", (event) => {
          event.stopPropagation();
          pendingProfileDeleteName = null;
          refreshProfiles(currentSelection || "Default");
        });

        item.appendChild(cancelButton);
        item.appendChild(confirmButton);
      } else {
        item.appendChild(deleteButton);
      }

      d.profileList.appendChild(item);
    });

    setProfileSelection(currentSelection || "Default");
    updateProfileMenuSelection(currentSelection || "Default");
    renderProfilePage(profiles, currentSelection || "Default");
  }

  function getProfileNameForSave() {
    const current = (typeof getActiveProfileName === "function") ? (getActiveProfileName() || "") : "";
    if (current) return current;
    const name = window.prompt("Profile name", "");
    return name ? name.trim() : "";
  }

  async function saveBindingsForProfile() {
    if (saveProfileTimer) {
      clearTimeout(saveProfileTimer);
    }

    saveProfileTimer = setTimeout(async () => {
      const name = getProfileNameForSave();
      if (!name) return;

      if (typeof setActiveProfileName === "function") {
        setActiveProfileName(name);
      }
      try { localStorage.setItem("activeProfileName", name); } catch { }
      await invoke("set_active_profile_preference", { profileName: name }).catch(() => { });
      setProfileSelection(name);

      const bindings = (typeof getBindings === "function") ? (getBindings() || []) : [];
      const osd = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
      const plugin_settings = (typeof getProfilePluginSettings === "function") ? (getProfilePluginSettings() || {}) : {};

      const host = (typeof getPluginHost === "function") ? getPluginHost() : null;
      if (host) {
        try { host.setBindings(bindings); } catch { }
      }

      await invoke("save_profile", {
        profile: {
          name,
          bindings,
          osd_settings: buildPersistedOsdSettings(osd),
          plugin_settings,
          midi_device_preference: buildPersistedMidiDevicePreference(
            (typeof getActiveProfileMidiPreference === "function") ? getActiveProfileMidiPreference() : null
          ),
        },
      });
    }, 500);
  }

  async function updateProfilePluginSettings(pluginId, nextSettings) {
    if (!pluginId || typeof pluginId !== "string") return;
    const safe = (nextSettings && typeof nextSettings === "object") ? nextSettings : {};
    const current = (typeof getProfilePluginSettings === "function") ? (getProfilePluginSettings() || {}) : {};
    const merged = { ...current, [pluginId]: safe };
    if (typeof setProfilePluginSettings === "function") {
      setProfilePluginSettings(merged);
    }

    const name = (typeof getActiveProfileName === "function")
      ? (getActiveProfileName() || localStorage.getItem("activeProfileName") || "Default")
      : (localStorage.getItem("activeProfileName") || "Default");
    if (typeof setActiveProfileName === "function") {
      setActiveProfileName(name);
    }
    const host = (typeof getPluginHost === "function") ? getPluginHost() : null;
    if (host) {
      try { host.setProfileState({ name, plugin_settings: merged }); } catch { }
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

  async function exportProfileByName(name) {
    const profileName = normalizeProfileName(name);
    if (!profileName) return;

    try {
      const savedPath = await invoke("export_current_profile", { profileName });
      if (savedPath && typeof showAlert === "function") {
        showAlert(t("profiles.exportedTitle"), t("profiles.exportedMessage", { path: savedPath }));
      }
    } catch (error) {
      if (typeof showAlert === "function") {
        showAlert(t("profiles.exportFailedTitle"), String(error));
      }
    }
  }

  async function importProfileFromFile() {
    try {
      const importedProfile = await invoke("import_profile_from_file");
      if (!importedProfile) return;

      const baseName = normalizeProfileName(importedProfile.name) || "Imported Profile";
      let nextName = baseName;

      let profiles = [];
      try {
        profiles = await invoke("list_profiles");
      } catch {
        profiles = [];
      }
      const existingNames = new Set(
        (profiles || [])
          .map((profile) => normalizeProfileName(profile?.name))
          .filter(Boolean)
      );

      if (existingNames.has(baseName)) {
        let choice = "replace";
        if (typeof showChoices === "function") {
          choice = await showChoices({
            title: t("profiles.alreadyExistsTitle"),
            message: t("profiles.alreadyExistsMessage", { name: baseName }),
            options: [
              { id: "replace", label: t("profiles.replace"), variant: "primary" },
              { id: "keep_both", label: t("profiles.keepBoth"), variant: "secondary" },
              { id: "cancel", label: t("common.cancel"), variant: "secondary" },
            ],
          });
        } else if (typeof window !== "undefined" && typeof window.confirm === "function") {
          const replace = window.confirm(t("profiles.replaceConfirm", { name: baseName }));
          choice = replace ? "replace" : "keep_both";
        }

        if (choice === "cancel" || choice === "close") return;
        if (choice === "keep_both") {
          nextName = buildImportedProfileName(baseName, existingNames);
        }
      }

      const profileToSave = {
        ...importedProfile,
        name: nextName,
      };

      await invoke("save_profile", { profile: profileToSave });
      await loadProfileByName(nextName);
      await refreshProfiles(nextName);
      closeProfileDropdown();

      if (typeof showAlert === "function") {
        if (nextName !== baseName) {
          showAlert(t("profiles.importedTitle"), t("profiles.importedAsMessage", { name: nextName }));
        } else {
          showAlert(t("profiles.importedTitle"), t("profiles.importedMessage", { name: nextName }));
        }
      }
    } catch (error) {
      if (typeof showAlert === "function") {
        showAlert(t("profiles.importFailedTitle"), String(error));
      }
    }
  }

  async function exportCurrentProfile() {
    const name = (typeof getActiveProfileName === "function")
      ? (getActiveProfileName() || localStorage.getItem("activeProfileName") || "Default")
      : (localStorage.getItem("activeProfileName") || "Default");
    const profileName = String(name || "").trim() || "Default";
    await exportProfileByName(profileName);
  }

  function bindUi() {
    if (d.profileToggle) {
      d.profileToggle.addEventListener("click", async (event) => {
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

    document.addEventListener("click", (event) => {
      if (!d.profileDropdown) return;
      if (!d.profileDropdown.contains(event.target)) {
        closeProfileDropdown();
      }
    });

    if (d.profilePageCreateInput) {
      d.profilePageCreateInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          createProfileByName(d.profilePageCreateInput.value).then(() => {
            d.profilePageCreateInput.value = "";
          });
        }
      });
    }
    if (d.profilePageCreateButton) {
      d.profilePageCreateButton.addEventListener("click", () => {
        createProfileByName(d.profilePageCreateInput?.value || "").then(() => {
          if (d.profilePageCreateInput) d.profilePageCreateInput.value = "";
        });
      });
    }
    if (d.profilePageImportButton) {
      d.profilePageImportButton.addEventListener("click", () => {
        importProfileFromFile();
      });
    }
    if (d.profilePageExportCurrentButton) {
      d.profilePageExportCurrentButton.addEventListener("click", () => {
        exportCurrentProfile();
      });
    }
    window.addEventListener("midimaster:locale-changed", () => {
      refreshProfiles(currentProfileSelection()).catch(() => {});
    });
  }

  return {
    bindUi,
    refreshProfiles,
    loadProfileByName,
    deleteProfileByName,
    setProfileSelection,
    closeProfileDropdown,
    saveBindingsForProfile,
    updateProfilePluginSettings,
    updateProfileMidiPreference,
    exportProfileByName,
    importProfileFromFile,
    exportCurrentProfile,
  };
}

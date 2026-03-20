export function createProfilesFeature({
  invoke,
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
}) {
  if (typeof invoke !== "function") {
    throw new Error("createProfilesFeature: invoke is required");
  }
  const d = (dom && typeof dom === "object") ? dom : {};
  const defaults = (defaultOsdSettings && typeof defaultOsdSettings === "object") ? defaultOsdSettings : {
    enabled: true,
    monitorIndex: 0,
    anchor: "top-right",
  };

  let pendingProfileDeleteName = null;
  let saveProfileTimer = null;

  function buildPersistedOsdSettings(source) {
    const current = (source && typeof source === "object") ? source : {};
    return {
      enabled: Boolean(current.enabled ?? defaults.enabled),
      monitor_index: Number(current.monitorIndex ?? defaults.monitorIndex ?? 0),
      monitor_name: current.monitorName || null,
      monitor_id: current.monitorId || null,
      anchor: current.anchor || defaults.anchor || "top-right",
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
    d.profileCurrent.textContent = name ? String(name) : "Select profile";
  }

  function closeProfileDropdown() {
    if (d.profileList) {
      d.profileList.classList.add("hidden");
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
      if (typeof setActiveProfileName === "function") {
        setActiveProfileName("Default");
      }
      try { localStorage.setItem("activeProfileName", "Default"); } catch { }
      await invoke("set_active_profile_preference", { profileName: "Default" }).catch(() => { });
      if (typeof setBindings === "function") {
        setBindings([]);
      }
      if (typeof renderBindings === "function") {
        renderBindings();
      }
    }
    await refreshProfiles((typeof getActiveProfileName === "function") ? (getActiveProfileName() || "Default") : "Default");
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
    createItem.className = "dropdown-item create";

    const createInput = document.createElement("input");
    createInput.type = "text";
    createInput.placeholder = "New profile name";

    const createButton = document.createElement("button");
    createButton.type = "button";
    createButton.textContent = "Create";

    const createProfile = async () => {
      const name = createInput.value.trim();
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
    };

    createInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        createProfile();
      }
    });
    createButton.addEventListener("click", createProfile);

    createItem.appendChild(createInput);
    createItem.appendChild(createButton);
    d.profileList.appendChild(createItem);

    profiles.forEach((profile) => {
      const item = document.createElement("div");
      item.className = "dropdown-item";

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
      deleteButton.textContent = "×";
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
        confirmButton.textContent = "Delete";
        confirmButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          pendingProfileDeleteName = null;
          await deleteProfileByName(profile.name);
        });

        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.className = "secondary";
        cancelButton.textContent = "Cancel";
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

  function bindUi() {
    if (d.profileToggle) {
      d.profileToggle.addEventListener("click", async () => {
        if (d.profileList && d.profileList.childElementCount === 0) {
          await refreshProfiles((typeof getActiveProfileName === "function") ? (getActiveProfileName() || "") : "");
        }
        if (d.profileList) {
          d.profileList.classList.toggle("hidden");
        }
      });
    }

    document.addEventListener("click", (event) => {
      if (!d.profileDropdown) return;
      if (!d.profileDropdown.contains(event.target)) {
        closeProfileDropdown();
      }
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
  };
}

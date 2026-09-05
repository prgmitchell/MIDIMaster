import { buildPersistedMidiPreference as buildPersistedMidiDevicePreference } from "../../../core/midi_preferences.js";

/** profile menu workflow. */
export function createProfileMenu({
  buildPersistedOsdSettings,
  closeProfileDropdown,
  createProfileByName,
  d,
  defaults,
  deleteProfileByName,
  exportProfileByName,
  getActiveProfileName,
  getCurrentMidiPreference,
  getOsdSettings,
  importProfileFromFile,
  invoke,
  loadProfileByName,
  renderProfilePage,
  setProfileSelection,
  t,
  updateProfileMenuSelection,
  viewState,
}) {
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
            typeof getOsdSettings === "function" ? getOsdSettings() || defaults : defaults,
          ),
          plugin_settings: {},
          midi_device_preference: buildPersistedMidiDevicePreference(
            typeof getCurrentMidiPreference === "function" ? getCurrentMidiPreference() : null,
          ),
          midi_device_preference_set: true,
        },
      });
      profiles = await invoke("list_profiles");
    }

    const currentSelection =
      preferredName ||
      (typeof getActiveProfileName === "function" ? getActiveProfileName() || "" : "") ||
      "Default";

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
    importButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
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
    exportCurrentButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/></svg>';
    exportCurrentButton.title = t("profiles.exportNamed", { name: currentSelection || "Default" });
    exportCurrentButton.setAttribute(
      "aria-label",
      t("profiles.exportCurrentNamed", { name: currentSelection || "Default" }),
    );
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

      if (viewState.pendingDeleteName === profile.name) {
        item.classList.add("confirming");
      }

      const selectButton = document.createElement("button");
      selectButton.type = "button";
      selectButton.textContent = profile.name;
      selectButton.addEventListener("click", async () => {
        viewState.pendingDeleteName = null;
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
        viewState.pendingDeleteName = profile.name;
        refreshProfiles(currentSelection || "Default");
      });

      item.appendChild(selectButton);

      if (viewState.pendingDeleteName === profile.name && profile.name !== "Default") {
        const confirmButton = document.createElement("button");
        confirmButton.type = "button";
        confirmButton.className = "delete confirm";
        confirmButton.textContent = t("common.delete");
        confirmButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          viewState.pendingDeleteName = null;
          await deleteProfileByName(profile.name);
        });

        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.className = "secondary";
        cancelButton.textContent = t("common.cancel");
        cancelButton.addEventListener("click", (event) => {
          event.stopPropagation();
          viewState.pendingDeleteName = null;
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

  return { refreshProfiles };
}

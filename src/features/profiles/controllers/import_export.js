/** import export workflow. */
export function createImportExport({
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
}) {
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
        (profiles || []).map((profile) => normalizeProfileName(profile?.name)).filter(Boolean),
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
    const name =
      typeof getActiveProfileName === "function"
        ? getActiveProfileName() || localStorage.getItem("activeProfileName") || "Default"
        : localStorage.getItem("activeProfileName") || "Default";
    const profileName = String(name || "").trim() || "Default";
    await exportProfileByName(profileName);
  }

  return { exportProfileByName, importProfileFromFile, exportCurrentProfile };
}

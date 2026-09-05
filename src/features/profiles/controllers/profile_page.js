/** profile page workflow. */
export function createProfilePage({
  d,
  deleteProfileByName,
  exportProfileByName,
  loadProfileByName,
  refreshProfiles,
  t,
  viewState,
}) {
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
      if (viewState.pendingDeleteName === profile.name) row.classList.add("confirming");

      const details = document.createElement("button");
      details.type = "button";
      details.className = "profile-page-select";
      details.innerHTML = `
        <span class="profile-page-name"></span>
        <span class="profile-page-meta">${profile.name === currentSelection ? t("profiles.activeProfile") : t("profiles.savedProfile")}</span>
      `;
      details.querySelector(".profile-page-name").textContent = profile.name;
      details.addEventListener("click", async () => {
        viewState.pendingDeleteName = null;
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
        viewState.pendingDeleteName = profile.name;
        refreshProfiles(currentSelection || "Default");
      });

      if (viewState.pendingDeleteName === profile.name && profile.name !== "Default") {
        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.className = "secondary-action";
        cancelButton.textContent = t("common.cancel");
        cancelButton.addEventListener("click", (event) => {
          event.stopPropagation();
          viewState.pendingDeleteName = null;
          refreshProfiles(currentSelection || "Default");
        });

        const confirmButton = document.createElement("button");
        confirmButton.type = "button";
        confirmButton.className = "danger-action";
        confirmButton.textContent = t("common.confirm");
        confirmButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          viewState.pendingDeleteName = null;
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

  return { renderProfilePage };
}

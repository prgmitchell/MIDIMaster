export function createUpdateDialog({
  showChoices,
  invoke,
  getSettingsFeature,
  switchAppPage,
  updateStatus,
  reportError,
}) {
  return function showUpdateAvailableDialog(info = {}, { standaloneIfMainHidden = false } = {}) {
    const latest = String(info.latestVersion || info.version || "").trim();
    const current = String(info.currentVersion || info.current_version || "").trim();
    if (!latest) return Promise.resolve("close");

    const showInlineDialog = () =>
      showChoices({
        title: "Update Available",
        message: `MIDIMaster ${latest} is available (current: ${current || "unknown"})`,
        options: [
          { id: "skip", label: "Skip Update", variant: "secondary" },
          { id: "install", label: "Download and Install", variant: "primary" },
        ],
      }).then((choice) => {
        if (choice === "skip") {
          try {
            localStorage.setItem("updaterSkippedVersion", latest);
          } catch {
            // Ignore storage failures.
          }
        } else if (choice === "install") {
          const settings = getSettingsFeature();
          settings.activateSettingsSection("startup");
          // Navigation reveals the page synchronously; its settings refresh
          // must not delay starting the download or displaying an error.
          switchAppPage("settings").catch((error) => {
            reportError("update_settings_navigation_failed", error);
          });
          updateStatus?.scrollIntoView({ block: "center", behavior: "instant" });
          settings.installAvailableUpdate();
        }
        return choice;
      });

    if (!standaloneIfMainHidden) return showInlineDialog();

    return invoke("show_update_notification_window_if_main_hidden", {
      currentVersion: current || null,
      latestVersion: latest,
    })
      .then((shownStandalone) => (shownStandalone ? "standalone" : showInlineDialog()))
      .catch((error) => {
        reportError("update_notification_window_failed", error);
        return showInlineDialog();
      });
  };
}

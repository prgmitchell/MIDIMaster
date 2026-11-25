import { createReleaseCard } from "../../features/updates/release_card.js";

export function createUpdateDialog({
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

    const showInlineDialog = () => {
      const existing = document.querySelector("dialog.release-dialog[open]");
      if (existing) existing.close("close");
      const dialog = document.createElement("dialog");
      dialog.className = "release-dialog";
      dialog.setAttribute("aria-labelledby", "release-title");
      const release = createReleaseCard({
        invoke,
        onClose: () => dialog.close("close"),
        onSkip: () => dialog.close("skip"),
        onInstall: () => dialog.close("install"),
      });
      dialog.append(release.card);
      document.body.append(dialog);
      release.setRelease(latest, current);
      dialog.showModal();
      release.card.querySelector("h1").focus();
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close("close");
      });
      return new Promise((resolve) => dialog.addEventListener("close", () => {
        const choice = dialog.returnValue || "close";
        dialog.remove();
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
        resolve(choice);
      }, { once: true }));
    };

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

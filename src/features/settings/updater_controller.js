export function createUpdaterController({ invoke, listen, dom, translate, getSettings }) {
  const state = {
    currentVersion: "-",
    latestVersion: "-",
    available: false,
    checking: false,
    downloading: false,
    hasChecked: false,
    body: "",
  };
  let checkPromise = null;
  let unlisten = null;

  function setText(target, text, selector = null) {
    if (!target) return;
    const node = selector ? target.querySelector(selector) : null;
    (node || target).textContent = String(text ?? "");
  }

  function renderSidebarVersion() {
    if (!dom.sidebarAppVersion) return;
    const currentVersion = String(state.currentVersion || "").trim();
    dom.sidebarAppVersion.textContent = currentVersion ? `v${currentVersion}` : "v-";
  }

  function shouldAutoCheckUpdates() {
    return (getSettings() || {}).autoCheckUpdates !== false;
  }

  function renderAutoCheckButton() {
    if (dom.autoCheckUpdatesButton) dom.autoCheckUpdatesButton.checked = shouldAutoCheckUpdates();
  }

  function setStatus(message, kind = "") {
    if (!dom.settingsUpdateStatus) return;
    dom.settingsUpdateStatus.querySelector(".settings-status-text")?.removeAttribute("data-i18n");
    setText(dom.settingsUpdateStatus, message, ".settings-status-text");
    dom.settingsUpdateStatus.classList.remove("error", "success");
    if (kind === "error" || kind === "success") dom.settingsUpdateStatus.classList.add(kind);
  }

  function setStaticStatus(key, kind = "") {
    if (!dom.settingsUpdateStatus) return;
    dom.settingsUpdateStatus.querySelector(".settings-status-text")?.setAttribute("data-i18n", key);
    setText(dom.settingsUpdateStatus, translate(key), ".settings-status-text");
    dom.settingsUpdateStatus.classList.remove("error", "success");
    if (kind === "error" || kind === "success") dom.settingsUpdateStatus.classList.add(kind);
  }

  function renderIdleStatus() {
    if (state.checking || state.downloading || state.hasChecked || state.available) return;
    setStaticStatus(shouldAutoCheckUpdates() ? "settings.noUpdateCheckYet" : "settings.autoCheckUpdatesOff");
  }

  function render() {
    if (dom.updateCurrentVersion) dom.updateCurrentVersion.textContent = state.currentVersion || "-";
    if (dom.updateLatestVersion) dom.updateLatestVersion.textContent = state.latestVersion || "-";
    if (dom.checkForUpdatesButton) {
      const labelKey = state.downloading
        ? "settings.downloadingUpdate"
        : (state.checking
          ? "settings.checkingUpdates"
          : (state.available ? "settings.downloadAndInstall" : "settings.checkForUpdates"));
      setText(dom.checkForUpdatesButton, translate(labelKey), ".settings-button-label");
      dom.checkForUpdatesButton.disabled = state.checking || state.downloading;
    }
    renderSidebarVersion();
    if (dom.topbarUpdateButton) {
      const visible = state.available && !state.downloading;
      dom.topbarUpdateButton.classList.toggle("hidden", !visible);
      dom.topbarUpdateButton.closest(".topbar")?.classList.toggle("has-update", visible);
      dom.topbarUpdateButton.disabled = state.checking || state.downloading;
      dom.topbarUpdateButton.setAttribute("aria-hidden", visible ? "false" : "true");
      const label = state.latestVersion && state.latestVersion !== "-"
        ? translate("topbar.updateAvailableVersion", { version: state.latestVersion })
        : translate("topbar.updateAvailable");
      dom.topbarUpdateButton.setAttribute("aria-label", label);
      dom.topbarUpdateButton.setAttribute("title", label);
      dom.topbarUpdateButton.title = label;
    }
    renderAutoCheckButton();
    renderIdleStatus();
  }

  function formatError(error) {
    const message = String(error || translate("settings.updateCheckFailed"));
    const normalized = message.toLowerCase();
    if (normalized.includes("valid release json") || normalized.includes("latest.json") || normalized.includes("404")) {
      return translate("settings.updateMetadataMissing");
    }
    if (normalized.includes("network") || normalized.includes("timeout")) {
      return translate("settings.updateNetworkError");
    }
    return message;
  }

  function normalizeInfo(updateInfo) {
    const info = updateInfo && typeof updateInfo === "object" ? updateInfo : {};
    const currentVersion = String(info.current_version ?? info.currentVersion ?? state.currentVersion ?? "-");
    return {
      available: Boolean(info.available),
      currentVersion,
      latestVersion: info.version ? String(info.version) : currentVersion,
      body: info.body ? String(info.body) : "",
    };
  }

  async function checkForUpdates({ silent = false } = {}) {
    void silent;
    if (checkPromise) return checkPromise;
    state.checking = true;
    state.hasChecked = true;
    render();
    setStatus(translate("settings.checkingUpdates"));
    checkPromise = (async () => {
      try {
        const normalized = normalizeInfo(await invoke("check_for_updates"));
        Object.assign(state, normalized);
        if (normalized.available) {
          setStatus(
            normalized.body
              ? translate("settings.updateAvailableNotes", { version: normalized.latestVersion })
              : translate("settings.updateAvailable", { version: normalized.latestVersion }),
            "success",
          );
        } else {
          setStatus(translate("settings.upToDate"), "success");
        }
        return normalized;
      } catch (error) {
        state.available = false;
        state.body = "";
        console.error("Updater check failed:", error);
        setStatus(formatError(error), "error");
        return null;
      } finally {
        state.checking = false;
        render();
        checkPromise = null;
      }
    })();
    return checkPromise;
  }

  function ensureAutoUpdateCheck() {
    if (!shouldAutoCheckUpdates() || state.hasChecked) return checkPromise || Promise.resolve(null);
    return checkForUpdates({ silent: true });
  }

  async function installAvailableUpdate() {
    state.downloading = true;
    render();
    setStatus(translate("settings.downloadingUpdate"));
    try {
      await invoke("download_and_install_update");
    } catch (error) {
      state.available = false;
      state.body = "";
      console.error("Updater install failed:", error);
      setStatus(String(error || translate("settings.updateInstallFailed")), "error");
    } finally {
      state.downloading = false;
      render();
    }
  }

  function applyStatusEvent(payload = {}) {
    const phase = String(payload.phase || "").trim();
    if (payload.current_version) state.currentVersion = String(payload.current_version);
    if (payload.version) state.latestVersion = String(payload.version);
    if (phase === "checking") {
      state.checking = true;
      setStatus(translate("settings.checkingUpdates"));
    } else if (phase === "available") {
      state.available = true;
      setStatus(translate("settings.updateAvailable", { version: state.latestVersion }), "success");
    } else if (phase === "no_update") {
      state.available = false;
      state.body = "";
      setStatus(translate("settings.upToDate"), "success");
    } else if (phase === "downloading") {
      state.downloading = true;
      const downloaded = Number(payload.downloaded || 0);
      const total = Number(payload.content_length || 0);
      setStatus(total > 0
        ? translate("settings.downloadingUpdatePercent", { percent: Math.min(100, Math.round((downloaded / total) * 100)) })
        : translate("settings.downloadingUpdate"));
    } else if (phase === "downloaded") {
      setStatus(translate("settings.updateDownloadedInstalling"));
    } else if (phase === "installed") {
      state.available = false;
      state.body = "";
      state.downloading = false;
      setStatus(translate("settings.updateInstalledRestarting"), "success");
    } else if (phase === "failed") {
      state.available = false;
      state.checking = false;
      state.downloading = false;
      if (payload.message) console.error("Updater event failure:", payload.message);
      setStatus(formatError(payload.message || translate("settings.updateInstallFailed")), "error");
    }
    if (["available", "no_update", "installed"].includes(phase)) state.checking = false;
    render();
  }

  async function bindEvents() {
    if (unlisten || typeof listen !== "function") return;
    unlisten = await listen("updater_status", (event) => {
      applyStatusEvent(event && typeof event.payload === "object" ? event.payload : {});
    });
  }

  async function loadCurrentVersion() {
    try {
      const version = await invoke("get_app_version");
      if (!version) return;
      state.currentVersion = String(version);
      if (!state.latestVersion || state.latestVersion === "-") state.latestVersion = state.currentVersion;
      render();
      renderSidebarVersion();
    } catch {
      // Version display is non-critical.
    }
  }

  function dispose() {
    unlisten?.();
    unlisten = null;
  }

  return {
    state,
    render,
    renderSidebarVersion,
    setStaticStatus,
    checkForUpdates,
    ensureAutoUpdateCheck,
    installAvailableUpdate,
    bindEvents,
    loadCurrentVersion,
    applyStatusEvent,
    dispose,
  };
}

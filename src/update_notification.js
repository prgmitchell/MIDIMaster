export function setupUpdateNotificationWindow({
  params = new URLSearchParams(window.location.search),
  invoke: invokeOverride,
  listen: listenOverride,
} = {}) {
  const updateMessage = document.getElementById("update-message");
  const updateStatus = document.getElementById("update-status");
  const installButton = document.getElementById("install-button");
  const skipButton = document.getElementById("skip-button");
  const closeButton = document.getElementById("close-button");
  const updateCard = document.querySelector(".update-card");
  const themeStorageKey = "uiTheme";

  let latestVersion = String(params.get("latestVersion") || "").trim();
  let currentVersion = String(params.get("currentVersion") || "").trim();

  function invoke(command, args = {}) {
    if (typeof invokeOverride === "function") {
      return invokeOverride(command, args);
    }
    const tauriInvoke = window.__TAURI__?.core?.invoke;
    if (typeof tauriInvoke !== "function") {
      return Promise.reject(new Error("Tauri API missing"));
    }
    return tauriInvoke(command, args);
  }

  function listen(eventName, handler) {
    if (typeof listenOverride === "function") {
      return listenOverride(eventName, handler);
    }
    const tauriListen = window.__TAURI__?.event?.listen;
    if (typeof tauriListen !== "function") {
      return Promise.resolve(() => {});
    }
    return tauriListen(eventName, handler);
  }

  function setStatus(message, { error = false } = {}) {
    if (!updateStatus) return;
    updateStatus.textContent = String(message || "");
    updateStatus.classList.toggle("error", Boolean(error));
  }

  function setBusy(isBusy) {
    if (installButton) installButton.disabled = Boolean(isBusy);
    if (skipButton) skipButton.disabled = Boolean(isBusy);
  }

  function applyStoredTheme() {
    let theme = "dark";
    try {
      const stored = localStorage.getItem(themeStorageKey);
      if (stored === "light" || stored === "dark") {
        theme = stored;
      }
    } catch {
      // Keep the default dark theme if storage is unavailable.
    }
    document.documentElement.style.colorScheme = theme;
    document.body.dataset.theme = theme;
    document.body.classList.toggle("dark-mode", theme === "dark");
  }

  function renderUpdateCopy() {
    if (!updateMessage) return;
    const latest = latestVersion || "a new version";
    const current = currentVersion || "unknown";
    updateMessage.textContent = `MIDIMaster ${latest} is available (current: ${current}).`;
  }

  function applyPayload(payload = {}) {
    if (!payload || typeof payload !== "object") return;
    applyStoredTheme();
    latestVersion = String(payload.latest_version || payload.latestVersion || latestVersion || "").trim();
    currentVersion = String(payload.current_version || payload.currentVersion || currentVersion || "").trim();
    renderUpdateCopy();
  }

  function rememberSkippedVersion() {
    if (!latestVersion) return;
    try {
      localStorage.setItem("updaterSkippedVersion", latestVersion);
    } catch {
      // Ignore storage failures; closing still dismisses this prompt.
    }
  }

  async function closeWindow() {
    await invoke("close_update_notification_window").catch(() => {});
  }

  function startDrag(event) {
    if (event.button !== 0 || event.target?.closest?.("button")) return;
    event.preventDefault();
    event.stopPropagation();
    invoke("start_update_notification_window_drag").catch(() => {});
  }

  async function installUpdate() {
    setBusy(true);
    setStatus("Starting download...");
    try {
      await invoke("download_and_install_update");
    } catch (error) {
      setBusy(false);
      setStatus(String(error || "Update install failed."), { error: true });
    }
  }

  skipButton?.addEventListener("click", () => {
    rememberSkippedVersion();
    closeWindow();
  });

  closeButton?.addEventListener("click", () => {
    closeWindow();
  });

  installButton?.addEventListener("click", () => {
    installUpdate();
  });

  updateCard?.addEventListener("mousedown", startDrag);
  window.addEventListener("focus", applyStoredTheme);
  window.addEventListener("storage", (event) => {
    if (event.key === themeStorageKey) {
      applyStoredTheme();
    }
  });

  window.__MIDIMASTER_UPDATE_NOTIFICATION__ = { setPayload: applyPayload };

  listen("update_notification_payload", (event) => {
    applyPayload(event?.payload);
  });

  listen("updater_status", (event) => {
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
    const phase = String(payload.phase || "");
    if (phase === "downloading") {
      setBusy(true);
      const downloaded = Number(payload.downloaded || 0);
      const total = Number(payload.content_length || 0);
      if (total > 0) {
        setStatus(`Downloading update... ${Math.min(100, Math.round((downloaded / total) * 100))}%`);
      } else {
        setStatus("Downloading update...");
      }
    } else if (phase === "downloaded") {
      setStatus("Update downloaded. Installing...");
    } else if (phase === "installed") {
      setStatus("Update installed. Restarting app...");
    } else if (phase === "failed") {
      setBusy(false);
      setStatus(String(payload.message || "Update install failed."), { error: true });
    }
  });

  applyStoredTheme();
  renderUpdateCopy();
}

if (document.getElementById("install-button") && document.getElementById("update-message")) {
  setupUpdateNotificationWindow();
}

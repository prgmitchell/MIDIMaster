import {
  closeOpenDropdowns,
  renderLabelWithBadges,
} from "../ui/dropdown_badges.js";
import {
  createSelectDropdownShell,
  renderNativeSelectDropdown,
} from "../ui/dropdown_select.js";

export function createSettingsFeature({
  invoke,
  listen,
  dom,
  getOsdSettings,
  setOsdSettings,
  getMonitorOptions,
  setMonitorOptions,
  getAppSettings,
  setAppSettings,
  onUpdateAvailableClick,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createSettingsFeature: invoke is required");
  }
  const d = (dom && typeof dom === "object") ? dom : {};
  let monitorDropdownEl = null;
  let monitorMenuEl = null;
  let monitorDisplayEl = null;
  let monitorDocClickBound = false;
  let settingsDocClickBound = false;
  const settingsSelectDropdowns = new Map();
  let updaterUnlisten = null;
  const updateState = {
    currentVersion: "-",
    latestVersion: "-",
    available: false,
    checking: false,
    downloading: false,
    body: "",
  };

  function setTextContent(target, text, selector = null) {
    const value = String(text ?? "");
    if (!target) return;
    const node = selector ? target.querySelector(selector) : null;
    if (node) {
      node.textContent = value;
      return;
    }
    target.textContent = value;
  }

  function renderSidebarVersion() {
    if (!d.sidebarAppVersion) return;
    const currentVersion = String(updateState.currentVersion || "").trim();
    d.sidebarAppVersion.textContent = currentVersion ? `v${currentVersion}` : "v-";
  }

  function renderAutoCheckButton() {
    if (!d.autoCheckUpdatesButton) return;
    const enabled = (typeof getAppSettings === "function")
      ? ((getAppSettings() || {}).autoCheckUpdates !== false)
      : true;
    d.autoCheckUpdatesButton.dataset.enabled = enabled ? "true" : "false";
    setTextContent(d.autoCheckUpdatesButton, enabled ? "Auto-check: On" : "Auto-check: Off", ".settings-mini-toggle-label");
  }

  function formatUpdaterError(error) {
    const message = String(error || "Update check failed.");
    const normalized = message.toLowerCase();
    if (
      normalized.includes("valid release json")
      || normalized.includes("latest.json")
      || normalized.includes("404")
    ) {
      return "Updater metadata is not published yet for this release. Use GitHub Releases for manual install.";
    }
    if (normalized.includes("network") || normalized.includes("timeout")) {
      return "Unable to reach update server right now. Try again in a moment.";
    }
    return message;
  }

  function setUpdateStatus(message, kind = "") {
    if (!d.settingsUpdateStatus) return;
    setTextContent(d.settingsUpdateStatus, String(message || ""), ".settings-status-text");
    d.settingsUpdateStatus.classList.remove("error", "success");
    if (kind === "error" || kind === "success") {
      d.settingsUpdateStatus.classList.add(kind);
    }
  }

  function renderUpdateUi() {
    if (d.updateCurrentVersion) {
      d.updateCurrentVersion.textContent = updateState.currentVersion || "-";
    }
    if (d.updateLatestVersion) {
      d.updateLatestVersion.textContent = updateState.latestVersion || "-";
    }
    if (d.checkForUpdatesButton) {
      if (updateState.downloading) {
        setTextContent(d.checkForUpdatesButton, "Downloading...", ".settings-button-label");
      } else if (updateState.checking) {
        setTextContent(d.checkForUpdatesButton, "Checking...", ".settings-button-label");
      } else if (updateState.available) {
        setTextContent(d.checkForUpdatesButton, "Download and install", ".settings-button-label");
      } else {
        setTextContent(d.checkForUpdatesButton, "Check for updates", ".settings-button-label");
      }
      d.checkForUpdatesButton.disabled = updateState.checking || updateState.downloading;
    }
    renderSidebarVersion();
    if (d.topbarUpdateButton) {
      const showTopbarUpdate = updateState.available && !updateState.downloading;
      d.topbarUpdateButton.classList.toggle("hidden", !showTopbarUpdate);
      d.topbarUpdateButton.closest(".topbar")?.classList.toggle("has-update", showTopbarUpdate);
      d.topbarUpdateButton.disabled = updateState.checking || updateState.downloading;
      d.topbarUpdateButton.setAttribute("aria-hidden", showTopbarUpdate ? "false" : "true");
      const versionSuffix = updateState.latestVersion && updateState.latestVersion !== "-"
        ? `: ${updateState.latestVersion}`
        : "";
      const label = `Update available${versionSuffix}`;
      d.topbarUpdateButton.setAttribute("aria-label", label);
      d.topbarUpdateButton.setAttribute("title", label);
      d.topbarUpdateButton.title = label;
    }
    renderAutoCheckButton();
  }

  function normalizeUpdateInfo(updateInfo) {
    const info = (updateInfo && typeof updateInfo === "object") ? updateInfo : {};
    const available = Boolean(info.available);
    const currentVersion = String(info.current_version ?? info.currentVersion ?? updateState.currentVersion ?? "-");
    const latestVersionRaw = info.version ?? null;
    const latestVersion = latestVersionRaw ? String(latestVersionRaw) : currentVersion;
    const body = info.body ? String(info.body) : "";
    return { available, currentVersion, latestVersion, body };
  }

  async function checkForUpdates({ silent = false } = {}) {
    updateState.checking = true;
    renderUpdateUi();
    if (!silent) {
      setUpdateStatus("Checking for updates...");
    }
    try {
      const updateInfo = await invoke("check_for_updates");
      const normalized = normalizeUpdateInfo(updateInfo);
      updateState.currentVersion = normalized.currentVersion;
      updateState.latestVersion = normalized.latestVersion;
      updateState.available = normalized.available;
      updateState.body = normalized.body;
      if (normalized.available) {
        const suffix = normalized.body ? " (release notes available)" : "";
        setUpdateStatus(`Update available: ${normalized.latestVersion}${suffix}`, "success");
      } else {
        setUpdateStatus("You are up to date.", "success");
      }
      return normalized;
    } catch (error) {
      updateState.available = false;
      updateState.body = "";
      if (!silent) {
        setUpdateStatus(formatUpdaterError(error), "error");
      }
      return null;
    } finally {
      updateState.checking = false;
      renderUpdateUi();
    }
  }

  async function installAvailableUpdate() {
    updateState.downloading = true;
    renderUpdateUi();
    setUpdateStatus("Downloading update...");
    try {
      await invoke("download_and_install_update");
    } catch (error) {
      updateState.available = false;
      updateState.body = "";
      setUpdateStatus(String(error || "Update install failed."), "error");
    } finally {
      updateState.downloading = false;
      renderUpdateUi();
    }
  }

  async function bindUpdaterEvents() {
    if (updaterUnlisten || typeof listen !== "function") return;
    updaterUnlisten = await listen("updater_status", (event) => {
      const payload = (event && typeof event.payload === "object") ? event.payload : {};
      const phase = String(payload.phase || "").trim();
      if (payload.current_version) {
        updateState.currentVersion = String(payload.current_version);
      }
      if (payload.version) {
        updateState.latestVersion = String(payload.version);
      }
      if (phase === "checking") {
        updateState.checking = true;
        setUpdateStatus("Checking for updates...");
      } else if (phase === "available") {
        updateState.available = true;
        setUpdateStatus(`Update available: ${updateState.latestVersion}`, "success");
      } else if (phase === "no_update") {
        updateState.available = false;
        updateState.body = "";
        setUpdateStatus("You are up to date.", "success");
      } else if (phase === "downloading") {
        updateState.downloading = true;
        const downloaded = Number(payload.downloaded || 0);
        const total = Number(payload.content_length || 0);
        if (total > 0) {
          const pct = Math.min(100, Math.round((downloaded / total) * 100));
          setUpdateStatus(`Downloading update... ${pct}%`);
        } else {
          setUpdateStatus("Downloading update...");
        }
      } else if (phase === "downloaded") {
        setUpdateStatus("Update downloaded. Installing...");
      } else if (phase === "installed") {
        updateState.available = false;
        updateState.body = "";
        setUpdateStatus("Update installed. Restarting app...", "success");
      } else if (phase === "failed") {
        updateState.available = false;
        updateState.checking = false;
        updateState.downloading = false;
        setUpdateStatus(formatUpdaterError(payload.message || "Update failed."), "error");
      }
      if (phase === "available" || phase === "no_update" || phase === "installed") {
        updateState.checking = false;
      }
      if (phase === "installed") {
        updateState.downloading = false;
      }
      renderUpdateUi();
    });
  }

  function closeSettingsPanel() {
    if (!d.settingsPanel) return;
    d.settingsPanel.classList.add("hidden");
  }

  function openSettingsPanel() {
    if (!d.settingsPanel) return;
    d.settingsPanel.classList.remove("hidden");
  }

  function updateOsdPositionSelection(anchor) {
    if (!d.osdPositionPicker) return;
    d.osdPositionPicker.querySelectorAll(".osd-position-dot").forEach((dot) => {
      dot.classList.toggle("selected", dot.dataset.anchor === anchor);
    });
  }

  async function applyOsdSettings(nextSettings) {
    const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
    const requestedEnabledChange = Boolean(
      nextSettings
      && Object.prototype.hasOwnProperty.call(nextSettings, "enabled")
    );
    const shouldPreviewAfterSave = requestedEnabledChange
      && !Boolean(current.enabled)
      && Boolean(nextSettings.enabled);
    const merged = { ...current, ...(nextSettings || {}) };
    if (typeof setOsdSettings === "function") {
      setOsdSettings(merged);
    }

    if (d.osdEnabledToggle) {
      if (d.osdEnabledToggle.type === "checkbox") {
        d.osdEnabledToggle.checked = Boolean(merged.enabled);
        d.osdEnabledToggle.classList.remove("hidden");
      } else {
        d.osdEnabledToggle.value = merged.enabled ? "enabled" : "disabled";
        renderSettingsSelectDropdown(d.osdEnabledToggle);
      }
    }
    if (d.osdMonitorSelect) {
      d.osdMonitorSelect.value = String(merged.monitorIndex ?? 0);
    }
    updateOsdPositionSelection(merged.anchor);
    document.body.setAttribute("data-anchor", merged.anchor || "top-right");

    try {
      await invoke("update_osd_settings", {
        enabled: merged.enabled,
        monitorIndex: merged.monitorIndex,
        monitorName: merged.monitorName || null,
        monitorId: merged.monitorId || null,
        anchor: merged.anchor,
      });
      if (shouldPreviewAfterSave) {
        await invoke("preview_osd");
      }
    } catch (error) {
      console.error("Failed to update OSD settings", error);
    }
  }

  async function loadOsdSettings() {
    try {
      const settings = await invoke("get_osd_settings");
      if (settings) {
        const next = {
          enabled: Boolean(settings.enabled),
          monitorIndex: Number(settings.monitor_index ?? settings.monitorIndex ?? 0),
          monitorName: settings.monitor_name ?? settings.monitorName ?? null,
          monitorId: settings.monitor_id ?? settings.monitorId ?? null,
          anchor: settings.anchor || "top-right",
        };
        if (typeof setOsdSettings === "function") {
          setOsdSettings(next);
        }
      }
    } catch (error) {
      console.error("Failed to load OSD settings", error);
    }
  }

  function formatMonitorName(name) {
    if (!name) return "Monitor";
    return String(name).trim().replace(/^\\\\\.\\/, "");
  }

  function formatMonitorOptionLabel(monitor, index) {
    const base = formatMonitorName(monitor?.name) || `Monitor ${index + 1}`;
    return base;
  }

  function resolveEffectiveMonitor(monitors, currentSettings) {
    const list = Array.isArray(monitors) ? monitors : [];
    if (list.length === 0) return null;

    const requestedId = String(currentSettings?.monitorId || "").trim();
    if (requestedId) {
      const byId = list.find((monitor) => String(monitor?.stable_id || "").trim() === requestedId);
      if (byId) return byId;
    }

    return list.find((monitor) => Boolean(monitor?.is_primary)) || list[0];
  }

  function closeMonitorDropdown() {
    if (!monitorDropdownEl) return;
    closeOpenDropdowns({ except: null });
  }

  function ensureSettingsSelectDropdown(selectEl, { title = "Select" } = {}) {
    if (!selectEl) return null;

    const existing = settingsSelectDropdowns.get(selectEl);
    if (existing && existing.root?.isConnected) return existing;

    const entry = createSelectDropdownShell({
      selectEl,
      rootClass: "settings-select-dropdown",
      title,
    });
    if (!entry) return null;
    settingsSelectDropdowns.set(selectEl, entry);

    if (!settingsDocClickBound) {
      settingsDocClickBound = true;
      document.addEventListener("click", (event) => {
        const clickedInsideMonitor = Boolean(monitorDropdownEl && monitorDropdownEl.contains(event.target));
        if (clickedInsideMonitor) return;
        const clickedInsideAnySettingsDropdown = Array.from(settingsSelectDropdowns.values())
          .some((item) => item.root && item.root.contains(event.target));
        if (clickedInsideAnySettingsDropdown) return;
        closeOpenDropdowns({ except: null });
      });
    }

    return entry;
  }

  function renderSettingsSelectDropdown(selectEl) {
    if (!selectEl) return;
    const entry = ensureSettingsSelectDropdown(selectEl, { title: selectEl.title || selectEl.id || "Select" });
    if (!entry) return;
    renderNativeSelectDropdown({
      entry,
      selectEl,
      fallbackText: "Select",
      closeDropdowns: () => closeOpenDropdowns({ except: null }),
      formatOptionText: (opt) => opt.textContent || "",
      getOptionBadges: () => [],
      truncateMenuLabels: false,
      truncateDisplayLabel: true,
    });
  }

  function renderAllSettingsSelectDropdowns() {
    renderSettingsSelectDropdown(d.startWithWindowsSelect);
    renderSettingsSelectDropdown(d.startInTraySelect);
    renderSettingsSelectDropdown(d.minimizeToTraySelect);
    renderSettingsSelectDropdown(d.exitToTraySelect);
  }

  function renderMonitorDisplay(option) {
    if (!monitorDisplayEl) return;
    renderLabelWithBadges(monitorDisplayEl, {
      text: option?.label || "Monitor",
      badges: option?.isPrimary ? [{ text: "MAIN", kind: "neutral" }] : [],
      truncate: true,
    });
  }

  function ensureMonitorDropdown() {
    if (!d.osdMonitorSelect) return;

    if (monitorDropdownEl && monitorDropdownEl.isConnected) {
      return;
    }

    const entry = createSelectDropdownShell({
      selectEl: d.osdMonitorSelect,
      rootClass: "settings-monitor-dropdown",
      title: "Monitor",
    });
    if (!entry) return;
    monitorDropdownEl = entry.root;
    monitorMenuEl = entry.menu;
    monitorDisplayEl = entry.display;

    if (!monitorDocClickBound) {
      monitorDocClickBound = true;
      document.addEventListener("click", (event) => {
        if (!monitorDropdownEl) return;
        if (monitorDropdownEl.contains(event.target)) return;
        closeMonitorDropdown();
      });
    }
  }

  function renderMonitorDropdownOptions(monitors) {
    ensureMonitorDropdown();
    if (!monitorMenuEl || !d.osdMonitorSelect) return;
    const list = Array.isArray(monitors) ? monitors : [];
    renderNativeSelectDropdown({
      entry: { root: monitorDropdownEl, menu: monitorMenuEl, display: monitorDisplayEl },
      selectEl: d.osdMonitorSelect,
      fallbackText: "Monitor",
      closeDropdowns: closeMonitorDropdown,
      formatOptionText: (opt) => opt.textContent || "",
      getOptionBadges: (opt) => (opt.dataset.isPrimary === "true"
        ? [{ text: "MAIN", kind: "neutral" }]
        : []),
      onOptionSelected: (opt) => {
        renderMonitorDisplay({
          value: String(opt.value || "0"),
          label: opt.textContent || "Monitor",
          isPrimary: opt.dataset.isPrimary === "true",
        });
      },
      truncateMenuLabels: false,
      truncateDisplayLabel: true,
    });

    if (list.length === 0) {
      renderMonitorDisplay({ value: "0", label: "Monitor", isPrimary: true });
    }
  }

  async function loadMonitorOptions() {
    let next = [];
    try {
      const monitors = await invoke("list_monitors");
      next = Array.isArray(monitors) ? monitors : [];
    } catch (error) {
      next = [];
      console.error("Failed to load monitors", error);
    }
    if (typeof setMonitorOptions === "function") {
      setMonitorOptions(next);
    }

    // Update dropdown if it exists
    if (d.osdMonitorSelect) {
      const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
      d.osdMonitorSelect.innerHTML = "";
      next.forEach((monitor, index) => {
        const option = document.createElement("option");
        option.value = String(monitor.index ?? index);
        option.dataset.rawName = monitor.name || "";
        option.dataset.stableId = monitor.stable_id || "";
        option.dataset.isPrimary = monitor.is_primary ? "true" : "false";
        option.textContent = formatMonitorOptionLabel(monitor, index);
        d.osdMonitorSelect.appendChild(option);
      });
      if (next.length === 0) {
        const option = document.createElement("option");
        option.value = "0";
        option.textContent = "Primary monitor";
        d.osdMonitorSelect.appendChild(option);
        d.osdMonitorSelect.value = "0";
      } else {
        // Mirror backend monitor resolution: prefer stable_id match, else primary monitor.
        const effective = resolveEffectiveMonitor(next, current);
        const fallbackIndex = Math.max(0, Number(current.monitorIndex ?? 0));
        const effectiveValue = String(effective?.index ?? fallbackIndex);
        d.osdMonitorSelect.value = effectiveValue;

        if (typeof setOsdSettings === "function" && effective) {
          setOsdSettings({
            ...current,
            monitorIndex: Number(effectiveValue),
            monitorName: effective.name || null,
            monitorId: effective.stable_id || null,
          });
        }
      }
      renderMonitorDropdownOptions(next);
    }
  }

  function syncAppSettingsUI(nextSettings) {
    const current = (typeof getAppSettings === "function") ? (getAppSettings() || {}) : {};
    const merged = { ...current, ...(nextSettings || {}) };
    if (typeof setAppSettings === "function") {
      setAppSettings(merged);
    }
    if (d.startWithWindowsSelect) {
      d.startWithWindowsSelect.value = merged.startWithWindows ? "enabled" : "disabled";
      renderSettingsSelectDropdown(d.startWithWindowsSelect);
    }
    if (d.startInTraySelect) {
      d.startInTraySelect.value = merged.startInTray ? "enabled" : "disabled";
      renderSettingsSelectDropdown(d.startInTraySelect);
    }
    if (d.minimizeToTraySelect) {
      d.minimizeToTraySelect.value = merged.minimizeToTray ? "enabled" : "disabled";
      renderSettingsSelectDropdown(d.minimizeToTraySelect);
    }
    if (d.exitToTraySelect) {
      d.exitToTraySelect.value = merged.exitToTray ? "enabled" : "disabled";
      renderSettingsSelectDropdown(d.exitToTraySelect);
    }
    renderAutoCheckButton();
  }

  function persistAppSettings() {
    const s = (typeof getAppSettings === "function") ? (getAppSettings() || {}) : {};
    return invoke("update_app_settings", {
      startWithWindows: Boolean(s.startWithWindows),
      startInTray: Boolean(s.startInTray),
      minimizeToTray: Boolean(s.minimizeToTray),
      exitToTray: Boolean(s.exitToTray),
      autoCheckUpdates: s.autoCheckUpdates !== false,
    }).catch((error) => {
      console.error("Failed to update app settings", error);
    });
  }

  async function loadAppSettings() {
    try {
      const settings = await invoke("get_app_settings");
      if (settings) {
        const next = {
          startWithWindows: Boolean(settings.start_with_windows ?? settings.startWithWindows),
          startInTray: Boolean(settings.start_in_tray ?? settings.startInTray),
          minimizeToTray: Boolean(settings.minimize_to_tray ?? settings.minimizeToTray),
          exitToTray: Boolean(settings.exit_to_tray ?? settings.exitToTray),
          autoCheckUpdates: Boolean(settings.auto_check_updates ?? settings.autoCheckUpdates ?? true),
        };
        if (typeof setAppSettings === "function") {
          setAppSettings(next);
        }
      }
    } catch (error) {
      console.error("Failed to load app settings", error);
    }
  }

  function bindUi() {
    bindUpdaterEvents().catch(() => {});
    if (d.settingsPanel) {
      d.settingsPanel.addEventListener("click", (event) => {
        if (d.settingsPanel.classList.contains("target-panel") && event.target === d.settingsPanel) {
          closeSettingsPanel();
        }
      });
    }
    if (d.settingsPanelClose) {
      d.settingsPanelClose.addEventListener("click", closeSettingsPanel);
    }

    if (d.settingsButton) {
      d.settingsButton.addEventListener("click", async () => {
        await loadOsdSettings();
        await loadMonitorOptions();
        await loadAppSettings();
        await loadCurrentAppVersion();
        syncAppSettingsUI((typeof getAppSettings === "function") ? (getAppSettings() || {}) : {});
        renderAllSettingsSelectDropdowns();
        if ((getAppSettings?.() || {}).autoCheckUpdates !== false) {
          await checkForUpdates({ silent: true });
        }
        openSettingsPanel();
      });
    }

    if (d.openLogsFolderButton) {
      d.openLogsFolderButton.addEventListener("click", async () => {
        try {
          await invoke("open_logs_folder");
        } catch (error) {
          console.error(`Unable to open logs folder: ${error}`);
        }
      });
    }

    if (d.osdEnabledToggle) {
      d.osdEnabledToggle.addEventListener("change", () => {
        const enabled = d.osdEnabledToggle.type === "checkbox"
          ? d.osdEnabledToggle.checked
          : d.osdEnabledToggle.value === "enabled";
        applyOsdSettings({ enabled });
      });
    }

    if (d.osdMonitorSelect) {
      d.osdMonitorSelect.addEventListener("change", () => {
        const nextIndex = Number(d.osdMonitorSelect.value || 0);
        const selectedOption = d.osdMonitorSelect.options[d.osdMonitorSelect.selectedIndex];
        const monitorName = selectedOption?.dataset?.rawName || null;
        const monitorId = selectedOption?.dataset?.stableId || null;
        applyOsdSettings({ monitorIndex: nextIndex, monitorName, monitorId });
        const currentMonitors = (typeof getMonitorOptions === "function") ? (getMonitorOptions() || []) : [];
        renderMonitorDropdownOptions(currentMonitors);
      });
    }

    if (d.osdPositionPicker) {
      d.osdPositionPicker.addEventListener("click", (event) => {
        const dot = event.target.closest(".osd-position-dot");
        if (!dot) return;
        const anchor = dot.dataset.anchor || "top-right";
        applyOsdSettings({ anchor });
      });
    }

    if (d.startWithWindowsSelect) {
      d.startWithWindowsSelect.addEventListener("change", () => {
        syncAppSettingsUI({ startWithWindows: d.startWithWindowsSelect.value === "enabled" });
        persistAppSettings();
      });
    }
    if (d.startInTraySelect) {
      d.startInTraySelect.addEventListener("change", () => {
        syncAppSettingsUI({ startInTray: d.startInTraySelect.value === "enabled" });
        persistAppSettings();
      });
    }
    if (d.minimizeToTraySelect) {
      d.minimizeToTraySelect.addEventListener("change", () => {
        syncAppSettingsUI({ minimizeToTray: d.minimizeToTraySelect.value === "enabled" });
        persistAppSettings();
      });
    }
    if (d.exitToTraySelect) {
      d.exitToTraySelect.addEventListener("change", () => {
        syncAppSettingsUI({ exitToTray: d.exitToTraySelect.value === "enabled" });
        persistAppSettings();
      });
    }
    if (d.autoCheckUpdatesButton) {
      d.autoCheckUpdatesButton.addEventListener("click", () => {
        const enabled = (getAppSettings?.() || {}).autoCheckUpdates !== false;
        syncAppSettingsUI({ autoCheckUpdates: !enabled });
        persistAppSettings();
        renderUpdateUi();
      });
    }
    if (d.checkForUpdatesButton) {
      d.checkForUpdatesButton.addEventListener("click", () => {
        if (updateState.available) {
          installAvailableUpdate();
          return;
        }
        checkForUpdates();
      });
    }
    if (d.topbarUpdateButton) {
      d.topbarUpdateButton.addEventListener("click", () => {
        if (!updateState.available || updateState.downloading) return;
        if (typeof onUpdateAvailableClick === "function") {
          onUpdateAvailableClick({
            currentVersion: updateState.currentVersion,
            latestVersion: updateState.latestVersion,
            body: updateState.body,
          });
        }
      });
    }

    setUpdateStatus("No update check yet.");
    renderUpdateUi();
    renderAllSettingsSelectDropdowns();
    loadCurrentAppVersion().catch(() => {});
  }

  async function loadCurrentAppVersion() {
    try {
      const version = await invoke("get_app_version");
      if (version) {
        updateState.currentVersion = String(version);
        if (!updateState.latestVersion || updateState.latestVersion === "-") {
          updateState.latestVersion = updateState.currentVersion;
        }
        renderUpdateUi();
        renderSidebarVersion();
      }
    } catch {
      // ignore version fetch failures
    }
  }

  return {
    bindUi,
    openSettingsPanel,
    closeSettingsPanel,
    loadMonitorOptions,
    loadOsdSettings,
    applyOsdSettings,
    loadAppSettings,
    loadCurrentAppVersion,
    syncAppSettingsUI,
    persistAppSettings,
    checkForUpdates,
    installAvailableUpdate,
  };
}

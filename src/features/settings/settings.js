export function createSettingsFeature({
  invoke,
  dom,
  getOsdSettings,
  setOsdSettings,
  getMonitorOptions,
  setMonitorOptions,
  getAppSettings,
  setAppSettings,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createSettingsFeature: invoke is required");
  }
  const d = (dom && typeof dom === "object") ? dom : {};

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
    const merged = { ...current, ...(nextSettings || {}) };
    if (typeof setOsdSettings === "function") {
      setOsdSettings(merged);
    }

    if (d.osdEnabledToggle) {
      d.osdEnabledToggle.value = merged.enabled ? "enabled" : "disabled";
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
        const label = formatMonitorName(monitor.name) || `Monitor ${index + 1}`;
        option.textContent = monitor.is_primary ? `${label} (Main)` : label;
        d.osdMonitorSelect.appendChild(option);
      });
      if (next.length === 0) {
        const option = document.createElement("option");
        option.value = "0";
        option.textContent = "Primary monitor";
        d.osdMonitorSelect.appendChild(option);
      }
      d.osdMonitorSelect.value = String(current.monitorIndex ?? 0);
    }
  }

  function reconcileMonitorSelection() {
    const options = (typeof getMonitorOptions === "function") ? (getMonitorOptions() || []) : [];
    const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
    if (!options.length || !current.monitorId) return false;

    const matchIndex = options.findIndex((m) => m && m.stable_id === current.monitorId);
    if (matchIndex !== -1 && matchIndex !== current.monitorIndex) {
      const next = { ...current, monitorIndex: matchIndex };
      if (typeof setOsdSettings === "function") {
        setOsdSettings(next);
      }
      if (d.osdMonitorSelect) {
        d.osdMonitorSelect.value = String(matchIndex);
      }
      return true;
    }
    return false;
  }

  function syncAppSettingsUI(nextSettings) {
    const current = (typeof getAppSettings === "function") ? (getAppSettings() || {}) : {};
    const merged = { ...current, ...(nextSettings || {}) };
    if (typeof setAppSettings === "function") {
      setAppSettings(merged);
    }
    if (d.startWithWindowsSelect) {
      d.startWithWindowsSelect.value = merged.startWithWindows ? "enabled" : "disabled";
    }
    if (d.startInTraySelect) {
      d.startInTraySelect.value = merged.startInTray ? "enabled" : "disabled";
    }
    if (d.minimizeToTraySelect) {
      d.minimizeToTraySelect.value = merged.minimizeToTray ? "enabled" : "disabled";
    }
    if (d.exitToTraySelect) {
      d.exitToTraySelect.value = merged.exitToTray ? "enabled" : "disabled";
    }
  }

  function persistAppSettings() {
    const s = (typeof getAppSettings === "function") ? (getAppSettings() || {}) : {};
    return invoke("update_app_settings", {
      startWithWindows: Boolean(s.startWithWindows),
      startInTray: Boolean(s.startInTray),
      minimizeToTray: Boolean(s.minimizeToTray),
      exitToTray: Boolean(s.exitToTray),
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
    if (d.settingsPanel) {
      d.settingsPanel.addEventListener("click", (event) => {
        if (event.target === d.settingsPanel) {
          closeSettingsPanel();
        }
      });
    }
    if (d.settingsPanelClose) {
      d.settingsPanelClose.addEventListener("click", closeSettingsPanel);
    }

    if (d.settingsButton) {
      d.settingsButton.addEventListener("click", async () => {
        await loadMonitorOptions();
        await loadOsdSettings();
        reconcileMonitorSelection();
        await loadAppSettings();
        await applyOsdSettings((typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {});
        syncAppSettingsUI((typeof getAppSettings === "function") ? (getAppSettings() || {}) : {});
        openSettingsPanel();
      });
    }

    if (d.osdEnabledToggle) {
      d.osdEnabledToggle.addEventListener("change", () => {
        applyOsdSettings({ enabled: d.osdEnabledToggle.value === "enabled" });
      });
    }

    if (d.osdMonitorSelect) {
      d.osdMonitorSelect.addEventListener("change", () => {
        const nextIndex = Number(d.osdMonitorSelect.value || 0);
        const selectedOption = d.osdMonitorSelect.options[d.osdMonitorSelect.selectedIndex];
        const monitorName = selectedOption?.dataset?.rawName || null;
        const monitorId = selectedOption?.dataset?.stableId || null;
        applyOsdSettings({ monitorIndex: nextIndex, monitorName, monitorId });
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
  }

  return {
    bindUi,
    openSettingsPanel,
    closeSettingsPanel,
    loadMonitorOptions,
    loadOsdSettings,
    applyOsdSettings,
    reconcileMonitorSelection,
    loadAppSettings,
    syncAppSettingsUI,
    persistAppSettings,
  };
}

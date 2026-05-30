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
  i18n,
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
  const t = (key, params = {}) => (i18n && typeof i18n.t === "function") ? i18n.t(key, params) : String(key || "");
  const applyTranslations = () => {
    if (i18n && typeof i18n.applyTranslations === "function") {
      i18n.applyTranslations(d.settingsPanel || document);
    }
  };
  let monitorDropdownEl = null;
  let monitorMenuEl = null;
  let monitorDisplayEl = null;
  let monitorDocClickBound = false;
  let settingsDocClickBound = false;
  const settingsSelectDropdowns = new Map();
  let updaterUnlisten = null;
  let settingsNavIndicatorRaf = 0;
  let osdAppearanceRaf = 0;
  let osdPreviewResizeObserver = null;
  const defaultSettingsSection = "startup";
  const defaultOsdAppearance = {
    style: "midnight",
    opacity: 0.96,
    scale: 1,
  };
  const defaultOsdAnchor = "top-right";
  const osdStyles = new Set(["midnight", "glass", "neon", "studio"]);
  const osdAnchors = new Set([
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
  ]);
  const languageOptions = Array.isArray(i18n?.supportedLocales) ? i18n.supportedLocales : [
    { code: "en", label: "English" },
  ];
  const updateState = {
    currentVersion: "-",
    latestVersion: "-",
    available: false,
    checking: false,
    downloading: false,
    hasChecked: false,
    body: "",
  };
  let updateCheckPromise = null;

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

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function normalizeOsdStyle(style) {
    const value = String(style || defaultOsdAppearance.style).trim().toLowerCase();
    return osdStyles.has(value) ? value : defaultOsdAppearance.style;
  }

  function normalizeOsdAnchor(anchor) {
    const value = String(anchor || defaultOsdAnchor).trim().toLowerCase();
    return osdAnchors.has(value) ? value : defaultOsdAnchor;
  }

  function normalizeOsdAppearance(settings = {}) {
    return {
      style: normalizeOsdStyle(settings.style),
      opacity: clampNumber(settings.opacity, 0.35, 1, defaultOsdAppearance.opacity),
      scale: clampNumber(settings.scale, 0.75, 1.5, defaultOsdAppearance.scale),
    };
  }

  function sliderFillPercent(inputEl, value) {
    if (!inputEl) return 0;
    const min = Number(inputEl.min || 0);
    const max = Number(inputEl.max || 100);
    const range = max - min;
    if (!Number.isFinite(min) || !Number.isFinite(max) || range <= 0) return 0;
    return Math.min(100, Math.max(0, ((Number(value) - min) / range) * 100));
  }

  function applyOsdAppearanceAttributes(appearance) {
    const previewCard = d.osdPositionPicker?.querySelector(".settings-osd-preview-card");
    const previewScreen = d.osdPositionPicker?.querySelector(".settings-osd-preview-screen");
    const roots = [
      document.body,
      d.settingsPanel,
      d.osdPositionPicker,
      d.osdPositionPicker?.querySelector(".settings-osd-preview"),
    ].filter(Boolean);
    roots.forEach((root) => {
      root.dataset.osdStyle = appearance.style;
      root.style.setProperty("--osd-opacity", String(appearance.opacity));
      root.style.setProperty("--osd-scale", String(appearance.scale));
    });
    if (previewCard) {
      previewCard.style.opacity = String(appearance.opacity);
      previewCard.style.setProperty("--osd-scale", String(appearance.scale));
      const screenRect = previewScreen?.getBoundingClientRect?.();
      const cardWidth = 154;
      const cardHeight = 54;
      const hasMeasuredScreen = Boolean(screenRect && screenRect.width > 0 && screenRect.height > 0);
      const maxPreviewScale = hasMeasuredScreen
        ? Math.min(
            appearance.scale,
            Math.max(0.65, ((screenRect.width / 3) - 12) / cardWidth),
            Math.max(0.65, ((screenRect.height / 3) - 12) / cardHeight),
          )
        : appearance.scale;
      previewCard.style.setProperty("--osd-preview-scale", String(Math.max(0.65, maxPreviewScale)));
    }
  }

  function syncOsdAppearanceUi(settings = {}) {
    const appearance = normalizeOsdAppearance(settings);
    if (typeof setOsdSettings === "function") {
      const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
      setOsdSettings({ ...current, ...(settings || {}), ...appearance });
    }
    applyOsdAppearanceAttributes(appearance);
    if (d.osdStyleSelect) {
      d.osdStyleSelect.value = appearance.style;
      d.osdStyleSelect.classList.add("hidden");
      d.osdStyleSelect.parentElement?.classList.add("has-segmented-style");
      d.osdStyleSelect.parentElement?.querySelectorAll("[data-osd-style-option]").forEach((button) => {
        const selected = button.dataset.osdStyleOption === appearance.style;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      });
    }
    if (d.osdTransparencyInput) {
      const transparency = Math.round(appearance.opacity * 100);
      d.osdTransparencyInput.value = String(transparency);
      d.osdTransparencyInput.style.setProperty("--range-fill", `${sliderFillPercent(d.osdTransparencyInput, transparency)}%`);
      if (d.osdTransparencyValue) {
        d.osdTransparencyValue.textContent = `${transparency}%`;
      }
    }
    if (d.osdScaleInput) {
      const scale = Math.round(appearance.scale * 100);
      d.osdScaleInput.value = String(scale);
      d.osdScaleInput.style.setProperty("--range-fill", `${sliderFillPercent(d.osdScaleInput, scale)}%`);
      if (d.osdScaleValue) {
        d.osdScaleValue.textContent = `${scale}%`;
      }
    }
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
    d.autoCheckUpdatesButton.checked = enabled;
  }

  function formatUpdaterError(error) {
    const message = String(error || t("settings.updateCheckFailed"));
    const normalized = message.toLowerCase();
    if (
      normalized.includes("valid release json")
      || normalized.includes("latest.json")
      || normalized.includes("404")
    ) {
      return t("settings.updateMetadataMissing");
    }
    if (normalized.includes("network") || normalized.includes("timeout")) {
      return t("settings.updateNetworkError");
    }
    return message;
  }

  function setUpdateStatus(message, kind = "") {
    if (!d.settingsUpdateStatus) return;
    d.settingsUpdateStatus.querySelector(".settings-status-text")?.removeAttribute("data-i18n");
    setTextContent(d.settingsUpdateStatus, String(message || ""), ".settings-status-text");
    d.settingsUpdateStatus.classList.remove("error", "success");
    if (kind === "error" || kind === "success") {
      d.settingsUpdateStatus.classList.add(kind);
    }
  }

  function setStaticUpdateStatus(key, kind = "") {
    if (!d.settingsUpdateStatus) return;
    const textEl = d.settingsUpdateStatus.querySelector(".settings-status-text");
    if (textEl) {
      textEl.setAttribute("data-i18n", key);
    }
    setTextContent(d.settingsUpdateStatus, t(key), ".settings-status-text");
    d.settingsUpdateStatus.classList.remove("error", "success");
    if (kind === "error" || kind === "success") {
      d.settingsUpdateStatus.classList.add(kind);
    }
  }

  function renderIdleUpdateStatus() {
    if (updateState.checking || updateState.downloading || updateState.hasChecked || updateState.available) return;
    setStaticUpdateStatus(
      shouldAutoCheckUpdates() ? "settings.noUpdateCheckYet" : "settings.autoCheckUpdatesOff",
    );
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
        setTextContent(d.checkForUpdatesButton, t("settings.downloadingUpdate"), ".settings-button-label");
      } else if (updateState.checking) {
        setTextContent(d.checkForUpdatesButton, t("settings.checkingUpdates"), ".settings-button-label");
      } else if (updateState.available) {
        setTextContent(d.checkForUpdatesButton, t("settings.downloadAndInstall"), ".settings-button-label");
      } else {
        setTextContent(d.checkForUpdatesButton, t("settings.checkForUpdates"), ".settings-button-label");
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
      const label = updateState.latestVersion && updateState.latestVersion !== "-"
        ? t("topbar.updateAvailableVersion", { version: updateState.latestVersion })
        : t("topbar.updateAvailable");
      d.topbarUpdateButton.setAttribute("aria-label", label);
      d.topbarUpdateButton.setAttribute("title", label);
      d.topbarUpdateButton.title = label;
    }
    renderAutoCheckButton();
    renderIdleUpdateStatus();
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

  function shouldAutoCheckUpdates() {
    return (typeof getAppSettings === "function")
      ? ((getAppSettings() || {}).autoCheckUpdates !== false)
      : true;
  }

  function ensureAutoUpdateCheck() {
    if (!shouldAutoCheckUpdates() || updateState.hasChecked) {
      return updateCheckPromise || Promise.resolve(null);
    }
    return checkForUpdates({ silent: true });
  }

  async function checkForUpdates({ silent = false } = {}) {
    if (updateCheckPromise) {
      return updateCheckPromise;
    }
    updateState.checking = true;
    updateState.hasChecked = true;
    renderUpdateUi();
    setUpdateStatus(t("settings.checkingUpdates"));
    updateCheckPromise = (async () => {
      try {
        const updateInfo = await invoke("check_for_updates");
        const normalized = normalizeUpdateInfo(updateInfo);
        updateState.currentVersion = normalized.currentVersion;
        updateState.latestVersion = normalized.latestVersion;
        updateState.available = normalized.available;
        updateState.body = normalized.body;
        if (normalized.available) {
          setUpdateStatus(
            normalized.body
              ? t("settings.updateAvailableNotes", { version: normalized.latestVersion })
              : t("settings.updateAvailable", { version: normalized.latestVersion }),
            "success",
          );
        } else {
          setUpdateStatus(t("settings.upToDate"), "success");
        }
        return normalized;
      } catch (error) {
        updateState.available = false;
        updateState.body = "";
        console.error("Updater check failed:", error);
        setUpdateStatus(formatUpdaterError(error), "error");
        return null;
      } finally {
        updateState.checking = false;
        renderUpdateUi();
        updateCheckPromise = null;
      }
    })();
    return updateCheckPromise;
  }

  async function installAvailableUpdate() {
    updateState.downloading = true;
    renderUpdateUi();
    setUpdateStatus(t("settings.downloadingUpdate"));
    try {
      await invoke("download_and_install_update");
    } catch (error) {
      updateState.available = false;
      updateState.body = "";
      console.error("Updater install failed:", error);
      setUpdateStatus(String(error || t("settings.updateInstallFailed")), "error");
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
        setUpdateStatus(t("settings.checkingUpdates"));
      } else if (phase === "available") {
        updateState.available = true;
        setUpdateStatus(t("settings.updateAvailable", { version: updateState.latestVersion }), "success");
      } else if (phase === "no_update") {
        updateState.available = false;
        updateState.body = "";
        setUpdateStatus(t("settings.upToDate"), "success");
      } else if (phase === "downloading") {
        updateState.downloading = true;
        const downloaded = Number(payload.downloaded || 0);
        const total = Number(payload.content_length || 0);
        if (total > 0) {
          const pct = Math.min(100, Math.round((downloaded / total) * 100));
          setUpdateStatus(t("settings.downloadingUpdatePercent", { percent: pct }));
        } else {
          setUpdateStatus(t("settings.downloadingUpdate"));
        }
      } else if (phase === "downloaded") {
        setUpdateStatus(t("settings.updateDownloadedInstalling"));
      } else if (phase === "installed") {
        updateState.available = false;
        updateState.body = "";
        setUpdateStatus(t("settings.updateInstalledRestarting"), "success");
      } else if (phase === "failed") {
        updateState.available = false;
        updateState.checking = false;
        updateState.downloading = false;
        if (payload.message) {
          console.error("Updater event failure:", payload.message);
        }
        setUpdateStatus(formatUpdaterError(payload.message || t("settings.updateInstallFailed")), "error");
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

  function getActiveSettingsSection() {
    if (!d.settingsPanel) return defaultSettingsSection;
    return d.settingsPanel.querySelector("[data-settings-section].active")?.dataset?.settingsSection
      || defaultSettingsSection;
  }

  function openSettingsPanel() {
    if (!d.settingsPanel) return;
    d.settingsPanel.classList.remove("hidden");
    activateSettingsSection(getActiveSettingsSection());
    scheduleSettingsNavIndicatorSync({ animate: false });
  }

  function activateSettingsSection(sectionName) {
    if (!d.settingsPanel) return;
    const nextSection = String(sectionName || defaultSettingsSection);
    const navItems = Array.from(d.settingsPanel.querySelectorAll("[data-settings-section]"));
    const panels = Array.from(d.settingsPanel.querySelectorAll("[data-settings-panel]"));
    const hasPanel = panels.some((panel) => panel.dataset.settingsPanel === nextSection);
    const activeSection = hasPanel ? nextSection : defaultSettingsSection;

    navItems.forEach((item) => {
      const active = item.dataset.settingsSection === activeSection;
      item.classList.toggle("active", active);
      if (active) {
        item.setAttribute("aria-current", "page");
      } else {
        item.removeAttribute("aria-current");
      }
    });
    panels.forEach((panel) => {
      const active = panel.dataset.settingsPanel === activeSection;
      panel.classList.toggle("active", active);
      panel.classList.toggle("hidden", !active);
    });
    if (activeSection === "osd") {
      syncOsdAppearanceControls();
    }
    scheduleSettingsNavIndicatorSync({ animate: true });
  }

  function syncSettingsNavIndicator({ animate = true } = {}) {
    if (!d.settingsPanel) return;
    const sidebar = d.settingsPanel.querySelector(".settings-sidebar");
    const indicator = sidebar?.querySelector(".settings-nav-indicator");
    const active = sidebar?.querySelector(".settings-nav-item.active");
    if (!indicator || !active || !sidebar) {
      if (indicator) indicator.style.opacity = "0";
      return;
    }
    const sidebarRect = sidebar.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    indicator.classList.toggle("is-ready", Boolean(animate));
    indicator.style.width = `${activeRect.width}px`;
    indicator.style.height = `${activeRect.height}px`;
    indicator.style.transform = `translate(${activeRect.left - sidebarRect.left}px, ${activeRect.top - sidebarRect.top}px)`;
    indicator.style.opacity = "1";
    if (!animate) {
      requestAnimationFrame(() => {
        indicator.classList.add("is-ready");
      });
    }
  }

  function scheduleSettingsNavIndicatorSync({ animate = true } = {}) {
    if (settingsNavIndicatorRaf) {
      cancelAnimationFrame(settingsNavIndicatorRaf);
    }
    settingsNavIndicatorRaf = requestAnimationFrame(() => {
      settingsNavIndicatorRaf = 0;
      syncSettingsNavIndicator({ animate });
    });
  }

  function scheduleOsdAppearanceSync() {
    if (osdAppearanceRaf) {
      cancelAnimationFrame(osdAppearanceRaf);
    }
    osdAppearanceRaf = requestAnimationFrame(() => {
      osdAppearanceRaf = 0;
      syncOsdAppearanceControls();
    });
  }

  function updateOsdPositionSelection(anchor) {
    if (!d.osdPositionPicker) return;
    const selectedAnchor = normalizeOsdAnchor(anchor);
    d.osdPositionPicker.dataset.anchor = selectedAnchor;
    d.osdPositionPicker.querySelectorAll(".osd-position-dot").forEach((dot) => {
      dot.classList.toggle("selected", dot.dataset.anchor === selectedAnchor);
    });
  }

  function syncOsdPositionUi(settings = {}) {
    const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
    const anchor = normalizeOsdAnchor(settings.anchor ?? current.anchor);
    if (typeof setOsdSettings === "function") {
      setOsdSettings({ ...current, ...(settings || {}), anchor });
    }
    updateOsdPositionSelection(anchor);
    document.body.setAttribute("data-anchor", anchor);
  }

  function syncOsdSettingsUi(settings = {}) {
    const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
    const merged = {
      ...current,
      ...(settings || {}),
      anchor: normalizeOsdAnchor(settings.anchor ?? current.anchor),
    };

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

    syncOsdAppearanceUi(merged);
    syncOsdPositionUi(merged);
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
    const merged = {
      ...current,
      ...(nextSettings || {}),
      anchor: normalizeOsdAnchor(nextSettings?.anchor ?? current.anchor),
    };
    if (typeof setOsdSettings === "function") {
      setOsdSettings(merged);
    }

    syncOsdSettingsUi(merged);

    try {
      const appearance = normalizeOsdAppearance(merged);
      await invoke("update_osd_settings", {
        enabled: merged.enabled,
        monitorIndex: merged.monitorIndex,
        monitorName: merged.monitorName || null,
        monitorId: merged.monitorId || null,
        anchor: merged.anchor,
        style: appearance.style,
        opacity: appearance.opacity,
        scale: appearance.scale,
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
          anchor: normalizeOsdAnchor(settings.anchor),
          style: normalizeOsdStyle(settings.style),
          opacity: clampNumber(settings.opacity, 0.35, 1, defaultOsdAppearance.opacity),
          scale: clampNumber(settings.scale, 0.75, 1.5, defaultOsdAppearance.scale),
        };
        syncOsdSettingsUi(next);
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
    const entry = ensureSettingsSelectDropdown(selectEl, { title: selectEl.title || selectEl.id || t("common.select") });
    if (!entry) return;
    selectEl.classList.add("hidden");
    selectEl.parentElement?.classList.add("has-custom-select");
    renderNativeSelectDropdown({
      entry,
      selectEl,
      fallbackText: t("common.select"),
      closeDropdowns: () => closeOpenDropdowns({ except: null }),
      formatOptionText: (opt) => opt.textContent || "",
      getOptionBadges: () => [],
      truncateMenuLabels: false,
      truncateDisplayLabel: true,
    });
  }

  function renderAllSettingsSelectDropdowns() {
    if (d.languageSelect) {
      renderSettingsSelectDropdown(d.languageSelect);
    }
  }

  function scheduleSettingsControlSync() {
    requestAnimationFrame(() => {
      renderAllSettingsSelectDropdowns();
      syncOsdAppearanceControls();
    });
  }

  function syncOsdAppearanceControls() {
    const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
    syncOsdSettingsUi(current);
  }

  function renderMonitorDisplay(option) {
    if (!monitorDisplayEl) return;
    renderLabelWithBadges(monitorDisplayEl, {
      text: option?.label || t("settings.monitor"),
      badges: option?.isPrimary ? [{ text: t("settings.primaryBadge"), kind: "neutral" }] : [],
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
      title: t("settings.monitor"),
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
      fallbackText: t("settings.monitor"),
      closeDropdowns: closeMonitorDropdown,
      formatOptionText: (opt) => opt.textContent || "",
      getOptionBadges: (opt) => (opt.dataset.isPrimary === "true"
        ? [{ text: t("settings.primaryBadge"), kind: "neutral" }]
        : []),
      onOptionSelected: (opt) => {
        renderMonitorDisplay({
          value: String(opt.value || "0"),
          label: opt.textContent || t("settings.monitor"),
          isPrimary: opt.dataset.isPrimary === "true",
        });
      },
      truncateMenuLabels: false,
      truncateDisplayLabel: true,
    });

    if (list.length === 0) {
      renderMonitorDisplay({ value: "0", label: t("settings.monitor"), isPrimary: true });
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
        option.textContent = t("settings.primaryMonitor");
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
      d.startWithWindowsSelect.checked = Boolean(merged.startWithWindows);
    }
    if (d.startInTraySelect) {
      d.startInTraySelect.checked = Boolean(merged.startInTray);
    }
    if (d.minimizeToTraySelect) {
      d.minimizeToTraySelect.checked = Boolean(merged.minimizeToTray);
    }
    if (d.exitToTraySelect) {
      d.exitToTraySelect.checked = Boolean(merged.exitToTray);
    }
    if (d.languageSelect) {
      d.languageSelect.value = normalizeLanguage(merged.language);
      renderSettingsSelectDropdown(d.languageSelect);
    }
    renderUpdateUi();
  }

  function persistAppSettings() {
    const s = (typeof getAppSettings === "function") ? (getAppSettings() || {}) : {};
    return invoke("update_app_settings", {
      startWithWindows: Boolean(s.startWithWindows),
      startInTray: Boolean(s.startInTray),
      minimizeToTray: Boolean(s.minimizeToTray),
      exitToTray: Boolean(s.exitToTray),
      autoCheckUpdates: s.autoCheckUpdates !== false,
      language: normalizeLanguage(s.language),
    }).catch((error) => {
      console.error("Failed to update app settings", error);
    });
  }

  function normalizeLanguage(language) {
    const value = String(language || "en").trim();
    return languageOptions.some((option) => option.code === value) ? value : "en";
  }

  function populateLanguageSelect() {
    if (!d.languageSelect || d.languageSelect.options.length > 0) return;
    languageOptions.forEach((language) => {
      const option = document.createElement("option");
      option.value = language.code;
      option.textContent = language.label;
      d.languageSelect.appendChild(option);
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
          language: normalizeLanguage(settings.language ?? settings.languageCode ?? "en"),
        };
        if (typeof setAppSettings === "function") {
          setAppSettings(next);
        }
        await i18n?.setLocale?.(next.language).catch((error) => {
          console.error("Failed to apply language setting", error);
        });
        applyTranslations();
      }
    } catch (error) {
      console.error("Failed to load app settings", error);
    }
  }

  function bindUi() {
    bindUpdaterEvents().catch(() => {});
    populateLanguageSelect();
    if (d.settingsPanel) {
      activateSettingsSection(defaultSettingsSection);
      window.addEventListener("resize", () => {
        scheduleSettingsNavIndicatorSync();
        scheduleOsdAppearanceSync();
      });
      if ("ResizeObserver" in window && d.osdPositionPicker && !osdPreviewResizeObserver) {
        osdPreviewResizeObserver = new ResizeObserver(scheduleOsdAppearanceSync);
        osdPreviewResizeObserver.observe(d.osdPositionPicker);
        const previewScreen = d.osdPositionPicker.querySelector(".settings-osd-preview-screen");
        if (previewScreen) {
          osdPreviewResizeObserver.observe(previewScreen);
        }
      }
      d.settingsPanel.addEventListener("click", (event) => {
        const sectionButton = event.target.closest("[data-settings-section]");
        if (sectionButton && d.settingsPanel.contains(sectionButton)) {
          activateSettingsSection(sectionButton.dataset.settingsSection);
          return;
        }
        const styleButton = event.target.closest("[data-osd-style-option]");
        if (styleButton && d.settingsPanel.contains(styleButton) && d.osdStyleSelect) {
          d.osdStyleSelect.value = normalizeOsdStyle(styleButton.dataset.osdStyleOption);
          d.osdStyleSelect.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        if (d.settingsPanel.classList.contains("target-panel") && event.target === d.settingsPanel) {
          closeSettingsPanel();
        }
      });
      d.settingsPanel.addEventListener("input", (event) => {
        if (event.target === d.osdTransparencyInput) {
          const opacity = clampNumber(Number(d.osdTransparencyInput.value) / 100, 0.35, 1, defaultOsdAppearance.opacity);
          const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
          syncOsdAppearanceUi({ ...current, opacity });
          return;
        }
        if (event.target === d.osdScaleInput) {
          const scale = clampNumber(Number(d.osdScaleInput.value) / 100, 0.75, 1.5, defaultOsdAppearance.scale);
          const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
          syncOsdAppearanceUi({ ...current, scale });
        }
      });
      d.settingsPanel.addEventListener("change", (event) => {
        if (event.target === d.osdStyleSelect) {
          const style = normalizeOsdStyle(d.osdStyleSelect.value);
          const current = (typeof getOsdSettings === "function") ? (getOsdSettings() || {}) : {};
          syncOsdAppearanceUi({ ...current, style });
          applyOsdSettings({ style });
          return;
        }
        if (event.target === d.osdTransparencyInput) {
          applyOsdSettings({
            opacity: clampNumber(Number(d.osdTransparencyInput.value) / 100, 0.35, 1, defaultOsdAppearance.opacity),
          });
          return;
        }
        if (event.target === d.osdScaleInput) {
          applyOsdSettings({
            scale: clampNumber(Number(d.osdScaleInput.value) / 100, 0.75, 1.5, defaultOsdAppearance.scale),
          });
        }
      });
      scheduleSettingsControlSync();
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
        syncAppSettingsUI({ startWithWindows: d.startWithWindowsSelect.checked });
        persistAppSettings();
      });
    }
    if (d.startInTraySelect) {
      d.startInTraySelect.addEventListener("change", () => {
        syncAppSettingsUI({ startInTray: d.startInTraySelect.checked });
        persistAppSettings();
      });
    }
    if (d.minimizeToTraySelect) {
      d.minimizeToTraySelect.addEventListener("change", () => {
        syncAppSettingsUI({ minimizeToTray: d.minimizeToTraySelect.checked });
        persistAppSettings();
      });
    }
    if (d.exitToTraySelect) {
      d.exitToTraySelect.addEventListener("change", () => {
        syncAppSettingsUI({ exitToTray: d.exitToTraySelect.checked });
        persistAppSettings();
      });
    }
    if (d.languageSelect) {
      d.languageSelect.addEventListener("change", async () => {
        const language = normalizeLanguage(d.languageSelect.value);
        syncAppSettingsUI({ language });
        await i18n?.setLocale?.(language).catch((error) => {
          console.error("Failed to apply language setting", error);
        });
        applyTranslations();
        renderUpdateUi();
        persistAppSettings();
      });
    }
    if (d.autoCheckUpdatesButton) {
      d.autoCheckUpdatesButton.addEventListener("change", () => {
        syncAppSettingsUI({ autoCheckUpdates: d.autoCheckUpdatesButton.checked });
        persistAppSettings();
        renderUpdateUi();
        ensureAutoUpdateCheck();
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

    window.addEventListener("midimaster:locale-changed", () => {
      applyTranslations();
      renderAllSettingsSelectDropdowns();
      renderMonitorDropdownOptions((typeof getMonitorOptions === "function") ? (getMonitorOptions() || []) : []);
      renderUpdateUi();
    });

    setStaticUpdateStatus("settings.noUpdateCheckYet");
    renderUpdateUi();
    renderAllSettingsSelectDropdowns();
    scheduleSettingsControlSync();
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
    ensureAutoUpdateCheck,
    installAvailableUpdate,
    activateSettingsSection,
    renderAllSettingsSelectDropdowns,
    syncOsdAppearanceControls,
  };
}

import { closeOpenDropdowns, renderLabelFromRawWithTags } from "../ui/dropdown_badges.js";

export function createTargetsFeature({
  invoke,
  i18n,
  dom,
  masterIconData,
  focusIconData,
  mediaPlayPauseIconData,
  mediaNextTrackIconData,
  mediaPrevTrackIconData,
  mediaStopIconData,
  getPluginHost,
  getSessions,
  getPlaybackDevices,
  getRecordingDevices,
  normalizeSessionKey,
  integrationTargetKey,
  resolveOsdTarget,
}) {
  const d = (dom && typeof dom === "object") ? dom : {};
  const getHost = (typeof getPluginHost === "function") ? getPluginHost : (() => null);
  const getSess = (typeof getSessions === "function") ? getSessions : (() => []);
  const getPlayback = (typeof getPlaybackDevices === "function") ? getPlaybackDevices : (() => []);
  const getRecording = (typeof getRecordingDevices === "function") ? getRecordingDevices : (() => []);
  const normalizeKey = (typeof normalizeSessionKey === "function") ? normalizeSessionKey : (() => "");
  const targetKey = (typeof integrationTargetKey === "function") ? integrationTargetKey : (() => "");
  const resolveDisplay = (typeof resolveOsdTarget === "function") ? resolveOsdTarget : (() => null);
  const callInvoke = (typeof invoke === "function") ? invoke : null;
  const t = (key, params = {}) => (i18n && typeof i18n.t === "function") ? i18n.t(key, params) : String(key || "");

  let activeTargetPanelSelect = null;
  let activeTargetPanelBack = null;
  let activeTargetPanelIntegrationId = null;
  let activeTargetPanelRefresh = null;
  const HOTKEY_ICON_DATA = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' fill='none'><rect x='2' y='4' width='16' height='12' rx='3' fill='%231a2446' stroke='%2398a6cc' stroke-width='1.2'/><rect x='4' y='7' width='2.2' height='2.2' rx='0.6' fill='%23c7d2f3'/><rect x='7' y='7' width='2.2' height='2.2' rx='0.6' fill='%23c7d2f3'/><rect x='10' y='7' width='2.2' height='2.2' rx='0.6' fill='%23c7d2f3'/><rect x='13' y='7' width='2.2' height='2.2' rx='0.6' fill='%23c7d2f3'/><rect x='5.2' y='10.6' width='9.6' height='2.2' rx='0.8' fill='%23c7d2f3'/></svg>";
  const OPEN_APPLICATION_TARGET_ICON_DATA = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' fill='none'><rect x='2.2' y='3.6' width='15.6' height='12.8' rx='2.2' stroke='%2398a6cc' stroke-width='1.2'/><path d='M6.2 7.3h4.9M6.2 10h7.6M6.2 12.7h5.7' stroke='%23c7d2f3' stroke-width='1.3' stroke-linecap='round'/><path d='M12.3 5.2l2.9 2.9-2.9 2.9' stroke='%238fd5ff' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/></svg>";
  const TOGGLE_MUTE_ICON_DATA = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' fill='none'><path d='M3 8.2v3.6h2.6l3.3 2.8V5.4L5.6 8.2H3z' fill='%23c7d2f3'/><path d='M12.4 7.1l4.5 5.8M16.9 7.1l-4.5 5.8' stroke='%23f7a7a7' stroke-width='1.5' stroke-linecap='round'/></svg>";
  const SET_DEFAULT_DEVICE_ICON_DATA = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' fill='none'><rect x='2.2' y='5' width='15.6' height='10' rx='2.2' stroke='%2398a6cc' stroke-width='1.2'/><path d='M6 10h4.6M8.6 7.4L11.2 10l-2.6 2.6' stroke='%23c7d2f3' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/><path d='M13.7 8.1v3.8M15.6 10l-1.9 1.9M11.8 10l1.9 1.9' stroke='%2386d6a7' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/></svg>";
  const WINDOW_FOCUS_ICON_DATA = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' fill='none'><rect x='2.5' y='4' width='15' height='12' rx='2.2' stroke='%2398a6cc' stroke-width='1.2'/><path d='M2.5 7.5h15' stroke='%2398a6cc' stroke-width='1.2'/><path d='M8 11h4M10 9v4' stroke='%238fd5ff' stroke-width='1.4' stroke-linecap='round'/></svg>";
  const CAPTURE_ICON_DATA = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' fill='none'><rect x='3' y='5.2' width='14' height='10.3' rx='2.2' stroke='%2398a6cc' stroke-width='1.2'/><path d='M7 5.2l1-1.7h4l1 1.7' stroke='%2398a6cc' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/><circle cx='10' cy='10.5' r='2.5' stroke='%238fd5ff' stroke-width='1.3'/></svg>";
  const SNIP_ICON_DATA = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' fill='none'><path d='M5 5h10v10H5z' stroke='%2398a6cc' stroke-width='1.2' stroke-dasharray='2 2'/><path d='M7 13l6-6M7 7l6 6' stroke='%238fd5ff' stroke-width='1.3' stroke-linecap='round'/></svg>";
  const RECORD_ICON_DATA = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' fill='none'><rect x='3' y='5' width='14' height='10' rx='2.2' stroke='%2398a6cc' stroke-width='1.2'/><circle cx='10' cy='10' r='2.6' fill='%23f26d6d'/></svg>";

  function normalizeOpenApplication(raw) {
    if (!raw || typeof raw !== "object") return null;
    const path = String(raw.path || "").trim();
    const display = String(raw.display || "").trim();
    const iconData = typeof raw.icon_data === "string" && raw.icon_data.trim()
      ? raw.icon_data.trim()
      : null;
    if (!path) return null;
    return {
      path,
      display: friendlyAppName(display || path) || display || path,
      icon_data: iconData,
    };
  }

  function displayNameFromPath(path) {
    const value = String(path || "").trim();
    if (!value) return "";
    const parts = value.split(/[\\/]/);
    return parts[parts.length - 1] || value;
  }

  function friendlyAppName(rawNameOrPath) {
    const base = displayNameFromPath(rawNameOrPath);
    if (!base) return "";
    return base.replace(/\.exe$/i, "").trim() || base;
  }

  function normalizeCompareName(raw) {
    return String(raw || "")
      .toLowerCase()
      .replace(/\.exe$/i, "")
      .replace(/[^a-z0-9]+/g, "");
  }

  function resolveOpenApplicationIcon(openApplication) {
    if (!openApplication?.display && !openApplication?.path) return null;
    const needle = normalizeCompareName(openApplication.display || openApplication.path);
    if (!needle) return null;
    const sessions = getSess();
    if (!Array.isArray(sessions) || sessions.length === 0) return null;
    for (const session of sessions) {
      const icon = session?.icon_data || null;
      if (!icon) continue;
      const candidates = [
        session?.display_name,
        session?.name,
        session?.process_name,
        session?.process,
        session?.exe,
      ];
      const matched = candidates.some((candidate) => normalizeCompareName(candidate) === needle);
      if (matched) return icon;
    }
    return null;
  }

  async function pickOpenApplication() {
    if (!callInvoke) return null;
    const picked = await callInvoke("pick_executable_path");
    if (!picked) return null;
    const path = String(picked.path || "").trim();
    if (!path) return null;
    const display = String(picked.display || "").trim();
    const iconData = typeof picked.icon_data === "string" && picked.icon_data.trim()
      ? picked.icon_data.trim()
      : null;
    return {
      path,
      display: friendlyAppName(display || path),
      icon_data: iconData,
    };
  }

  function mediaIconForAction(action) {
    if (action === "MediaNextTrack") return mediaNextTrackIconData;
    if (action === "MediaPrevTrack") return mediaPrevTrackIconData;
    if (action === "MediaStop") return mediaStopIconData;
    return mediaPlayPauseIconData;
  }

  function closeTargetMenus(except = null) {
    closeOpenDropdowns({ except });
  }

  function createTargetIcon(option) {
    if (option?.icon_data) {
      const icon = document.createElement("img");
      icon.className = "target-icon";
      icon.alt = "";
      const src = String(option.icon_data);
      icon.src = src.startsWith("data:") || src.startsWith("assets/")
        ? src
        : `data:image/png;base64,${src}`;
      return icon;
    }
    const fallback = document.createElement("span");
    fallback.className = "target-icon fallback";
    fallback.textContent = option?.label?.[0]?.toUpperCase() || "?";
    return fallback;
  }

  const INTEGRATION_META = {
    obs: {
      descriptionKey: "targets.integration.obsDescription",
    },
    hue: {
      descriptionKey: "targets.integration.hueDescription",
    },
    wavelink: {
      descriptionKey: "targets.integration.wavelinkDescription",
    },
  };

  const CATEGORY_META = {
    all: { key: "targets.category.all", icon: "all" },
    builtIn: { key: "targets.category.builtIn", icon: "built-in" },
    utilities: { key: "targets.category.utilities", icon: "utilities" },
    integrations: { key: "targets.category.integrations", icon: "integrations" },
    applications: { key: "targets.category.applications", icon: "applications" },
    playback: { key: "targets.category.playback", icon: "playback" },
    recording: { key: "targets.category.recording", icon: "recording" },
    devices: { key: "targets.category.devices", icon: "devices" },
    actions: { key: "targets.category.actions", icon: "actions" },
    other: { key: "targets.category.other", icon: "other" },
  };

  function categoryLabel(id) {
    const meta = CATEGORY_META[id] || CATEGORY_META.other;
    return t(meta.key);
  }

  function targetPanelParts() {
    const panel = d.targetPanel || null;
    return {
      searchInput: panel?.querySelector?.("#target-panel-search") || null,
      categories: panel?.querySelector?.("#target-panel-categories") || null,
    };
  }

  function categoryForOption(option, fallback = "other") {
    if (!option || option.kind === "divider") return null;
    if (option.category) return option.category;
    if (option.integrationId || option.integration_id) return "integrations";
    if (option.kind === "master" || option.kind === "focus") return "builtIn";
    if (option.kind === "media-control" || option.kind === "hotkey-target" || option.kind === "open-application-target" || option.kind === "action-root" || option.kind === "capture-action") return "utilities";
    if (option.kind === "integration-root" || option.kind === "integration-target" || option.kind === "integration-nav") return "integrations";
    if (option.kind === "session") return "applications";
    if (option.kind === "device") {
      const value = String(option.value || "");
      if (value.startsWith("playback:")) return "playback";
      if (value.startsWith("recording:")) return "recording";
      return "devices";
    }
    if (option.kind === "action") return "actions";
    if (option.kind === "placeholder") return fallback;
    return fallback;
  }

  function descriptionForOption(option, category) {
    if (option?.description) return String(option.description);
    if (option?.kind === "master") return t("targets.description.master");
    if (option?.kind === "focus") return t("targets.description.focus");
    if (option?.kind === "media-control") return t("targets.description.mediaControl");
    if (option?.kind === "hotkey-target") return t("targets.description.hotkey");
    if (option?.kind === "open-application-target") return t("targets.description.openApplication");
    if (option?.kind === "action-root" && option?.value === "window-focus") return t("targets.description.windowFocus");
    if (option?.kind === "action-root" && option?.value === "capture") return t("targets.description.captureControls");
    if (option?.kind === "capture-action") return t("targets.description.captureAction");
    if (option?.kind === "session") return option.ghost ? t("targets.description.savedApplicationUnavailable") : t("targets.description.applicationSession");
    if (option?.kind === "device") {
      if (option.ghost) return t("targets.description.savedDeviceUnavailable");
      if (category === "playback") return t("targets.description.playbackDevice");
      if (category === "recording") return t("targets.description.recordingDevice");
      return t("targets.description.audioDevice");
    }
    if (option?.kind === "integration-root") {
      const meta = INTEGRATION_META[String(option.value || "").toLowerCase()];
      return meta?.descriptionKey ? t(meta.descriptionKey) : t("targets.description.openIntegrationTargets");
    }
    if (option?.kind === "integration-target") {
      const integration = option?.target?.Integration || option?.target?.integration;
      const integrationId = String(integration?.integration_id || option?.integrationId || option?.integration_id || "").toLowerCase();
      const targetKind = String(integration?.kind || "").toLowerCase();
      if (integrationId === "wavelink") {
        if (targetKind === "mix") return t("targets.description.wavelinkMix");
        if (targetKind === "channel") return t("targets.description.wavelinkChannel");
        if (targetKind === "channel_mix") return t("targets.description.wavelinkChannelMix");
        return t("targets.description.wavelinkTarget");
      }
      if (integrationId === "obs") {
        if (targetKind === "input") return t("targets.description.obsInput");
        if (targetKind === "scene") return t("targets.description.obsScene");
        if (targetKind === "source") return t("targets.description.obsSource");
        if (targetKind === "action") return t("targets.description.obsAction");
      }
      if (integrationId === "hue") {
        if (targetKind === "group") return t("targets.description.hueGroup");
        if (targetKind === "light") return t("targets.description.hueLight");
      }
      return "";
    }
    if (option?.kind === "integration-nav") return t("targets.description.integrationGroup");
    if (option?.kind === "action") return "";
    if (option?.kind === "placeholder") return "";
    return categoryLabel(category);
  }

  function tagsForOption(option, category) {
    const tags = [];
    const add = (value) => {
      const text = String(value || "").trim();
      if (text && !tags.some((tag) => tag.toLowerCase() === text.toLowerCase())) {
        tags.push(text);
      }
    };
    if (option?.ghost && !option?.suppressUnavailableTag) add(t("targets.unavailable"));

    if (option?.kind !== "integration-root") {
      (option?.tags || []).forEach(add);
    }
    return tags;
  }

  function optionSearchText(option) {
    return [
      option?.label,
      option?.value,
      option?.kind,
      option?.categoryLabel,
      option?.description,
      ...(Array.isArray(option?.tags) ? option.tags : []),
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function normalizePanelOptions(options) {
    let currentDivider = null;
    const normalized = [];
    for (const option of options || []) {
      if (!option || typeof option !== "object") continue;
      if (option.kind === "divider") {
        currentDivider = String(option.label || "").trim();
        continue;
      }
      const category = categoryForOption(option, "other");
      const meta = CATEGORY_META[category] || CATEGORY_META.other;
      const next = {
        ...option,
        category,
        categoryLabel: categoryLabel(category),
      };
      if (!next.description) {
        next.description = descriptionForOption(next, category);
      }
      next.tags = tagsForOption(next, category);
      if (currentDivider && !next.sectionLabel) {
        next.sectionLabel = currentDivider;
      }
      next.searchText = optionSearchText(next);
      normalized.push(next);
    }
    return normalized;
  }

  function categorySvg(kind) {
    if (kind === "built-in") return "<path d='M12 5v14M8 8h8M8 16h8' />";
    if (kind === "utilities") return "<path d='M4 7h16M7 4v6M17 14v6M4 17h16' />";
    if (kind === "integrations") return "<path d='M8 8h8v8H8z' /><path d='M12 3v5M12 16v5M3 12h5M16 12h5' />";
    if (kind === "applications") return "<path d='M4 5h16v14H4z' /><path d='M4 9h16' />";
    if (kind === "playback") return "<path d='M5 8v8h4l6 4V4L9 8H5z' />";
    if (kind === "recording") return "<path d='M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z' /><path d='M6 11a6 6 0 0 0 12 0M12 17v3' />";
    if (kind === "devices") return "<path d='M5 6h14v10H5z' /><path d='M9 20h6M12 16v4' />";
    if (kind === "actions") return "<path d='M8 5v14l11-7Z' />";
    if (kind === "other") return "<circle cx='12' cy='12' r='7' /><path d='M12 9v3M12 15h.01' />";
    return "<path d='M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v5H4zM13 14h7v5h-7z' />";
  }

  function createCategoryIcon(icon) {
    const wrap = document.createElement("span");
    wrap.className = "target-category-icon";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML = `<svg viewBox="0 0 24 24" focusable="false">${categorySvg(icon)}</svg>`;
    return wrap;
  }

  function closeTargetPanel() {
    if (!d.targetPanel) {
      return;
    }
    d.targetPanel.classList.add("hidden");
    if (d.targetPanelList) {
      d.targetPanelList.innerHTML = "";
    }
    const { searchInput, categories } = targetPanelParts();
    if (searchInput) searchInput.value = "";
    if (categories) categories.innerHTML = "";
    activeTargetPanelSelect = null;
    activeTargetPanelBack = null;
    activeTargetPanelIntegrationId = null;
    activeTargetPanelRefresh = null;

    if (d.targetPanelBack) {
      d.targetPanelBack.style.display = "none";
      d.targetPanelBack.onclick = null;
    }
  }

  function openTargetPanel(options, selectedValue, selectedKind, onSelect, title = "", nav = null) {
    if (!d.targetPanel || !d.targetPanelList) {
      return;
    }
    activeTargetPanelSelect = onSelect;
    activeTargetPanelBack = nav && typeof nav === "object" ? (nav.onBack || null) : null;
    activeTargetPanelIntegrationId = nav && typeof nav === "object" ? (nav.integrationId || null) : null;
    activeTargetPanelRefresh = nav && typeof nav === "object" && typeof nav.refresh === "function"
      ? nav.refresh
      : null;
    const { searchInput, categories } = targetPanelParts();
    const normalizedOptions = normalizePanelOptions(options);
    let activeCategory = "all";
    let categoryIndicatorRaf = 0;

    if (d.targetPanelBack) {
      if (typeof activeTargetPanelBack === "function") {
        d.targetPanelBack.style.display = "inline-flex";
        d.targetPanelBack.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          activeTargetPanelBack();
        };
      } else {
        d.targetPanelBack.style.display = "none";
        d.targetPanelBack.onclick = null;
      }
    }

    d.targetPanelList.innerHTML = "";
    if (categories) {
      categories.innerHTML = "";
    }
    if (searchInput) {
      searchInput.value = "";
    }
    if (d.targetPanelTitle) {
      d.targetPanelTitle.textContent = title || t("targets.selectTarget");
    }

    const renderOption = (option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "target-option target-card";
      item.appendChild(createTargetIcon(option));

      const copy = document.createElement("span");
      copy.className = "target-card-copy";

      const titleRow = document.createElement("span");
      titleRow.className = "target-card-title-row";

      const label = document.createElement("span");
      label.className = "target-label";
      renderLabelFromRawWithTags(label, {
        rawLabel: option.label,
        extraTags: [],
        truncateMain: true,
      });
      titleRow.appendChild(label);
      copy.appendChild(titleRow);

      if (option.description) {
        const description = document.createElement("span");
        description.className = "target-card-description";
        description.textContent = option.description;
        copy.appendChild(description);
      }

      if (Array.isArray(option.tags) && option.tags.length > 0) {
        const tagRow = document.createElement("span");
        tagRow.className = "target-card-tags";
        option.tags.slice(0, 4).forEach((tag) => {
          const pill = document.createElement("span");
          pill.className = "target-card-tag";
          pill.textContent = tag;
          tagRow.appendChild(pill);
        });
        copy.appendChild(tagRow);
      }

      item.appendChild(copy);

      if (option.kind === "integration-root" || option.kind === "integration-nav" || option.kind === "action-root") {
        const navMeta = document.createElement("span");
        navMeta.className = "target-card-nav-meta";

        const badge = document.createElement("span");
        badge.className = "target-card-kind-badge";
        badge.textContent = option.kind === "action-root" ? t("targets.category.actions") : t("targets.integration");
        navMeta.appendChild(badge);

        const arrow = document.createElement("span");
        arrow.className = "target-card-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "\u203a";
        navMeta.appendChild(arrow);

        item.appendChild(navMeta);
      }

      item.classList.toggle(
        "selected",
        option.value === selectedValue && option.kind === selectedKind,
      );
      if (option.ghost) {
        item.classList.add("unavailable");
        item.style.opacity = "0.6";
      }

      if (option.kind === "placeholder" || option.disabled) {
        item.disabled = true;
      }
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (activeTargetPanelSelect) {
          const res = activeTargetPanelSelect(option);
          if (res === false) {
            item.classList.toggle("selected");
            return;
          }
        }
        closeTargetPanel();
      });
      d.targetPanelList.appendChild(item);
    };

    const render = () => {
      const query = String(searchInput?.value || "").trim().toLowerCase();
      const filtered = normalizedOptions.filter((option) => {
        const matchesCategory = activeCategory === "all" || option.category === activeCategory;
        const matchesSearch = !query || option.searchText.includes(query);
        return matchesCategory && matchesSearch;
      });

      d.targetPanelList.innerHTML = "";
      if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "target-panel-empty";
        empty.textContent = query ? t("targets.noMatches") : t("targets.noneAvailable");
        d.targetPanelList.appendChild(empty);
        return;
      }
      filtered.forEach(renderOption);
    };

    const syncCategoryIndicator = () => {
      if (!categories) return;
      const indicator = categories.querySelector(".target-category-indicator");
      const active = categories.querySelector(".target-category.active");
      if (!indicator || !active) {
        if (indicator) indicator.style.opacity = "0";
        return;
      }
      const parentRect = categories.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      indicator.style.width = `${activeRect.width}px`;
      indicator.style.height = `${activeRect.height}px`;
      indicator.style.transform = `translate(${activeRect.left - parentRect.left + categories.scrollLeft}px, ${activeRect.top - parentRect.top + categories.scrollTop}px)`;
      indicator.style.opacity = "1";
      requestAnimationFrame(() => indicator.classList.add("is-ready"));
    };

    const scheduleCategoryIndicatorSync = () => {
      if (categoryIndicatorRaf) {
        cancelAnimationFrame(categoryIndicatorRaf);
      }
      categoryIndicatorRaf = requestAnimationFrame(() => {
        categoryIndicatorRaf = 0;
        syncCategoryIndicator();
      });
    };

    const renderCategories = () => {
      if (!categories) return;
      categories.innerHTML = "";
      const indicator = document.createElement("div");
      indicator.className = "target-category-indicator";
      indicator.setAttribute("aria-hidden", "true");
      categories.appendChild(indicator);
      const counts = new Map();
      normalizedOptions.forEach((option) => {
        counts.set(option.category, (counts.get(option.category) || 0) + 1);
      });
      const categoryIds = ["all", ...Object.keys(CATEGORY_META).filter((id) => id !== "all" && counts.has(id))];
      categoryIds.forEach((id) => {
        const meta = CATEGORY_META[id] || CATEGORY_META.other;
        const count = id === "all" ? normalizedOptions.length : (counts.get(id) || 0);
        if (count === 0) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "target-category";
        button.classList.toggle("active", id === activeCategory);
        button.appendChild(createCategoryIcon(meta.icon));

        const label = document.createElement("span");
        label.className = "target-category-label";
        label.textContent = categoryLabel(id);
        button.appendChild(label);

        const countEl = document.createElement("span");
        countEl.className = "target-category-count";
        countEl.textContent = String(count);
        button.appendChild(countEl);

        button.addEventListener("click", (event) => {
          event.preventDefault();
          activeCategory = id;
          categories.querySelectorAll(".target-category").forEach((item) => {
            item.classList.toggle("active", item === button);
          });
          scheduleCategoryIndicatorSync();
          render();
        });
        categories.appendChild(button);
      });
      categories.onscroll = scheduleCategoryIndicatorSync;
      scheduleCategoryIndicatorSync();
    };

    if (searchInput) {
      searchInput.oninput = render;
      setTimeout(() => searchInput.focus(), 0);
    }
    renderCategories();
    render();
    d.targetPanel.classList.remove("hidden");
  }

  function buildTargetOptions(currentTarget, isButton = false) {
    const pluginHost = getHost();
    const sessions = getSess();
    const playbackDevices = getPlayback();
    const recordingDevices = getRecording();

    const integration = currentTarget?.Integration || currentTarget?.integration;
    const selectedAppContainer = currentTarget?.Application || currentTarget?.application;
    const selectedAppName = selectedAppContainer?.name || selectedAppContainer?.appName;
    const selectedAppKey = selectedAppName ? String(selectedAppName).toLowerCase() : "";
    const selectedAppDisplayName = selectedAppContainer?.display_name || selectedAppContainer?.displayName || "";
    const selectedAppIconData = selectedAppContainer?.icon_data || selectedAppContainer?.iconData || null;
    const sessionContainer = currentTarget?.Session || currentTarget?.session;
    const selectedSessionId = (sessionContainer && typeof sessionContainer === "object")
      ? (sessionContainer.session_id ?? sessionContainer.sessionId)
      : (sessionContainer != null ? sessionContainer : null);
    const selectedSessionKey = (selectedSessionId != null)
      ? (() => {
        const s = sessions.find((x) => String(x.id) === String(selectedSessionId));
        return s ? normalizeKey(s) : null;
      })()
      : null;
    const selectedDeviceId = currentTarget?.Device?.device_id || currentTarget?.device?.device_id;

    const isUnset = currentTarget == null || currentTarget === "" || currentTarget === "Unset";
    const selectedKind = isUnset
      ? "placeholder"
      : (integration ? "integration-target"
        : (currentTarget?.Session || currentTarget?.session || currentTarget?.Application || currentTarget?.application) ? "session"
          : (currentTarget?.Device || currentTarget?.device) ? "device"
            : (currentTarget === "Master" || currentTarget?.Master != null) ? "master"
              : (currentTarget === "Focus" || currentTarget?.Focus != null) ? "focus"
                : currentTarget === "MediaControl" ? "media-control"
                  : currentTarget === "CaptureControl" ? "capture-control"
                  : currentTarget === "Hotkey" ? "hotkey-target"
                    : currentTarget === "OpenApplication" ? "open-application-target"
                : "placeholder"
      );

    let selectedValue = "";
    if (selectedKind === "integration-target") selectedValue = targetKey(integration);
    else if (selectedKind === "session") selectedValue = selectedAppKey || selectedSessionKey || "";
    else if (selectedKind === "device") selectedValue = selectedDeviceId || "";
    else if (selectedKind === "master" || selectedKind === "focus" || selectedKind === "media-control" || selectedKind === "capture-control" || selectedKind === "hotkey-target" || selectedKind === "open-application-target") selectedValue = selectedKind;
    else if (selectedKind === "placeholder") selectedValue = "placeholder";

    const options = [
      {
        value: "master",
        label: t("targets.master"),
        icon_data: masterIconData,
        kind: "master",
      },
      {
        value: "focus",
        label: t("targets.focus"),
        icon_data: focusIconData,
        kind: "focus",
      },
    ];

    if (isButton) {
      options.push({
        value: "media-control",
        label: t("targets.mediaControls"),
        icon_data: mediaPlayPauseIconData,
        kind: "media-control",
      });
      options.push({
        value: "window-focus",
        label: t("targets.windowFocus"),
        icon_data: WINDOW_FOCUS_ICON_DATA,
        kind: "action-root",
      });
      options.push({
        value: "capture",
        label: t("targets.captureControls"),
        icon_data: CAPTURE_ICON_DATA,
        kind: "action-root",
      });
      options.push({
        value: "hotkey-target",
        label: t("targets.hotkey"),
        icon_data: HOTKEY_ICON_DATA,
        kind: "hotkey-target",
      });
      options.push({
        value: "open-application-target",
        label: t("targets.openApplication"),
        icon_data: OPEN_APPLICATION_TARGET_ICON_DATA,
        kind: "open-application-target",
      });
    }

    if (pluginHost) {
      const integrations = pluginHost.getIntegrations();
      if (Array.isArray(integrations) && integrations.length > 0) {
        options.push({ kind: "divider", label: t("targets.category.integrations") });
        for (const integ of integrations) {
          if (!integ || !integ.id) continue;
          options.push({
            kind: "integration-root",
            value: String(integ.id),
            label: integ.name || String(integ.id),
            icon_data: integ.icon_data || null,
          });
        }
      }
    }

    const seen = new Set();
    const sessionsAdded = sessions.filter((session) => !session.is_master && session.id !== "master");
    if (sessionsAdded.length > 0) {
      options.push({ kind: "divider", label: t("targets.category.applications") });
      sessionsAdded.forEach((session) => {
        const key = normalizeKey(session);
        if (!key) return;

        if (seen.has(key)) {
          return;
        }

        seen.add(key);
        options.push({
          value: key,
          label: session.display_name,
          display_name: session.display_name,
          icon_data: session.icon_data,
          kind: "session",
        });
      });
    }

    if (selectedAppName && !seen.has(selectedAppKey)) {
      if (sessionsAdded.length === 0) {
        options.push({ kind: "divider", label: t("targets.category.applications") });
      }
      const label = selectedAppDisplayName
        || (selectedAppName.charAt(0).toUpperCase() + selectedAppName.slice(1));
      options.push({
        value: selectedAppKey,
        label: t("targets.unavailableName", { name: label }),
        display_name: label,
        icon_data: selectedAppIconData,
        kind: "session",
        ghost: true,
      });
    }

    if (playbackDevices.length > 0) {
      options.push({ kind: "divider", label: t("targets.category.playback") });
      playbackDevices.forEach((device) => {
        options.push({
          value: `playback:${device.id}`,
          label: device.display_name,
          icon_data: device.icon_data,
          kind: "device",
        });
      });
    }

    if (recordingDevices.length > 0) {
      options.push({ kind: "divider", label: t("targets.category.recording") });
      recordingDevices.forEach((device) => {
        options.push({
          value: `recording:${device.id}`,
          label: device.display_name,
          icon_data: device.icon_data,
          kind: "device",
        });
      });
    }

    if (selectedDeviceId) {
      const found = options.some((opt) => opt.value === selectedDeviceId);
      if (!found) {
        if (playbackDevices.length === 0 && recordingDevices.length === 0) {
          options.push({ kind: "divider", label: t("targets.category.devices") });
        }
        options.push({
          value: selectedDeviceId,
          label: t("targets.unavailableName", { name: t("targets.category.devices") }),
          kind: "device",
          ghost: true,
        });
      }
    }

    let activeIntegrationOption = null;
    if (selectedKind === "integration-target" && selectedValue) {
      let label = t("targets.integrationTarget");
      let ghost = false;
      let icon_data = null;
      if (integration) {
        const handler = pluginHost?.getIntegration?.(integration.integration_id);
        if (handler && typeof handler.describeTarget === "function") {
          try {
            const desc = handler.describeTarget({ Integration: integration });
            if (desc?.label) label = desc.label;
            if (desc?.icon_data) icon_data = desc.icon_data;
            if (typeof desc?.ghost === "boolean") ghost = desc.ghost;
          } catch { }
        }

        if (!icon_data || label === t("targets.integrationTarget")) {
          try {
            const fallback = resolveDisplay({ Integration: integration });
            if (fallback?.label) label = fallback.label;
            if (fallback?.icon_data) icon_data = fallback.icon_data;
          } catch { }
        }

        if (!handler) {
          ghost = true;
        }

        if (ghost && label && typeof label === "string" && !label.includes(t("targets.unavailable"))) {
          label = t("targets.unavailableName", { name: label });
        }
      }
      activeIntegrationOption = {
        kind: "integration-target",
        value: selectedValue,
        label,
        ghost,
        icon_data,
        target: integration ? { Integration: integration } : null,
      };
    }

    return { options, selectedValue, selectedKind, activeIntegrationOption };
  }

  function buildTargetSelect(
    currentTarget,
    isBindingButton = false,
    currentAction = "Volume",
    currentHotkeyDisplay = "",
    currentOpenApplication = null,
  ) {
    const container = document.createElement("div");
    container.className = "target-dropdown binding-target-dropdown";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "target-button";

    const display = document.createElement("span");
    display.className = "target-display";

    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "\u25be";

    button.appendChild(display);
    button.appendChild(caret);

    const normalizeTargets = (value) => {
      if (Array.isArray(value)) {
        return value.filter((v) => v && v !== "Unset").slice(0, 8);
      }
      if (value != null && value !== "Unset") {
        return [value];
      }
      return [];
    };

    const targetIdentity = (target) => {
      if (!target) return "";
      if (target === "Master" || target?.Master != null) return "master";
      if (target === "Focus" || target?.Focus != null) return "focus";
      if (target === "MediaControl") return "media-control";
      if (target === "CaptureControl") return "capture-control";
      if (target === "Hotkey") return "hotkey-target";
      if (target === "OpenApplication") return "open-application-target";
      const integration = target?.Integration || target?.integration;
      if (integration) {
        return `integration:${targetKey(integration)}`;
      }
      const app = target?.Application || target?.application;
      if (app?.name) return `app:${String(app.name).toLowerCase()}`;
      const session = target?.Session || target?.session;
      if (session?.session_id || session?.sessionId) {
        return `session:${session.session_id ?? session.sessionId}`;
      }
      const device = target?.Device || target?.device;
      if (device?.device_id || device?.deviceId) {
        return `device:${device.device_id ?? device.deviceId}`;
      }
      return JSON.stringify(target);
    };

    let selectedTargets = normalizeTargets(currentTarget);
    let hotkeyDisplay = String(currentHotkeyDisplay || "");
    const targetDisplayCache = new Map();
    let selectedAction = isBindingButton ? (currentAction || "ToggleMute") : "Volume";
    let selectedActionKind = "";
    let selectedOpenApplication = isBindingButton
      ? normalizeOpenApplication(currentOpenApplication)
      : null;

    const { options, selectedValue, selectedKind, activeIntegrationOption } = buildTargetOptions(selectedTargets[0] || currentTarget, isBindingButton);
    const placeholderOption = {
      value: "",
      label: t("targets.selectApplicationOrDevice"),
      icon_data: null,
      kind: "placeholder",
    };

    const integrationFromTarget = (target) => {
      return target?.Integration || target?.integration || null;
    };

    selectedActionKind = String(integrationFromTarget(selectedTargets[0])?.data?.action_kind || "").trim();

      const actionLabel = (action, target = null) => {
        const integ = integrationFromTarget(target);
        const persistedActionLabel = String(integ?.data?.action_label || "").trim();
      if (persistedActionLabel) {
        const display = cachedDisplayForTarget(target);
        const targetLabel = String(display?.label || "").replace(/\s*\([^()]+\)\s*$/g, "").trim();
        if (targetLabel && targetLabel.toLowerCase() === persistedActionLabel.toLowerCase()) {
          return "";
        }
        return persistedActionLabel;
      }

      // Check if the integration declares a custom label for this action
      if (integ?.integration_id) {
        const pluginHost = getHost();
        const handler = pluginHost?.getIntegration(integ.integration_id);
        if (Array.isArray(handler?.buttonActions)) {
          const match = handler.buttonActions.find((a) => a.value === action);
          if (match?.label) return match.label;
        }
      }
      if (action === "MediaPlayPause") return t("targets.action.mediaPlayPause");
      if (action === "MediaNextTrack") return t("targets.action.mediaNextTrack");
      if (action === "MediaPrevTrack") return t("targets.action.mediaPrevTrack");
      if (action === "MediaStop") return t("targets.action.mediaStop");
      if (action === "FocusWindow") return t("targets.action.focusWindow");
      if (action === "FullScreenshot") return t("targets.action.fullScreenshot");
      if (action === "SnipScreenshot") return t("targets.action.snipScreenshot");
      if (action === "ToggleScreenRecording") return t("targets.action.toggleScreenRecording");
      if (action === "Hotkey") return t("targets.hotkey");
      if (action === "ToggleMute") return t("targets.action.toggleMute");
      if (action === "SetDefaultDevice") return t("targets.action.setDefault");
      if (action === "OpenApplication") return t("targets.openApplication");
      if (action === "Volume" && isBindingButton) {
        const targetKind = String(integ?.kind || "").toLowerCase();
        if (targetKind === "action" || targetKind === "scene") return "";
        return t("targets.action.trigger");
      }
      return action;
    };

    const cachedDisplayForTarget = (target) => {
      const key = targetIdentity(target);
      const cached = targetDisplayCache.get(key);
      if (target === "Hotkey") {
        return {
          label: hotkeyDisplay ? t("targets.hotkeyWithValue", { value: hotkeyDisplay }) : t("targets.hotkeyNotSet"),
          icon_data: cached?.icon_data ?? HOTKEY_ICON_DATA,
        };
      }
      if (target === "OpenApplication") {
        const openAppLabel = friendlyAppName(selectedOpenApplication?.display || selectedOpenApplication?.path || "") || t("targets.openApplication");
        return {
          label: openAppLabel,
          icon_data: selectedOpenApplication?.icon_data
            || resolveOpenApplicationIcon(selectedOpenApplication)
            || cached?.icon_data
            || OPEN_APPLICATION_TARGET_ICON_DATA,
        };
      }
      if (target === "CaptureControl") {
        return {
          label: t("targets.captureControls"),
          icon_data: CAPTURE_ICON_DATA,
        };
      }
      const resolved = resolveDisplay(target);
      const merged = {
        label: (resolved?.label || cached?.label || "Target"),
        icon_data: (resolved?.icon_data ?? cached?.icon_data ?? null),
      };
      targetDisplayCache.set(key, merged);
      return merged;
    };

    const renderChip = (target, index) => {
      const displayOption = cachedDisplayForTarget(target);
      const chip = document.createElement("span");
      chip.className = "target-chip";
      if (/\(\s*Unavailable\s*\)\s*$/i.test(String(displayOption?.label || "")) || String(displayOption?.label || "").includes(t("targets.unavailable"))) {
        chip.classList.add("unavailable");
      }
      chip.dataset.index = String(index);

      const icon = createTargetIcon(displayOption);
      icon.classList.add("target-chip-icon");
      chip.appendChild(icon);

      const label = document.createElement("span");
      label.className = "target-chip-label";
      const actionTags = (isBindingButton && selectedAction)
        ? [actionLabel(selectedAction, target)]
        : [];
      renderLabelFromRawWithTags(label, {
        rawLabel: displayOption.label,
        extraTags: actionTags.filter(Boolean),
        truncateMain: true,
        collapseTags: false,
      });
      chip.appendChild(label);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "target-chip-remove";
      remove.title = t("targets.removeTarget");
      remove.setAttribute("aria-label", t("targets.removeTarget"));
      remove.textContent = "×";
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const idx = Number(chip.dataset.index);
        if (Number.isNaN(idx)) return;
        selectedTargets = selectedTargets.filter((_, i) => i !== idx);
        syncContainerValue(false);
        container.dispatchEvent(new Event("change"));
      });
      chip.appendChild(remove);
      return chip;
    };

    const setDisplay = () => {
      display.innerHTML = "";
      if (selectedTargets.length === 0) {
        const label = document.createElement("span");
        label.className = "target-placeholder";
        label.textContent = placeholderOption.label;
        display.appendChild(label);
        return;
      }
      const chipsWrap = document.createElement("span");
      chipsWrap.className = "target-chips-wrap";
      if (selectedTargets.length > 1) {
        chipsWrap.classList.add("is-scrollable");
      }
      selectedTargets.forEach((target, index) => {
        chipsWrap.appendChild(renderChip(target, index));
      });
      display.appendChild(chipsWrap);
    };

    const mapOptionToTarget = (option) => {
      if (option && option.target) {
        const t = option.target;
        const integ = t?.Integration || t?.integration;
        if (integ && typeof integ === "object" && integ.integration_id) {
          const next = {
            Integration: {
              integration_id: String(integ.integration_id),
              kind: String(integ.kind || ""),
              data: { ...(integ.data || {}) },
            },
          };
          if (option.label) next.Integration.data.label = String(option.label);
          if (option.icon_data) next.Integration.data.icon_data = option.icon_data;
          if (option.__selectedActionLabel) {
            next.Integration.data.action_label = String(option.__selectedActionLabel);
          }
          if (option.__selectedActionValue) {
            next.Integration.data.action_value = String(option.__selectedActionValue);
          }
          if (option.__selectedActionKind) {
            next.Integration.data.action_kind = String(option.__selectedActionKind);
          }
          return next;
        }
        return t;
      }
      if (option.kind === "master") {
        return "Master";
      }
      if (option.kind === "focus") {
        return "Focus";
      }
      if (option.kind === "media-control") {
        return "MediaControl";
      }
      if (option.kind === "capture-action") {
        return "CaptureControl";
      }
      if (option.kind === "hotkey-target") {
        return "Hotkey";
      }
      if (option.kind === "open-application-target") {
        return "OpenApplication";
      }
      if (option.kind === "device") {
        return { Device: { device_id: option.value } };
      }
      if (option.kind === "session") {
        const displayName = String(option.display_name || option.label || "")
          .replace(/\s*\(Unavailable\)\s*$/i, "")
          .trim();
        const app = { name: option.value };
        if (displayName) app.display_name = displayName;
        if (option.icon_data) app.icon_data = option.icon_data;
        return { Application: app };
      }
      if (option.kind === "placeholder") {
        return "Unset";
      }
      return selectedTargets[0] || "Unset";
    };

    const syncContainerValue = (markUnavailable = false) => {
      container.__selectedTargets = [...selectedTargets];
      container.__selectedTarget = selectedTargets[0] || "Unset";
      container.__openApplication = selectedOpenApplication;
      container.value = selectedTargets.length ? targetIdentity(selectedTargets[0]) : "";
      container.dataset.kind = selectedTargets.length ? "multi" : "placeholder";
      container.classList.toggle("target-unavailable", Boolean(markUnavailable && selectedTargets.length <= 1));
      container.dataset.action = selectedAction;
      container.dataset.actionKind = selectedActionKind;
      setDisplay();
    };

    const selectOption = (option, actionChoice = null, emit = true) => {
      let nextActionValue = null;
      let nextActionLabel = null;
      if (typeof actionChoice === "string") {
        nextActionValue = actionChoice;
      } else if (actionChoice && typeof actionChoice === "object") {
        nextActionValue = String(actionChoice.value || "");
        nextActionLabel = String(actionChoice.label || "").trim() || null;
      }
      if (nextActionValue) {
        selectedAction = nextActionValue;
      }
      selectedActionKind = String(actionChoice?.behavior || actionChoice?.action_kind || "").trim();
      if (nextActionValue !== "OpenApplication") {
        selectedOpenApplication = null;
      }
      const chosenOpenApplication = normalizeOpenApplication(
        actionChoice?.openApplication || actionChoice?.open_application,
      );
      if (chosenOpenApplication) {
        selectedOpenApplication = chosenOpenApplication;
      }
      if (nextActionLabel && option && typeof option === "object") {
        option.__selectedActionLabel = nextActionLabel;
      }
      if (nextActionValue && option && typeof option === "object") {
        option.__selectedActionValue = nextActionValue;
      }
      if (selectedActionKind && option && typeof option === "object") {
        option.__selectedActionKind = selectedActionKind;
      }

      const mapped = mapOptionToTarget(option);
      if (mapped === "Hotkey") {
        selectedAction = "Hotkey";
      }
      if (mapped === "OpenApplication") {
        selectedAction = "OpenApplication";
      }
      const key = targetIdentity(mapped);
      const cachedLabel = String(option?.label || "").trim();
      if (cachedLabel || option?.icon_data) {
        targetDisplayCache.set(key, {
          label: cachedLabel || t("common.target"),
          icon_data: option?.icon_data ?? null,
        });
      }
      const exists = selectedTargets.findIndex((t) => targetIdentity(t) === key);
      const updatesExistingAction = exists >= 0 && nextActionValue && option?.kind === "capture-action";
      if (updatesExistingAction) {
        selectedTargets[exists] = mapped;
      } else if (exists >= 0) {
        selectedTargets.splice(exists, 1);
      } else if (selectedTargets.length < 8) {
        selectedTargets.push(mapped);
      }
      syncContainerValue(Boolean(option.ghost));
      if (emit) container.dispatchEvent(new Event("change"));
    };

    let initial = selectedKind === "placeholder"
      ? placeholderOption
      : options.find((option) => option.value === selectedValue && option.kind === selectedKind);

    if (!initial && activeIntegrationOption) {
      initial = activeIntegrationOption;
    }

    if (!initial) {
      initial = options.find((option) => option.kind !== "divider") || options[0];
    }

    container.dataset.action = selectedAction;
    if (selectedTargets.length === 0 && initial && initial.kind !== "placeholder") {
      selectedTargets = [mapOptionToTarget(initial)];
    }
    syncContainerValue(false);

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const { options } = buildTargetOptions(selectedTargets[0] || currentTarget, isBindingButton);

      const buildButtonActionOptions = (targetOption) => {
        if (targetOption?.kind === "media-control") {
          return [
            { label: t("targets.action.mediaPlayPause"), value: "MediaPlayPause", kind: "action", icon_data: mediaPlayPauseIconData },
            { label: t("targets.action.mediaNextTrack"), value: "MediaNextTrack", kind: "action", icon_data: mediaNextTrackIconData },
            { label: t("targets.action.mediaPrevTrack"), value: "MediaPrevTrack", kind: "action", icon_data: mediaPrevTrackIconData },
            { label: t("targets.action.mediaStop"), value: "MediaStop", kind: "action", icon_data: mediaStopIconData },
          ];
        }
        if (
          targetOption?.kind === "master"
          || targetOption?.kind === "focus"
          || targetOption?.kind === "session"
          || targetOption?.kind === "application"
        ) {
          return [{
            label: t("targets.action.toggleMute"),
            value: "ToggleMute",
            kind: "action",
            icon_data: TOGGLE_MUTE_ICON_DATA,
          }];
        }
        if (targetOption?.kind === "device") {
          return [
            {
              label: t("targets.action.toggleMute"),
              value: "ToggleMute",
              kind: "action",
              icon_data: TOGGLE_MUTE_ICON_DATA,
            },
            {
              label: t("targets.action.setDefaultDevice"),
              value: "SetDefaultDevice",
              kind: "action",
              icon_data: SET_DEFAULT_DEVICE_ICON_DATA,
            },
          ];
        }

        // Check per-target buttonActions first (set by plugins in getTargetOptions)
        if (Array.isArray(targetOption?.buttonActions) && targetOption.buttonActions.length > 0) {
          return targetOption.buttonActions.map((a) => ({
            label: a.label || a.value || t("targets.category.actions"),
            value: a.value || "Volume",
            kind: "action",
            icon_data: a.icon_data || targetOption.icon_data || null,
            behavior: a.behavior || a.action_kind || "",
          }));
        }

        // Then check integration-level buttonActions (set by plugins in registerIntegration)
        const integ = targetOption?.target?.Integration || targetOption?.target?.integration;
        if (integ?.integration_id) {
          const pluginHost = getHost();
          const handler = pluginHost?.getIntegration(integ.integration_id);
          if (Array.isArray(handler?.buttonActions) && handler.buttonActions.length > 0) {
            return handler.buttonActions.map((a) => ({
              label: a.label || a.value || t("targets.category.actions"),
              value: a.value || "Volume",
              kind: "action",
              icon_data: a.icon_data || targetOption.icon_data || null,
              behavior: a.behavior || a.action_kind || "",
            }));
          }
        }

        // Default fallback for integrations without declared actions
        return [
          { label: t("targets.action.trigger"), value: "Volume", kind: "action" },
          { label: t("targets.action.toggleMute"), value: "ToggleMute", kind: "action" },
        ];
      };

      const buildWindowFocusOptions = () => {
        const seen = new Set();
        return getSess()
          .filter((session) => session && !session.is_master && session.id !== "master")
          .map((session) => {
            const key = normalizeKey(session);
            if (!key || seen.has(key)) return null;
            seen.add(key);
            return {
              value: key,
              label: session.display_name || key,
              display_name: session.display_name || key,
              icon_data: session.icon_data || WINDOW_FOCUS_ICON_DATA,
              kind: "session",
              category: "applications",
              description: t("targets.description.windowFocusApp"),
            };
          })
          .filter(Boolean);
      };

      const captureOptions = () => [
        {
          value: "FullScreenshot",
          label: t("targets.action.fullScreenshot"),
          kind: "capture-action",
          icon_data: CAPTURE_ICON_DATA,
        },
        {
          value: "SnipScreenshot",
          label: t("targets.action.snipScreenshot"),
          kind: "capture-action",
          icon_data: SNIP_ICON_DATA,
        },
        {
          value: "ToggleScreenRecording",
          label: t("targets.action.toggleScreenRecording"),
          kind: "capture-action",
          icon_data: RECORD_ICON_DATA,
        },
      ];

      const showWindowFocusSubmenu = () => {
        const focusOptions = buildWindowFocusOptions();
        openTargetPanel(
          focusOptions.length > 0 ? focusOptions : [{
            value: "",
            label: t("targets.noRunningApplications"),
            kind: "placeholder",
            icon_data: WINDOW_FOCUS_ICON_DATA,
          }],
          null,
          null,
          (option) => {
            selectOption(option, {
              value: "FocusWindow",
              label: t("targets.action.focusWindow"),
            });
          },
          t("targets.windowFocus"),
          { onBack: openRootTargetPanel },
        );
      };

      const showCaptureSubmenu = () => {
        openTargetPanel(
          captureOptions(),
          selectedAction,
          "capture-action",
          (option) => {
            selectOption(option, {
              value: option.value,
              label: option.label,
            });
          },
          t("targets.captureControls"),
          { onBack: openRootTargetPanel },
        );
      };

      const openRootTargetPanel = () => {
        openTargetPanel(
          options,
          null,
          null,
          (targetOption) => {
            if (targetOption.kind === "integration-root") {
              showIntegrationSubmenu(targetOption.value, [], null).catch(() => { });
              return false;
            }

            if (targetOption.kind === "action-root" && targetOption.value === "window-focus") {
              showWindowFocusSubmenu();
              return false;
            }

            if (targetOption.kind === "action-root" && targetOption.value === "capture") {
              showCaptureSubmenu();
              return false;
            }

            if (isBindingButton && targetOption.kind === "open-application-target") {
              (async () => {
                try {
                  const openApplication = await pickOpenApplication();
                  if (!openApplication) return;
                  selectOption(targetOption, {
                    value: "OpenApplication",
                    label: t("targets.openApplication"),
                    openApplication,
                  });
                  closeTargetPanel();
                } catch { }
              })();
              return false;
            }

            if (isBindingButton && targetOption.kind !== "hotkey-target") {
              return chooseButtonTarget(targetOption);
            }

            selectOption(targetOption);
            return true;
          },
          t("targets.selectTargets"),
        );
      };

      const chooseButtonTarget = (targetOption) => {
        const actionOptions = buildButtonActionOptions(targetOption);
        if (actionOptions.length === 1) {
          selectOption(targetOption, actionOptions[0]);
          return true;
        }
        setTimeout(() => {
          openTargetPanel(actionOptions, selectedAction, "action", (actionOption) => {
            selectOption(targetOption, actionOption);
          }, t("targets.selectAction"));
        }, 10);
        return false;
      };

      const showIntegrationSubmenu = async (integrationId, navStack = [], navState = null) => {
        const pluginHost = getHost();
        const handler = pluginHost?.getIntegration(integrationId);
        let sub = [];
        try {
          const sessions = getSess();
          const playbackDevices = getPlayback();
          const recordingDevices = getRecording();
          const res = handler?.getTargetOptions?.({
            sessions,
            playbackDevices,
            recordingDevices,
            controlType: isBindingButton ? "button" : "fader",
            nav: navState,
          });
          sub = (res && typeof res.then === "function") ? (await res) : (res || []);
        } catch {
          sub = [];
        }
        if (!Array.isArray(sub) || sub.length === 0) {
          let isDisconnected = true;
          try {
            const desc = handler?.describeTarget?.({});
            if (desc && typeof desc.ghost === "boolean") {
              isDisconnected = desc.ghost;
            }
          } catch { }
          sub = [{
            label: isDisconnected
              ? t("targets.integrationNotConnected")
              : t("targets.noCompatibleTargets"),
            value: "",
            kind: "placeholder",
            ghost: true,
            icon_data: handler?.icon_data || null,
            category: "integrations",
            integrationId,
            suppressUnavailableTag: true,
          }];
        }

        const subOptions = sub
          .filter((o) => o && typeof o === "object")
          .map((o) => {
            if (o.nav) {
              return {
                label: o.label || t("common.open"),
                icon_data: o.icon_data || handler?.icon_data || null,
                kind: "integration-nav",
                value: JSON.stringify(o.nav),
                nav: o.nav,
                category: "integrations",
                integrationId,
                description: o.description || null,
                tags: Array.isArray(o.tags) ? o.tags : [],
              };
            }
            const mapped = {
              label: o.label || t("targets.integrationTarget"),
              icon_data: o.icon_data || handler?.icon_data || null,
              kind: o.kind || "integration-target",
              value: targetKey((o.target?.Integration || o.target?.integration) || {}),
              target: o.target,
              category: o.category || "integrations",
              integrationId,
              description: o.description || null,
              tags: Array.isArray(o.tags) ? o.tags : [],
              suppressUnavailableTag: Boolean(o.suppressUnavailableTag),
            };
            // Carry per-target buttonActions from plugin's getTargetOptions
            if (Array.isArray(o.buttonActions) && o.buttonActions.length > 0) {
              mapped.buttonActions = o.buttonActions;
            }
            return mapped;
          });

        openTargetPanel(
          subOptions,
          null,
          null,
          (opt) => {
            if (opt.kind === "integration-nav") {
              const nextStack = navStack.concat([opt.nav]);
              showIntegrationSubmenu(integrationId, nextStack, opt.nav).catch(() => { });
              return false;
            }

            if (isBindingButton) {
              return chooseButtonTarget(opt);
            }

            selectOption(opt);
            return true;
          },
          handler?.name ? t("targets.selectNamedTarget", { name: handler.name }) : t("targets.selectIntegrationTarget"),
          {
            integrationId,
            refresh: () => showIntegrationSubmenu(integrationId, navStack, navState).catch(() => { }),
            onBack: () => {
              if (navStack.length === 0) {
                openRootTargetPanel();
                return;
              }
              const nextStack = navStack.slice(0, -1);
              const nextNav = nextStack.length > 0 ? nextStack[nextStack.length - 1] : null;
              showIntegrationSubmenu(integrationId, nextStack, nextNav).catch(() => { });
            },
          },
        );
      };

      openRootTargetPanel();
    });

    container.appendChild(button);
    container.setHotkeyDisplay = (nextDisplay = "") => {
      hotkeyDisplay = String(nextDisplay || "");
      setDisplay();
    };
    container.getOpenApplication = () => selectedOpenApplication;
    return container;
  }

  function bindUi() {
    if (d.targetPanel) {
      d.targetPanel.addEventListener("click", (event) => {
        if (event.target === d.targetPanel) {
          closeTargetPanel();
        }
      });
    }
    if (d.targetPanelClose) {
      d.targetPanelClose.addEventListener("click", closeTargetPanel);
    }
    window.addEventListener("midimaster:integration-targets-changed", (event) => {
      const integrationId = String(event?.detail?.integrationId || event?.detail?.integration_id || "");
      if (!integrationId || integrationId !== activeTargetPanelIntegrationId) return;
      if (typeof activeTargetPanelRefresh === "function") {
        activeTargetPanelRefresh();
      }
    });
  }

  return {
    bindUi,
    closeTargetMenus,
    createTargetIcon,
    openTargetPanel,
    closeTargetPanel,
    buildTargetOptions,
    buildTargetSelect,
  };
}

import { CATEGORY_META, INTEGRATION_META } from "../catalog_presentation.js";
/** panel metadata workflow. */
export function createPanelMetadata({ elements, t }) {
  function categoryLabel(id) {
    const meta = CATEGORY_META[id] || CATEGORY_META.other;
    return t(meta.key);
  }

  function targetPanelParts() {
    const panel = elements.targetPanel || null;
    return {
      searchInput: panel?.querySelector?.("#target-panel-search") || null,
      categories: panel?.querySelector?.("#target-panel-categories") || null,
    };
  }

  function categoryForOption(option, fallback = "other") {
    if (!option || option.kind === "divider") return null;
    if (option.category) return option.category;
    if (option.integrationId || option.integration_id) return "integrations";
    if (
      option.kind === "master" ||
      option.kind === "focus" ||
      option.kind === "monitor-brightness" ||
      option.kind === "monitor-brightness-root"
    )
      return "builtIn";
    if (
      option.kind === "media-control" ||
      option.kind === "capture-control" ||
      option.kind === "macro-target" ||
      option.kind === "soundboard-target" ||
      option.kind === "hotkey-target" ||
      option.kind === "open-application-target" ||
      option.kind === "autohotkey-script-target" ||
      option.kind === "profile-switch-root" ||
      option.kind === "profile-target" ||
      option.kind === "action-root" ||
      option.kind === "capture-action"
    )
      return "utilities";
    if (
      option.kind === "integration-root" ||
      option.kind === "integration-target" ||
      option.kind === "integration-nav"
    )
      return "integrations";
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
    if (option?.kind === "monitor-brightness" || option?.kind === "monitor-brightness-root")
      return t("targets.description.monitorBrightness");
    if (option?.kind === "media-control") return t("targets.description.mediaControl");
    if (option?.kind === "capture-control") return t("targets.description.captureControls");
    if (option?.kind === "macro-target") return t("targets.description.macro");
    if (option?.kind === "soundboard-target") return t("targets.description.soundboard");
    if (option?.kind === "hotkey-target") return t("targets.description.hotkey");
    if (option?.kind === "open-application-target") return t("targets.description.openApplication");
    if (option?.kind === "autohotkey-script-target") return t("targets.description.autoHotkeyScript");
    if (option?.kind === "profile-switch-root") return t("targets.description.switchProfile");
    if (option?.kind === "profile-target") return t("targets.description.profileTarget");
    if (option?.kind === "action-root" && option?.value === "window-focus")
      return t("targets.description.windowFocus");
    if (option?.kind === "action-root" && option?.value === "capture")
      return t("targets.description.captureControls");
    if (option?.kind === "capture-action") return t("targets.description.captureAction");
    if (option?.kind === "session")
      return option.ghost
        ? t("targets.description.savedApplicationUnavailable")
        : t("targets.description.applicationSession");
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
      const integrationId = String(
        integration?.integration_id || option?.integrationId || option?.integration_id || "",
      ).toLowerCase();
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
      ...(Array.isArray(option?.title_tags) ? option.title_tags : []),
      ...(Array.isArray(option?.tags) ? option.tags : []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
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
    if (kind === "recording")
      return "<path d='M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z' /><path d='M6 11a6 6 0 0 0 12 0M12 17v3' />";
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

  return {
    categoryLabel,
    targetPanelParts,
    categoryForOption,
    descriptionForOption,
    tagsForOption,
    optionSearchText,
    normalizePanelOptions,
    categorySvg,
    createCategoryIcon,
  };
}

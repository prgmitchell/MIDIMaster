import { parseLabelParts, tagVariant } from "../ui/label_tags.js";

export function createOsdFeature({
  osdElement,
  isOsdWindow,
  osdDebugAlways,
  getOsdSettings,
  resolveOsdTarget,
  createTargetIcon,
  resolveTargetKey,
}) {
  const osd = osdElement || null;
  const getSettings = (typeof getOsdSettings === "function") ? getOsdSettings : (() => ({ enabled: true }));
  const resolveDisplay = (typeof resolveOsdTarget === "function") ? resolveOsdTarget : (() => null);
  const iconFor = (typeof createTargetIcon === "function") ? createTargetIcon : (() => document.createElement("span"));
  const keyForTarget = (typeof resolveTargetKey === "function") ? resolveTargetKey : (() => null);

  const activeOsdCards = new Map();

  function renderLabelWithTags(host, rawLabel) {
    host.innerHTML = "";
    const { base, tags } = parseLabelParts(rawLabel);

    const content = document.createElement("span");
    content.className = "osd-label-content";

    const main = document.createElement("span");
    main.className = "osd-label-main";
    main.textContent = base || rawLabel || "Target";
    content.appendChild(main);

    if (tags.length > 0) {
      const tagsWrap = document.createElement("span");
      tagsWrap.className = "osd-label-tags";
      tags.forEach((tag) => {
        const badge = document.createElement("span");
        badge.className = `osd-tag osd-tag--${tagVariant(tag, { includeState: false })}`;
        badge.textContent = tag;
        tagsWrap.appendChild(badge);
      });
      content.appendChild(tagsWrap);
    }

    host.appendChild(content);
  }

  function getOsdKey(target) {
    const key = keyForTarget(target);
    if (key) return key;
    if (target === "Master" || target?.Master !== undefined) return "::master::";
    if (target === "Focus" || target?.Focus !== undefined) return "::focus::";
    return "::unknown::";
  }

  function integrationDataForTarget(target) {
    const integration = target?.Integration || target?.integration;
    return integration && typeof integration === "object" && integration.data && typeof integration.data === "object"
      ? integration.data
      : {};
  }

  function displayLabelForTarget(display, target) {
    const baseLabel = String(display?.label || "Target");
    const actionLabel = String(integrationDataForTarget(target).action_label || "").trim();
    if (!actionLabel || baseLabel.toLowerCase().includes(`(${actionLabel.toLowerCase()})`)) {
      return baseLabel;
    }
    return `${baseLabel} (${actionLabel})`;
  }

  function osdValueTextForTarget(target, options = null) {
    const fromOptions = String(options?.valueText || "").trim();
    if (fromOptions) return fromOptions;
    return String(integrationDataForTarget(target).osd_value_text || "").trim();
  }

  function createOsdCard(_display) {
    const card = document.createElement("div");
    card.className = "osd-card";

    const header = document.createElement("div");
    header.className = "osd-header";

    const iconDiv = document.createElement("div");
    iconDiv.className = "osd-icon";
    iconDiv.setAttribute("aria-hidden", "true");

    const labelSpan = document.createElement("span");
    labelSpan.className = "osd-label";

    const valueSpan = document.createElement("span");
    valueSpan.className = "osd-value";

    header.appendChild(iconDiv);
    header.appendChild(labelSpan);
    header.appendChild(valueSpan);

    const barDiv = document.createElement("div");
    barDiv.className = "osd-bar";

    const fillDiv = document.createElement("div");
    fillDiv.className = "osd-bar-fill";

    barDiv.appendChild(fillDiv);

    card.appendChild(header);
    card.appendChild(barDiv);

    return { card, iconDiv, labelSpan, valueSpan, fillDiv };
  }

  function removeOsdCard(key) {
    const item = activeOsdCards.get(key);
    if (!item) return;

    if (item.timer) clearTimeout(item.timer);

    item.element.classList.remove("visible");
    activeOsdCards.delete(key);

    setTimeout(() => {
      item.element.remove();
    }, 250);
  }

  function showVolumeOsd(target, volume, focusSession, options = null) {
    if (!osd) return;

    const display = resolveDisplay(target, focusSession);
    if (!display) return;

    const key = getOsdKey(target);
    let item = activeOsdCards.get(key);
    let refs;

    if (item) {
      if (item.timer) clearTimeout(item.timer);
      refs = item.refs;
    } else {
      refs = createOsdCard(display);
      item = {
        element: refs.card,
        refs,
        timer: null,
      };
      osd.appendChild(refs.card);
      activeOsdCards.set(key, item);
      refs.card.offsetHeight;
      refs.card.classList.add("visible");
    }

    renderLabelWithTags(refs.labelSpan, displayLabelForTarget(display, target));
    refs.iconDiv.innerHTML = "";
    const icon = iconFor({ label: display.label, icon_data: display.icon_data });
    refs.iconDiv.appendChild(icon);

    refs.fillDiv.style.backgroundColor = "";
    refs.iconDiv.style.fontSize = "";
    refs.iconDiv.style.marginRight = "";
    refs.valueSpan.style.fontSize = "";

    const valueText = osdValueTextForTarget(target, options);
    const fillSource = typeof options?.inputValue === "number"
      ? options.inputValue
      : (valueText ? 1.0 : volume);
    const clampedVolume = Math.min(1, Math.max(0, Number(fillSource) || 0));
    const percent = Math.round(clampedVolume * 100);
    refs.fillDiv.style.width = `${percent}%`;
    refs.valueSpan.textContent = valueText || `${percent}%`;

    if (!osdDebugAlways) {
      item.timer = setTimeout(() => {
        removeOsdCard(key);
      }, 1500);
    }
  }

  function showMuteOsd(target, muted, focusSession) {
    if (!osd) return;

    const display = resolveDisplay(target, focusSession);
    if (!display) return;

    const key = getOsdKey(target);
    let item = activeOsdCards.get(key);
    let refs;

    if (item) {
      if (item.timer) clearTimeout(item.timer);
      refs = item.refs;
    } else {
      refs = createOsdCard(display);
      item = {
        element: refs.card,
        refs,
        timer: null,
      };
      osd.appendChild(refs.card);
      activeOsdCards.set(key, item);
      refs.card.offsetHeight;
      refs.card.classList.add("visible");
    }

    renderLabelWithTags(refs.labelSpan, display.label);
    refs.iconDiv.innerHTML = "";
    const icon = iconFor(display);
    refs.iconDiv.appendChild(icon);

    refs.fillDiv.style.width = muted ? "0%" : "100%";
    refs.fillDiv.style.backgroundColor = muted ? "#ff4444" : "";
    refs.valueSpan.textContent = muted ? "\ud83d\udd07" : "\ud83d\udd0a";
    refs.valueSpan.style.fontSize = "24px";

    if (!osdDebugAlways) {
      item.timer = setTimeout(() => {
        removeOsdCard(key);
      }, 1500);
    }
  }

  function hideVolumeOsd() {
    for (const key of activeOsdCards.keys()) {
      removeOsdCard(key);
    }
  }

  function handleOsdUpdate(payload) {
    if (!payload) return;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (typeof payload !== "object") return;

    const settings = getSettings() || {};
    if (!settings.enabled && isOsdWindow && payload.osd_enabled !== true) {
      return;
    }

    if (payload.action === "toggle_mute") {
      showMuteOsd(payload.target, payload.muted, payload.focus_session);
    } else {
      showVolumeOsd(payload.target, payload.volume, payload.focus_session, {
        inputValue: typeof payload.input_value === "number" ? payload.input_value : null,
      });
    }
  }

  return {
    showVolumeOsd,
    showMuteOsd,
    hideVolumeOsd,
    handleOsdUpdate,
  };
}

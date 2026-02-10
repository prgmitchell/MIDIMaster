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

  function getOsdKey(target) {
    const key = keyForTarget(target);
    if (key) return key;
    if (target === "Master" || target?.Master !== undefined) return "::master::";
    if (target === "Focus" || target?.Focus !== undefined) return "::focus::";
    return "::unknown::";
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

  function showVolumeOsd(target, volume, focusSession) {
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

    refs.labelSpan.textContent = display.label;
    refs.iconDiv.innerHTML = "";
    const icon = iconFor({ label: display.label, icon_data: display.icon_data });
    refs.iconDiv.appendChild(icon);

    refs.fillDiv.style.backgroundColor = "";
    refs.iconDiv.style.fontSize = "";
    refs.iconDiv.style.marginRight = "";
    refs.valueSpan.style.fontSize = "";

    const clampedVolume = Math.min(1, Math.max(0, Number(volume) || 0));
    const percent = Math.round(clampedVolume * 100);
    refs.fillDiv.style.width = `${percent}%`;
    refs.valueSpan.textContent = `${percent}%`;

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

    refs.labelSpan.textContent = display.label;
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
    if (!settings.enabled && isOsdWindow) {
      return;
    }

    if (payload.action === "toggle_mute") {
      showMuteOsd(payload.target, payload.muted, payload.focus_session);
    } else {
      showVolumeOsd(payload.target, payload.volume, payload.focus_session);
    }
  }

  return {
    showVolumeOsd,
    showMuteOsd,
    hideVolumeOsd,
    handleOsdUpdate,
  };
}

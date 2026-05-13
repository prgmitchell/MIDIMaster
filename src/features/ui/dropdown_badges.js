import { parseLabelParts, tagVariant } from "./label_tags.js";
import { t } from "../../app/i18n.js";

export function renderLabelWithBadges(
  container,
  { text = "", badges = [], truncate = true } = {},
) {
  if (!container) return;
  container.innerHTML = "";

  const label = document.createElement("span");
  label.className = "target-label";

  const content = document.createElement("span");
  content.className = "target-label-content";

  const main = document.createElement("span");
  main.className = `target-label-main${truncate ? " is-truncated" : ""}`;
  main.textContent = String(text || "");
  content.appendChild(main);

  const badgeList = Array.isArray(badges) ? badges : [];
  const normalized = badgeList
    .map((badge) => {
      if (typeof badge === "string") {
        return { text: badge, kind: "neutral" };
      }
      if (badge && typeof badge === "object") {
        return {
          text: String(badge.text || ""),
          kind: String(badge.kind || "neutral"),
        };
      }
      return null;
    })
    .filter((badge) => badge && badge.text);

  if (normalized.length > 0) {
    const tags = document.createElement("span");
    tags.className = "target-label-tags";
    normalized.forEach((badge) => {
      const el = document.createElement("span");
      el.className = `target-tag target-tag--${badge.kind}`;
      el.textContent = badge.text;
      el.title = badge.text;
      tags.appendChild(el);
    });
    content.appendChild(tags);
  }

  label.appendChild(content);
  container.appendChild(label);
}

export function renderLabelFromRawWithTags(
  container,
  {
    rawLabel = "",
    extraTags = [],
    truncateMain = true,
    collapseTags = true,
  } = {},
) {
  if (!container) return;

  const { base, tags } = parseLabelParts(rawLabel);
  const normalizedExtraTags = Array.isArray(extraTags)
    ? extraTags
        .filter(Boolean)
        .map((t) => {
          if (typeof t === "string" || typeof t === "number") {
            return String(t).trim();
          }
          if (t && typeof t === "object") {
            return String(t.text ?? t.label ?? "").trim();
          }
          return "";
        })
        .filter(Boolean)
    : [];
  const allTags = [...tags, ...normalizedExtraTags];

  const uniqueTags = [];
  const seenTags = new Set();
  for (const tag of allTags) {
    const key = tag.toLowerCase();
    if (seenTags.has(key)) continue;
    seenTags.add(key);
    uniqueTags.push(tag);
  }

  let visibleTags = uniqueTags.map((tag) => ({ text: tag, kind: tagVariant(tag), hiddenTags: [] }));
  if (truncateMain && collapseTags && uniqueTags.length > 1) {
    const baseLen = (base || rawLabel || "").length;
    const tagTextLen = uniqueTags.reduce((sum, t) => sum + String(t).length, 0);
    const shouldCollapse = uniqueTags.length > 2 || (baseLen + tagTextLen > 24);

    if (!shouldCollapse) {
      visibleTags = uniqueTags.map((tag) => ({ text: tag, kind: tagVariant(tag), hiddenTags: [] }));
    } else {
      const tagPriority = (tag) => {
        const variant = tagVariant(tag);
        if (variant === "action") return 0;
        if (variant === "mix") return 1;
        if (variant === "state") return 2;
        return 3;
      };
      const sorted = [...uniqueTags].sort((a, b) => tagPriority(a) - tagPriority(b));
      const first = sorted[0];
      const hidden = sorted.slice(1);
      const restCount = hidden.length;
      visibleTags = [{ text: first, kind: tagVariant(first), hiddenTags: [] }];
      if (restCount > 0) {
        visibleTags.push({ text: `+${restCount}`, kind: "count", hiddenTags: hidden });
      }
    }
  }

  const badges = visibleTags.map((tag) => ({
    text: tag.text,
    kind: tag.kind,
    hiddenTags: tag.hiddenTags || [],
  }));
  renderLabelWithBadges(container, {
    text: base || rawLabel || "Target",
    badges,
    truncate: truncateMain,
  });

  if (!container.firstElementChild) return;
  const badgeElements = container.querySelectorAll(".target-tag");
  badges.forEach((badge, index) => {
    if (badge.kind === "count" && Array.isArray(badge.hiddenTags) && badge.hiddenTags.length > 0) {
      const el = badgeElements[index];
      if (el) {
        const hiddenList = badge.hiddenTags.join(", ");
        el.title = hiddenList;
        el.setAttribute("aria-label", t("common.additionalTags", { tags: hiddenList }));
      }
    }
  });
}

export function closeAllDropdowns({ except = null } = {}) {
  document.querySelectorAll(".target-dropdown.open, .profile-select.open").forEach((dropdown) => {
    if (except && dropdown === except) return;
    dropdown.classList.remove("open");
    dropdown.querySelector(".target-menu")?.classList.add("hidden");
    dropdown.querySelector(".dropdown")?.classList.add("hidden");
    dropdown.querySelector(".target-button, .select-button")?.setAttribute("aria-expanded", "false");
  });
}

export function closeOpenDropdowns(options = {}) {
  closeAllDropdowns(options);
}

export function positionFloatingDropdownMenu({
  menu,
  trigger,
  minHeight = 160,
  maxHeight = 280,
  gap = 6,
  viewportPadding = 14,
  zIndex = 1000,
} = {}) {
  if (!menu || !trigger || menu.classList.contains("hidden")) return;

  const rect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || rect.right;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || rect.bottom;
  const safeWidth = Math.max(120, Math.min(rect.width, viewportWidth - (viewportPadding * 2)));
  const left = Math.max(
    viewportPadding,
    Math.min(rect.left, viewportWidth - safeWidth - viewportPadding),
  );
  const availableBelow = viewportHeight - rect.bottom - viewportPadding - gap;
  const availableAbove = rect.top - viewportPadding - gap;
  const availableSpace = Math.max(availableBelow, availableAbove);
  const safeMaxHeight = Math.max(
    Math.min(minHeight, maxHeight),
    Math.min(maxHeight, availableSpace),
  );

  menu.style.position = "fixed";
  menu.style.left = `${left}px`;
  menu.style.right = "auto";
  menu.style.width = `${safeWidth}px`;
  menu.style.minWidth = `${safeWidth}px`;
  menu.style.maxWidth = `${Math.max(120, viewportWidth - (viewportPadding * 2))}px`;
  menu.style.maxHeight = `${safeMaxHeight}px`;
  menu.style.zIndex = String(zIndex);

  const menuHeight = Math.min(menu.scrollHeight || safeMaxHeight, safeMaxHeight);
  const openUp = availableBelow < Math.min(180, menuHeight) && availableAbove > availableBelow;
  const top = openUp
    ? Math.max(viewportPadding, rect.top - gap - menuHeight)
    : Math.min(rect.bottom + gap, viewportHeight - viewportPadding - menuHeight);
  menu.style.top = `${top}px`;
}

export function wireDropdownToggle({ root, menu, trigger }) {
  if (!root || !menu || !trigger) return () => {};

  const onTriggerClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const opening = menu.classList.contains("hidden");
    closeAllDropdowns({ except: root });
    if (opening) {
      root.classList.add("open");
      menu.classList.remove("hidden");
      if (typeof root.__positionDropdownMenu === "function") {
        root.__positionDropdownMenu();
      }
      trigger.setAttribute("aria-expanded", "true");
    } else {
      root.classList.remove("open");
      menu.classList.add("hidden");
      trigger.setAttribute("aria-expanded", "false");
    }
  };

  trigger.addEventListener("click", onTriggerClick);

  return () => {
    trigger.removeEventListener("click", onTriggerClick);
  };
}

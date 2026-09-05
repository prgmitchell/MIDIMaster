import { CATEGORY_META } from "../catalog_presentation.js";
import { renderLabelFromRawWithTags } from "../../ui/dropdown_badges.js";

/** panel workflow. */
export function createPanel({
  categoryLabel,
  createCategoryIcon,
  createTargetIcon,
  elements,
  normalizePanelOptions,
  panelState,
  t,
  targetPanelParts,
}) {
  function closeTargetPanel() {
    if (!elements.targetPanel) {
      return;
    }
    elements.targetPanel.classList.add("hidden");
    elements.targetPanel.classList.remove("target-panel--over-config");
    if (elements.targetPanelList) {
      elements.targetPanelList.innerHTML = "";
    }
    const { searchInput, categories } = targetPanelParts();
    if (searchInput) searchInput.value = "";
    if (categories) categories.innerHTML = "";
    panelState.activeTargetPanelSelect = null;
    panelState.activeTargetPanelBack = null;
    panelState.activeTargetPanelIntegrationId = null;
    panelState.activeTargetPanelRefresh = null;

    if (elements.targetPanelBack) {
      elements.targetPanelBack.style.display = "none";
      elements.targetPanelBack.onclick = null;
    }
  }

  function openTargetPanel(options, selectedValue, selectedKind, onSelect, title = "", nav = null) {
    if (!elements.targetPanel || !elements.targetPanelList) {
      return;
    }
    panelState.activeTargetPanelSelect = onSelect;
    panelState.activeTargetPanelBack = nav && typeof nav === "object" ? nav.onBack || null : null;
    panelState.activeTargetPanelIntegrationId =
      nav && typeof nav === "object" ? nav.integrationId || null : null;
    panelState.activeTargetPanelRefresh =
      nav && typeof nav === "object" && typeof nav.refresh === "function" ? nav.refresh : null;
    const { searchInput, categories } = targetPanelParts();
    const normalizedOptions = normalizePanelOptions(options);
    let activeCategory = "all";
    let categoryIndicatorRaf = 0;

    if (elements.targetPanelBack) {
      if (typeof panelState.activeTargetPanelBack === "function") {
        elements.targetPanelBack.style.display = "inline-flex";
        elements.targetPanelBack.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          panelState.activeTargetPanelBack();
        };
      } else {
        elements.targetPanelBack.style.display = "none";
        elements.targetPanelBack.onclick = null;
      }
    }

    elements.targetPanelList.innerHTML = "";
    if (categories) {
      categories.innerHTML = "";
    }
    if (searchInput) {
      searchInput.value = "";
    }
    if (elements.targetPanelTitle) {
      elements.targetPanelTitle.textContent = title || t("targets.selectTarget");
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
        extraTags: Array.isArray(option.title_tags) ? option.title_tags : [],
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

      if (
        option.kind === "integration-root" ||
        option.kind === "integration-nav" ||
        option.kind === "action-root" ||
        option.kind === "monitor-brightness-root"
      ) {
        const navMeta = document.createElement("span");
        navMeta.className = "target-card-nav-meta";

        const badge = document.createElement("span");
        badge.className = "target-card-kind-badge";
        badge.textContent =
          option.kind === "action-root"
            ? t("targets.category.actions")
            : option.kind === "monitor-brightness-root"
              ? t("targets.category.devices")
              : t("targets.integration");
        navMeta.appendChild(badge);

        const arrow = document.createElement("span");
        arrow.className = "target-card-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "\u203a";
        navMeta.appendChild(arrow);

        item.appendChild(navMeta);
      }

      item.classList.toggle("selected", option.value === selectedValue && option.kind === selectedKind);
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
        if (panelState.activeTargetPanelSelect) {
          const res = panelState.activeTargetPanelSelect(option);
          if (res === false) {
            item.classList.toggle("selected");
            return;
          }
        }
        closeTargetPanel();
      });
      elements.targetPanelList.appendChild(item);
    };

    const render = () => {
      const query = String(searchInput?.value || "")
        .trim()
        .toLowerCase();
      const filtered = normalizedOptions.filter((option) => {
        const matchesCategory = activeCategory === "all" || option.category === activeCategory;
        const matchesSearch = !query || option.searchText.includes(query);
        return matchesCategory && matchesSearch;
      });

      elements.targetPanelList.innerHTML = "";
      if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "target-panel-empty";
        empty.textContent = query ? t("targets.noMatches") : t("targets.noneAvailable");
        elements.targetPanelList.appendChild(empty);
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
      const categoryIds = [
        "all",
        ...Object.keys(CATEGORY_META).filter((id) => id !== "all" && counts.has(id)),
      ];
      categoryIds.forEach((id) => {
        const meta = CATEGORY_META[id] || CATEGORY_META.other;
        const count = id === "all" ? normalizedOptions.length : counts.get(id) || 0;
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
    elements.targetPanel.classList.remove("hidden");
  }

  return { closeTargetPanel, openTargetPanel };
}

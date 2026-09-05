/** list controls workflow. */
export function createListControls({
  lifetime,
  alertAction,
  bindingMatchesTypeFilter,
  bindingObjectIdentities,
  bindingSnapshotKey,
  bindingsCard,
  elements,
  getBindingById,
  getEditingId,
  invoke,
  listState,
  normalizeBindingTypeFilter,
  renderBindings,
  renderedBindings,
  setEditingId,
  setPendingFocusId,
  t,
}) {
  function bindingObjectIdentity(binding) {
    if (!binding || typeof binding !== "object") return 0;
    let identity = bindingObjectIdentities.get(binding);
    if (!identity) {
      identity = listState.nextBindingObjectIdentity++;
      bindingObjectIdentities.set(binding, identity);
    }
    return identity;
  }

  function bindingRenderKey(binding, index) {
    return [
      bindingObjectIdentity(binding),
      index,
      String(document.documentElement?.lang || ""),
      binding.id === getEditingId(),
      bindingSnapshotKey(binding),
    ].join("|");
  }

  function getBindingTypeFilter() {
    return normalizeBindingTypeFilter(listState.bindingTypeFilter);
  }

  function showMacroAlreadyConfiguredError() {
    alertAction(t("dialogs.macroAlreadyConfiguredTitle"), t("dialogs.macroAlreadyConfiguredMessage"));
  }

  function bindingTypeFilterOptions() {
    return [
      { value: "all", label: t("bindings.filterAll") },
      { value: "faders", label: t("bindings.filterFaders") },
      { value: "buttons", label: t("bindings.filterButtons") },
    ];
  }

  function updateBindingTypeFilterUi() {
    const currentFilter = getBindingTypeFilter();
    const options = bindingTypeFilterOptions();
    const active = options.find((option) => option.value === currentFilter) || options[0];

    if (elements.bindingTypeFilter) {
      const label = t("bindings.typeFilterLabel");
      elements.bindingTypeFilter.title = `${label}: ${active.label}`;
      elements.bindingTypeFilter.setAttribute("aria-label", label);
    }
    elements.bindingTypeFilter?.querySelectorAll("[data-filter]").forEach((optionButton) => {
      const selected = normalizeBindingTypeFilter(optionButton.dataset?.filter) === currentFilter;
      optionButton.classList.toggle("selected", selected);
      optionButton.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function setBindingTypeFilter(value) {
    const next = normalizeBindingTypeFilter(value);
    const changed = next !== listState.bindingTypeFilter;
    listState.bindingTypeFilter = next;
    updateBindingTypeFilterUi();
    if (changed) {
      renderBindings();
    }
  }

  function bindBindingTypeFilterUi() {
    const root = elements.bindingTypeFilter;
    if (!root) return;

    root.querySelectorAll("[data-filter]").forEach((optionButton) => {
      lifetime.listen(optionButton, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setBindingTypeFilter(optionButton.dataset?.filter);
      });
    });

    updateBindingTypeFilterUi();
  }

  function updateBindingDensityUi() {
    const density = listState.compactBindings ? "compact" : "comfortable";
    if (elements.mainScreen) {
      elements.mainScreen.dataset.bindingsDensity = density;
    }
    elements.bindingDensityToggle?.querySelectorAll("[data-density]").forEach((optionButton) => {
      const selected = String(optionButton.dataset?.density || "") === density;
      optionButton.classList.toggle("selected", selected);
      optionButton.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    queueBindingsScrollLayoutSync();
  }

  async function setCompactBindings(value, { persist = false } = {}) {
    const next = Boolean(value);
    const previous = listState.compactBindings;
    listState.compactBindings = next;
    updateBindingDensityUi();
    if (!persist || next === previous) {
      return listState.compactBindings;
    }

    const sequence = ++listState.bindingDensitySaveSequence;
    try {
      const saved = await invoke("set_compact_bindings", { compactBindings: next });
      if (sequence !== listState.bindingDensitySaveSequence) {
        return listState.compactBindings;
      }
      listState.compactBindings = typeof saved === "boolean" ? saved : next;
      updateBindingDensityUi();
    } catch (error) {
      if (sequence === listState.bindingDensitySaveSequence) {
        listState.compactBindings = previous;
        updateBindingDensityUi();
        alertAction(t("dialogs.actionFailedTitle"), t("dialogs.actionFailedMessage"));
      }
      console.error("Failed to save binding view density", error);
    }
    return listState.compactBindings;
  }

  function bindBindingDensityUi() {
    const root = elements.bindingDensityToggle;
    if (!root) return;
    root.querySelectorAll("[data-density]").forEach((optionButton) => {
      lifetime.listen(optionButton, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void setCompactBindings(optionButton.dataset?.density === "compact", { persist: true });
      });
    });
    updateBindingDensityUi();
  }

  function measureScrollbarWidth() {
    const probe = document.createElement("div");
    probe.style.cssText = [
      "position:absolute",
      "top:-9999px",
      "left:-9999px",
      "width:120px",
      "height:120px",
      "overflow:scroll",
      "visibility:hidden",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(probe);
    const width = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    return Math.max(0, width || 0);
  }

  function syncBindingsScrollLayout() {
    listState.bindingsLayoutSyncQueued = false;
    if (!bindingsCard || !elements.bindingsContainer?.isConnected) return;

    if (!listState.bindingsScrollbarWidth) {
      listState.bindingsScrollbarWidth = measureScrollbarWidth();
    }

    const isScrollable =
      elements.bindingsContainer.scrollHeight > elements.bindingsContainer.clientHeight + 1;
    bindingsCard.classList.toggle("is-scrollable", isScrollable);
    bindingsCard.style.setProperty("--bindings-scrollbar-width", `${listState.bindingsScrollbarWidth}px`);
    bindingsCard.style.setProperty("--bindings-header-reserve", `${listState.bindingsScrollbarWidth}px`);
    bindingsCard.style.setProperty("--bindings-row-reserve", "0px");
  }

  function queueBindingsScrollLayoutSync() {
    if (listState.bindingsLayoutSyncQueued) return;
    listState.bindingsLayoutSyncQueued = true;
    requestAnimationFrame(syncBindingsScrollLayout);
  }

  function queueBindingReveal(bindingId) {
    const nextId = String(bindingId || "").trim();
    listState.pendingRevealBindingId = nextId || null;
  }

  function findRenderedBindingItem(bindingId) {
    const targetId = String(bindingId || "");
    if (!targetId || !elements.bindingsContainer) return null;
    return renderedBindings.get(targetId)?.item || null;
  }

  function flushQueuedBindingReveal() {
    const bindingId = listState.pendingRevealBindingId;
    if (!bindingId) return;
    listState.pendingRevealBindingId = null;

    requestAnimationFrame(() => {
      const item = findRenderedBindingItem(bindingId);
      if (!item) return;
      const reduceMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
      item.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
      item.classList.remove("binding-item-revealed");
      void item.offsetWidth;
      item.classList.add("binding-item-revealed");
      clearTimeout(item.__bindingRevealTimer);
      item.__bindingRevealTimer = setTimeout(
        () => {
          item.classList.remove("binding-item-revealed");
        },
        reduceMotion ? 700 : 1800,
      );
    });
  }

  function ensureBindingVisibleForPicker(bindingId) {
    const binding = getBindingById(bindingId);
    let needsRender = false;
    if (elements.bindingSearchInput && String(elements.bindingSearchInput.value || "").trim()) {
      elements.bindingSearchInput.value = "";
      needsRender = true;
    }
    if (binding && !bindingMatchesTypeFilter(binding, getBindingTypeFilter())) {
      listState.bindingTypeFilter = "all";
      updateBindingTypeFilterUi();
      needsRender = true;
    }
    if (needsRender) {
      renderBindings();
    }
  }

  async function openBindingTargetPicker(bindingId) {
    const targetId = String(bindingId || "");
    if (!targetId) return false;
    setEditingId(null);
    setPendingFocusId(null);
    ensureBindingVisibleForPicker(targetId);

    const openRenderedPicker = async () => {
      const item = findRenderedBindingItem(targetId);
      if (!item) return false;
      const reduceMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
      item.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
      item.classList.remove("binding-item-revealed");
      void item.offsetWidth;
      item.classList.add("binding-item-revealed");
      clearTimeout(item.__bindingRevealTimer);
      item.__bindingRevealTimer = setTimeout(
        () => {
          item.classList.remove("binding-item-revealed");
        },
        reduceMotion ? 700 : 1800,
      );

      const targetDropdown = item.querySelector(".binding-target-dropdown");
      if (typeof targetDropdown?.openTargetPicker === "function") {
        await targetDropdown.openTargetPicker();
        return true;
      }
      const targetButton = targetDropdown?.querySelector?.(".target-button");
      if (targetButton) {
        targetButton.click();
        return true;
      }
      return false;
    };

    if (await openRenderedPicker()) return true;

    return new Promise((resolve, reject) => {
      requestAnimationFrame(() => {
        openRenderedPicker().then(resolve, reject);
      });
    });
  }

  return {
    bindingRenderKey,
    getBindingTypeFilter,
    showMacroAlreadyConfiguredError,
    updateBindingTypeFilterUi,
    bindBindingTypeFilterUi,
    setCompactBindings,
    bindBindingDensityUi,
    queueBindingsScrollLayoutSync,
    queueBindingReveal,
    flushQueuedBindingReveal,
    openBindingTargetPicker,
  };
}

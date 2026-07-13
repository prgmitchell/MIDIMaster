export function getNavIndicatorMetrics(sidebarRect, activeRect, scrollLeft = 0, scrollTop = 0) {
  return {
    width: activeRect.width,
    height: activeRect.height,
    x: activeRect.left - sidebarRect.left + scrollLeft,
    y: activeRect.top - sidebarRect.top + scrollTop,
  };
}

export function createConnectionsPanelController({
  dom,
  pluginsTabs,
  i18n,
  getPluginHost,
  setPluginHost,
  startPluginHostIfNeeded,
}) {
  const d = (dom && typeof dom === "object") ? dom : {};
  const t = (key, params = {}) => (i18n && typeof i18n.t === "function") ? i18n.t(key, params) : String(key || "");
  let connectionsTabsSignature = "";
  let connectionsSidebarListenerBound = false;
  let activeTabId = "installed";
  let mountRunId = 0;
  let navIndicatorRaf = 0;

  function syncNavIndicator() {
    if (!d.connectionsSidebar) return;
    const indicator = d.connectionsSidebar.querySelector(".connections-nav-indicator");
    const active = d.connectionsSidebar.querySelector(".connections-nav-item.active");
    if (!indicator || !active) {
      if (indicator) indicator.style.opacity = "0";
      return;
    }
    const metrics = getNavIndicatorMetrics(
      d.connectionsSidebar.getBoundingClientRect(),
      active.getBoundingClientRect(),
      d.connectionsSidebar.scrollLeft,
      d.connectionsSidebar.scrollTop,
    );
    indicator.style.width = `${metrics.width}px`;
    indicator.style.height = `${metrics.height}px`;
    indicator.style.transform = `translate(${metrics.x}px, ${metrics.y}px)`;
    indicator.style.opacity = "1";
  }

  function scheduleNavIndicatorSync() {
    if (navIndicatorRaf) {
      cancelAnimationFrame(navIndicatorRaf);
    }
    navIndicatorRaf = requestAnimationFrame(() => {
      navIndicatorRaf = 0;
      syncNavIndicator();
    });
  }

  function setActiveTab(tabId) {
    activeTabId = tabId || activeTabId;
    if (!d.connectionsSidebar || !d.connectionsContent) {
      return;
    }

    d.connectionsSidebar.querySelectorAll(".connections-nav-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.tab === activeTabId);
    });
    d.connectionsContent.querySelectorAll(".connection-tab").forEach((pane) => {
      pane.classList.toggle("active", pane.dataset.tab === activeTabId);
    });
    scheduleNavIndicatorSync();
  }

  function getCurrentActiveTab() {
    if (!d.connectionsSidebar) return activeTabId;
    const active = d.connectionsSidebar.querySelector(".connections-nav-item.active");
    return active?.dataset?.tab || activeTabId;
  }

  function renderPluginTabShell(container, tab) {
    if (!container) return;
    container.innerHTML = `
      <div class="plugins-custom-shell">
        <div class="plugins-custom-content" data-role="custom-content"></div>
      </div>
    `;
    const target = container.querySelector('[data-role="custom-content"]');
    try {
      tab.mount(target);
    } catch {
      if (target) {
        const empty = document.createElement("div");
        empty.className = "plugins-browser-empty";
        empty.textContent = t("plugins.customUiLoadFailed", { name: tab.name });
        target.replaceChildren(empty);
      }
    }
  }

  const navIconPaths = {
    installed: ["M5 12.5 9 16.5 19 6.5", "M4 5h16v14H4z"],
    all: ["M5 5h6v6H5z", "M13 5h6v6h-6z", "M5 13h6v6H5z", "M13 13h6v6h-6z"],
    updates: ["M20 5v5h-5", "M4 19v-5h5", "M6.75 9A7 7 0 0 1 18 6.5L20 10", "M17.25 15A7 7 0 0 1 6 17.5L4 14"],
    store: ["M6 8h12l-1 11H7L6 8Z", "M9 8a3 3 0 0 1 6 0", "M8 12h8"],
    audio: ["M6 10v4", "M10 7v10", "M14 5v14", "M18 9v6"],
    lighting: ["M12 3v2", "M5.65 5.65 7.05 7.05", "M18.35 5.65 16.95 7.05", "M8 13a4 4 0 1 1 8 0c0 1.5-.8 2.3-1.6 3H9.6C8.8 15.3 8 14.5 8 13Z", "M10 20h4", "M9.5 17h5"],
    streaming: ["M5 7h10v10H5z", "M15 10l4-2v8l-4-2"],
    utilities: ["M14.7 6.3a4 4 0 0 0-5.4 5.4L4.8 16.2a2.1 2.1 0 0 0 3 3l4.5-4.5a4 4 0 0 0 5.4-5.4", "m14 7 3 3"],
    category: ["M4 7h16", "M7 12h10", "M9 17h6"],
  };

  function createNavSvgIcon(item) {
    const key = item.kind === "category"
      ? String(item.slug || item.name || "category").toLowerCase()
      : String(item.id || item.tabId || "").toLowerCase();
    const icon = document.createElement("span");
    icon.className = "connections-nav-icon connections-nav-icon--svg";
    icon.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("focusable", "false");
    for (const pathData of (navIconPaths[key] || navIconPaths.category)) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathData);
      svg.appendChild(path);
    }
    icon.appendChild(svg);
    return icon;
  }

  async function mountConnectionsTabs(opts = null) {
    const runId = ++mountRunId;
    const options = (opts && typeof opts === "object") ? opts : {};
    const force = Boolean(options.force);
    const requestedTabId = String(options.activeTabId || getCurrentActiveTab() || activeTabId || "installed");

    if (!d.connectionsSidebar || !d.connectionsContent) {
      return;
    }

    if (!connectionsSidebarListenerBound) {
      connectionsSidebarListenerBound = true;
      d.connectionsSidebar.addEventListener("click", (event) => {
        const btn = event.target?.closest?.(".connections-nav-item");
        if (!btn) return;
        const tabId = String(btn.dataset.tab || "");
        if (!tabId) return;
        setActiveTab(tabId);
      });
    }

    const [browserSections] = await Promise.all([
      pluginsTabs.getPluginsBrowserSections().catch(() => ({ primary: [], categories: [] })),
    ]);
    if (runId !== mountRunId) return;
    const pluginHost = getPluginHost();
    const pluginTabs = pluginHost ? pluginHost.getConnectionTabs() : [];

    const navItems = [
      ...browserSections.primary.map((item) => ({
        ...item,
        kind: "builtin",
        tabId: item.id,
        section: "primary",
      })),
      ...browserSections.categories.map((item) => ({
        ...item,
        kind: "category",
        tabId: item.id,
        view: item.id,
        section: "categories",
      })),
      ...pluginTabs.map((tab) => ({
        kind: "plugin",
        tabId: `plugin:${tab.id}`,
        id: tab.id,
        name: tab.name,
        icon_data: tab.icon_data || pluginsTabs.PLUGINS_ICON_DATA,
        mount: tab.mount,
        section: "plugins",
      })),
    ];

    const signature = JSON.stringify({
      items: navItems.map((item) => ({ tabId: item.tabId, count: item.count || 0, section: item.section, name: item.name })),
    });

    if (!force && signature === connectionsTabsSignature && d.connectionsSidebar.childElementCount > 0) {
      setActiveTab(requestedTabId);
      return;
    }

    connectionsTabsSignature = signature;
    d.connectionsSidebar.innerHTML = "";
    d.connectionsContent.innerHTML = "";

    const indicator = document.createElement("div");
    indicator.className = "connections-nav-indicator";
    indicator.setAttribute("aria-hidden", "true");
    d.connectionsSidebar.appendChild(indicator);

    const sections = [
      { key: "primary", label: "" },
      { key: "categories", label: t("plugins.collections") },
      { key: "plugins", label: t("plugins.pluginPanels") },
    ];

    for (const section of sections) {
      const items = navItems.filter((item) => item.section === section.key);
      if (!items.length) continue;

      const group = document.createElement("div");
      group.className = `connections-nav-group connections-nav-group--${section.key}`;
      if (section.label) {
        const heading = document.createElement("div");
        heading.className = "connections-nav-group-title";
        heading.textContent = section.label;
        group.appendChild(heading);
      }

      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "connections-nav-item";
        button.dataset.tab = item.tabId;

        const labelWrap = document.createElement("span");
        labelWrap.className = "connections-nav-label";

        if (item.kind === "plugin" && item.icon_data) {
          const icon = document.createElement("img");
          icon.className = "connections-nav-icon";
          icon.alt = "";
          icon.src = item.icon_data;
          button.appendChild(icon);
        } else {
          button.appendChild(createNavSvgIcon(item));
        }

        labelWrap.textContent = item.name;
        button.appendChild(labelWrap);

        if (typeof item.count === "number") {
          const badge = document.createElement("span");
          badge.className = "connections-nav-count";
          badge.textContent = String(item.count);
          button.appendChild(badge);
        }

        group.appendChild(button);

        const pane = document.createElement("div");
        pane.className = "connection-tab";
        pane.dataset.tab = item.tabId;
        d.connectionsContent.appendChild(pane);

        if (item.kind === "plugin") {
          renderPluginTabShell(pane, item);
        } else {
          await pluginsTabs.mountPluginsBrowserTab(pane, {
            view: item.kind === "category" ? item.view : item.id,
            label: item.name,
            onOpenPluginPanel: (tabId) => setActiveTab(tabId),
          });
          if (runId !== mountRunId) return;
        }
      }

      d.connectionsSidebar.appendChild(group);
    }

    if (runId !== mountRunId) return;
    const validTabIds = new Set(navItems.map((item) => item.tabId));
    const fallbackTabId = navItems[0]?.tabId || "installed";
    setActiveTab(validTabIds.has(requestedTabId) ? requestedTabId : fallbackTabId);
    syncNavIndicator();
    requestAnimationFrame(() => {
      indicator.classList.add("is-ready");
    });
  }

  async function reloadPlugins() {
    const nextActiveTab = getCurrentActiveTab();
    try {
      const pluginHost = getPluginHost();
      if (pluginHost) {
        await pluginHost.stop().catch(() => { });
      }
    } catch { }
    setPluginHost(null);
    await startPluginHostIfNeeded().catch(() => { });
    await mountConnectionsTabs({ force: true, activeTabId: nextActiveTab });
  }

  async function openConnectionsPanel() {
    if (!d.connectionsPanel) {
      return;
    }

    const preloadTasks = [
      pluginsTabs.preloadInstalledPlugins().catch(() => { }),
    ];
    if (typeof pluginsTabs.preloadStoreCatalog === "function") {
      preloadTasks.push(pluginsTabs.preloadStoreCatalog().catch(() => { }));
    }
    await Promise.all(preloadTasks);

    d.connectionsPanel.classList.remove("hidden");
    await mountConnectionsTabs({ activeTabId });
    startPluginHostIfNeeded()
      .then(() => mountConnectionsTabs({ force: true, activeTabId }))
      .catch(() => { });
  }

  function bindUi() {
    if (d.connectionsPanel) {
      d.connectionsPanel.addEventListener("click", (event) => {
        if (d.connectionsPanel.classList.contains("target-panel") && event.target === d.connectionsPanel) {
          d.closeConnectionsPanel?.();
        }
      });
    }

    if (d.connectionsPanelClose) {
      d.connectionsPanelClose.addEventListener("click", () => d.closeConnectionsPanel?.());
    }

    if (d.connectionsButton) {
      d.connectionsButton.addEventListener("click", () => {
        const pluginsPageActive = document.querySelector('[data-page-panel="plugins"]')?.classList.contains("active");
        if (pluginsPageActive) {
          return;
        }
        openConnectionsPanel();
      });
    }

    window.addEventListener("resize", scheduleNavIndicatorSync);
    window.addEventListener("midimaster:locale-changed", () => {
      mountConnectionsTabs({ force: true, activeTabId: getCurrentActiveTab() }).catch(() => {});
    });
  }

  return {
    mountConnectionsTabs,
    reloadPlugins,
    openConnectionsPanel,
    bindUi,
  };
}

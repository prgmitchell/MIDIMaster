export function createConnectionsPanelController({
  dom,
  pluginsTabs,
  getPluginHost,
  setPluginHost,
  startPluginHostIfNeeded,
}) {
  const d = (dom && typeof dom === "object") ? dom : {};
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
    const sidebarRect = d.connectionsSidebar.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    indicator.style.width = `${activeRect.width}px`;
    indicator.style.height = `${activeRect.height}px`;
    indicator.style.transform = `translate(${activeRect.left - sidebarRect.left}px, ${activeRect.top - sidebarRect.top}px)`;
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
        target.innerHTML = `<div class="plugins-browser-empty">Failed to load ${tab.name} UI.</div>`;
      }
    }
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
      { key: "categories", label: "Collections" },
      { key: "plugins", label: "Plugin Panels" },
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
  }

  return {
    mountConnectionsTabs,
    reloadPlugins,
    openConnectionsPanel,
    bindUi,
  };
}

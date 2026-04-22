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

  function mountConnectionsTabs(opts = null) {
    const force = (opts && typeof opts === "object") ? Boolean(opts.force) : false;
    if (!d.connectionsSidebar || !d.connectionsContent) {
      return;
    }

    if (!connectionsSidebarListenerBound) {
      connectionsSidebarListenerBound = true;
      d.connectionsSidebar.addEventListener("click", (event) => {
        const btn = event.target?.closest?.(".connections-nav-item");
        if (!btn) return;
        const tabId = btn.dataset.tab;
        if (!tabId) return;

        d.connectionsSidebar.querySelectorAll(".connections-nav-item").forEach((i) => i.classList.remove("active"));
        d.connectionsContent.querySelectorAll(".connection-tab").forEach((t) => t.classList.remove("active"));

        btn.classList.add("active");
        const pane = document.getElementById(`connection-tab-${tabId}`);
        if (pane) pane.classList.add("active");
      });
    }

    const pluginHost = getPluginHost();
    const pluginTabs = pluginHost ? pluginHost.getConnectionTabs() : [];
    const tabs = [
      {
        id: "__plugins_manager__",
        name: "Installed",
        icon_data: pluginsTabs.PLUGINS_ICON_DATA,
        mount: pluginsTabs.mountPluginsManagerTab,
      },
      {
        id: "__plugins_store__",
        name: "Store",
        icon_data: pluginsTabs.PLUGINS_ICON_DATA,
        mount: pluginsTabs.mountPluginsStoreTab,
      },
      ...pluginTabs,
    ];

    const sig = Array.isArray(tabs) ? tabs.map((t) => t.id).join("|") : "";
    if (!force && sig === connectionsTabsSignature && d.connectionsSidebar.childElementCount > 0) {
      return;
    }
    connectionsTabsSignature = sig;

    d.connectionsSidebar.innerHTML = "";
    d.connectionsContent.innerHTML = "";

    if (!tabs.length) {
      return;
    }

    for (const tab of tabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "connections-nav-item";
      btn.dataset.tab = tab.id;
      const icon = document.createElement("img");
      icon.className = "nav-icon";
      icon.alt = "";
      icon.src = tab.icon_data || "";
      const label = document.createElement("span");
      label.textContent = tab.name;
      btn.appendChild(icon);
      btn.appendChild(label);
      d.connectionsSidebar.appendChild(btn);

      const pane = document.createElement("div");
      pane.id = `connection-tab-${tab.id}`;
      pane.className = "connection-tab";
      d.connectionsContent.appendChild(pane);

      try {
        tab.mount(pane);
      } catch {
        pane.innerHTML = `<div class=\"connection-description\"><p>Failed to load ${tab.name} UI.</p></div>`;
      }
    }

    const firstBtn = d.connectionsSidebar.querySelector(".connections-nav-item");
    const firstPane = d.connectionsContent.querySelector(".connection-tab");
    if (firstBtn) firstBtn.classList.add("active");
    if (firstPane) firstPane.classList.add("active");
  }

  async function reloadPlugins() {
    try {
      const pluginHost = getPluginHost();
      if (pluginHost) {
        await pluginHost.stop().catch(() => { });
      }
    } catch { }
    setPluginHost(null);
    await startPluginHostIfNeeded().catch(() => { });
    mountConnectionsTabs({ force: true });
  }

  async function openConnectionsPanel() {
    if (!d.connectionsPanel) {
      return;
    }

    await pluginsTabs.preloadInstalledPlugins().catch(() => { });

    d.connectionsPanel.classList.remove("hidden");
    mountConnectionsTabs({ force: true });
    startPluginHostIfNeeded()
      .then(() => mountConnectionsTabs({ force: true }))
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
        openConnectionsPanel();
      });
    }
  }

  return {
    mountConnectionsTabs,
    reloadPlugins,
    openConnectionsPanel,
    bindUi,
  };
}

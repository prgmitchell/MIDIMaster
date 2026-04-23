import {
  createSelectDropdownShell,
  renderNativeSelectDropdown,
} from "../ui/dropdown_select.js";

export const PLUGINS_ICON_DATA = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect width='18' height='18' rx='4' fill='%232b2d42'/><path d='M6.2 6.1c.6-1 1.6-1.6 2.8-1.6s2.2.6 2.8 1.6c.2.3.6.4.9.2l.7-.4c.3-.2.4-.6.2-.9C15.5 3.5 13.4 2 11 2H7C4.6 2 2.5 3.5 1.4 5c-.2.3-.1.7.2.9l.7.4c.3.2.7.1.9-.2zM11.8 11.9c-.6 1-1.6 1.6-2.8 1.6s-2.2-.6-2.8-1.6c-.2-.3-.6-.4-.9-.2l-.7.4c-.3.2-.4.6-.2.9C2.5 14.5 4.6 16 7 16h4c2.4 0 4.5-1.5 5.6-3 .2-.3.1-.7-.2-.9l-.7-.4c-.3-.2-.7-.1-.9.2z' fill='white' opacity='.85'/></svg>";

function guessMimeFromPath(p) {
  const s = String(p || "").toLowerCase();
  if (s.endsWith(".svg")) return "image/svg+xml";
  if (s.endsWith(".png")) return "image/png";
  if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
  if (s.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "misc";
}

function parseSemver(v) {
  const parts = String(v || "").split(".").map((x) => parseInt(x, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isUpdateAvailable(installedV, latestV) {
  const a = parseSemver(installedV);
  const b = parseSemver(latestV);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

function compareVersionsDesc(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return -1;
    if (left[i] < right[i]) return 1;
  }
  return 0;
}

function normalizeCategories(...values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const list = Array.isArray(value) ? value : [];
    for (const item of list) {
      const label = String(item || "").trim();
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(label);
    }
  }
  return result.slice(0, 4);
}

function resolveDescription(installedPlugin, storePlugin) {
  return String(
    installedPlugin?.description
    || storePlugin?.description
    || ""
  ).trim();
}

function createIconButtonMarkup(pathD) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${pathD}"></path></svg>`;
}

const TRASH_ICON = createIconButtonMarkup("M9 3h6m-9 3h12m-1 0-.7 11.2a2 2 0 0 1-2 1.8H9.7a2 2 0 0 1-2-1.8L7 6m3 4v5m4-5v5");

let pluginPackageFileInput = null;
function pickMidimasterPackageFile() {
  return new Promise((resolve) => {
    if (!pluginPackageFileInput) {
      pluginPackageFileInput = document.createElement("input");
      pluginPackageFileInput.type = "file";
      pluginPackageFileInput.accept = ".midimaster";
      pluginPackageFileInput.style.display = "none";
      document.body.appendChild(pluginPackageFileInput);
    }
    pluginPackageFileInput.value = "";
    pluginPackageFileInput.onchange = () => {
      const f = pluginPackageFileInput.files && pluginPackageFileInput.files[0];
      resolve(f || null);
    };
    pluginPackageFileInput.click();
  });
}

export function createPluginsTabs({ invoke, getPluginHost, reloadPlugins, showConfirm }) {
  if (typeof invoke !== "function") {
    throw new Error("createPluginsTabs: invoke is required");
  }

  const getHost = (typeof getPluginHost === "function") ? getPluginHost : (() => null);
  const reload = (typeof reloadPlugins === "function") ? reloadPlugins : (async () => { });
  const confirmAction = (typeof showConfirm === "function")
    ? showConfirm
    : (() => Promise.resolve(false));

  let installedCache = null;
  let installedCachePromise = null;
  let storeCatalogCache = null;
  let storeCatalogPromise = null;
  let storeCatalogError = "";
  const installedIconCache = new Map();

  async function warmInstalledIcons(plugins) {
    const list = Array.isArray(plugins) ? plugins : [];
    await Promise.all(list.map(async (plugin) => {
      try {
        if (!plugin || typeof plugin !== "object") return;
        const pluginId = String(plugin.id || "");
        const rel = plugin.icon ? String(plugin.icon) : "";
        if (!pluginId || !rel) return;
        const key = `${pluginId}:${rel}`;
        if (installedIconCache.has(key)) return;
        const b64 = await invoke("read_plugin_base64", { pluginId, relPath: rel, plugin_id: pluginId, rel_path: rel });
        const mime = guessMimeFromPath(rel);
        installedIconCache.set(key, `data:${mime};base64,${b64}`);
      } catch {
        // ignore icon read failures
      }
    }));
  }

  async function preloadInstalledPlugins(force = false) {
    if (force) {
      installedCachePromise = null;
    }
    if (installedCachePromise) {
      return installedCachePromise;
    }

    installedCachePromise = (async () => {
      try {
        const plugins = await invoke("list_plugins");
        installedCache = Array.isArray(plugins) ? plugins : [];
      } catch {
        installedCache = [];
      }
      warmInstalledIcons(installedCache).catch(() => { });
      return installedCache;
    })();

    return installedCachePromise;
  }

  async function preloadStoreCatalog(force = false) {
    if (force) {
      storeCatalogPromise = null;
    }
    if (storeCatalogPromise) {
      return storeCatalogPromise;
    }

    storeCatalogPromise = (async () => {
      storeCatalogError = "";
      try {
        const catalog = await invoke("fetch_store_catalog");
        storeCatalogCache = (catalog && typeof catalog === "object") ? catalog : { plugins: [] };
      } catch (error) {
        console.error("Failed to fetch store catalog", error);
        storeCatalogCache = { plugins: [] };
        storeCatalogError = "Could not load store catalog.";
      }
      return storeCatalogCache;
    })();

    return storeCatalogPromise;
  }

  async function loadBrowserData(force = false) {
    const [installed, catalog] = await Promise.all([
      preloadInstalledPlugins(force),
      preloadStoreCatalog(force),
    ]);
    return {
      installed: Array.isArray(installed) ? installed : [],
      catalog: catalog && typeof catalog === "object" ? catalog : { plugins: [] },
      storeError: storeCatalogError,
    };
  }

  function getResolvedIcon(entry) {
    const iconRel = entry.installed?.icon ? String(entry.installed.icon) : "";
    const iconKey = iconRel ? `${entry.id}:${iconRel}` : "";
    const host = getHost();
    const integrationIcon = host?.getIntegration?.(entry.id)?.icon_data || null;
    if (iconKey && installedIconCache.has(iconKey)) {
      return installedIconCache.get(iconKey);
    }
    if (integrationIcon) {
      return integrationIcon;
    }
    if (entry.store?.icon_url) {
      return String(entry.store.icon_url);
    }
    return PLUGINS_ICON_DATA;
  }

  function getPluginPanelTabId(pluginId) {
    const host = getHost();
    const tabs = host?.getConnectionTabs?.();
    const match = Array.isArray(tabs)
      ? tabs.find((tab) => String(tab?.id || "") === String(pluginId || ""))
      : null;
    return match ? `plugin:${pluginId}` : "";
  }

  function buildEntries({ installed, catalog }) {
    const installedMap = new Map((Array.isArray(installed) ? installed : []).map((plugin) => [String(plugin.id || ""), plugin]));
    const storePlugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
    const storeMap = new Map(storePlugins.map((plugin) => [String(plugin.id || ""), plugin]));
    const ids = new Set([...installedMap.keys(), ...storeMap.keys()]);

    const entries = [...ids]
      .filter(Boolean)
      .map((id) => {
        const installedPlugin = installedMap.get(id) || null;
        const storePlugin = storeMap.get(id) || null;
        const name = String(installedPlugin?.name || storePlugin?.name || id);
        const installedVersion = String(installedPlugin?.version || "");
        const latestVersion = String(storePlugin?.latest?.version || installedVersion);
        const description = resolveDescription(installedPlugin, storePlugin);
        const author = String(storePlugin?.author || "");
        const categories = normalizeCategories(
          installedPlugin?.categories,
          storePlugin?.categories,
          storePlugin?.tags,
        );

        return {
          id,
          name,
          description,
          author,
          installed: installedPlugin,
          store: storePlugin,
          iconSrc: null,
          installedVersion,
          latestVersion,
          versionLabel: installedVersion || latestVersion,
          enabled: installedPlugin ? installedPlugin.enabled !== false : false,
          bundled: Boolean(installedPlugin?.bundled),
          isInstalled: Boolean(installedPlugin),
          isStoreOnly: !installedPlugin && Boolean(storePlugin),
          hasUpdate: Boolean(installedPlugin && storePlugin && isUpdateAvailable(installedVersion, latestVersion)),
          categories,
          categorySlugs: categories.map((category) => slugify(category)),
          searchText: [id, name, description, author, ...categories].join(" ").toLowerCase(),
        };
      });

    for (const entry of entries) {
      entry.iconSrc = getResolvedIcon(entry);
    }

    return entries;
  }

  function buildNavigationModel(entries) {
    const installedEntries = entries.filter((entry) => entry.isInstalled);
    const updatesEntries = entries.filter((entry) => entry.hasUpdate);
    const storeEntries = entries.filter((entry) => Boolean(entry.store));
    const categoryMap = new Map();

    for (const entry of entries) {
      for (const category of entry.categories) {
        const slug = slugify(category);
        const current = categoryMap.get(slug) || { id: `category:${slug}`, name: category, slug, count: 0 };
        current.count += 1;
        categoryMap.set(slug, current);
      }
    }

    const categories = [...categoryMap.values()]
      .filter((item) => item.count > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      primary: [
        { id: "installed", name: "Installed", count: installedEntries.length },
        { id: "all", name: "All Plugins", count: entries.length },
        { id: "updates", name: "Updates", count: updatesEntries.length },
        { id: "store", name: "Store", count: storeEntries.length },
      ],
      categories,
    };
  }

  function getEntriesForView(entries, view) {
    if (!view || view === "installed") {
      return entries.filter((entry) => entry.isInstalled);
    }
    if (view === "all") {
      return entries;
    }
    if (view === "updates") {
      return entries.filter((entry) => entry.hasUpdate);
    }
    if (view === "store") {
      return entries.filter((entry) => Boolean(entry.store));
    }
    if (view.startsWith("category:")) {
      const slug = view.slice("category:".length);
      return entries.filter((entry) => entry.categorySlugs.includes(slug));
    }
    return entries;
  }

  function sortEntries(entries, sortValue) {
    const next = [...entries];
    switch (sortValue) {
      case "name-desc":
        next.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "updates-first":
        next.sort((a, b) => {
          if (a.hasUpdate !== b.hasUpdate) return a.hasUpdate ? -1 : 1;
          if (a.isInstalled !== b.isInstalled) return a.isInstalled ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        break;
      case "version-desc":
        next.sort((a, b) => {
          const versionOrder = compareVersionsDesc(a.latestVersion || a.installedVersion, b.latestVersion || b.installedVersion);
          if (versionOrder !== 0) return versionOrder;
          return a.name.localeCompare(b.name);
        });
        break;
      default:
        next.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return next;
  }

  function getViewEmptyState(view) {
    switch (view) {
      case "installed":
        return "No installed plugins yet.";
      case "updates":
        return "All installed plugins are up to date.";
      case "store":
        return "No store plugins matched your search.";
      default:
        return "No plugins matched your filters.";
    }
  }

  function getActionLabel(entry, currentView) {
    if (entry.isInstalled) {
      if (entry.hasUpdate) return "Update";
      if (currentView === "store") return "Installed";
      return "";
    }
    if (entry.store) return "Install";
    return "";
  }

  function createStatusSetter(statusEl) {
    return (text, kind = "") => {
      if (!statusEl) return;
      statusEl.textContent = text || "";
      statusEl.classList.toggle("hidden", !text);
      statusEl.classList.toggle("error", kind === "error");
      statusEl.classList.toggle("success", kind === "success");
    };
  }

  async function installPackageFromFile(setStatus) {
    const file = await pickMidimasterPackageFile();
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(buffer);
      await invoke("install_plugin_package", {
        filename: file.name,
        bytesBase64: b64,
        bytes_base64: b64,
      });
      setStatus("");
      await preloadInstalledPlugins(true);
      await preloadStoreCatalog(true);
      await reload();
    } catch (error) {
      console.error("Failed to install plugin package", error);
      setStatus("Failed to install plugin. Check the package file and try again.", "error");
    }
  }

  async function runEntryAction(entry, action, setStatus) {
    try {
      if (action === "toggle") {
        await invoke("set_plugin_enabled", { pluginId: entry.id, enabled: !entry.enabled, plugin_id: entry.id });
      } else if (action === "uninstall") {
        await invoke("uninstall_plugin", { pluginId: entry.id, plugin_id: entry.id });
        setStatus("");
      } else if (action === "install-store") {
        await invoke("install_store_plugin", { pluginId: entry.id, plugin_id: entry.id });
        setStatus("");
      }
      await preloadInstalledPlugins(true);
      await preloadStoreCatalog(true);
      await reload();
    } catch (error) {
      console.error(`Plugin action failed: ${action}`, error);
      if (action === "toggle") {
        setStatus("Failed to update plugin state.", "error");
      } else if (action === "uninstall") {
        setStatus("Failed to uninstall plugin.", "error");
      } else {
        setStatus("Install failed. The package may be untrusted or unavailable.", "error");
      }
    }
  }

  function renderPluginCards({ listEl, entries, view, setStatus, onOpenPluginPanel }) {
    if (!listEl) return;
    listEl.innerHTML = "";

    if (!entries.length) {
      listEl.innerHTML = `<div class="plugins-browser-empty">${escapeHtml(getViewEmptyState(view))}</div>`;
      return;
    }

    entries.forEach((entry) => {
      const row = document.createElement("article");
      row.className = "plugins-browser-card";

      const tags = entry.categories
        .slice(0, 3)
        .map((category) => `<span class="plugins-browser-tag">${escapeHtml(category)}</span>`)
        .join("");

      const metaParts = [];
      if (entry.author) metaParts.push(escapeHtml(entry.author));
      metaParts.push(escapeHtml(entry.id));
      if (entry.bundled) metaParts.push("Bundled");
      const meta = metaParts.join(" - ");
      const actionLabel = getActionLabel(entry, view);
      const pluginPanelTabId = getPluginPanelTabId(entry.id);
      const versionValue = escapeHtml(entry.installedVersion || entry.latestVersion || "v0.0.0");
      const secondaryValue = entry.hasUpdate
        ? `<span class="plugins-browser-version plugins-browser-version--update">Update ${escapeHtml(entry.latestVersion)}</span>`
        : "";

      row.innerHTML = `
        <div class="plugins-browser-card-media">
          <img class="plugins-browser-card-icon" alt="" src="${escapeHtml(entry.iconSrc || PLUGINS_ICON_DATA)}" />
        </div>
        <div class="plugins-browser-card-body">
          <div class="plugins-browser-card-heading">
            <div class="plugins-browser-card-title-wrap">
              <h3 class="plugins-browser-card-title">${escapeHtml(entry.name)}</h3>
              <span class="plugins-browser-version">${versionValue}</span>
              ${secondaryValue}
            </div>
          </div>
          <p class="plugins-browser-card-description">${escapeHtml(entry.description || "No description provided.")}</p>
          <div class="plugins-browser-card-meta">${meta}</div>
          ${tags ? `<div class="plugins-browser-card-tags">${tags}</div>` : ""}
        </div>
        <div class="plugins-browser-card-actions"></div>
      `;

      const actionsEl = row.querySelector(".plugins-browser-card-actions");
      if (!actionsEl) {
        listEl.appendChild(row);
        return;
      }

      const topActionsEl = document.createElement("div");
      topActionsEl.className = "plugins-browser-card-action-row";
      actionsEl.appendChild(topActionsEl);

      if (actionLabel) {
        const primaryAction = document.createElement("button");
        primaryAction.type = "button";
        primaryAction.className = `plugins-browser-action ${entry.hasUpdate ? "is-accent" : ""}`;
        primaryAction.textContent = actionLabel;
        if (entry.isInstalled && !entry.hasUpdate) {
          primaryAction.disabled = true;
          primaryAction.classList.add("is-disabled");
        } else {
          primaryAction.addEventListener("click", async () => {
            primaryAction.disabled = true;
            await runEntryAction(entry, "install-store", setStatus);
          });
        }
        topActionsEl.appendChild(primaryAction);
      }

      if (pluginPanelTabId) {
        const panelButton = document.createElement("button");
        panelButton.type = "button";
        panelButton.className = "plugins-browser-action is-panel";
        panelButton.textContent = "Open Panel";
        panelButton.addEventListener("click", () => {
          if (typeof onOpenPluginPanel === "function") {
            onOpenPluginPanel(pluginPanelTabId);
          }
        });
        topActionsEl.appendChild(panelButton);
      } else if (entry.isInstalled) {
        const panelSpacer = document.createElement("div");
        panelSpacer.className = "plugins-browser-action-spacer";
        panelSpacer.setAttribute("aria-hidden", "true");
        topActionsEl.appendChild(panelSpacer);
      }

      if (entry.isInstalled && !entry.bundled) {
        const uninstallButton = document.createElement("button");
        uninstallButton.type = "button";
        uninstallButton.className = "plugins-browser-icon-button is-danger";
        uninstallButton.innerHTML = TRASH_ICON;
        uninstallButton.setAttribute("aria-label", "Remove plugin");
        uninstallButton.title = "Remove plugin";
        uninstallButton.addEventListener("click", async () => {
          const confirmed = await confirmAction({
            title: "Remove Plugin",
            message: `Remove ${entry.name} from MIDIMaster?`,
            confirmLabel: "Remove",
            cancelLabel: "Cancel",
            confirmVariant: "danger",
          });
          if (!confirmed) {
            return;
          }
          uninstallButton.disabled = true;
          await runEntryAction(entry, "uninstall", setStatus);
        });
        topActionsEl.appendChild(uninstallButton);
      }

      if (entry.isInstalled) {
        const toggle = document.createElement("label");
        toggle.className = "plugins-toggle plugins-browser-toggle";
        toggle.title = entry.enabled ? "Disable plugin" : "Enable plugin";
        toggle.innerHTML = `
          <input type="checkbox" ${entry.enabled ? "checked" : ""} />
          <span class="plugins-toggle-ui" aria-hidden="true"></span>
        `;
        const input = toggle.querySelector("input");
        if (input) {
          input.addEventListener("change", async () => {
            input.disabled = true;
            await runEntryAction(entry, "toggle", setStatus);
          });
        }
        actionsEl.appendChild(toggle);
      } else {
        const toggleSpacer = document.createElement("div");
        toggleSpacer.className = "plugins-browser-toggle-spacer";
        toggleSpacer.setAttribute("aria-hidden", "true");
        actionsEl.appendChild(toggleSpacer);
      }

      listEl.appendChild(row);
    });
  }

  async function getPluginsBrowserSections() {
    const data = await loadBrowserData();
    return buildNavigationModel(buildEntries(data));
  }

  async function mountPluginsBrowserTab(container, options = {}) {
    const view = String(options.view || "installed");
    const label = String(options.label || "Plugins");
    const onOpenPluginPanel = (typeof options.onOpenPluginPanel === "function") ? options.onOpenPluginPanel : null;

    container.innerHTML = `
      <div class="plugins-browser">
        <div class="plugins-browser-toolbar">
          <label class="plugins-browser-search">
            <span class="plugins-browser-search-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="m21 21-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z"></path>
              </svg>
            </span>
            <input type="search" data-role="search" placeholder="Search plugins..." autocomplete="off" />
          </label>
          <div class="plugins-browser-toolbar-actions">
          <label class="plugins-browser-sort-wrap">
            <span class="plugins-browser-sort-label">Sort by</span>
            <select class="plugins-browser-sort" data-role="sort">
                <option value="name-asc">Name (A-Z)</option>
                <option value="name-desc">Name (Z-A)</option>
                <option value="updates-first">Updates first</option>
                <option value="version-desc">Newest version</option>
              </select>
            </label>
            <button type="button" class="plugins-browser-install" data-role="install-file">Add Plugin</button>
          </div>
        </div>
        <div class="plugins-browser-status hidden" data-role="status"></div>
        <div class="plugins-browser-scroll">
          <div class="plugins-browser-list" data-role="list"></div>
        </div>
        <div class="plugins-browser-footer" data-role="footer"></div>
      </div>
    `;

    const searchEl = container.querySelector('[data-role="search"]');
    const sortEl = container.querySelector('[data-role="sort"]');
    const statusEl = container.querySelector('[data-role="status"]');
    const listEl = container.querySelector('[data-role="list"]');
    const footerEl = container.querySelector('[data-role="footer"]');
    const installButton = container.querySelector('[data-role="install-file"]');
    const setStatus = createStatusSetter(statusEl);

    let model = null;
    const sortDropdown = createSelectDropdownShell({
      selectEl: sortEl,
      rootClass: "plugins-sort-dropdown",
      title: "Sort plugins",
    });

    const render = () => {
      if (!model || !listEl || !footerEl) return;
      const q = String(searchEl?.value || "").trim().toLowerCase();
      const sortValue = String(sortEl?.value || "name-asc");

      const baseEntries = getEntriesForView(model.entries, view);
      const filteredEntries = q
        ? baseEntries.filter((entry) => entry.searchText.includes(q))
        : baseEntries;
      const visibleEntries = sortEntries(filteredEntries, sortValue);

      renderPluginCards({ listEl, entries: visibleEntries, view, setStatus, onOpenPluginPanel });
      const noun = visibleEntries.length === 1 ? "plugin" : "plugins";
      footerEl.textContent = `${visibleEntries.length} of ${baseEntries.length} ${noun} shown in ${label}.`;

      renderNativeSelectDropdown({
        entry: sortDropdown,
        selectEl: sortEl,
        fallbackText: "Name (A-Z)",
        formatOptionText: (opt) => opt.textContent || "",
        truncateMenuLabels: false,
        truncateDisplayLabel: false,
      });
    };

    const load = async () => {
      model = null;
      setStatus("");
      if (listEl) {
        listEl.innerHTML = "<div class=\"plugins-browser-empty\">Loading plugins...</div>";
      }
      const data = await loadBrowserData();
      model = {
        ...data,
        entries: buildEntries(data),
      };
      if (data.storeError && view === "store") {
        setStatus(data.storeError, "error");
      }
      render();
    };

    if (searchEl) {
      searchEl.addEventListener("input", render);
    }
    if (sortEl) {
      sortEl.addEventListener("change", render);
    }
    if (installButton) {
      installButton.addEventListener("click", () => installPackageFromFile(setStatus));
    }

    load().catch((error) => {
      console.error("Failed to render plugins browser", error);
      setStatus("Failed to load plugins.", "error");
    });
  }

  return {
    preloadInstalledPlugins,
    preloadStoreCatalog,
    getPluginsBrowserSections,
    mountPluginsBrowserTab,
  };
}

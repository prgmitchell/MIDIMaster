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

export function createPluginsTabs({ invoke, getPluginHost, reloadPlugins }) {
  if (typeof invoke !== "function") {
    throw new Error("createPluginsTabs: invoke is required");
  }

  const getHost = (typeof getPluginHost === "function") ? getPluginHost : (() => null);
  const reload = (typeof reloadPlugins === "function") ? reloadPlugins : (async () => { });

  let installedCache = null;
  let installedCachePromise = null;
  const installedIconCache = new Map();

  async function warmInstalledIcons(plugins) {
    const list = Array.isArray(plugins) ? plugins : [];
    await Promise.all(list.map(async (p) => {
      try {
        if (!p || typeof p !== "object") return;
        const pluginId = String(p.id || "");
        const rel = p.icon ? String(p.icon) : "";
        if (!pluginId || !rel) return;
        const key = `${pluginId}:${rel}`;
        if (installedIconCache.has(key)) return;
        const b64 = await invoke("read_plugin_base64", { pluginId, relPath: rel, plugin_id: pluginId, rel_path: rel });
        const mime = guessMimeFromPath(rel);
        installedIconCache.set(key, `data:${mime};base64,${b64}`);
      } catch {
        // ignore
      }
    }));
  }

  async function preloadInstalledPlugins() {
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
    })();

    return installedCachePromise;
  }

  function renderInstalledPlugins(listEl, setStatus, plugins, refreshFn) {
    if (!listEl) return;
    listEl.innerHTML = "";

    const safe = Array.isArray(plugins) ? plugins : [];
    if (!safe.length) {
      listEl.innerHTML = "<div class=\"plugins-manager-loading\">No plugins found.</div>";
      return;
    }

    safe.forEach((p) => {
      if (!p || typeof p !== "object") return;
      const pluginId = String(p.id || "");
      const name = String(p.name || pluginId || "Plugin");
      const version = String(p.version || "");
      const enabled = p.enabled !== false;
      const bundled = Boolean(p.bundled);
      const iconRel = p.icon ? String(p.icon) : "";
      const iconKey = iconRel ? `${pluginId}:${iconRel}` : "";
      const host = getHost();
      const integrationIcon = host?.getIntegration?.(pluginId)?.icon_data || null;
      const iconSrc = (iconKey && installedIconCache.has(iconKey))
        ? installedIconCache.get(iconKey)
        : (integrationIcon || PLUGINS_ICON_DATA);

      const row = document.createElement("div");
      row.className = "plugins-manager-row";
      row.innerHTML = `
        <div class="plugins-manager-row-left">
          <img class="connection-icon" alt="" src="${iconSrc || ""}" />
          <div class="plugins-manager-row-text">
            <div class="plugins-manager-row-name">${name}</div>
            <div class="plugins-manager-row-meta">${pluginId}${version ? ` - ${version}` : ""}${bundled ? " - Bundled" : ""}</div>
          </div>
        </div>
        <div class="plugins-manager-row-actions">
          ${bundled ? "" : "<button type=\"button\" class=\"connection-status plugins-manager-uninstall\" data-role=\"uninstall\" aria-label=\"Uninstall\" title=\"Uninstall\">×</button>"}
          <label class="plugins-toggle" title="Enable plugin">
            <input type="checkbox" data-role="enabled" ${enabled ? "checked" : ""} />
            <span class="plugins-toggle-ui" aria-hidden="true"></span>
          </label>
        </div>
      `;

      const enabledInput = row.querySelector('[data-role="enabled"]');
      const uninstallBtn = row.querySelector('[data-role="uninstall"]');

      if (enabledInput) {
        enabledInput.addEventListener("change", async () => {
          const nextEnabled = Boolean(enabledInput.checked);
          try {
            await invoke("set_plugin_enabled", { pluginId, enabled: nextEnabled, plugin_id: pluginId });
          } catch (e) {
            console.error("Failed to update plugin enabled state", e);
            setStatus("Failed to update plugin state.", "error");
          }
          await reload();
          await (typeof refreshFn === "function" ? refreshFn() : Promise.resolve());
        });
      }

      if (uninstallBtn && !bundled) {
        let awaitingConfirm = false;
        let confirmTimer = null;
        const resetConfirm = () => {
          awaitingConfirm = false;
          if (confirmTimer) {
            clearTimeout(confirmTimer);
            confirmTimer = null;
          }
          uninstallBtn.textContent = "×";
        };

        uninstallBtn.addEventListener("click", async () => {
          if (!awaitingConfirm) {
            awaitingConfirm = true;
            uninstallBtn.textContent = "?";
            confirmTimer = setTimeout(resetConfirm, 2500);
            return;
          }
          resetConfirm();
          try {
            await invoke("uninstall_plugin", { pluginId, plugin_id: pluginId });
            setStatus(`Uninstalled ${name}.`, "success");
          } catch (e) {
            console.error("Failed to uninstall plugin", e);
            setStatus("Failed to uninstall plugin.", "error");
          }
          await reload();
          await (typeof refreshFn === "function" ? refreshFn() : Promise.resolve());
        });
      }

      listEl.appendChild(row);
    });
  }

  function mountPluginsManagerTab(container) {
    container.innerHTML = `
      <div class="plugins-manager">
        <div class="connection-item-header plugins-manager-header">
          <div class="connection-info">
            <img src="${PLUGINS_ICON_DATA}" alt="" class="connection-icon" />
            <span class="connection-name">Installed</span>
          </div>
          <button type="button" class="connection-status plugins-manager-add" data-role="install" aria-label="Install plugin" title="Install plugin">
            <span class="plugins-manager-add-plus">+</span>
          </button>
        </div>
        <div class="plugins-manager-status" data-role="status"></div>
        <div class="plugins-manager-list" data-role="list"></div>
      </div>
    `;

    const installBtn = container.querySelector('[data-role="install"]');
    const listEl = container.querySelector('[data-role="list"]');
    const statusEl = container.querySelector('[data-role="status"]');

    const setStatus = (text, kind = "") => {
      if (!statusEl) return;
      statusEl.textContent = text || "";
      statusEl.classList.toggle("error", kind === "error");
      statusEl.classList.toggle("success", kind === "success");
      statusEl.classList.toggle("hidden", !text);
    };

    const refresh = async () => {
      if (!listEl) return;
      setStatus("");
      let plugins = [];
      try {
        plugins = await invoke("list_plugins");
        if (!Array.isArray(plugins)) plugins = [];
      } catch {
        plugins = [];
      }

      installedCache = plugins;
      warmInstalledIcons(plugins).catch(() => { });
      renderInstalledPlugins(listEl, setStatus, plugins, refresh);
    };

    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        const file = await pickMidimasterPackageFile();
        if (!file) return;
        try {
          const buf = await file.arrayBuffer();
          const b64 = arrayBufferToBase64(buf);
          await invoke("install_plugin_package", {
            filename: file.name,
            bytesBase64: b64,
            bytes_base64: b64,
          });
          setStatus(`Installed ${file.name}.`, "success");
        } catch (e) {
          console.error("Failed to install plugin package", e);
          setStatus("Failed to install plugin. Check the package file and try again.", "error");
        }

        await reload();
        await refresh();
      });
    }

    // Render from cache instantly if available.
    if (installedCache) {
      renderInstalledPlugins(listEl, setStatus, installedCache, refresh);
    }
    refresh().catch(() => { });
  }

  function mountPluginsStoreTab(container) {
    container.innerHTML = `
      <div class="connection-item-header">
        <div class="connection-info">
          <img src="${PLUGINS_ICON_DATA}" alt="" class="connection-icon" />
          <span class="connection-name">Store</span>
        </div>
        <div class="connection-status">
          <span class="connection-status-dot connected"></span>
          <span>Official</span>
        </div>
      </div>
      <div class="plugins-store">
        <div class="plugins-store-toolbar">
          <input class="plugins-store-search" type="text" placeholder="Search plugins" data-role="q" />
        </div>
        <div class="plugins-store-status hidden" data-role="status"></div>
        <div class="plugins-store-list" data-role="list"></div>
      </div>
    `;

    const qEl = container.querySelector('[data-role="q"]');
    const statusEl = container.querySelector('[data-role="status"]');
    const listEl = container.querySelector('[data-role="list"]');

    const setStatus = (text, kind = "") => {
      if (!statusEl) return;
      statusEl.textContent = text || "";
      statusEl.classList.toggle("hidden", !text);
      statusEl.classList.toggle("error", kind === "error");
      statusEl.classList.toggle("success", kind === "success");
    };

    let catalog = null;
    let installed = [];

    function render() {
      if (!listEl) return;
      const q = (qEl?.value || "").trim().toLowerCase();
      const plugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
      const filtered = q
        ? plugins.filter((p) => {
          const name = String(p?.name || "").toLowerCase();
          const id = String(p?.id || "").toLowerCase();
          const author = String(p?.author || "").toLowerCase();
          return name.includes(q) || id.includes(q) || author.includes(q);
        })
        : plugins;

      if (!filtered.length) {
        listEl.innerHTML = "<div class=\"plugins-store-empty\">No plugins found.</div>";
        return;
      }

      const installedMap = new Map(installed.map((p) => [String(p.id || ""), p]));
      listEl.innerHTML = "";
      filtered.forEach((p) => {
        if (!p || typeof p !== "object") return;
        const id = String(p.id || "");
        const name = String(p.name || id);
        const author = p.author ? String(p.author) : "";
        const desc = p.description ? String(p.description) : "";
        const latestV = String(p.latest?.version || "");

        const inst = installedMap.get(id);
        const installedV = inst ? String(inst.version || "") : "";
        const hasUpdate = inst && isUpdateAvailable(installedV, latestV);

        const row = document.createElement("div");
        row.className = "plugins-store-row";
        row.innerHTML = `
          <div class="plugins-store-row-left">
            <div class="plugins-store-row-text">
              <div class="plugins-store-row-name">${name}</div>
              <div class="plugins-store-row-meta">${id}${author ? ` - ${author}` : ""}${latestV ? ` - v${latestV}` : ""}</div>
              ${desc ? `<div class=\"plugins-store-row-desc\">${desc}</div>` : ""}
            </div>
          </div>
          <div class="plugins-store-row-actions">
            <button type="button" class="connection-button" data-role="install">${inst ? (hasUpdate ? "Update" : "Installed") : "Install"}</button>
          </div>
        `;

        const btn = row.querySelector('[data-role="install"]');
        if (btn) {
          if (inst && !hasUpdate) {
            btn.disabled = true;
            btn.classList.add("disabled");
          } else {
            btn.addEventListener("click", async () => {
              btn.disabled = true;
              btn.classList.add("disabled");
              try {
                await invoke("install_store_plugin", { pluginId: id, plugin_id: id });
                setStatus(`Installed ${name}.`, "success");
                await reload();
                await loadInstalled();
                render();
              } catch (e) {
                console.error("Store install failed", e);
                setStatus("Install failed. The package may be untrusted or unavailable.", "error");
              } finally {
                btn.disabled = false;
                btn.classList.remove("disabled");
              }
            });
          }
        }

        listEl.appendChild(row);
      });
    }

    async function loadInstalled() {
      try {
        const p = await invoke("list_plugins");
        installed = Array.isArray(p) ? p : [];
      } catch {
        installed = [];
      }
    }

    async function loadCatalog() {
      setStatus("");
      if (listEl) {
        listEl.innerHTML = "<div class=\"plugins-store-empty\">Loading...</div>";
      }
      try {
        catalog = await invoke("fetch_store_catalog");
      } catch (e) {
        console.error("Failed to fetch store catalog", e);
        catalog = { plugins: [] };
        setStatus("Could not load store catalog.", "error");
      }
    }

    if (qEl) {
      qEl.addEventListener("input", () => render());
    }

    Promise.resolve()
      .then(loadCatalog)
      .then(loadInstalled)
      .then(render)
      .catch(() => { });
  }

  return { mountPluginsManagerTab, mountPluginsStoreTab, preloadInstalledPlugins };
}

// Runtime plugin host for MIDIMaster.
//
// Goals (v1):
// - Load plugin JS modules from the app config directory via backend commands.
// - Provide a small, stable API surface to plugins.
// - Dispatch integration binding triggers to the right integration handler.
//
// This file intentionally avoids any framework/bundler assumptions.

export function createPluginHost({ invoke, listen, onUpdatePluginSettings, onInvalidateBindingsUI }) {
  const integrations = new Map();
  const plugins = new Map();

  const connectionTabs = new Map();

  // Active profile state (pushed in by the host app).
  let profileState = { name: null, plugin_settings: {} };
  const profileChangedHandlers = new Set();

  function setProfileState(next) {
    const name = (next && typeof next === "object") ? (next.name || null) : null;
    const plugin_settings = (next && typeof next === "object") ? (next.plugin_settings || {}) : {};
    profileState = {
      name,
      plugin_settings: (plugin_settings && typeof plugin_settings === "object") ? plugin_settings : {},
    };
    profileChangedHandlers.forEach((h) => {
      try { h(profileState); } catch { }
    });
  }

  let bindingsSnapshot = [];
  const bindingsChangedHandlers = new Set();

  // WebSocket bridge helpers
  const wsMessageHandlers = new Map(); // id -> Set(fn)
  let wsListenersBound = false;
  let wsMessageUnlisten = null;
  let wsClosedUnlisten = null;
  let triggerListenerUnlisten = null;

  function registerIntegration(integration) {
    if (!integration || typeof integration !== "object") {
      throw new Error("registerIntegration: integration must be an object");
    }
    if (!integration.id || typeof integration.id !== "string") {
      throw new Error("registerIntegration: integration.id must be a string");
    }
    integrations.set(integration.id, integration);
  }

  function getIntegration(id) {
    return integrations.get(id) || null;
  }

  function getIntegrations() {
    return Array.from(integrations.values());
  }

  function registerConnectionTab(tab) {
    if (!tab || typeof tab !== "object") {
      throw new Error("registerConnectionTab: tab must be an object");
    }
    if (!tab.id || typeof tab.id !== "string") {
      throw new Error("registerConnectionTab: tab.id must be a string");
    }
    if (!tab.name || typeof tab.name !== "string") {
      throw new Error("registerConnectionTab: tab.name must be a string");
    }
    if (typeof tab.mount !== "function") {
      throw new Error("registerConnectionTab: tab.mount must be a function");
    }
    connectionTabs.set(tab.id, {
      id: tab.id,
      name: tab.name,
      icon_data: tab.icon_data || null,
      order: Number.isFinite(tab.order) ? tab.order : 100,
      mount: tab.mount,
      unmount: typeof tab.unmount === "function" ? tab.unmount : null,
    });
  }

  function getConnectionTabs() {
    return Array.from(connectionTabs.values()).sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
  }

  function setBindings(nextBindings) {
    if (!Array.isArray(nextBindings)) {
      nextBindings = [];
    }
    bindingsSnapshot = nextBindings;
    bindingsChangedHandlers.forEach((fn) => {
      try { fn(bindingsSnapshot); } catch (e) { }
    });
  }

  async function loadInstalledPlugins() {
    const manifests = await invoke("list_plugins");
    if (!Array.isArray(manifests)) {
      return [];
    }
    const loaded = [];
    for (const manifest of manifests) {
      if (!manifest || typeof manifest !== "object") continue;
      if (manifest.enabled === false) continue;
      const pluginId = String(manifest.id || "");
      const entry = String(manifest.entry || "");
      if (!pluginId || !entry) continue;
      try {
        // Tauri JS invoke expects camelCase keys for command arguments.
        const code = await invoke("read_plugin_text", {
          pluginId,
          relPath: entry,
          // Keep snake_case for compatibility (harmless if ignored)
          plugin_id: pluginId,
          rel_path: entry,
        });
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        const mod = await import(url);
        URL.revokeObjectURL(url);

        console.log(`[plugins] loaded module ${pluginId}`);

        const activate = mod.activate || mod.default;
        if (typeof activate !== "function") {
          console.warn(`Plugin ${pluginId} has no activate() export`);
          continue;
        }

        const ctx = {
          pluginId,
          registerIntegration,
          connections: {
            registerTab: registerConnectionTab,
          },
          app: {
            invalidateBindingsUI: () => {
              try {
                if (typeof onInvalidateBindingsUI === "function") {
                  onInvalidateBindingsUI();
                }
              } catch { }
            },
          },
          profile: {
            get: () => {
              const s = profileState?.plugin_settings?.[pluginId];
              return (s && typeof s === "object") ? s : {};
            },
            set: async (nextSettings) => {
              if (typeof onUpdatePluginSettings === "function") {
                await onUpdatePluginSettings(pluginId, nextSettings);
              }
              // Update local snapshot immediately so the UI feels responsive.
              try {
                const copy = { ...(profileState.plugin_settings || {}) };
                copy[pluginId] = nextSettings;
                setProfileState({ name: profileState.name, plugin_settings: copy });
              } catch { }
            },
            onChanged: (handler) => {
              if (typeof handler !== "function") return () => { };
              const wrapped = (state) => {
                const s = state?.plugin_settings?.[pluginId];
                handler({ profile_name: state?.name || null, settings: (s && typeof s === "object") ? s : {} });
              };
              profileChangedHandlers.add(wrapped);
              try { wrapped(profileState); } catch { }
              return () => profileChangedHandlers.delete(wrapped);
            },
          },
          assets: {
            readBase64: (relPath) => invoke("read_plugin_base64", {
              pluginId,
              relPath,
              // Compatibility
              plugin_id: pluginId,
              rel_path: relPath,
            }),
            readDataUrl: async (relPath, mime = null) => {
              const b64 = await invoke("read_plugin_base64", {
                pluginId,
                relPath,
                // Compatibility
                plugin_id: pluginId,
                rel_path: relPath,
              });
              const safeMime = mime || "application/octet-stream";
              return `data:${safeMime};base64,${b64}`;
            },
          },
          tauri: { invoke, listen },
          bindings: {
            getAll: () => bindingsSnapshot,
            onChanged: (handler) => {
              bindingsChangedHandlers.add(handler);
              return () => bindingsChangedHandlers.delete(handler);
            },
          },
          feedback: {
            set: (bindingId, value, action = null, opts = null) => {
              const silent = (typeof opts === "boolean")
                ? opts
                : (opts && typeof opts === "object" ? Boolean(opts.silent) : false);
              return invoke("set_binding_feedback", {
                bindingId,
                value,
                action,
                silent,
                // Compatibility
                binding_id: bindingId,
              });
            },
          },
          ws: {
            open: (url, headers = {}, connectTimeoutMs = 500) => invoke("ws_open", {
              url,
              headers,
              connectTimeoutMs,
              // Compatibility
              connect_timeout_ms: connectTimeoutMs,
            }),
            send: (id, text) => invoke("ws_send", { id, text }),
            close: (id) => invoke("ws_close", { id }),
            onMessage: (id, handler) => {
              if (!wsMessageHandlers.has(id)) {
                wsMessageHandlers.set(id, new Set());
              }
              wsMessageHandlers.get(id).add(handler);
              return () => wsMessageHandlers.get(id)?.delete(handler);
            },
          },
        };

        const api = await activate(ctx);

        console.log(`[plugins] activated ${pluginId}`);
        plugins.set(pluginId, { manifest, api });
        loaded.push({ pluginId, manifest });
      } catch (err) {
        console.error(`Failed to load plugin ${pluginId}`, err);
      }
    }
    return loaded;
  }

  async function bindWsListeners() {
    if (wsListenersBound) return;
    wsListenersBound = true;

    wsMessageUnlisten = await listen("ws_message", (event) => {
      let payload = event?.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { payload = null; }
      }
      if (!payload || typeof payload !== "object") return;
      const id = payload.id;
      const handlers = wsMessageHandlers.get(id);
      if (!handlers || handlers.size === 0) return;
      handlers.forEach((fn) => {
        try { fn(payload); } catch (e) { }
      });
    });

    wsClosedUnlisten = await listen("ws_closed", (event) => {
      let payload = event?.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { payload = null; }
      }
      const id = payload?.id;
      if (id != null) {
        wsMessageHandlers.delete(id);
      }
    });
  }

  async function start() {
    await bindWsListeners();
    if (triggerListenerUnlisten) return;
    triggerListenerUnlisten = await listen("integration_binding_triggered", async (event) => {
      let payload = event?.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { payload = null; }
      }
      if (!payload || typeof payload !== "object") return;
      const target = payload.target;
      if (!target || typeof target !== "object") return;
      const integrationId = target.integration_id;
      if (!integrationId) return;
      const integration = getIntegration(integrationId);
      if (!integration || typeof integration.onBindingTriggered !== "function") return;
      try {
        await integration.onBindingTriggered(payload);
      } catch (err) {
        console.error(`Integration ${integrationId} trigger failed`, err);
      }
    });
  }

  async function stop() {
    if (triggerListenerUnlisten) {
      try { await triggerListenerUnlisten(); } catch { }
      triggerListenerUnlisten = null;
    }

    if (wsMessageUnlisten) {
      try { await wsMessageUnlisten(); } catch { }
      wsMessageUnlisten = null;
    }
    if (wsClosedUnlisten) {
      try { await wsClosedUnlisten(); } catch { }
      wsClosedUnlisten = null;
    }
    wsListenersBound = false;
  }

  return {
    registerIntegration,
    getIntegration,
    getIntegrations,
    getConnectionTabs,
    setProfileState,
    loadInstalledPlugins,
    start,
    stop,
    setBindings,
  };
}

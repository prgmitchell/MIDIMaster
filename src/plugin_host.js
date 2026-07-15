// Runtime plugin host for MIDIMaster.
//
// Goals (v1):
// - Load plugin JS modules from the app config directory via backend commands.
// - Provide a small, stable API surface to plugins.
// - Dispatch integration binding triggers to the right integration handler.
//
// This file intentionally avoids any framework/bundler assumptions.

export function createPluginHost({ invoke, listen, onUpdatePluginSettings, onInvalidateBindingsUI, showAlert, showConfirm }) {
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
  let triggerBatchListenerUnlisten = null;

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

  function createPluginCleanup(pluginId) {
    let disposed = false;
    const disposers = new Set();
    const pendingDisposers = new Set();
    const wsIds = new Set();

    function addDisposer(disposer) {
      if (typeof disposer !== "function") return () => { };
      let active = true;
      const wrapped = async () => {
        if (!active) return;
        active = false;
        disposers.delete(wrapped);
        try { await disposer(); } catch (err) {
          console.warn(`[plugins] cleanup failed for ${pluginId}`, err);
        }
      };
      if (disposed) {
        wrapped();
        return wrapped;
      }
      disposers.add(wrapped);
      return wrapped;
    }

    function trackListener(unlistenPromise) {
      let tracked = null;
      tracked = Promise.resolve(unlistenPromise)
        .then((unlisten) => addDisposer(unlisten))
        .finally(() => {
          pendingDisposers.delete(tracked);
        });
      pendingDisposers.add(tracked);
      return tracked;
    }

    async function closeTrackedSockets() {
      const ids = Array.from(wsIds);
      wsIds.clear();
      for (const id of ids) {
        wsMessageHandlers.delete(id);
        try { await invoke("ws_close", { id }); } catch { }
      }
    }

    async function dispose(api = null) {
      if (disposed) return;
      disposed = true;

      const apiDisposers = [];
      if (api && typeof api.dispose === "function") apiDisposers.push(api.dispose);
      if (api && typeof api.stop === "function" && api.stop !== api.dispose) apiDisposers.push(api.stop);
      for (const fn of apiDisposers) {
        try { await fn.call(api); } catch (err) {
          console.warn(`[plugins] api cleanup failed for ${pluginId}`, err);
        }
      }

      if (pendingDisposers.size > 0) {
        await Promise.allSettled(Array.from(pendingDisposers));
      }

      const cleanupFns = Array.from(disposers);
      disposers.clear();
      for (const fn of cleanupFns) {
        await fn();
      }

      await closeTrackedSockets();
    }

    return {
      onDispose: (handler) => addDisposer(handler),
      trackListener,
      trackWs: (id) => {
        if (id == null) return;
        if (disposed) {
          wsMessageHandlers.delete(id);
          invoke("ws_close", { id }).catch(() => { });
          return;
        }
        wsIds.add(id);
      },
      forgetWs: (id) => {
        wsIds.delete(id);
        wsMessageHandlers.delete(id);
      },
      dispose,
    };
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
      let cleanup = null;
      let api = null;
      try {
        if (plugins.has(pluginId)) {
          const previous = plugins.get(pluginId);
          await previous?.cleanup?.dispose?.(previous.api);
          plugins.delete(pluginId);
        }
        cleanup = createPluginCleanup(pluginId);
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
            showAlert: (title, message = "") => {
              if (typeof showAlert !== "function") {
                return Promise.resolve();
              }
              return Promise.resolve(showAlert(title, message)).catch(() => {});
            },
            showConfirm: (options = {}) => {
              if (typeof showConfirm !== "function") {
                return Promise.resolve(false);
              }
              return Promise.resolve(showConfirm(options)).then(Boolean).catch(() => false);
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
              return cleanup.onDispose(() => profileChangedHandlers.delete(wrapped));
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
          lifecycle: {
            onDispose: (handler) => cleanup.onDispose(handler),
          },
          tauri: {
            invoke,
            listen: (eventName, handler) => cleanup.trackListener(listen(eventName, handler)),
          },
          bindings: {
            getAll: () => bindingsSnapshot,
            onChanged: (handler) => {
              if (typeof handler !== "function") return () => { };
              bindingsChangedHandlers.add(handler);
              return cleanup.onDispose(() => bindingsChangedHandlers.delete(handler));
            },
          },
          feedback: {
            set: (bindingId, value, action = null, opts = null) => {
              const silent = (typeof opts === "boolean")
                ? opts
                : (opts && typeof opts === "object" ? Boolean(opts.silent) : false);
              const inputValue = (opts && typeof opts === "object" && typeof opts.inputValue === "number")
                ? opts.inputValue
                : ((opts && typeof opts === "object" && typeof opts.input_value === "number") ? opts.input_value : null);
              const forceHardwareFeedback = Boolean(
                opts && typeof opts === "object" && (
                  opts.forceHardwareFeedback ||
                  opts.force_hardware_feedback ||
                  opts.force === true
                )
              );
              return invoke("set_binding_feedback", {
                bindingId,
                value,
                action,
                silent,
                inputValue,
                forceHardwareFeedback,
                // Compatibility
                binding_id: bindingId,
                input_value: inputValue,
                force_hardware_feedback: forceHardwareFeedback,
              });
            },
          },
          ws: {
            open: async (url, headers = {}, connectTimeoutMs = 500) => {
              const id = await invoke("ws_open", {
                url,
                headers,
                connectTimeoutMs,
                // Compatibility
                connect_timeout_ms: connectTimeoutMs,
              });
              cleanup.trackWs(id);
              return id;
            },
            send: (id, text) => invoke("ws_send", { id, text }),
            close: async (id) => {
              cleanup.forgetWs(id);
              return invoke("ws_close", { id });
            },
            onMessage: (id, handler) => {
              if (!wsMessageHandlers.has(id)) {
                wsMessageHandlers.set(id, new Set());
              }
              wsMessageHandlers.get(id).add(handler);
              return cleanup.onDispose(() => wsMessageHandlers.get(id)?.delete(handler));
            },
          },
          http: {
            postJson: (url, body, opts = null) => invoke("plugin_http_post_json", {
              url,
              body: (body && typeof body === "object") ? body : {},
              timeoutMs: (opts && typeof opts === "object" && Number.isFinite(Number(opts.timeoutMs)))
                ? Number(opts.timeoutMs)
                : null,
            }),
          },
        };

        api = await activate(ctx);

        console.log(`[plugins] activated ${pluginId}`);
        plugins.set(pluginId, { manifest, api, cleanup });
        loaded.push({ pluginId, manifest });
      } catch (err) {
        await cleanup?.dispose?.(api);
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
    if (triggerListenerUnlisten || triggerBatchListenerUnlisten) return;
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

    triggerBatchListenerUnlisten = await listen("integration_binding_triggered_batch", async (event) => {
      let payload = event?.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { payload = null; }
      }
      if (!payload || typeof payload !== "object") return;

      const targets = Array.isArray(payload.targets) ? payload.targets : [];
      if (targets.length === 0) return;

      const integrationId = String(
        payload.integration_id
        || targets[0]?.target?.integration_id
        || targets[0]?.integration_id
        || "",
      );
      if (!integrationId) return;

      const integration = getIntegration(integrationId);
      if (!integration) return;

      if (typeof integration.onBindingTriggeredBatch === "function") {
        try {
          await integration.onBindingTriggeredBatch(payload);
        } catch (err) {
          console.error(`Integration ${integrationId} batch trigger failed`, err);
        }
        return;
      }

      if (typeof integration.onBindingTriggered !== "function") return;

      for (let index = 0; index < targets.length; index += 1) {
        const targetEntry = targets[index];
        const target = targetEntry?.target || targetEntry;
        if (!target || typeof target !== "object") continue;
        try {
          await integration.onBindingTriggered({
            ...payload,
            target,
            target_index: Number(targetEntry?.target_index ?? index),
            target_count: Number(targetEntry?.target_count ?? targets.length),
            is_primary_target: targetEntry?.is_primary_target === true,
            original_target_index: Number(targetEntry?.original_target_index ?? targetEntry?.target_index ?? index),
          });
        } catch (err) {
          console.error(`Integration ${integrationId} trigger failed`, err);
          break;
        }
      }
    });
  }

  async function stop() {
    for (const tab of connectionTabs.values()) {
      if (typeof tab.unmount === "function") {
        try { await tab.unmount(); } catch { }
      }
    }

    const pluginEntries = Array.from(plugins.values());
    for (const plugin of pluginEntries) {
      await plugin.cleanup?.dispose?.(plugin.api);
    }
    plugins.clear();
    integrations.clear();
    connectionTabs.clear();
    profileChangedHandlers.clear();
    bindingsChangedHandlers.clear();
    wsMessageHandlers.clear();

    if (triggerListenerUnlisten) {
      try { await triggerListenerUnlisten(); } catch { }
      triggerListenerUnlisten = null;
    }
    if (triggerBatchListenerUnlisten) {
      try { await triggerBatchListenerUnlisten(); } catch { }
      triggerBatchListenerUnlisten = null;
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

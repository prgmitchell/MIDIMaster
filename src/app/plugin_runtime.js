import { createPluginHost } from "../plugin_host.js";
import { createPluginDisplayMetadataCache } from "./plugin_display_metadata.js";

export function mergePersistentIntegrationDisplayMetadata(dataValue, description = null) {
  const data = dataValue && typeof dataValue === "object" ? dataValue : {};
  let nextLabel = typeof data.label === "string" ? data.label : "";
  for (const suffix of [" (Unavailable)", " (Connecting...)", " (Disconnected)"]) {
    if (nextLabel.endsWith(suffix)) nextLabel = nextLabel.slice(0, -suffix.length);
  }
  if (!nextLabel.trim() && typeof description?.label === "string") {
    nextLabel = description.label.trim();
  }

  if (nextLabel === (typeof data.label === "string" ? data.label : "")) {
    return data;
  }
  return { ...data, label: nextLabel };
}

export function createPluginRuntime({
  invoke,
  listen,
  isOsdWindow,
  getActiveProfileName,
  getProfilePluginSettings,
  getBindings,
  getProfilesFeature,
  getBindingsFeature,
  getConnectionsPanel,
  getBindingTargets,
  setBindingTargets,
  saveBindingsForProfile,
  isBindingInteractionActive,
  requestBindingsRerender,
  mountConnectionsTabs,
  showAlert,
  showConfirm,
}) {
  let pluginHost = null;
  let pluginHostStarted = false;
  let bindingsInvalidationSuppressed = false;
  let disposed = false;
  let invalidationTimer = null;
  const displayMetadata = createPluginDisplayMetadataCache({ invoke });

  function getPluginHost() {
    return pluginHost;
  }

  function setPluginHost(next) {
    pluginHost = next;
    if (!next) {
      pluginHostStarted = false;
      displayMetadata.invalidate();
    }
  }

  function preloadPluginManifests() {
    return displayMetadata.loadManifests();
  }

  async function preloadBindingDisplayMetadata() {
    const integrationIds = new Set();
    const bindings = getBindings();
    for (const binding of Array.isArray(bindings) ? bindings : []) {
      for (const target of getBindingTargets(binding)) {
        const integration = target?.Integration || target?.integration;
        if (integration?.integration_id) {
          integrationIds.add(String(integration.integration_id));
        }
      }
    }
    await displayMetadata.warmIntegrationIcons(integrationIds);
  }

  function getIntegrationDisplayMetadata(integrationId) {
    return displayMetadata.getIntegrationDisplayMetadata(integrationId);
  }

  async function startPluginHostIfNeeded(options = {}) {
    if (isOsdWindow || disposed) return { started: false, metadataChanged: false };
    const suppressInitialBindingsInvalidation = Boolean(options?.suppressInitialBindingsInvalidation);
    const wasStarted = pluginHostStarted;
    const shouldSuppressInvalidation = suppressInitialBindingsInvalidation && !pluginHostStarted;
    let metadataChanged = false;

    if (!pluginHost) {
      pluginHost = createPluginHost({
        invoke,
        listen,
        onUpdatePluginSettings: updateProfilePluginSettings,
        onInvalidateBindingsUI: createBindingsInvalidator(),
        showAlert,
        showConfirm,
      });
    }

    if (shouldSuppressInvalidation) {
      bindingsInvalidationSuppressed = true;
    }

    try {
      try {
        pluginHost.setProfileState({
          name: getActiveProfileName() || localStorage.getItem("activeProfileName") || "Default",
          plugin_settings: getProfilePluginSettings() || {},
        });
      } catch {}

      if (!pluginHostStarted) {
        let manifests = null;
        try {
          manifests = await preloadPluginManifests();
        } catch {}
        if (disposed) return { started: false, metadataChanged: false };
        await pluginHost.loadInstalledPlugins(manifests).catch(() => {});
        if (disposed) {
          await pluginHost.stop();
          return { started: false, metadataChanged: false };
        }
        await pluginHost.start().catch(() => {});
        if (disposed) {
          await pluginHost.stop();
          return { started: false, metadataChanged: false };
        }
        pluginHostStarted = true;
      }

      try {
        pluginHost.setBindings(getBindings());
      } catch {}

      try {
        metadataChanged = hydrateIntegrationDisplayMetadata();
        if (metadataChanged) {
          try {
            pluginHost.setBindings(getBindings());
          } catch {}
          await saveBindingsForProfile();
        }
      } catch {}

      try {
        const connectionsPanel = getConnectionsPanel();
        if (connectionsPanel && !connectionsPanel.classList.contains("hidden")) {
          mountConnectionsTabs({ force: true });
        }
      } catch {}
    } finally {
      if (shouldSuppressInvalidation) {
        bindingsInvalidationSuppressed = false;
      }
    }

    return { started: !wasStarted && pluginHostStarted, metadataChanged };
  }

  function createBindingsInvalidator() {
    return () => {
      if (bindingsInvalidationSuppressed || disposed) return;
      if (invalidationTimer) return;
      invalidationTimer = setTimeout(() => {
        invalidationTimer = null;
        try {
          if (getBindingsFeature()?.isInlineNameEditingActive?.()) {
            requestBindingsRerender("plugin_invalidate");
            return;
          }
          if (isBindingInteractionActive()) {
            return;
          }
          requestBindingsRerender("plugin_invalidate");
        } catch {}
      }, 75);
    };
  }

  function hydrateIntegrationDisplayMetadata() {
    const bindings = getBindings();
    if (!Array.isArray(bindings) || !bindings.length) return false;
    let changed = false;

    for (const b of bindings) {
      const targets = getBindingTargets(b);
      let updatedAny = false;
      const nextTargets = targets.map((t) => {
        const integ = t?.Integration || t?.integration;
        if (!integ || typeof integ !== "object" || !integ.integration_id) return t;
        const data = integ.data && typeof integ.data === "object" ? integ.data : {};

        const hasLabel = typeof data.label === "string" && data.label.trim().length > 0;
        let desc = null;
        if (!hasLabel) {
          try {
            const handler = pluginHost?.getIntegration?.(integ.integration_id);
            if (handler && typeof handler.describeTarget === "function") {
              desc = handler.describeTarget({ Integration: integ });
            }
          } catch {
            desc = null;
          }
        }
        const next = mergePersistentIntegrationDisplayMetadata(data, desc);
        if (next !== data) {
          updatedAny = true;
          return {
            Integration: {
              integration_id: String(integ.integration_id),
              kind: String(integ.kind || ""),
              data: next,
            },
          };
        }
        return t;
      });

      if (updatedAny) {
        setBindingTargets(b, nextTargets);
        changed = true;
      }
    }

    return changed;
  }

  async function updateProfilePluginSettings(pluginId, nextSettings) {
    return getProfilesFeature().updateProfilePluginSettings(pluginId, nextSettings);
  }

  return {
    dispose: async () => {
      disposed = true;
      clearTimeout(invalidationTimer);
      invalidationTimer = null;
      await pluginHost?.stop?.();
    },
    getPluginHost,
    setPluginHost,
    startPluginHostIfNeeded,
    updateProfilePluginSettings,
    hydrateIntegrationDisplayMetadata,
    preloadPluginManifests,
    preloadBindingDisplayMetadata,
    getIntegrationDisplayMetadata,
  };
}

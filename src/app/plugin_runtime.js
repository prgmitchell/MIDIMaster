import { createPluginHost } from "../plugin_host.js";
import { createPluginDisplayMetadataCache } from "./plugin_display_metadata.js";

export function mergePersistentIntegrationDisplayMetadata(dataValue, description = null) {
  const data = (dataValue && typeof dataValue === "object") ? dataValue : {};
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
  setActiveProfileName,
  getProfilePluginSettings,
  setProfilePluginSettings,
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
    if (isOsdWindow) return { started: false, metadataChanged: false };
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
      } catch { }

      if (!pluginHostStarted) {
        let manifests = null;
        try {
          manifests = await preloadPluginManifests();
        } catch { }
        await pluginHost.loadInstalledPlugins(manifests).catch(() => { });
        await pluginHost.start().catch(() => { });
        pluginHostStarted = true;
      }

      try {
        pluginHost.setBindings(getBindings());
      } catch { }

      try {
        metadataChanged = hydrateIntegrationDisplayMetadata();
        if (metadataChanged) {
          try { pluginHost.setBindings(getBindings()); } catch { }
          await saveBindingsForProfile();
        }
      } catch { }

      try {
        const connectionsPanel = getConnectionsPanel();
        if (connectionsPanel && !connectionsPanel.classList.contains("hidden")) {
          mountConnectionsTabs({ force: true });
        }
      } catch { }
    } finally {
      if (shouldSuppressInvalidation) {
        bindingsInvalidationSuppressed = false;
      }
    }

    return { started: !wasStarted && pluginHostStarted, metadataChanged };
  }

  function createBindingsInvalidator() {
    let t = null;
    return () => {
      if (bindingsInvalidationSuppressed) return;
      if (t) return;
      t = setTimeout(() => {
        t = null;
        try {
          if (getBindingsFeature()?.isInlineNameEditingActive?.()) {
            requestBindingsRerender("plugin_invalidate");
            return;
          }
          if (isBindingInteractionActive()) {
            return;
          }
          requestBindingsRerender("plugin_invalidate");
        } catch { }
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
        const data = (integ.data && typeof integ.data === "object") ? integ.data : {};

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
    const profilesFeature = getProfilesFeature();
    if (profilesFeature && typeof profilesFeature.updateProfilePluginSettings === "function") {
      return profilesFeature.updateProfilePluginSettings(pluginId, nextSettings);
    }

    if (!pluginId || typeof pluginId !== "string") return;
    const safe = (nextSettings && typeof nextSettings === "object") ? nextSettings : {};
    const nextPluginSettings = { ...(getProfilePluginSettings() || {}), [pluginId]: safe };
    setProfilePluginSettings(nextPluginSettings);
    const name = getActiveProfileName() || localStorage.getItem("activeProfileName") || "Default";
    if (!getActiveProfileName()) setActiveProfileName(name);
    try { pluginHost?.setProfileState?.({ name, plugin_settings: nextPluginSettings }); } catch { }
    await saveBindingsForProfile();
  }

  function extractIntegrationTarget(target) {
    if (!target || typeof target !== "object") return null;
    const integ = target.Integration || target.integration;
    if (!integ || typeof integ !== "object" || !integ.integration_id) return null;
    return {
      integration_id: String(integ.integration_id),
      kind: String(integ.kind || ""),
      data: integ.data || {},
    };
  }

  async function triggerIntegration(binding, action, value) {
    if (!pluginHost || !binding) return false;
    const targets = getBindingTargets(binding);
    const integrationGroups = new Map();
    let invoked = false;

    for (let i = 0; i < targets.length; i += 1) {
      const rawTarget = targets[i];
      const target = extractIntegrationTarget(rawTarget);
      if (!target) continue;
      const handler = pluginHost.getIntegration(target.integration_id);
      if (!handler) continue;

      if (action === "Volume") {
        if (!integrationGroups.has(target.integration_id)) {
          integrationGroups.set(target.integration_id, { handler, targets: [] });
        }
        integrationGroups.get(target.integration_id).targets.push({
          target,
          target_index: i,
          target_count: 0,
          is_primary_target: i === 0,
          original_target_index: i,
          binding_target_count: targets.length,
        });
        invoked = true;
        continue;
      }

      if (typeof handler.onBindingTriggered !== "function") continue;
      await handler.onBindingTriggered({
        binding_id: binding.id,
        action,
        value,
        target,
        target_index: i,
        target_count: targets.length,
        is_primary_target: i === 0,
      });
      invoked = true;
    }

    for (const [integrationId, entry] of integrationGroups.entries()) {
      const groupedTargets = entry.targets.map((item, index) => ({
        ...item,
        target_index: index,
        target_count: entry.targets.length,
      }));
      if (typeof entry.handler?.onBindingTriggeredBatch === "function") {
        await entry.handler.onBindingTriggeredBatch({
          binding_id: binding.id,
          action,
          value,
          integration_id: integrationId,
          targets: groupedTargets,
        });
        continue;
      }

      if (typeof entry.handler?.onBindingTriggered !== "function") continue;
      for (const targetEntry of groupedTargets) {
        await entry.handler.onBindingTriggered({
          binding_id: binding.id,
          action,
          value,
          target: targetEntry.target,
          target_index: targetEntry.target_index,
          target_count: targetEntry.target_count,
          is_primary_target: targetEntry.is_primary_target,
          original_target_index: targetEntry.original_target_index,
        });
      }
    }
    return invoked;
  }

  return {
    getPluginHost,
    setPluginHost,
    startPluginHostIfNeeded,
    triggerIntegration,
    extractIntegrationTarget,
    updateProfilePluginSettings,
    hydrateIntegrationDisplayMetadata,
    preloadPluginManifests,
    preloadBindingDisplayMetadata,
    getIntegrationDisplayMetadata,
  };
}

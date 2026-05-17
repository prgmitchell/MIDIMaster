import { createPluginHost } from "../plugin_host.js";

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
}) {
  let pluginHost = null;
  let pluginHostStarted = false;
  let bindingsInvalidationSuppressed = false;

  function getPluginHost() {
    return pluginHost;
  }

  function setPluginHost(next) {
    pluginHost = next;
    if (!next) {
      pluginHostStarted = false;
    }
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
        await pluginHost.loadInstalledPlugins().catch(() => { });
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

        if (typeof data.label === "string") {
          const suffixes = [" (Unavailable)", " (Connecting...)", " (Disconnected)"];
          let nextLabel = data.label;
          for (const s of suffixes) {
            if (nextLabel.endsWith(s)) nextLabel = nextLabel.slice(0, -s.length);
          }
          if (nextLabel !== data.label) {
            updatedAny = true;
            return {
              Integration: {
                integration_id: String(integ.integration_id),
                kind: String(integ.kind || ""),
                data: { ...data, label: nextLabel },
              },
            };
          }
        }

        const hasLabel = typeof data.label === "string" && data.label.trim().length > 0;
        const hasIcon = typeof data.icon_data === "string" && data.icon_data.trim().length > 0;
        if (hasLabel && hasIcon) return t;

        let desc = null;
        try {
          const handler = pluginHost?.getIntegration?.(integ.integration_id);
          if (handler && typeof handler.describeTarget === "function") {
            desc = handler.describeTarget({ Integration: integ });
          }
        } catch {
          desc = null;
        }

        if (!desc || typeof desc !== "object") return t;
        const next = { ...data };
        if (!hasLabel && typeof desc.label === "string" && desc.label.trim()) next.label = desc.label;
        if (!hasIcon && typeof desc.icon_data === "string" && desc.icon_data.trim()) next.icon_data = desc.icon_data;

        if (next.label !== data.label || next.icon_data !== data.icon_data) {
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
  };
}

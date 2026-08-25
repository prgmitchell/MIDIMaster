function normalizeId(value) {
  return String(value || "").trim();
}

export function pluginIconMimeType(path) {
  const normalized = String(path || "").toLowerCase();
  if (normalized.endsWith(".svg")) return "image/svg+xml";
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function integrationMatchesPlugin(integrationId, pluginId) {
  if (integrationId === pluginId) return true;
  return [".", ":", "/"].some((separator) => integrationId.startsWith(`${pluginId}${separator}`));
}

export function createPluginDisplayMetadataCache({ invoke } = {}) {
  if (typeof invoke !== "function") {
    throw new Error("createPluginDisplayMetadataCache: invoke is required");
  }

  let manifests = null;
  let manifestsPromise = null;
  const metadataByPluginId = new Map();
  const iconPromises = new Map();

  function indexManifests(nextManifests) {
    manifests = Array.isArray(nextManifests)
      ? nextManifests.filter((manifest) => manifest && typeof manifest === "object")
      : [];
    metadataByPluginId.clear();
    for (const manifest of manifests) {
      const id = normalizeId(manifest.id);
      if (!id) continue;
      metadataByPluginId.set(id, {
        integration_id: id,
        label: normalizeId(manifest.name) || id,
        icon_data: null,
      });
    }
    return manifests;
  }

  async function loadManifests() {
    if (manifests) return manifests;
    if (manifestsPromise) return manifestsPromise;

    const pending = Promise.resolve(invoke("list_plugins"))
      .then(indexManifests)
      .catch((error) => {
        if (manifestsPromise === pending) manifestsPromise = null;
        throw error;
      });
    manifestsPromise = pending;
    return pending;
  }

  function findManifest(integrationId) {
    const id = normalizeId(integrationId);
    if (!id || !manifests) return null;
    const exact = manifests.find((manifest) => normalizeId(manifest.id) === id);
    if (exact) return exact;
    return manifests
      .filter((manifest) => integrationMatchesPlugin(id, normalizeId(manifest.id)))
      .sort((left, right) => normalizeId(right.id).length - normalizeId(left.id).length)[0]
      || null;
  }

  function getIntegrationDisplayMetadata(integrationId) {
    const manifest = findManifest(integrationId);
    if (!manifest) return null;
    return metadataByPluginId.get(normalizeId(manifest.id)) || null;
  }

  async function warmManifestIcon(manifest) {
    const pluginId = normalizeId(manifest?.id);
    const relPath = normalizeId(manifest?.icon);
    if (!pluginId || !relPath) return;
    const cacheKey = `${pluginId}:${relPath}`;
    if (iconPromises.has(cacheKey)) {
      await iconPromises.get(cacheKey);
      return;
    }

    const pending = Promise.resolve(invoke("read_plugin_base64", {
      pluginId,
      relPath,
    })).then((encoded) => {
      const base64 = normalizeId(encoded);
      if (!base64) return;
      const current = metadataByPluginId.get(pluginId);
      if (!current) return;
      metadataByPluginId.set(pluginId, {
        ...current,
        icon_data: `data:${pluginIconMimeType(relPath)};base64,${base64}`,
      });
    }).catch(() => {
      // A missing or invalid optional icon should not block the first binding render.
    });
    iconPromises.set(cacheKey, pending);
    await pending;
  }

  async function warmIntegrationIcons(integrationIds) {
    await loadManifests();
    const relevant = new Map();
    for (const integrationId of integrationIds || []) {
      const manifest = findManifest(integrationId);
      const pluginId = normalizeId(manifest?.id);
      if (pluginId) relevant.set(pluginId, manifest);
    }
    await Promise.all(Array.from(relevant.values(), warmManifestIcon));
  }

  function invalidate() {
    manifests = null;
    manifestsPromise = null;
    metadataByPluginId.clear();
    iconPromises.clear();
  }

  return {
    loadManifests,
    warmIntegrationIcons,
    getIntegrationDisplayMetadata,
    invalidate,
  };
}

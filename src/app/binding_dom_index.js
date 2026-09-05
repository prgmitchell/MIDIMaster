export function createBindingDomIndex() {
  const byBindingId = new Map();
  let volumeIndex = null;
  let targetIndex = null;
  const matchCache = new Map();

  function invalidate() {
    volumeIndex = null;
    targetIndex = null;
    matchCache.clear();
  }

  function key(bindingId) {
    return String(bindingId ?? "");
  }

  function ensure(bindingId) {
    const bindingKey = key(bindingId);
    let refs = byBindingId.get(bindingKey);
    if (!refs) {
      refs = { item: null, slider: null, muteButton: null, targetDropdown: null, target: null };
      byBindingId.set(bindingKey, refs);
    }
    return refs;
  }

  function register(bindingId, refs = {}) {
    const current = ensure(bindingId);
    Object.assign(current, refs);
    invalidate();
    return current;
  }

  function get(bindingId) {
    return byBindingId.get(key(bindingId)) || null;
  }

  function values() {
    return Array.from(byBindingId.values());
  }

  function clear() {
    byBindingId.clear();
    invalidate();
  }

  function volumes() {
    if (volumeIndex) return volumeIndex;
    const entries = [];
    const byId = new Map();
    for (const refs of byBindingId.values()) {
      if (!refs.slider) continue;
      const entry = {
        slider: refs.slider,
        bindingId: String(refs.slider.dataset.bindingId || ""),
        target: refs.target,
      };
      entries.push(entry);
      if (entry.bindingId && !byId.has(entry.bindingId)) byId.set(entry.bindingId, entry);
    }
    volumeIndex = { entries, byId };
    return volumeIndex;
  }

  /** Integration identities can be indexed exactly. Other targets retain the
   * target core's fuzzy label rules; their results are cached only until rendered
   * rows or observed session/device/focus metadata change. Do not cache MIDI times.
   */
  function matchVolumeTargets(target, { targetsMatch, resolveTargetKey, metadata = [] }) {
    if (!target) return [];
    if (!targetIndex || targetIndex.targetsMatch !== targetsMatch ||
        targetIndex.resolveTargetKey !== resolveTargetKey ||
        metadata.length !== targetIndex.metadata.length ||
        metadata.some((value, index) => value !== targetIndex.metadata[index])) {
      const byKey = new Map();
      const byJson = new Map();
      const append = (map, key, entry) => {
        if (key == null) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(entry);
      };
      for (const entry of volumes().entries) {
        if (!entry.target) continue;
        append(byKey, resolveTargetKey(entry.target), entry);
        append(byJson, JSON.stringify(entry.target), entry);
      }
      targetIndex = { byKey, byJson, metadata: [...metadata], targetsMatch, resolveTargetKey };
      matchCache.clear();
    }
    const json = JSON.stringify(target);
    if (matchCache.has(json)) return matchCache.get(json);
    let candidates = volumes().entries;
    if (target.Integration || target.integration) {
      // targetsMatch accepts exact JSON/key identity before it rejects integration
      // label fallback. Include keys from every target shape to retain that rule.
      const keyMatches = targetIndex.byKey.get(resolveTargetKey(target)) || [];
      const jsonMatches = targetIndex.byJson.get(json) || [];
      const keyEntries = new Set(keyMatches);
      const matches = new Set([...keyMatches, ...jsonMatches]);
      candidates = [...matches];
      // Both lists use render order; merging must keep the same update ordering.
      if (jsonMatches.some((entry) => !keyEntries.has(entry))) {
        candidates = volumes().entries.filter((entry) => matches.has(entry));
      }
    }
    const matches = candidates.filter((entry) => entry.target && targetsMatch(entry.target, target));
    if (matchCache.size >= 256) matchCache.delete(matchCache.keys().next().value);
    matchCache.set(json, matches);
    return matches;
  }

  return {
    register,
    get,
    values,
    volumeEntries: () => volumes().entries,
    volumeEntry: (bindingId) => volumes().byId.get(key(bindingId)) || null,
    matchVolumeTargets,
    clear,
    size: () => byBindingId.size,
  };
}

export function createBindingDomIndex() {
  const byBindingId = new Map();

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
  }

  return {
    register,
    get,
    values,
    clear,
    size: () => byBindingId.size,
  };
}

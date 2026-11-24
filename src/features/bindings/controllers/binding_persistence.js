// Rust commits edits against the named profile and returns the resulting row order.
// Keep unchanged row objects so their DOM handlers and live MIDI values stay valid.
export function createBindingPersistence({
  profileWrites,
  invoke,
  getProfileName,
  getBindings,
  setBindings,
}) {
  function commit(previous, upsert, removeIds, order) {
    const expectedProfile = getProfileName();
    const touched = new Set([...upsert.map((binding) => binding.id), ...removeIds]);
    const originals = new Map(
      previous.filter((binding) => touched.has(binding.id)).map((binding) => [binding.id, binding]),
    );
    return profileWrites.run(async () => {
      const current = new Map(getBindings().map((binding) => [binding.id, binding]));
      if (
        expectedProfile !== getProfileName() ||
        [...touched].some((id) => current.get(id) !== originals.get(id))
      ) {
        throw new Error("Binding changed before the edit could be saved");
      }
      const ids = await invoke("edit_profile_bindings", {
        expectedProfile,
        edits: { upsert, removeIds, order },
      });
      if (expectedProfile !== getProfileName()) return;
      // A hardware event can update an assignment while the native write is in flight.
      const latest = new Map(getBindings().map((binding) => [binding.id, binding]));
      const changedDuringWrite = [...touched].some((id) => latest.get(id) !== current.get(id));
      for (const binding of upsert) latest.set(binding.id, binding);
      let bindings;
      if (!changedDuringWrite && ids.every((id) => latest.has(id))) {
        bindings = ids.map((id) => latest.get(id));
      } else {
        const profile = await invoke("get_active_profile");
        if (profile?.name !== expectedProfile || getProfileName() !== expectedProfile) return;
        bindings = profile.bindings;
      }
      setBindings(bindings);
    });
  }

  function save(original, draft) {
    return commit([original], [draft], [], null);
  }

  function remove(binding) {
    return commit([binding], [], [binding.id], null);
  }

  function applyList(previous, next) {
    const before = new Map(previous.map((binding) => [binding.id, binding]));
    const order = next.map((binding) => binding.id);
    const remaining = new Set(order);
    const removeIds = previous
      .filter((binding) => !remaining.has(binding.id))
      .map((binding) => binding.id);
    const upsert = next.filter((binding) => {
      const original = before.get(binding.id);
      return original !== binding && JSON.stringify(original) !== JSON.stringify(binding);
    });
    const naturalOrder = [...before.keys()].filter((id) => remaining.has(id));
    naturalOrder.push(...order.filter((id) => !before.has(id)));
    const reordered = naturalOrder.some((id, index) => id !== order[index]);
    if (!upsert.length && !removeIds.length && !reordered) return Promise.resolve();
    return commit(previous, upsert, removeIds, reordered ? order : null);
  }

  return { save, remove, applyList };
}

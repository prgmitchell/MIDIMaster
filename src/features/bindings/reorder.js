function bindingId(binding) {
  return String(binding?.id || "");
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

export function reorderVisibleBindings(bindings, visibleBindingIds, draggedBindingId, destinationVisibleIndex) {
  if (!Array.isArray(bindings) || !Array.isArray(visibleBindingIds)) {
    return { bindings, changed: false };
  }

  const visibleIds = visibleBindingIds.map((id) => String(id || ""));
  const draggedId = String(draggedBindingId || "");
  if (
    bindings.length < 2
    || visibleIds.length < 2
    || !draggedId
    || visibleIds.some((id) => !id)
    || hasDuplicates(visibleIds)
    || !Number.isInteger(destinationVisibleIndex)
    || destinationVisibleIndex < 0
    || destinationVisibleIndex >= visibleIds.length
  ) {
    return { bindings, changed: false };
  }

  const fullIds = bindings.map(bindingId);
  if (fullIds.some((id) => !id) || hasDuplicates(fullIds)) {
    return { bindings, changed: false };
  }

  const fullIndexById = new Map(fullIds.map((id, index) => [id, index]));
  const visibleFullIndexes = [];
  for (const id of visibleIds) {
    const fullIndex = fullIndexById.get(id);
    if (!Number.isInteger(fullIndex)) {
      return { bindings, changed: false };
    }
    visibleFullIndexes.push(fullIndex);
  }

  const sourceVisibleIndex = visibleIds.indexOf(draggedId);
  if (sourceVisibleIndex < 0 || sourceVisibleIndex === destinationVisibleIndex) {
    return { bindings, changed: false };
  }

  const reorderedVisibleIds = visibleIds.slice();
  const [movedId] = reorderedVisibleIds.splice(sourceVisibleIndex, 1);
  reorderedVisibleIds.splice(destinationVisibleIndex, 0, movedId);

  const bindingById = new Map(bindings.map((binding) => [bindingId(binding), binding]));
  const nextBindings = bindings.slice();
  visibleFullIndexes.forEach((fullIndex, visibleIndex) => {
    nextBindings[fullIndex] = bindingById.get(reorderedVisibleIds[visibleIndex]);
  });

  return { bindings: nextBindings, changed: true };
}

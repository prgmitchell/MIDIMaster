const BINDING_TYPE_FILTERS = new Set(["all", "faders", "buttons"]);

export function createBindingRenderModel({
  fallbackNameFor,
  labelForControl,
  displayModeName,
  getTargets,
  isButtonBinding,
}) {
  function normalizeTypeFilter(value) {
    const normalized = String(value || "all").toLowerCase();
    return BINDING_TYPE_FILTERS.has(normalized) ? normalized : "all";
  }

  function matchesTypeFilter(binding, filterValue) {
    const normalized = normalizeTypeFilter(filterValue);
    if (normalized === "all") return true;
    const isButton = isButtonBinding(binding);
    return normalized === "buttons" ? isButton : !isButton;
  }

  function searchText(binding, index) {
    return [
      binding?.name || "",
      fallbackNameFor(binding, index),
      labelForControl(binding?.control || {}),
      displayModeName(binding),
      JSON.stringify(getTargets(binding)),
      binding?.action || "",
      binding?.soundboard?.display || "",
      binding?.soundboard?.path || "",
    ].join(" ").toLowerCase();
  }

  return { normalizeTypeFilter, matchesTypeFilter, searchText };
}

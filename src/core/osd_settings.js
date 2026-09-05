/** The frontend OSD model. Persisted profiles use snake_case; commands use camelCase. */
export const DEFAULT_OSD_SETTINGS = Object.freeze({
  enabled: true,
  monitorIndex: 0,
  monitorName: null,
  monitorId: null,
  anchor: "top-right",
  showBindingName: false,
  style: "midnight",
  opacity: 0.96,
  scale: 1,
});

export const OSD_STYLES = Object.freeze(["midnight", "glass", "neon", "studio"]);
export const OSD_ANCHORS = Object.freeze([
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);

/** Decode either wire spelling without changing profile values before the editor validates them. */
export function fromOsdSettings(value = {}, defaults = DEFAULT_OSD_SETTINGS) {
  return {
    enabled: Boolean(value.enabled ?? defaults.enabled),
    monitorIndex: Number(value.monitor_index ?? value.monitorIndex ?? defaults.monitorIndex),
    monitorName: value.monitor_name ?? value.monitorName ?? defaults.monitorName,
    monitorId: value.monitor_id ?? value.monitorId ?? defaults.monitorId,
    anchor: value.anchor || defaults.anchor,
    showBindingName: Boolean(value.show_binding_name ?? value.showBindingName ?? defaults.showBindingName),
    style: value.style || defaults.style,
    opacity: Number(value.opacity ?? defaults.opacity),
    scale: Number(value.scale ?? defaults.scale),
  };
}

export function toPersistedOsdSettings(value, defaults = DEFAULT_OSD_SETTINGS) {
  const settings = fromOsdSettings(value, defaults);
  return {
    enabled: settings.enabled,
    monitor_index: settings.monitorIndex,
    monitor_name: settings.monitorName || null,
    monitor_id: settings.monitorId || null,
    anchor: settings.anchor,
    show_binding_name: settings.showBindingName,
    style: settings.style,
    opacity: settings.opacity,
    scale: settings.scale,
  };
}

export function normalizeOsdStyle(style) {
  const value = String(style || DEFAULT_OSD_SETTINGS.style)
    .trim()
    .toLowerCase();
  return OSD_STYLES.includes(value) ? value : DEFAULT_OSD_SETTINGS.style;
}

export function normalizeOsdAnchor(anchor) {
  const value = String(anchor || DEFAULT_OSD_SETTINGS.anchor)
    .trim()
    .toLowerCase();
  return OSD_ANCHORS.includes(value) ? value : DEFAULT_OSD_SETTINGS.anchor;
}

export function normalizeOsdAppearance(settings = {}) {
  return {
    style: normalizeOsdStyle(settings.style),
    opacity: Number.isFinite(Number(settings.opacity))
      ? clampOsdOpacity(settings.opacity)
      : DEFAULT_OSD_SETTINGS.opacity,
    scale: Number.isFinite(Number(settings.scale))
      ? clampOsdScale(settings.scale)
      : DEFAULT_OSD_SETTINGS.scale,
  };
}

export const clampOsdOpacity = (value) => Math.min(1, Math.max(0.35, Number(value)));
export const clampOsdScale = (value) => Math.min(1.5, Math.max(0.75, Number(value)));

export function toOsdCommandSettings(settings) {
  return {
    ...fromOsdSettings(settings),
    monitorName: settings.monitorName || null,
    monitorId: settings.monitorId || null,
    anchor: normalizeOsdAnchor(settings.anchor),
    ...normalizeOsdAppearance(settings),
  };
}

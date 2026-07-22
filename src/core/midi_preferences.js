export function normalizeMidiPreference(source) {
  const current = (source && typeof source === "object") ? source : {};
  const routes = normalizeMidiRoutes(current);
  const first = routes[0] || {};
  return {
    inputDeviceId: String(first.inputDeviceId || current.inputDeviceId || current.input_device_id || "").trim(),
    outputDeviceId: String(first.outputDeviceId || current.outputDeviceId || current.output_device_id || "").trim(),
    inputDeviceName: String(first.inputDeviceName || current.inputDeviceName || current.input_device_name || "").trim(),
    outputDeviceName: String(first.outputDeviceName || current.outputDeviceName || current.output_device_name || "").trim(),
    routes,
    configured: Boolean(
      current.configured
      ?? current.midiDevicePreferenceSet
      ?? current.midi_device_preference_set
      ?? current.midi_device_preference_configured
      ?? (routes.length > 0)
    ),
  };
}

export function hasMidiPreference(source) {
  const preference = normalizeMidiPreference(source);
  return preference.configured || preference.routes.length > 0;
}

export function normalizeMidiRoute(source) {
  const current = (source && typeof source === "object") ? source : {};
  const inputDeviceId = String(current.inputDeviceId || current.input_device_id || "").trim();
  const outputDeviceId = String(current.outputDeviceId || current.output_device_id || "").trim();
  if (!inputDeviceId || !outputDeviceId) return null;
  return {
    inputDeviceId,
    outputDeviceId,
    inputDeviceName: String(current.inputDeviceName || current.input_device_name || "").trim(),
    outputDeviceName: String(current.outputDeviceName || current.output_device_name || "").trim(),
    enabled: current.enabled !== false,
  };
}

export function normalizeMidiRoutes(source) {
  const current = (source && typeof source === "object") ? source : {};
  const rawRoutes = Array.isArray(current.routes)
    ? current.routes
    : (Array.isArray(current.midi_device_routes) ? current.midi_device_routes : []);
  const routes = [];

  rawRoutes.forEach((raw) => {
    const route = normalizeMidiRoute(raw);
    if (!route || routes.some((existing) => sameInputRouteIdentity(existing, route))) return;
    routes.push(route);
  });

  if (routes.length === 0) {
    const legacy = normalizeMidiRoute({
      inputDeviceId: current.inputDeviceId || current.input_device_id,
      outputDeviceId: current.outputDeviceId || current.output_device_id,
      inputDeviceName: current.inputDeviceName || current.input_device_name,
      outputDeviceName: current.outputDeviceName || current.output_device_name,
      enabled: true,
    });
    if (legacy) routes.push(legacy);
  }

  return routes;
}

export function buildPersistedMidiRoutes(routes) {
  return normalizeMidiRoutes({ routes }).map((route) => ({
    input_device_id: route.inputDeviceId,
    output_device_id: route.outputDeviceId,
    input_device_name: route.inputDeviceName || null,
    output_device_name: route.outputDeviceName || null,
    enabled: route.enabled !== false,
  }));
}

export function buildPersistedMidiPreference(source) {
  const preference = normalizeMidiPreference(source);
  const routes = buildPersistedMidiRoutes(preference.routes);
  const first = routes[0] || {};
  return {
    input_device_id: first.input_device_id || null,
    output_device_id: first.output_device_id || null,
    input_device_name: first.input_device_name || null,
    output_device_name: first.output_device_name || null,
    routes,
  };
}

export function stripUnavailableMidiSuffix(label) {
  const raw = String(label || "").trim();
  return raw.endsWith(" (Unavailable)") ? raw.slice(0, -" (Unavailable)".length) : raw;
}

function sameInputRouteIdentity(left, right) {
  const leftInputId = String(left?.inputDeviceId || left?.input_device_id || "").trim();
  const rightInputId = String(right?.inputDeviceId || right?.input_device_id || "").trim();
  if (!leftInputId || leftInputId !== rightInputId) return false;

  const leftName = stripUnavailableMidiSuffix(left?.inputDeviceName || left?.input_device_name || "");
  const rightName = stripUnavailableMidiSuffix(right?.inputDeviceName || right?.input_device_name || "");
  return !(leftName && rightName && leftName !== rightName);
}

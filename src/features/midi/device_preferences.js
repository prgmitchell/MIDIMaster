export function normalizeMidiPreference(source) {
  const current = (source && typeof source === "object") ? source : {};
  const routes = normalizeMidiRoutes(current);
  const first = routes[0] || {};
  const configured = Boolean(
    current.configured
    ?? current.midiDevicePreferenceSet
    ?? current.midi_device_preference_set
    ?? current.midi_device_preference_configured
    ?? (routes.length > 0)
  );
  return {
    inputDeviceId: String(first.inputDeviceId || current.inputDeviceId || current.input_device_id || "").trim(),
    outputDeviceId: String(first.outputDeviceId || current.outputDeviceId || current.output_device_id || "").trim(),
    inputDeviceName: String(first.inputDeviceName || current.inputDeviceName || current.input_device_name || "").trim(),
    outputDeviceName: String(first.outputDeviceName || current.outputDeviceName || current.output_device_name || "").trim(),
    routes,
    configured,
  };
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

function sameInputRouteIdentity(left, right) {
  const leftInputId = String(left?.inputDeviceId || left?.input_device_id || "").trim();
  const rightInputId = String(right?.inputDeviceId || right?.input_device_id || "").trim();
  if (!leftInputId || leftInputId !== rightInputId) return false;

  const leftName = stripUnavailableSuffix(left?.inputDeviceName || left?.input_device_name || "");
  const rightName = stripUnavailableSuffix(right?.inputDeviceName || right?.input_device_name || "");
  return !(leftName && rightName && leftName !== rightName);
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

export function routeKey(route) {
  return String(route?.inputDeviceId || route?.input_device_id || "").trim();
}

export function findDeviceMatch(devices, deviceId, deviceName) {
  const list = Array.isArray(devices) ? devices : [];
  const byId = deviceId ? list.find((device) => device.id === deviceId) : null;
  if (byId) return byId;
  if (!deviceName) return null;
  return list.find((device) => device.name === deviceName) || null;
}

// MIDI IDs can be index-based and may shift after unplug/replug.
// Prefer an exact id+name match when both are known; otherwise use name fallback
// and DO NOT fall back to id-only when a saved name is present (can bind to wrong device).
export function findPreferredDevice(devices, deviceId, deviceName) {
  const list = Array.isArray(devices) ? devices : [];
  const hasId = Boolean(deviceId);
  const hasName = Boolean(deviceName);
  const byId = hasId ? list.find((device) => device.id === deviceId) : null;
  const byName = hasName ? list.find((device) => device.name === deviceName) : null;

  if (hasId && hasName) {
    const exact = list.find((device) => device.id === deviceId && device.name === deviceName);
    if (exact) return exact;
    if (byName) return byName;
    return null;
  }

  return byId || byName || null;
}

export function findConnectedAliveDevice(devices, expectedId, expectedName) {
  const list = Array.isArray(devices) ? devices : [];
  if (!expectedId && !expectedName) return null;
  if (expectedId && expectedName) {
    return list.find((device) => device.id === expectedId && device.name === expectedName) || null;
  }
  return findDeviceMatch(list, expectedId, expectedName);
}

export function resolvePreferredMidiDevicePair(deviceSnapshot, preference) {
  const pref = normalizeMidiPreference(preference);
  const inputs = Array.isArray(deviceSnapshot?.inputs) ? deviceSnapshot.inputs : [];
  const outputs = Array.isArray(deviceSnapshot?.outputs) ? deviceSnapshot.outputs : [];
  const hasPairPreference = Boolean(pref.inputDeviceId && pref.outputDeviceId);
  const inputMatch = hasPairPreference
    ? findPreferredDevice(inputs, pref.inputDeviceId, pref.inputDeviceName)
    : null;
  const outputMatch = hasPairPreference
    ? findPreferredDevice(outputs, pref.outputDeviceId, pref.outputDeviceName)
    : null;

  return {
    preference: pref,
    inputMatch,
    outputMatch,
    available: Boolean(inputMatch && outputMatch),
  };
}

export function resolvePreferredMidiDeviceRoutes(deviceSnapshot, preference) {
  const pref = normalizeMidiPreference(preference);
  const inputs = Array.isArray(deviceSnapshot?.inputs) ? deviceSnapshot.inputs : [];
  const outputs = Array.isArray(deviceSnapshot?.outputs) ? deviceSnapshot.outputs : [];
  const routes = pref.routes.map((route) => {
    const inputMatch = findPreferredDevice(inputs, route.inputDeviceId, route.inputDeviceName);
    const outputMatch = findPreferredDevice(outputs, route.outputDeviceId, route.outputDeviceName);
    return {
      preference: route,
      inputMatch,
      outputMatch,
      available: Boolean(inputMatch && outputMatch),
    };
  });

  return {
    preference: pref,
    routes,
    available: routes.length > 0 && routes.every((route) => route.available || route.preference.enabled === false),
  };
}

export function hasDuplicateInputRoute(routes, inputDeviceId, indexToIgnore = -1) {
  const target = String(inputDeviceId || "").trim();
  if (!target) return false;
  const list = Array.isArray(routes) ? routes : [];
  const targetRoute = indexToIgnore >= 0 ? list[indexToIgnore] : null;
  const targetName = stripUnavailableSuffix(targetRoute?.inputDeviceName || targetRoute?.input_device_name || "");
  return list.some((route, index) => {
    if (index === indexToIgnore || !route || typeof route !== "object") return false;
    const input = String(route.inputDeviceId || route.input_device_id || "").trim();
    if (input !== target) return false;
    const routeName = stripUnavailableSuffix(route.inputDeviceName || route.input_device_name || "");
    return !(targetName && routeName && targetName !== routeName);
  });
}

export function sharedOutputCounts(routes) {
  const counts = new Map();
  normalizeMidiRoutes({ routes }).forEach((route) => {
    const id = route.outputDeviceId;
    if (!id) return;
    counts.set(id, (counts.get(id) || 0) + 1);
  });
  return counts;
}

export function resolveMidiDeviceDropdownState({
  selectedValue = "",
  selectedUnavailable = false,
  connectedDeviceId = "",
} = {}) {
  const value = String(selectedValue || "").trim();
  const connectedId = String(connectedDeviceId || "").trim();
  const unavailable = Boolean(value && selectedUnavailable);
  const connected = Boolean(value && !unavailable && connectedId && value === connectedId);

  return {
    empty: !value,
    unavailable,
    connected,
    available: Boolean(value && !unavailable),
  };
}

export function shouldRecoverSuspectMidiPair(health, preference) {
  const current = (health && typeof health === "object") ? health : {};
  const pref = normalizeMidiPreference(preference);
  const inputDeviceId = String(current.inputDeviceId || current.input_device_id || "").trim();
  const outputDeviceId = String(current.outputDeviceId || current.output_device_id || "").trim();

  return Boolean(
    current.suspect
    && pref.inputDeviceId
    && pref.outputDeviceId
    && inputDeviceId === pref.inputDeviceId
    && outputDeviceId === pref.outputDeviceId
  );
}

export function unavailableDeviceLabel(name, id, kind) {
  const rawBase = String(name || id || `${kind} device`).trim();
  const suffix = " (Unavailable)";
  const base = rawBase.endsWith(suffix) ? rawBase.slice(0, -suffix.length) : rawBase;
  return `${base} (Unavailable)`;
}

export function stripUnavailableSuffix(label) {
  const raw = String(label || "").trim();
  return raw.endsWith(" (Unavailable)") ? raw.slice(0, -" (Unavailable)".length) : raw;
}


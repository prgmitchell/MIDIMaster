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

export function midiRoutesEqual(left, right) {
  const a = normalizeMidiRoutes({ routes: left });
  const b = normalizeMidiRoutes({ routes: right });
  if (a.length !== b.length) return false;
  return a.every((route, index) => {
    const other = b[index];
    return Boolean(
      other
      && route.inputDeviceId === other.inputDeviceId
      && route.outputDeviceId === other.outputDeviceId
      && route.inputDeviceName === other.inputDeviceName
      && route.outputDeviceName === other.outputDeviceName
      && route.enabled === other.enabled
    );
  });
}

export function orderMidiRoutesByPreference(routes, preferredRoutes) {
  const remaining = normalizeMidiRoutes({ routes }).map((route) => ({ ...route }));
  const preferred = normalizeMidiRoutes({ routes: preferredRoutes });
  const ordered = [];

  preferred.forEach((preference) => {
    const preferredName = stripUnavailableSuffix(preference.inputDeviceName || "");
    let matchIndex = remaining.findIndex((route) => {
      if (route.inputDeviceId !== preference.inputDeviceId) return false;
      const routeName = stripUnavailableSuffix(route.inputDeviceName || "");
      return !(preferredName && routeName && preferredName !== routeName);
    });

    if (matchIndex < 0 && preferredName) {
      const nameMatches = remaining
        .map((route, index) => ({
          index,
          name: stripUnavailableSuffix(route.inputDeviceName || ""),
        }))
        .filter((candidate) => candidate.name === preferredName);
      if (nameMatches.length === 1) matchIndex = nameMatches[0].index;
    }

    if (matchIndex >= 0) {
      ordered.push(remaining.splice(matchIndex, 1)[0]);
    }
  });

  return [...ordered, ...remaining];
}

export function createMidiRouteDraftController() {
  let draftRoutes = null;
  let baselineRoutes = [];
  let dirty = false;

  return {
    begin(routes) {
      draftRoutes = normalizeMidiRoutes({ routes }).map((route) => ({ ...route }));
      baselineRoutes = draftRoutes.map((route) => ({ ...route }));
      dirty = false;
    },
    replace(routes) {
      draftRoutes = normalizeMidiRoutes({ routes }).map((route) => ({ ...route }));
      dirty = !midiRoutesEqual(draftRoutes, baselineRoutes);
    },
    discard() {
      draftRoutes = null;
      baselineRoutes = [];
      dirty = false;
    },
    current(fallbackRoutes = []) {
      return normalizeMidiRoutes({
        routes: Array.isArray(draftRoutes) ? draftRoutes : fallbackRoutes,
      });
    },
    draft() {
      return Array.isArray(draftRoutes)
        ? draftRoutes.map((route) => ({ ...route }))
        : null;
    },
    isDirty() {
      return dirty;
    },
    async commit(apply) {
      if (!dirty || !Array.isArray(draftRoutes) || typeof apply !== "function") return null;
      const routes = draftRoutes.map((route) => ({ ...route }));
      const result = await apply(routes);
      baselineRoutes = routes.map((route) => ({ ...route }));
      draftRoutes = null;
      dirty = false;
      return result;
    },
  };
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
export function preferredDeviceMatch(devices, deviceId, deviceName) {
  const list = Array.isArray(devices) ? devices : [];
  const hasId = Boolean(deviceId);
  const hasName = Boolean(deviceName);
  const byId = hasId ? list.find((device) => device.id === deviceId) : null;
  const nameMatches = hasName ? list.filter((device) => device.name === deviceName) : [];
  const byUniqueName = nameMatches.length === 1 ? nameMatches[0] : null;

  if (hasId && hasName) {
    const exact = list.find((device) => device.id === deviceId && device.name === deviceName);
    if (exact) return { match: exact, status: "exact" };
    if (byUniqueName) return { match: byUniqueName, status: "name" };
    return { match: null, status: nameMatches.length > 1 ? "ambiguous" : "unavailable" };
  }

  if (byId) return { match: byId, status: "id" };
  if (byUniqueName) return { match: byUniqueName, status: "name" };
  return { match: null, status: nameMatches.length > 1 ? "ambiguous" : "unavailable" };
}

export function findPreferredDevice(devices, deviceId, deviceName) {
  return preferredDeviceMatch(devices, deviceId, deviceName).match;
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
    const inputResolution = preferredDeviceMatch(inputs, route.inputDeviceId, route.inputDeviceName);
    const outputResolution = preferredDeviceMatch(outputs, route.outputDeviceId, route.outputDeviceName);
    const inputMatch = inputResolution.match;
    const outputMatch = outputResolution.match;
    return {
      preference: route,
      inputMatch,
      outputMatch,
      inputStatus: inputResolution.status,
      outputStatus: outputResolution.status,
      ambiguous: inputResolution.status === "ambiguous" || outputResolution.status === "ambiguous",
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
  const suspect = Boolean(
    current.suspect
    || current.inputSuspect
    || current.input_suspect
    || current.inputNameMismatch
    || current.input_name_mismatch
    || current.outputSuspect
    || current.output_suspect
    || current.outputNameMismatch
    || current.output_name_mismatch
  );

  return Boolean(
    suspect
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


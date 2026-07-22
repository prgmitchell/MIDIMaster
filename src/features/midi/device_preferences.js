import {
  buildPersistedMidiRoutes,
  normalizeMidiPreference,
  normalizeMidiRoute,
  normalizeMidiRoutes,
  stripUnavailableMidiSuffix,
} from "../../core/midi_preferences.js";

export {
  buildPersistedMidiRoutes,
  normalizeMidiPreference,
  normalizeMidiRoute,
  normalizeMidiRoutes,
  stripUnavailableMidiSuffix as stripUnavailableSuffix,
};

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
    const preferredName = stripUnavailableMidiSuffix(preference.inputDeviceName || "");
    let matchIndex = remaining.findIndex((route) => {
      if (route.inputDeviceId !== preference.inputDeviceId) return false;
      const routeName = stripUnavailableMidiSuffix(route.inputDeviceName || "");
      return !(preferredName && routeName && preferredName !== routeName);
    });

    if (matchIndex < 0 && preferredName) {
      const nameMatches = remaining
        .map((route, index) => ({
          index,
          name: stripUnavailableMidiSuffix(route.inputDeviceName || ""),
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
  const targetName = stripUnavailableMidiSuffix(targetRoute?.inputDeviceName || targetRoute?.input_device_name || "");
  return list.some((route, index) => {
    if (index === indexToIgnore || !route || typeof route !== "object") return false;
    const input = String(route.inputDeviceId || route.input_device_id || "").trim();
    if (input !== target) return false;
    const routeName = stripUnavailableMidiSuffix(route.inputDeviceName || route.input_device_name || "");
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


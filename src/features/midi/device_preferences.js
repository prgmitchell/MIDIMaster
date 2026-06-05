export function normalizeMidiPreference(source) {
  const current = (source && typeof source === "object") ? source : {};
  return {
    inputDeviceId: String(current.inputDeviceId || current.input_device_id || "").trim(),
    outputDeviceId: String(current.outputDeviceId || current.output_device_id || "").trim(),
    inputDeviceName: String(current.inputDeviceName || current.input_device_name || "").trim(),
    outputDeviceName: String(current.outputDeviceName || current.output_device_name || "").trim(),
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
  const base = String(name || id || `${kind} device`).trim();
  return `${base} (Unavailable)`;
}

export function stripUnavailableSuffix(label) {
  const raw = String(label || "").trim();
  return raw.endsWith(" (Unavailable)") ? raw.slice(0, -" (Unavailable)".length) : raw;
}


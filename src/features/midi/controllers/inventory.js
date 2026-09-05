import { normalizeMidiPreference } from "../device_preferences.js";

/** inventory workflow. */
export function createInventory({
  MIDI_ENUM_MIN_INTERVAL_MS,
  MIDI_OUTPUT_ENUM_DELAY_MS,
  discovery,
  invoke,
  onDeviceInventoryChanged,
}) {
  function hasPreference(pref) {
    const normalized = normalizeMidiPreference(pref);
    return normalized.routes.length > 0;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function deviceInventorySignature(snapshot = {}) {
    const compact = {
      inputs: (Array.isArray(snapshot.inputs) ? snapshot.inputs : []).map((device) => ({
        id: String(device?.id || ""),
        name: String(device?.name || ""),
      })),
      outputs: (Array.isArray(snapshot.outputs) ? snapshot.outputs : []).map((device) => ({
        id: String(device?.id || ""),
        name: String(device?.name || ""),
      })),
    };
    return JSON.stringify(compact);
  }

  async function enumerateMidiDevices({ force = false, reason = "unknown" } = {}) {
    const now = Date.now();
    if (!force && now - discovery.lastDeviceRefreshAt < MIDI_ENUM_MIN_INTERVAL_MS) {
      return discovery.lastDeviceSnapshot;
    }
    if (discovery.deviceRefreshInFlight) {
      return discovery.deviceRefreshInFlight;
    }

    discovery.deviceRefreshInFlight = (async () => {
      try {
        const inputs = await invoke("list_midi_devices").catch((error) => {
          console.warn(`Failed to list MIDI inputs (${reason}):`, error);
          return discovery.lastDeviceSnapshot.inputs || [];
        });
        await sleep(MIDI_OUTPUT_ENUM_DELAY_MS);
        const outputs = await invoke("list_midi_output_devices").catch((error) => {
          console.warn(`Failed to list MIDI outputs (${reason}):`, error);
          return discovery.lastDeviceSnapshot.outputs || [];
        });
        discovery.lastDeviceSnapshot = {
          inputs: Array.isArray(inputs) ? inputs : [],
          outputs: Array.isArray(outputs) ? outputs : [],
        };
        const signature = deviceInventorySignature(discovery.lastDeviceSnapshot);
        if (signature !== discovery.lastDeviceInventorySignature) {
          discovery.lastDeviceInventorySignature = signature;
          if (typeof onDeviceInventoryChanged === "function") {
            onDeviceInventoryChanged(discovery.lastDeviceSnapshot);
          }
        }
        discovery.lastDeviceRefreshAt = Date.now();
        return discovery.lastDeviceSnapshot;
      } finally {
        discovery.deviceRefreshInFlight = null;
      }
    })();

    return discovery.deviceRefreshInFlight;
  }

  return { hasPreference, enumerateMidiDevices };
}

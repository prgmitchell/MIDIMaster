import { applyAppearanceToDocument } from "../appearance.js";
import { normalizeMidiRoutes } from "../../core/midi_preferences.js";

/** client preferences workflow. */
export function createClientPreferences({
  clientPreferences,
  invoke,
  midiInputNameStorageKey,
  midiInputStorageKey,
  midiOutputNameStorageKey,
  midiOutputStorageKey,
  profileState,
  settingsStore,
  stripDeviceStateSuffix,
}) {
  function getSavedMidiDeviceIds() {
    let inputId = "";
    let outputId = "";
    let inputName = "";
    let outputName = "";
    try {
      inputId = localStorage.getItem(midiInputStorageKey) || "";
      outputId = localStorage.getItem(midiOutputStorageKey) || "";
      inputName = localStorage.getItem(midiInputNameStorageKey) || "";
      outputName = localStorage.getItem(midiOutputNameStorageKey) || "";
    } catch {
      // ignore storage failures
    }

    return {
      inputId: inputId || clientPreferences.persistedMidiInputId || "",
      outputId: outputId || clientPreferences.persistedMidiOutputId || "",
      inputName: inputName || clientPreferences.persistedMidiInputName || "",
      outputName: outputName || clientPreferences.persistedMidiOutputName || "",
      routes: clientPreferences.persistedMidiRoutes || [],
    };
  }

  function midiDeviceLabelForBindingDevice(deviceId) {
    const normalizedId = String(deviceId || "").trim();
    if (!normalizedId) return "";

    const routes = [
      ...(Array.isArray(profileState.midiPreference?.routes) ? profileState.midiPreference.routes : []),
      ...(Array.isArray(clientPreferences.persistedMidiRoutes) ? clientPreferences.persistedMidiRoutes : []),
    ];
    const legacyRoutes = [
      {
        inputDeviceId: profileState.midiPreference?.inputDeviceId,
        inputDeviceName: profileState.midiPreference?.inputDeviceName,
        outputDeviceId: profileState.midiPreference?.outputDeviceId,
        outputDeviceName: profileState.midiPreference?.outputDeviceName,
      },
      {
        inputDeviceId: clientPreferences.persistedMidiInputId,
        inputDeviceName: clientPreferences.persistedMidiInputName,
        outputDeviceId: clientPreferences.persistedMidiOutputId,
        outputDeviceName: clientPreferences.persistedMidiOutputName,
      },
    ];

    const allRoutes = [...routes, ...legacyRoutes];
    const inputMatch = allRoutes.find(
      (route) => String(route?.inputDeviceId || route?.input_device_id || "").trim() === normalizedId,
    );
    if (inputMatch) {
      return (
        stripDeviceStateSuffix(inputMatch.inputDeviceName || inputMatch.input_device_name || normalizedId) ||
        normalizedId
      );
    }

    const outputMatch = allRoutes.find(
      (route) => String(route?.outputDeviceId || route?.output_device_id || "").trim() === normalizedId,
    );
    if (outputMatch) {
      return (
        stripDeviceStateSuffix(
          outputMatch.outputDeviceName || outputMatch.output_device_name || normalizedId,
        ) || normalizedId
      );
    }

    return normalizedId;
  }

  async function clearSavedMidiDeviceIds() {}

  async function hydrateClientPreferences(loadedSettings = null) {
    try {
      const settings = loadedSettings || (await invoke("get_app_settings"));
      if (!settings || typeof settings !== "object") {
        return;
      }

      const hydratedSettings = settingsStore.hydrate(settings);
      applyAppearanceToDocument(hydratedSettings.appearance, { matchMediaSource: window });

      const savedInputId = settings.midi_input_device_id ?? settings.midiInputDeviceId ?? "";
      const savedOutputId = settings.midi_output_device_id ?? settings.midiOutputDeviceId ?? "";
      const savedInputName = settings.midi_input_device_name ?? settings.midiInputDeviceName ?? "";
      const savedOutputName = settings.midi_output_device_name ?? settings.midiOutputDeviceName ?? "";
      clientPreferences.persistedMidiInputId = savedInputId || "";
      clientPreferences.persistedMidiOutputId = savedOutputId || "";
      clientPreferences.persistedMidiInputName = savedInputName || "";
      clientPreferences.persistedMidiOutputName = savedOutputName || "";
      clientPreferences.persistedMidiRoutes = normalizeMidiRoutes(settings);
      const savedActiveProfileName = settings.active_profile_name ?? settings.activeProfileName ?? "";
      clientPreferences.persistedActiveProfileName = String(savedActiveProfileName || "").trim();

      try {
        if (clientPreferences.persistedMidiInputId && !localStorage.getItem(midiInputStorageKey)) {
          localStorage.setItem(midiInputStorageKey, clientPreferences.persistedMidiInputId);
        }
        if (clientPreferences.persistedMidiOutputId && !localStorage.getItem(midiOutputStorageKey)) {
          localStorage.setItem(midiOutputStorageKey, clientPreferences.persistedMidiOutputId);
        }
        if (clientPreferences.persistedMidiInputName && !localStorage.getItem(midiInputNameStorageKey)) {
          localStorage.setItem(midiInputNameStorageKey, clientPreferences.persistedMidiInputName);
        }
        if (clientPreferences.persistedMidiOutputName && !localStorage.getItem(midiOutputNameStorageKey)) {
          localStorage.setItem(midiOutputNameStorageKey, clientPreferences.persistedMidiOutputName);
        }
        if (clientPreferences.persistedActiveProfileName) {
          localStorage.setItem("activeProfileName", clientPreferences.persistedActiveProfileName);
        }
      } catch {
        // ignore storage failures
      }
    } catch {
      // ignore preference hydration failures
    }
  }

  return {
    getSavedMidiDeviceIds,
    midiDeviceLabelForBindingDevice,
    clearSavedMidiDeviceIds,
    hydrateClientPreferences,
  };
}

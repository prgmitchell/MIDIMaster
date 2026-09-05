import { createBindingLookupIndex } from "./binding_lookup_index.js";
import { DEFAULT_OSD_SETTINGS } from "../core/osd_settings.js";

/**
 * Application-owned state shared by controllers. Each object has one lifetime:
 * profileState: the active persisted profile and its MIDI preference;
 * audioState: observed OS sessions/devices, refreshed independently of profiles;
 * liveState: transient MIDI/feedback values, never serialized as a profile;
 * osdState: frontend OSD preferences/monitor inventory (wire conversion lives in core);
 * clientPreferences: legacy reconnect/startup fallbacks, not another active profile;
 * viewState/startupState: interaction and initialization coordination only.
 * Settings values have a separate owner: createSettingsStore.
 */
export function createApplicationState() {
  const features = {
    plugins: null,
    settings: null,
    profiles: null,
    bindings: null,
    targets: null,
    midi: null,
    connections: null,
  };

  const profileState = {
    bindings: [],
    bindingLookupIndex: createBindingLookupIndex(),
    pluginSettings: {},
    name: "",
    midiPreference: {
      inputDeviceId: "",
      outputDeviceId: "",
      inputDeviceName: "",
      outputDeviceName: "",
      routes: [],
    },
    switchInFlight: false,
  };

  const audioState = {
    sessions: [],
    focusedSession: null,
    playbackDevices: [],
    recordingDevices: [],
  };

  const viewState = {
    pendingFocusBindingId: null,
    editingBindingId: null,
    dragState: null,
    targetMenuListenerBound: false,
    activeMidiRouteCount: 0,
  };

  const clientPreferences = {
    persistedMidiInputId: "",
    persistedMidiOutputId: "",
    persistedMidiInputName: "",
    persistedMidiOutputName: "",
    persistedMidiRoutes: [],
    persistedActiveProfileName: "",
  };

  const liveState = {
    bindingInteractionTimes: {},
    bindingLastValues: {},
    bindingMuteValues: {},
    bindingTriggerFlashTimes: {},
    liveMidiValuesByControl: new Map(),
    volumeUpdateBatcher: null,
    lastVolumeUpdateAt: 0,
    osdBindingValues: new Map(),
    osdRelativeAutoFormatByBinding: new Map(),
    integrationTargetStateByKey: new Map(),
  };

  const osdState = {
    settings: { ...DEFAULT_OSD_SETTINGS },
    monitors: [],
  };

  const startupState = {
    appStarted: false,
    storageRecoveryNoticeShown: false,
  };
  return {
    features,
    profileState,
    audioState,
    viewState,
    clientPreferences,
    liveState,
    osdState,
    startupState,
  };
}

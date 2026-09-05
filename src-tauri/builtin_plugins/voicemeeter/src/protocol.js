export const INTEGRATION_ID = "voicemeeter";

export const POLL_MS = 100;

export const IDLE_POLL_MS = 500;

export const METER_POLL_MS = 250;

export const DISCONNECT_FAILURE_THRESHOLD = 3;

export const RECONNECT_MS = 2000;

export const WRITE_INTERVAL_MS = 16;

export const LOCAL_INTENT_MS = 900;

export const DEVICE_VERIFY_DELAYS_MS = [100, 250, 500, 1000];

export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

export function gainFromNormalized(value) {
  const normalized = clamp01(value);
  if (normalized <= 0) return -60;
  if (normalized <= 0.8) return Math.max(-60, 20 * Math.log10(normalized / 0.8));
  return ((normalized - 0.8) / 0.2) * 12;
}

export function normalizedFromGain(value) {
  const gain = clamp(value, -60, 12);
  if (gain <= -60) return 0;
  if (gain <= 0) return 0.8 * 10 ** (gain / 20);
  return 0.8 + (gain / 12) * 0.2;
}

export function normalizeContinuous(value, min, max, property = "") {
  if (String(property).toLowerCase() === "gain") return normalizedFromGain(value);
  if (max <= min) return 0;
  return clamp01((Number(value) - min) / (max - min));
}

export function denormalizeContinuous(value, min, max, property = "") {
  if (String(property).toLowerCase() === "gain") return gainFromNormalized(value);
  return min + clamp01(value) * (max - min);
}

export function parameterKey(parameter) {
  return `${String(parameter?.scope || "").toLowerCase()}:${Number(parameter?.index || 0)}:${String(parameter?.property || "").toLowerCase()}`;
}

export function shouldAcceptRemoteValue(intent, remoteValue, now = Date.now()) {
  if (!intent) return true;
  if (now - Number(intent.at || 0) >= LOCAL_INTENT_MS) return true;
  return Math.abs(Number(remoteValue) - Number(intent.value)) <= 0.001;
}

export function bindingUiSignature(state) {
  return JSON.stringify([
    Boolean(state?.status?.connected),
    state?.status?.edition || "",
    state?.stripLabels || [],
    state?.busLabels || [],
    state?.inputDevices || [],
    state?.outputDevices || [],
    state?.settings?.macro_aliases || {},
    state?.settings?.presets || [],
  ]);
}

export function shouldPollMeters({ mounted, documentHidden, tabActive, pageActive }) {
  return Boolean(mounted && !documentHidden && tabActive && pageActive);
}

export function pollingInterval({ dashboardVisible, needsLiveFeedback }) {
  return dashboardVisible || needsLiveFeedback ? POLL_MS : IDLE_POLL_MS;
}

export function meterPollDue({ dashboardVisible, force, now, lastMeterPollAt }) {
  return Boolean(dashboardVisible && (force || now - lastMeterPollAt >= METER_POLL_MS));
}

export function shouldMarkDisconnected(consecutiveFailures) {
  return Number(consecutiveFailures) >= DISCONNECT_FAILURE_THRESHOLD;
}

export function shouldRenderConnectionTransition(wasConnected, isConnected) {
  return !wasConnected && isConnected;
}

export function profileSettingsFromEvent(value) {
  return value?.settings && typeof value.settings === "object" ? value.settings : value || {};
}

export function buttonAction(label, behavior = "stateful") {
  const momentary = behavior === "momentary";
  return {
    label,
    value: momentary ? "SetMainOutputDevice" : "ToggleEffect",
    behavior: momentary ? "momentary" : "stateful",
  };
}

export function parameterButtonBehavior(scope, property) {
  const normalizedScope = String(scope || "").toLowerCase();
  const normalizedProperty = String(property || "").toLowerCase();
  return normalizedScope === "bus" && (normalizedProperty.startsWith("mode.") || normalizedProperty === "sel")
    ? "momentary"
    : "stateful";
}

export function isOneShotVoicemeeterTarget(target) {
  const kind = String(target?.kind || "").toLowerCase();
  if (["device_assignment", "preset", "command"].includes(kind)) return true;
  if (kind !== "parameter") return false;
  return parameterButtonBehavior(target?.data?.scope, target?.data?.property) === "momentary";
}

export function targetUsesPersistentFeedback(target) {
  if (String(target?.kind || "").toLowerCase() !== "parameter") return false;
  if (isOneShotVoicemeeterTarget(target)) return false;
  return String(target?.data?.action_kind || "").toLowerCase() !== "momentary";
}

export function deviceSlotKey(scope, index) {
  return `${String(scope || "").toLowerCase()}:${Number(index)}`;
}

export function assignableDevices(devices, direction, index) {
  const outputAfterA1 = String(direction).toLowerCase() === "output" && Number(index) > 0;
  return (Array.isArray(devices) ? devices : []).filter(
    (device) => !outputAfterA1 || String(device?.driver_type).toLowerCase() !== "asio",
  );
}

export function deviceVerificationResult(expectedName, observedState, error = null) {
  const expected = String(expectedName || "");
  const observed = String(observedState?.name || "");
  const sampleRate = Number(observedState?.sample_rate || 0);
  if (!expected && !observed) return { status: "success", observed, sampleRate };
  if (expected && observed === expected && sampleRate > 0) return { status: "success", observed, sampleRate };
  if (error) return { status: "read_error", observed, sampleRate, error: String(error) };
  if (observed === expected) return { status: "not_initialized", observed, sampleRate };
  return { status: "mismatch", observed, sampleRate };
}

export async function verifyDeviceAssignment({
  expectedName,
  readState,
  isCurrent,
  delays = DEVICE_VERIFY_DELAYS_MS,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let lastState = null;
  let lastError = null;
  let previousDelay = 0;
  for (const delay of delays) {
    await wait(Math.max(0, Number(delay) - previousDelay));
    previousDelay = Number(delay);
    if (!isCurrent()) return { status: "superseded" };
    try {
      lastState = await readState();
      lastError = null;
      const result = deviceVerificationResult(expectedName, lastState);
      if (result.status === "success") return result;
    } catch (error) {
      lastError = error;
    }
  }
  return deviceVerificationResult(expectedName, lastState, lastError);
}

export function deviceFeedbackMatches(data, assignedName, confirmed, devices) {
  const expectedName = String(data?.device_name || "");
  if (!expectedName || String(assignedName || "") !== expectedName) return false;
  const expectedDriver = String(data?.driver_type || "").toLowerCase();
  if (confirmed?.name === expectedName) return confirmed.driver === expectedDriver;
  const matchingDrivers = new Set(
    (Array.isArray(devices) ? devices : [])
      .filter((device) => String(device?.name || "") === expectedName)
      .map((device) => String(device?.driver_type || "").toLowerCase()),
  );
  return matchingDrivers.size === 1 && matchingDrivers.has(expectedDriver);
}

export function editionCode(status) {
  return Number(status?.edition_code || 0);
}

export function defaultLabel(scope, index, capabilities) {
  const physical =
    scope === "strip"
      ? index < Number(capabilities?.physical_strip_count || 0)
      : index < Number(capabilities?.physical_bus_count || 0);
  if (scope === "strip") return `${physical ? "Hardware Input" : "Virtual Input"} ${index + 1}`;
  if (physical) return `Hardware Output A${index + 1}`;
  return `Virtual Output B${index - Number(capabilities?.physical_bus_count || 0) + 1}`;
}

export function displayChannelLabel(scope, index, state) {
  const labels = scope === "strip" ? state.stripLabels : state.busLabels;
  return String(labels[index] || "").trim() || defaultLabel(scope, index, state.status?.capabilities);
}

export const STRIP_CONTINUOUS = [
  ["gain", "Gain", -60, 12, 1],
  ["pan_x", "Pan Left / Right", -0.5, 0.5, 1],
  ["pan_y", "Pan Front / Rear", -0.5, 1, 1],
  ["color_x", "Color X", -0.5, 0.5, 1, "physical"],
  ["color_y", "Color Y", -0.5, 1, 1, "physical"],
  ["audibility", "Audibility", 0, 10, 1],
  ["comp", "Compressor", 0, 10, 2, "physical"],
  ["gate", "Gate", 0, 10, 2, "physical"],
  ["limit", "Limiter", -40, 12, 2, "physical"],
  ["fx_x", "Modulation FX X", -0.5, 0.5, 2, "physical"],
  ["fx_y", "Modulation FX Y", 0, 1, 2, "physical"],
  ["eqgain1", "EQ Low", -12, 12, 1, "virtual"],
  ["eqgain2", "EQ Mid", -12, 12, 1, "virtual"],
  ["eqgain3", "EQ High", -12, 12, 1, "virtual"],
  ["denoiser", "Denoiser", 0, 10, 3, "physical"],
  ["reverb", "Reverb Send", 0, 10, 3],
  ["delay", "Delay Send", 0, 10, 3],
  ["fx1", "External FX 1 Send", 0, 10, 3],
  ["fx2", "External FX 2 Send", 0, 10, 3],
];

export const STRIP_BUTTONS = [
  ["mute", "Mute", 1],
  ["solo", "Solo", 1],
  ["mono", "Mono", 1, "physical"],
  ["mc", "Mute Center", 1, "virtual"],
  ["eq.on", "EQ On", 3],
  ["eq.ab", "EQ A/B", 3],
  ["postreverb", "Post Reverb", 3],
  ["postdelay", "Post Delay", 3],
  ["postfx1", "Post FX 1", 3],
  ["postfx2", "Post FX 2", 3],
];

export const BUS_CONTINUOUS = [
  ["gain", "Gain", -60, 12, 1],
  ["returnreverb", "Reverb Return", 0, 10, 3],
  ["returndelay", "Delay Return", 0, 10, 3],
  ["returnfx1", "FX 1 Return", 0, 10, 3],
  ["returnfx2", "FX 2 Return", 0, 10, 3],
];

export const BUS_BUTTONS = [
  ["mute", "Mute", 1],
  ["mono", "Mono / Stereo Reverse", 1],
  ["eq.on", "EQ On", 2],
  ["eq.ab", "EQ A/B", 2],
  ["mode.normal", "Normal Mode", 1],
  ["mode.amix", "Mix Down A", 1],
  ["mode.bmix", "Mix Down B", 2],
  ["mode.repeat", "Stereo Repeat", 1],
  ["mode.composite", "Composite", 1],
  ["mode.tvmix", "TV Mix", 2],
  ["mode.upmix21", "Up Mix 2.1", 2],
  ["mode.upmix41", "Up Mix 4.1", 2],
  ["mode.upmix61", "Up Mix 6.1", 2],
  ["mode.centeronly", "Center Only", 2],
  ["mode.lfeonly", "LFE Only", 2],
  ["mode.rearonly", "Rear Only", 2],
  ["sel", "Select", 3],
  ["monitor", "Monitor", 3],
];

export function routeProperties(code) {
  const routes = [
    ["a1", "Route to A1", 1],
    ["b1", "Route to B1", 1],
  ];
  if (code >= 2) routes.push(["a2", "Route to A2", 2], ["a3", "Route to A3", 2], ["b2", "Route to B2", 2]);
  if (code >= 3) routes.push(["a4", "Route to A4", 3], ["a5", "Route to A5", 3], ["b3", "Route to B3", 3]);
  return routes;
}

export function specApplies(spec, scope, index, state) {
  if (editionCode(state.status) < Number(spec[4] || spec[2] || 1)) return false;
  const kind = spec[5] || spec[3];
  if (scope !== "strip" || (kind !== "physical" && kind !== "virtual")) return true;
  const physical = index < Number(state.status?.capabilities?.physical_strip_count || 0);
  return kind === "physical" ? physical : !physical;
}

export function makeParameterTarget(scope, index, property, label, min = 0, max = 1, actionKind = null) {
  return {
    Integration: {
      integration_id: INTEGRATION_ID,
      kind: "parameter",
      data: {
        scope,
        index,
        property,
        min,
        max,
        label,
        ...(actionKind ? { action_kind: actionKind, action_label: label } : {}),
      },
    },
  };
}

export function parameterOption(scope, index, spec, state, isButton) {
  const property = spec[0];
  const controlLabel = spec[1];
  const min = isButton ? 0 : Number(spec[2]);
  const max = isButton ? (property === "mono" && scope === "bus" ? 2 : 1) : Number(spec[3]);
  const channel = displayChannelLabel(scope, index, state);
  const label = `${channel}: ${controlLabel}`;
  const behavior = isButton ? parameterButtonBehavior(scope, property) : null;
  return {
    label,
    icon_data: state.icon,
    ...(isButton ? { buttonActions: [buttonAction(controlLabel, behavior)] } : {}),
    target: makeParameterTarget(scope, index, property, label, min, max, behavior),
  };
}

export function parseNumberedAliases(raw) {
  const output = {};
  String(raw || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const match = line.match(/^\s*(\d+)\s*:\s*(.+?)\s*$/);
      const index = match ? Number(match[1]) - 1 : -1;
      if (match && index >= 0 && index < 80) output[String(index)] = match[2];
    });
  return output;
}

export function parsePresetLines(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s*:\s*(.+?)\s*$/);
      return match ? { slot: Number(match[1]) - 1, label: match[2] } : null;
    })
    .filter((entry) => entry && entry.slot >= 0 && entry.slot <= 255)
    .slice(0, 256);
}

export const voicemeeterTestUtils = {
  gainFromNormalized,
  normalizedFromGain,
  normalizeContinuous,
  denormalizeContinuous,
  parameterKey,
  shouldAcceptRemoteValue,
  bindingUiSignature,
  shouldPollMeters,
  pollingInterval,
  meterPollDue,
  shouldMarkDisconnected,
  shouldRenderConnectionTransition,
  profileSettingsFromEvent,
  buttonAction,
  parameterButtonBehavior,
  isOneShotVoicemeeterTarget,
  targetUsesPersistentFeedback,
  parameterOption,
  deviceSlotKey,
  assignableDevices,
  deviceVerificationResult,
  verifyDeviceAssignment,
  deviceFeedbackMatches,
  capabilitiesForEdition: (code) => ({
    strip_count: code === 1 ? 3 : code === 2 ? 5 : 8,
    physical_strip_count: code === 1 ? 2 : code === 2 ? 3 : 5,
    bus_count: code === 1 ? 2 : code === 2 ? 5 : 8,
    physical_bus_count: code === 1 ? 1 : code === 2 ? 3 : 5,
  }),
  routeProperties,
  parseNumberedAliases,
  parsePresetLines,
};

export function isOsdWindow() {
  try {
    return new URLSearchParams(window.location.search).get("osd") === "1";
  } catch {
    return false;
  }
}

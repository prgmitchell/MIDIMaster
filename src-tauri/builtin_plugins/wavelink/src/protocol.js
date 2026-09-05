import { sleep, clamp01 } from "../../../plugin_sources/shared/runtime.js";
export { sleep, clamp01 };
export const ORIGIN = "streamdeck://";

export const HOST = "127.0.0.1";

export const CONNECT_TIMEOUT_MS = 2000;

export const APP_INFO_TIMEOUT_MS = 1500;

export const VOLUME_WRITE_INTERVAL_MS = 16;

export const VOLUME_WRITE_EPSILON = 0.002;

export const STATE_REFRESH_DEBOUNCE_MS = 120;

export const LOCAL_WRITE_QUIET_MS = 1200;

export const FEEDBACK_INTENT_HOLD_MS = 1200;

export const FEEDBACK_INTENT_MATCH_EPSILON = 0.02;

export const RPC_TIMEOUT_MS = 1200;

export const RECONNECT_INITIAL_DELAY_MS = 1000;

export const RECONNECT_MAX_DELAY_MS = 15000;

export const RECONNECT_IDLE_DELAY_MS = 5000;

export let rpcSequence = 10;

export function nextRequestId() {
  rpcSequence += 1;
  if (rpcSequence > 2_000_000_000) rpcSequence = 10;
  return rpcSequence;
}

export function boolFromUnknown(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "on", "enabled", "active", "1"].includes(text)) return true;
    if (["false", "off", "disabled", "inactive", "0"].includes(text)) return false;
  }
  return null;
}

export function pickFirstString(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys) {
    const value = obj[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

export function shouldSyncMuteFeedback(action) {
  return action === "Volume" || action === "ToggleMute";
}

export const MAIN_OUTPUT_CYCLE_LABEL = "Cycle Main Output";

export function outputDeviceName(device) {
  return String(
    device?.name ||
      device?.displayName ||
      device?.display_name ||
      device?.output_device_name ||
      outputDeviceId(device) ||
      "Output Device",
  );
}

export function outputDeviceId(deviceOrData) {
  return pickFirstString(deviceOrData, ["output_device_id", "outputDeviceId", "device_id", "deviceId", "id"]);
}

export function outputId(deviceOrData) {
  const direct = pickFirstString(deviceOrData, ["output_id", "outputId"]);
  if (direct) return direct;
  const firstOutputId = deviceOrData?.outputs?.[0]?.id;
  if (firstOutputId != null && String(firstOutputId).trim()) return String(firstOutputId).trim();
  return outputDeviceId(deviceOrData);
}

export function normalizeOutputDevice(device) {
  const deviceId = outputDeviceId(device);
  if (!deviceId) return null;
  const nextOutputId = outputId(device) || deviceId;
  if (!nextOutputId) return null;
  return {
    output_device_id: deviceId,
    output_id: nextOutputId,
    output_device_name: outputDeviceName(device),
    device_type: String(device?.deviceType || device?.device_type || device?.type || ""),
  };
}

export function validOutputDevices(outputDevices) {
  if (!Array.isArray(outputDevices)) return [];
  return outputDevices.map(normalizeOutputDevice).filter(Boolean);
}

export function outputDeviceMatchesMainOutput(deviceOrData, mainOutput) {
  const deviceId = outputDeviceId(deviceOrData);
  const deviceOutputId = outputId(deviceOrData);
  const mainDeviceId = outputDeviceId(mainOutput);
  const mainOutputId = outputId(mainOutput);
  return Boolean(
    (deviceId && mainDeviceId && deviceId === mainDeviceId) ||
      (deviceOutputId && mainOutputId && deviceOutputId === mainOutputId) ||
      (deviceId && mainOutputId && deviceId === mainOutputId),
  );
}

export function nextMainOutputDevice(outputDevicesState) {
  const devices = validOutputDevices(outputDevicesState?.outputDevices);
  if (devices.length < 2) return null;
  const currentIndex = devices.findIndex((device) =>
    outputDeviceMatchesMainOutput(device, outputDevicesState?.mainOutput),
  );
  return devices[currentIndex >= 0 ? (currentIndex + 1) % devices.length : 0] || null;
}

export function createMainOutputCycleOption(outputDevices, iconDataUrl = null) {
  if (validOutputDevices(outputDevices).length < 2) return null;
  return {
    label: MAIN_OUTPUT_CYCLE_LABEL,
    icon_data: iconDataUrl || null,
    buttonActions: [{ label: MAIN_OUTPUT_CYCLE_LABEL, value: "SetMainOutputDevice", behavior: "momentary" }],
    target: {
      Integration: {
        integration_id: "wavelink",
        kind: "main_output_cycle",
        data: {
          label: MAIN_OUTPUT_CYCLE_LABEL,
          action_label: MAIN_OUTPUT_CYCLE_LABEL,
          action_kind: "momentary",
        },
      },
    },
  };
}

export const wavelinkTestUtils = {
  shouldSyncMuteFeedback,
  outputDeviceName,
  outputDeviceId,
  outputId,
  normalizeOutputDevice,
  validOutputDevices,
  outputDeviceMatchesMainOutput,
  nextMainOutputDevice,
  createMainOutputCycleOption,
};

export const ui = {
  statusText: null,
  statusDot: null,
  connectBtn: null,
  appInfoText: null,
  autoConnectInput: null,
  invalidateBindingsUI: null,
};

export let lastUiSig = "";

export const lastStatus = { connected: false, connecting: false, detail: "Not connected" };

export function setStatus(connected, detail = "", opts = null) {
  lastStatus.connected = Boolean(connected);
  lastStatus.connecting = opts && typeof opts === "object" ? Boolean(opts.connecting) : false;
  lastStatus.detail = detail || "";
  const disconnectedByUser = opts && typeof opts === "object" ? Boolean(opts.disconnectedByUser) : false;
  if (ui.statusText) {
    ui.statusText.textContent = connected ? detail || "Connected" : detail || "Not connected";
  }
  if (ui.statusDot) {
    ui.statusDot.classList.toggle("connected", Boolean(connected));
    ui.statusDot.classList.toggle("connecting", !connected && lastStatus.connecting);
    ui.statusDot.classList.toggle("error", !connected && !lastStatus.connecting && !disconnectedByUser);
  }

  if (ui.connectBtn) {
    if (lastStatus.connecting) {
      ui.connectBtn.disabled = true;
      ui.connectBtn.classList.add("disabled");
      ui.connectBtn.classList.remove("danger");
      ui.connectBtn.textContent = "Connecting...";
      return;
    }

    ui.connectBtn.disabled = false;
    ui.connectBtn.classList.remove("disabled");
    ui.connectBtn.classList.toggle("danger", Boolean(connected));
    ui.connectBtn.textContent = connected ? "Disconnect" : "Connect";
  }
  const sig = `${Boolean(connected)}:${Boolean(lastStatus.connecting)}:${Boolean(disconnectedByUser)}`;
  if (sig !== lastUiSig) {
    lastUiSig = sig;
    try {
      ui.invalidateBindingsUI?.();
    } catch {}
  }
}

export function normalizeEndpoint(target) {
  const t = target?.Integration || target?.integration;
  if (!t || t.integration_id !== "wavelink") {
    return null;
  }
  const data = t.data || {};
  const identifier = String(data.identifier ?? data.channel_id ?? data.channelId ?? data.id ?? "");
  const mixerId = String(data.mixer_id ?? data.mix_id ?? data.mixId ?? "");

  // New shapes
  if (t.kind === "mix") {
    return { identifier: "", mixer_id: mixerId };
  }
  if (t.kind === "channel") {
    return { identifier, mixer_id: "" };
  }
  if (t.kind === "channel_mix") {
    return { identifier, mixer_id: mixerId };
  }

  // Back-compat
  if (t.kind === "endpoint") {
    return {
      identifier,
      mixer_id: mixerId,
    };
  }

  return null;
}

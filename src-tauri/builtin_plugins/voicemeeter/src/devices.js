import {
  parameterKey,
  shouldAcceptRemoteValue,
  LOCAL_INTENT_MS,
  normalizeContinuous,
  clamp01,
  deviceSlotKey,
  verifyDeviceAssignment,
} from "./protocol.js";

/** devices workflow. */
export function createDevices({ ctx, state }) {
  async function applyFeedback(snapshot, silent = true) {
    const byParameter = state.feedbackCache;
    for (const entry of snapshot.values || []) {
      const key = parameterKey(entry);
      const intent = state.localIntents.get(key);
      if (!shouldAcceptRemoteValue(intent, entry.value)) continue;
      if (
        intent &&
        (Date.now() - intent.at >= LOCAL_INTENT_MS || Math.abs(Number(entry.value) - intent.value) <= 0.001)
      )
        state.localIntents.delete(key);
      for (const binding of byParameter.get(key) || []) {
        const min = Number(binding.data.min ?? 0);
        const max = Number(binding.data.max ?? 1);
        const normalized =
          binding.action === "Volume"
            ? normalizeContinuous(entry.value, min, max, binding.data.property)
            : clamp01(Number(entry.value) / Math.max(1, max));
        await ctx.feedback.set(binding.id, normalized, binding.action, { silent });
      }
    }
  }

  function setDeviceDiagnostic(message) {
    state.lastDeviceDiagnostic = String(message || "");
    if (state.ui.deviceDiagnostic) {
      state.ui.deviceDiagnostic.textContent = state.lastDeviceDiagnostic;
      state.ui.deviceDiagnostic.hidden = !state.lastDeviceDiagnostic;
    }
  }

  function assignmentFailureMessage(data, result, nativeError = null) {
    const slot =
      data.direction === "input"
        ? `Hardware Input ${Number(data.index) + 1}`
        : `Hardware Output A${Number(data.index) + 1}`;
    const driver = data.driver_type ? String(data.driver_type).toUpperCase() : "device clear";
    const device = String(data.device_name || "No device");
    const reason = nativeError
      ? String(nativeError)
      : result?.status === "not_initialized"
        ? "Voicemeeter selected the device but could not initialize its audio driver."
        : result?.status === "read_error"
          ? `MIDIMaster could not verify the device state: ${result.error}`
          : `Voicemeeter reported ${result?.observed ? `“${result.observed}”` : "no active device"} instead.`;
    return { slot, summary: `${slot} — ${driver}: ${device}`, detail: reason };
  }

  async function assignAndVerifyDevice(data) {
    const index = Number(data.index);
    const slotKey = deviceSlotKey(data.scope, index);
    const generation = Number(state.deviceRequestGenerations.get(slotKey) || 0) + 1;
    state.deviceRequestGenerations.set(slotKey, generation);
    const assignment = {
      scope: data.scope,
      index,
      direction: data.direction,
      driver_type: data.driver_type || null,
      name: data.device_name || "",
    };
    try {
      await ctx.tauri.invoke("voicemeeter_assign_device", { assignment });
    } catch (error) {
      if (state.deviceRequestGenerations.get(slotKey) !== generation) return;
      state.confirmedDevices.delete(slotKey);
      const failure = assignmentFailureMessage(data, null, error);
      setDeviceDiagnostic(`${failure.summary} — ${failure.detail}`);
      await ctx.app.showAlert(
        "Voicemeeter device assignment failed",
        `${failure.summary}\n\n${failure.detail}`,
      );
      return;
    }

    const result = await verifyDeviceAssignment({
      expectedName: data.device_name || "",
      isCurrent: () => !state.disposed && state.deviceRequestGenerations.get(slotKey) === generation,
      readState: () => ctx.tauri.invoke("voicemeeter_device_state", { scope: data.scope, index }),
    });
    if (result.status === "superseded") return;

    const targetDevices = data.direction === "input" ? state.inputDevices : state.outputDevices;
    targetDevices[index] = result.observed || "";
    if (result.status === "success") {
      if (data.device_name)
        state.confirmedDevices.set(slotKey, {
          name: String(data.device_name),
          driver: String(data.driver_type || "").toLowerCase(),
        });
      else state.confirmedDevices.delete(slotKey);
      const slot =
        data.direction === "input" ? `Hardware Input ${index + 1}` : `Hardware Output A${index + 1}`;
      const driver = data.driver_type ? `${String(data.driver_type).toUpperCase()} — ` : "";
      const rate = result.sampleRate > 0 ? ` at ${Math.round(result.sampleRate)} Hz` : "";
      setDeviceDiagnostic(`${slot}: ${driver}${data.device_name || "cleared"}${rate}`);
      return;
    }

    state.confirmedDevices.delete(slotKey);
    if (result.observed && result.observed === String(data.device_name || "")) {
      state.confirmedDevices.set(slotKey, { name: result.observed, driver: "" });
    }
    const failure = assignmentFailureMessage(data, result);
    setDeviceDiagnostic(`${failure.summary} — ${failure.detail}`);
    console.warn("Voicemeeter device assignment failed", {
      assignment,
      observed: result.observed,
      sampleRate: result.sampleRate,
      status: result.status,
      error: result.error || null,
    });
    await ctx.app.showAlert(
      "Voicemeeter device assignment failed",
      `${failure.summary}\n\n${failure.detail}`,
    );
  }

  return { applyFeedback, assignAndVerifyDevice };
}

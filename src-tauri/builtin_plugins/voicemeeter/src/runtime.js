import {
  pollingInterval,
  meterPollDue,
  shouldMarkDisconnected,
  parameterKey,
  WRITE_INTERVAL_MS,
} from "./protocol.js";

/** runtime workflow. */
export function createRuntime({
  applyFeedback,
  ctx,
  dashboardIsVisible,
  renderMeters,
  state,
  updateStatusUi,
}) {
  async function poll(force = false) {
    if (!state.status.connected || state.disposed || state.polling) return;
    const now = Date.now();
    const dashboardVisible = dashboardIsVisible();
    const needsLiveFeedback = state.parameterCache.length > 0;
    const pollInterval = pollingInterval({ dashboardVisible, needsLiveFeedback });
    if (!force && now - state.lastPollAt < pollInterval) return;
    state.lastPollAt = now;
    state.polling = true;
    try {
      const includeMeters = meterPollDue({
        dashboardVisible,
        force,
        now,
        lastMeterPollAt: state.lastMeterPollAt,
      });
      if (includeMeters) state.lastMeterPollAt = now;
      const snapshot = await ctx.tauri.invoke("voicemeeter_snapshot", {
        parameters: state.parameterCache,
        includeMeters,
        force,
      });
      if (!snapshot.status?.connected) {
        state.consecutivePollFailures += 1;
        if (!shouldMarkDisconnected(state.consecutivePollFailures)) return;
      } else {
        state.consecutivePollFailures = 0;
      }
      state.status = snapshot.status;
      if (snapshot.strip_labels?.length) state.stripLabels = snapshot.strip_labels;
      if (snapshot.bus_labels?.length) state.busLabels = snapshot.bus_labels;
      if (snapshot.input_devices?.length) state.inputDevices = snapshot.input_devices;
      if (snapshot.output_devices?.length) state.outputDevices = snapshot.output_devices;
      state.meters = snapshot.meters || [];
      if (force || snapshot.dirty || snapshot.macro_dirty) await applyFeedback(snapshot, true);
      updateStatusUi();
      if (includeMeters && snapshot.meters?.length) renderMeters();
    } catch (error) {
      state.consecutivePollFailures += 1;
      if (shouldMarkDisconnected(state.consecutivePollFailures)) {
        state.status = { ...state.status, connected: false, detail: "Voicemeeter is not running" };
        updateStatusUi();
      }
    } finally {
      state.polling = false;
    }
  }

  function scheduleWrite(parameter, value) {
    const key = parameterKey(parameter);
    state.pendingWrites.set(key, { ...parameter, value });
    state.localIntents.set(key, { value, at: Date.now() });
    if (state.writeTimer) return;
    state.writeTimer = setTimeout(async () => {
      state.writeTimer = null;
      const writes = Array.from(state.pendingWrites.values());
      state.pendingWrites.clear();
      if (!writes.length || !state.status.connected) return;
      try {
        await ctx.tauri.invoke("voicemeeter_write_parameters", { writes });
      } catch (error) {
        console.warn("Voicemeeter write failed", error);
        state.status = { ...state.status, detail: "Connected — last control write failed" };
        updateStatusUi();
        poll(true).catch(() => {});
      }
    }, WRITE_INTERVAL_MS);
  }

  return { poll, scheduleWrite };
}

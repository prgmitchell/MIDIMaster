import { createIntegration } from "./integration.js";
import { createDashboard } from "./dashboard.js";
import { createTargets } from "./targets.js";
import { createRuntime } from "./runtime.js";
import { createDevices } from "./devices.js";
import { createConnection } from "./connection.js";
import { createBindings } from "./bindings.js";
import { INTEGRATION_ID, POLL_MS, RECONNECT_MS, profileSettingsFromEvent, isOsdWindow } from "./protocol.js";
export { voicemeeterTestUtils } from "./protocol.js";

export async function activate(ctx) {
  let icon = null;
  try {
    icon = await ctx.assets.readDataUrl("VoicemeeterLogo.png", "image/png");
  } catch {
    icon = null;
  }

  if (isOsdWindow()) {
    ctx.registerIntegration({
      id: INTEGRATION_ID,
      name: "Voicemeeter",
      icon_data: icon,
      describeTarget: (raw) => {
        const target = raw?.Integration || raw?.integration || {};
        return { label: target.data?.label || "Voicemeeter", icon_data: icon, ghost: true };
      },
      getTargetOptions: () => [],
      onBindingTriggered: async () => {},
    });
    return;
  }

  const state = {
    icon,
    status: { connected: false, installed: false, installed_editions: [] },
    stripLabels: [],
    busLabels: [],
    inputDevices: [],
    outputDevices: [],
    devices: { input: [], output: [] },
    meters: [],
    mounted: false,
    disposed: false,
    disconnectedByUser: false,
    connecting: false,
    polling: false,
    lastPollAt: 0,
    lastMeterPollAt: 0,
    consecutivePollFailures: 0,
    settings: { auto_connect: true, preferred_edition: "banana", macro_aliases: {}, presets: [] },
    lastBindingUiSignature: "",
    lastStatusUiSignature: "",
    meterLayoutSignature: "",
    meterElements: new Map(),
    parameterCache: [],
    feedbackCache: new Map(),
    ui: {},
    pendingWrites: new Map(),
    localIntents: new Map(),
    writeTimer: null,
    deviceRequestGenerations: new Map(),
    confirmedDevices: new Map(),
    lastDeviceDiagnostic: "",
  };

  const { resetLegacyOneShotFeedback, rebuildBindingCache } = createBindings({
    ctx,
    state,
  });

  const { dashboardIsVisible, updateStatusUi, refreshDevices, connect, disconnect } = createConnection({
    ctx,
    poll: (...args) => poll(...args),
    renderDashboard: (...args) => renderDashboard(...args),
    state,
  });

  const { applyFeedback, assignAndVerifyDevice } = createDevices({
    ctx,
    state,
  });

  const { poll, scheduleWrite } = createRuntime({
    applyFeedback,
    ctx,
    dashboardIsVisible,
    renderMeters: (...args) => renderMeters(...args),
    state,
    updateStatusUi,
  });

  const { targetOptions, onTriggered } = createTargets({
    assignAndVerifyDevice,
    ctx,
    icon,
    resetLegacyOneShotFeedback,
    scheduleWrite,
    state,
  });

  const { renderMeters, renderDashboard } = createDashboard({
    connect,
    ctx,
    disconnect,
    icon,
    poll,
    refreshDevices,
    state,
    updateStatusUi,
  });

  const { registerPluginIntegration } = createIntegration({
    ctx,
    icon,
    onTriggered,
    state,
    targetOptions,
  });

  registerPluginIntegration();

  if (!isOsdWindow())
    ctx.connections.registerTab({
      id: INTEGRATION_ID,
      name: "Voicemeeter",
      icon_data: icon,
      order: 35,
      mount: (container) => {
        state.mounted = true;
        state.ui.root = container;
        renderDashboard();
        poll(true).catch(() => {});
      },
      unmount: () => {
        state.mounted = false;
        state.meterElements.clear();
        state.meterLayoutSignature = "";
        state.ui = {};
      },
    });

  const applyProfile = (value) => {
    const settings = profileSettingsFromEvent(value);
    state.settings = {
      auto_connect: settings?.auto_connect ?? true,
      preferred_edition: settings?.preferred_edition || "banana",
      macro_aliases: settings?.macro_aliases || {},
      presets: Array.isArray(settings?.presets) ? settings.presets : [],
    };
    if (state.mounted) renderDashboard();
  };
  applyProfile(ctx.profile.get());
  ctx.profile.onChanged(applyProfile);
  rebuildBindingCache();
  ctx.bindings.onChanged(() => {
    rebuildBindingCache();
    if (state.status.connected) poll(true).catch(() => {});
  });

  const pollTimer = setInterval(() => poll(false).catch(() => {}), POLL_MS);
  const reconnectTimer = setInterval(() => {
    if (
      state.settings.auto_connect &&
      !state.disconnectedByUser &&
      !state.status.connected &&
      !state.connecting
    )
      connect().catch(() => {});
  }, RECONNECT_MS);
  if (state.settings.auto_connect) connect().catch(() => {});

  ctx.lifecycle.onDispose(() => {
    state.disposed = true;
    clearInterval(pollTimer);
    clearInterval(reconnectTimer);
    if (state.writeTimer) clearTimeout(state.writeTimer);
    state.pendingWrites.clear();
    state.localIntents.clear();
    state.deviceRequestGenerations.clear();
    state.confirmedDevices.clear();
    ctx.tauri.invoke("voicemeeter_disconnect").catch(() => {});
  });
}

const INTEGRATION_ID = "voicemeeter";
const POLL_MS = 100;
const IDLE_POLL_MS = 500;
const METER_POLL_MS = 250;
const DISCONNECT_FAILURE_THRESHOLD = 3;
const RECONNECT_MS = 2000;
const WRITE_INTERVAL_MS = 16;
const LOCAL_INTENT_MS = 900;

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

// Audio taper with unity at 80% and a short +12 dB headroom region.
function gainFromNormalized(value) {
  const normalized = clamp01(value);
  if (normalized <= 0) return -60;
  if (normalized <= 0.8) return Math.max(-60, 20 * Math.log10(normalized / 0.8));
  return ((normalized - 0.8) / 0.2) * 12;
}

function normalizedFromGain(value) {
  const gain = clamp(value, -60, 12);
  if (gain <= -60) return 0;
  if (gain <= 0) return 0.8 * (10 ** (gain / 20));
  return 0.8 + (gain / 12) * 0.2;
}

function normalizeContinuous(value, min, max, property = "") {
  if (String(property).toLowerCase() === "gain") return normalizedFromGain(value);
  if (max <= min) return 0;
  return clamp01((Number(value) - min) / (max - min));
}

function denormalizeContinuous(value, min, max, property = "") {
  if (String(property).toLowerCase() === "gain") return gainFromNormalized(value);
  return min + clamp01(value) * (max - min);
}

function parameterKey(parameter) {
  return `${String(parameter?.scope || "").toLowerCase()}:${Number(parameter?.index || 0)}:${String(parameter?.property || "").toLowerCase()}`;
}

function shouldAcceptRemoteValue(intent, remoteValue, now = Date.now()) {
  if (!intent) return true;
  if ((now - Number(intent.at || 0)) >= LOCAL_INTENT_MS) return true;
  return Math.abs(Number(remoteValue) - Number(intent.value)) <= 0.001;
}

function bindingUiSignature(state) {
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

function shouldPollMeters({ mounted, documentHidden, tabActive, pageActive }) {
  return Boolean(mounted && !documentHidden && tabActive && pageActive);
}

function pollingInterval({ dashboardVisible, needsLiveFeedback }) {
  return (dashboardVisible || needsLiveFeedback) ? POLL_MS : IDLE_POLL_MS;
}

function meterPollDue({ dashboardVisible, force, now, lastMeterPollAt }) {
  return Boolean(dashboardVisible && (force || (now - lastMeterPollAt) >= METER_POLL_MS));
}

function shouldMarkDisconnected(consecutiveFailures) {
  return Number(consecutiveFailures) >= DISCONNECT_FAILURE_THRESHOLD;
}

function shouldRenderConnectionTransition(wasConnected, isConnected) {
  return !wasConnected && isConnected;
}

function profileSettingsFromEvent(value) {
  return value?.settings && typeof value.settings === "object" ? value.settings : (value || {});
}

function editionCode(status) {
  return Number(status?.edition_code || 0);
}

function defaultLabel(scope, index, capabilities) {
  const physical = scope === "strip"
    ? index < Number(capabilities?.physical_strip_count || 0)
    : index < Number(capabilities?.physical_bus_count || 0);
  if (scope === "strip") return `${physical ? "Hardware Input" : "Virtual Input"} ${index + 1}`;
  if (physical) return `Hardware Output A${index + 1}`;
  return `Virtual Output B${index - Number(capabilities?.physical_bus_count || 0) + 1}`;
}

function displayChannelLabel(scope, index, state) {
  const labels = scope === "strip" ? state.stripLabels : state.busLabels;
  return String(labels[index] || "").trim() || defaultLabel(scope, index, state.status?.capabilities);
}

const STRIP_CONTINUOUS = [
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

const STRIP_BUTTONS = [
  ["mute", "Mute", 1], ["solo", "Solo", 1], ["mono", "Mono", 1, "physical"], ["mc", "Mute Center", 1, "virtual"],
  ["eq.on", "EQ On", 3], ["eq.ab", "EQ A/B", 3],
  ["postreverb", "Post Reverb", 3], ["postdelay", "Post Delay", 3],
  ["postfx1", "Post FX 1", 3], ["postfx2", "Post FX 2", 3],
];

const BUS_CONTINUOUS = [
  ["gain", "Gain", -60, 12, 1],
  ["returnreverb", "Reverb Return", 0, 10, 3], ["returndelay", "Delay Return", 0, 10, 3],
  ["returnfx1", "FX 1 Return", 0, 10, 3], ["returnfx2", "FX 2 Return", 0, 10, 3],
];

const BUS_BUTTONS = [
  ["mute", "Mute", 1], ["mono", "Mono / Stereo Reverse", 1],
  ["eq.on", "EQ On", 2], ["eq.ab", "EQ A/B", 2],
  ["mode.normal", "Normal Mode", 1], ["mode.amix", "Mix Down A", 1],
  ["mode.bmix", "Mix Down B", 2], ["mode.repeat", "Stereo Repeat", 1],
  ["mode.composite", "Composite", 1], ["mode.tvmix", "TV Mix", 2],
  ["mode.upmix21", "Up Mix 2.1", 2], ["mode.upmix41", "Up Mix 4.1", 2],
  ["mode.upmix61", "Up Mix 6.1", 2], ["mode.centeronly", "Center Only", 2],
  ["mode.lfeonly", "LFE Only", 2], ["mode.rearonly", "Rear Only", 2],
  ["sel", "Select", 3], ["monitor", "Monitor", 3],
];

function routeProperties(code) {
  const routes = [["a1", "Route to A1", 1], ["b1", "Route to B1", 1]];
  if (code >= 2) routes.push(["a2", "Route to A2", 2], ["a3", "Route to A3", 2], ["b2", "Route to B2", 2]);
  if (code >= 3) routes.push(["a4", "Route to A4", 3], ["a5", "Route to A5", 3], ["b3", "Route to B3", 3]);
  return routes;
}

function specApplies(spec, scope, index, state) {
  if (editionCode(state.status) < Number(spec[4] || spec[2] || 1)) return false;
  const kind = spec[5] || spec[3];
  if (scope !== "strip" || (kind !== "physical" && kind !== "virtual")) return true;
  const physical = index < Number(state.status?.capabilities?.physical_strip_count || 0);
  return kind === "physical" ? physical : !physical;
}

function makeParameterTarget(scope, index, property, label, min = 0, max = 1, actionKind = null) {
  return {
    Integration: {
      integration_id: INTEGRATION_ID,
      kind: "parameter",
      data: {
        scope, index, property, min, max, label,
        ...(actionKind ? { action_kind: actionKind, action_label: label } : {}),
      },
    },
  };
}

function parameterOption(scope, index, spec, state, isButton) {
  const property = spec[0];
  const controlLabel = spec[1];
  const min = isButton ? 0 : Number(spec[2]);
  const max = isButton ? (property === "mono" && scope === "bus" ? 2 : 1) : Number(spec[3]);
  const channel = displayChannelLabel(scope, index, state);
  const label = `${channel}: ${controlLabel}`;
  return {
    label,
    icon_data: state.icon,
    ...(isButton ? { buttonActions: [{ label: controlLabel, value: "ToggleEffect", behavior: "stateful" }] } : {}),
    target: makeParameterTarget(scope, index, property, label, min, max, isButton ? "stateful" : null),
  };
}

function parseNumberedAliases(raw) {
  const output = {};
  String(raw || "").split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*(\d+)\s*:\s*(.+?)\s*$/);
    const index = match ? Number(match[1]) - 1 : -1;
    if (match && index >= 0 && index < 80) output[String(index)] = match[2];
  });
  return output;
}

function parsePresetLines(raw) {
  return String(raw || "").split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s*:\s*(.+?)\s*$/);
    return match ? { slot: Number(match[1]) - 1, label: match[2] } : null;
  }).filter((entry) => entry && entry.slot >= 0 && entry.slot <= 255).slice(0, 256);
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

function isOsdWindow() {
  try { return new URLSearchParams(window.location.search).get("osd") === "1"; } catch { return false; }
}

export async function activate(ctx) {
  let icon = null;
  try { icon = await ctx.assets.readDataUrl("VoicemeeterLogo.png", "image/png"); } catch { icon = null; }

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
    stripLabels: [], busLabels: [], inputDevices: [], outputDevices: [], devices: { input: [], output: [] },
    meters: [], mounted: false, disposed: false, disconnectedByUser: false, connecting: false, polling: false,
    lastPollAt: 0, lastMeterPollAt: 0, consecutivePollFailures: 0,
    settings: { auto_connect: true, preferred_edition: "banana", macro_aliases: {}, presets: [] },
    lastBindingUiSignature: "", lastStatusUiSignature: "", meterLayoutSignature: "", meterElements: new Map(),
    parameterCache: [], feedbackCache: new Map(), deviceFeedbackCache: [],
    ui: {}, pendingWrites: new Map(), localIntents: new Map(), writeTimer: null,
  };

  function integrationTargets(binding) {
    const targets = Array.isArray(binding?.targets) && binding.targets.length ? binding.targets : [binding?.target];
    return targets.map((target) => target?.Integration || target?.integration).filter((target) => target?.integration_id === INTEGRATION_ID);
  }

  function rebuildBindingCache() {
    const seen = new Map();
    const feedback = new Map();
    const deviceFeedback = [];
    for (const binding of ctx.bindings.getAll() || []) {
      for (const target of integrationTargets(binding)) {
        const data = target.data || {};
        if (target.kind === "parameter" && data.scope && data.property != null) {
          const parameter = { scope: data.scope, index: Number(data.index), property: data.property };
          const key = parameterKey(parameter);
          seen.set(key, parameter);
          if (!feedback.has(key)) feedback.set(key, []);
          feedback.get(key).push({ id: binding.id, action: binding.action || "Volume", data });
        } else if (target.kind === "device_assignment" && binding?.id) {
          deviceFeedback.push({ binding, data });
        }
      }
    }
    state.parameterCache = Array.from(seen.values());
    state.feedbackCache = feedback;
    state.deviceFeedbackCache = deviceFeedback;
  }

  function dashboardIsVisible() {
    const tab = state.ui.root?.closest?.(".connection-tab");
    const page = state.ui.root?.closest?.("[data-page-panel]");
    return shouldPollMeters({
      mounted: state.mounted,
      documentHidden: document.hidden,
      tabActive: tab?.classList.contains("active"),
      pageActive: page?.classList.contains("active"),
    });
  }

  function updateStatusUi(detail = null) {
    const connected = Boolean(state.status.connected);
    const statusUiSignature = JSON.stringify([connected, state.connecting, state.status.installed, state.status.edition, state.status.version, detail || state.status.detail]);
    if (statusUiSignature !== state.lastStatusUiSignature) {
      state.lastStatusUiSignature = statusUiSignature;
      if (state.ui.status) state.ui.status.textContent = detail || state.status.detail || (connected ? "Connected" : "Not connected");
      state.ui.dot?.classList.toggle("connected", connected);
      state.ui.dot?.classList.toggle("connecting", !connected && state.connecting);
      state.ui.dot?.classList.toggle("error", !connected && !state.connecting && state.status.installed === false);
      if (state.ui.connect) {
        state.ui.connect.textContent = state.connecting ? "Connecting…" : connected ? "Disconnect" : "Connect";
        state.ui.connect.disabled = state.connecting;
        state.ui.connect.classList.toggle("danger", connected);
      }
      if (state.ui.edition) {
        const edition = state.status.edition ? `${state.status.edition[0].toUpperCase()}${state.status.edition.slice(1)}` : "—";
        state.ui.edition.textContent = state.status.version ? `${edition} ${state.status.version}` : edition;
      }
    }
    const nextBindingUiSignature = bindingUiSignature(state);
    if (nextBindingUiSignature !== state.lastBindingUiSignature) {
      state.lastBindingUiSignature = nextBindingUiSignature;
      ctx.app.invalidateBindingsUI();
    }
  }

  async function refreshDevices() {
    if (!state.status.connected) return;
    const [input, output] = await Promise.all([
      ctx.tauri.invoke("voicemeeter_list_devices", { direction: "input" }).catch(() => []),
      ctx.tauri.invoke("voicemeeter_list_devices", { direction: "output" }).catch(() => []),
    ]);
    state.devices = { input: Array.isArray(input) ? input : [], output: Array.isArray(output) ? output : [] };
  }

  async function connect({ manual = false } = {}) {
    if (state.connecting || state.disposed) return false;
    const wasConnected = Boolean(state.status.connected);
    let renderConnectedDashboard = false;
    state.connecting = true;
    if (manual) state.disconnectedByUser = false;
    if (manual) updateStatusUi("Connecting…");
    try {
      state.status = await ctx.tauri.invoke("voicemeeter_connect");
      if (state.status.connected) {
        state.consecutivePollFailures = 0;
        await refreshDevices();
        await poll(true);
        renderConnectedDashboard = shouldRenderConnectionTransition(wasConnected, true);
      }
      return Boolean(state.status.connected);
    } catch (error) {
      state.status = { ...state.status, connected: false, detail: String(error) };
      if (manual) updateStatusUi(String(error));
      return false;
    } finally {
      state.connecting = false;
      if (renderConnectedDashboard) renderDashboard();
      else updateStatusUi();
    }
  }

  async function disconnect({ manual = true } = {}) {
    if (manual) state.disconnectedByUser = true;
    state.pendingWrites.clear();
    state.consecutivePollFailures = 0;
    try { await ctx.tauri.invoke("voicemeeter_disconnect"); } catch { /* already disconnected */ }
    state.localIntents.clear();
    state.status = { ...state.status, connected: false, detail: "Not connected" };
    updateStatusUi();
    renderDashboard();
  }

  async function applyFeedback(snapshot, silent = true) {
    const byParameter = state.feedbackCache;
    for (const entry of snapshot.values || []) {
      const key = parameterKey(entry);
      const intent = state.localIntents.get(key);
      if (!shouldAcceptRemoteValue(intent, entry.value)) continue;
      if (intent && ((Date.now() - intent.at) >= LOCAL_INTENT_MS || Math.abs(Number(entry.value) - intent.value) <= 0.001)) state.localIntents.delete(key);
      for (const binding of byParameter.get(key) || []) {
        const min = Number(binding.data.min ?? 0);
        const max = Number(binding.data.max ?? 1);
        const normalized = binding.action === "Volume"
          ? normalizeContinuous(entry.value, min, max, binding.data.property)
          : clamp01(Number(entry.value) / Math.max(1, max));
        await ctx.feedback.set(binding.id, normalized, binding.action, { silent });
      }
    }
    for (const entry of state.deviceFeedbackCache) {
      const { binding, data } = entry;
      const assigned = data.direction === "input"
        ? snapshot.input_devices?.[Number(data.index)]
        : snapshot.output_devices?.[Number(data.index)];
      const selected = Boolean(data.device_name) && String(assigned || "") === String(data.device_name);
      await ctx.feedback.set(binding.id, selected ? 1 : 0, binding.action || "ToggleEffect", { silent });
    }
  }

  async function poll(force = false) {
    if (!state.status.connected || state.disposed || state.polling) return;
    const now = Date.now();
    const dashboardVisible = dashboardIsVisible();
    const needsLiveFeedback = state.parameterCache.length > 0 || state.deviceFeedbackCache.length > 0;
    const pollInterval = pollingInterval({ dashboardVisible, needsLiveFeedback });
    if (!force && (now - state.lastPollAt) < pollInterval) return;
    state.lastPollAt = now;
    state.polling = true;
    try {
      const includeMeters = meterPollDue({ dashboardVisible, force, now, lastMeterPollAt: state.lastMeterPollAt });
      if (includeMeters) state.lastMeterPollAt = now;
      const snapshot = await ctx.tauri.invoke("voicemeeter_snapshot", {
        parameters: state.parameterCache, includeMeters, force,
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
      try { await ctx.tauri.invoke("voicemeeter_write_parameters", { writes }); }
      catch (error) {
        console.warn("Voicemeeter write failed", error);
        state.status = { ...state.status, detail: "Connected — last control write failed" };
        updateStatusUi();
        poll(true).catch(() => {});
      }
    }, WRITE_INTERVAL_MS);
  }

  function targetOptions({ controlType, nav } = {}) {
    if (!state.status.connected) return [];
    const isButton = controlType === "button";
    const section = String(nav?.section || "");
    const caps = state.status.capabilities || {};
    const channelOptions = (scope, nextSection) => Array.from({ length: Number(scope === "strip" ? caps.strip_count : caps.bus_count) }, (_, index) => ({
      label: displayChannelLabel(scope, index, state), icon_data: icon, nav: { section: nextSection, scope, index },
    }));

    if (!section) {
      const groups = [
        { label: "Input Strips", nav: { section: "strips" }, description: "Gain, dynamics, EQ, mute, solo, and processing." },
        { label: "Output Buses", nav: { section: "buses" }, description: "Bus gain, modes, EQ, mute, and returns." },
      ];
      if (isButton) groups.push(
        { label: "Strip Routing", nav: { section: "routing" }, description: "Toggle strip assignments to A and B buses." },
        { label: "Hardware Devices", nav: { section: "devices" }, description: "Assign physical inputs and hardware output devices." },
        { label: "MacroButtons", nav: { section: "macros", offset: 0 }, description: "Trigger any of the 80 Voicemeeter MacroButtons." },
        { label: "Presets", nav: { section: "presets" }, description: "Recall preset slots configured on the dashboard." },
        { label: "Engine Actions", nav: { section: "commands" }, description: "Show Voicemeeter or restart its audio engine." },
      );
      return groups.map((item) => ({ ...item, icon_data: icon }));
    }
    if (section === "strips") return channelOptions("strip", "controls");
    if (section === "buses") return channelOptions("bus", "controls");
    if (section === "routing") return channelOptions("strip", "routes");
    if (section === "controls") {
      const scope = String(nav.scope); const index = Number(nav.index);
      const specs = scope === "strip" ? (isButton ? STRIP_BUTTONS : STRIP_CONTINUOUS) : (isButton ? BUS_BUTTONS : BUS_CONTINUOUS);
      return specs.filter((spec) => specApplies(spec, scope, index, state)).map((spec) => parameterOption(scope, index, spec, state, isButton));
    }
    if (section === "routes") return routeProperties(editionCode(state.status)).map((spec) => parameterOption("strip", Number(nav.index), spec, state, true));
    if (section === "devices") return [
      { label: "Hardware Inputs", icon_data: icon, nav: { section: "device_slots", direction: "input", scope: "strip" } },
      { label: "Hardware Outputs", icon_data: icon, nav: { section: "device_slots", direction: "output", scope: "bus" } },
    ];
    if (section === "device_slots") {
      const count = nav.direction === "input" ? caps.physical_strip_count : caps.physical_bus_count;
      return Array.from({ length: Number(count) }, (_, index) => ({ label: nav.direction === "input" ? `Hardware Input ${index + 1}` : `Hardware Output A${index + 1}`, icon_data: icon, nav: { section: "device_choices", direction: nav.direction, scope: nav.scope, index } }));
    }
    if (section === "device_choices") {
      const current = nav.direction === "input" ? state.inputDevices[nav.index] : state.outputDevices[nav.index];
      const clear = { label: "Clear device", icon_data: icon, buttonActions: [{ label: "Clear Device", value: "SetMainOutputDevice", behavior: "momentary" }], target: { Integration: { integration_id: INTEGRATION_ID, kind: "device_assignment", data: { scope: nav.scope, index: Number(nav.index), direction: nav.direction, driver_type: null, device_name: "", label: `Clear ${nav.direction} device`, action_kind: "momentary" } } } };
      return [clear, ...(state.devices[nav.direction] || []).map((device) => ({
        label: `${device.driver_type.toUpperCase()}: ${device.name}${current === device.name ? " (Selected)" : ""}`, icon_data: icon,
        buttonActions: [{ label: "Select Device", value: "ToggleEffect", behavior: "stateful" }],
        target: { Integration: { integration_id: INTEGRATION_ID, kind: "device_assignment", data: { scope: nav.scope, index: Number(nav.index), direction: nav.direction, driver_type: device.driver_type, device_name: device.name, label: `${nav.direction === "input" ? "Input" : `A${Number(nav.index) + 1}`}: ${device.name}`, action_kind: "stateful" } } },
      }))];
    }
    if (section === "macros") {
      const offset = Number(nav.offset || 0); const aliases = state.settings.macro_aliases || {};
      const options = Array.from({ length: Math.min(20, 80 - offset) }, (_, item) => {
        const index = offset + item; const name = aliases[String(index)] || `MacroButton ${index + 1}`;
        const target = makeParameterTarget("macro", index, "state", name, 0, 1, "stateful");
        return { label: name, icon_data: icon, buttonActions: [
          { label: "Toggle", value: "ToggleEffect", behavior: "stateful" },
          { label: "Push / Release", value: "Volume", behavior: "momentary" },
        ], target };
      });
      if (offset + 20 < 80) options.push({ label: `MacroButtons ${offset + 21}–${Math.min(80, offset + 40)}`, icon_data: icon, nav: { section: "macros", offset: offset + 20 } });
      return options;
    }
    if (section === "presets") return (state.settings.presets || []).map((preset) => ({ label: preset.label, icon_data: icon, buttonActions: [{ label: "Recall Preset", value: "SetMainOutputDevice", behavior: "momentary" }], target: { Integration: { integration_id: INTEGRATION_ID, kind: "preset", data: { slot: preset.slot, label: preset.label, action_kind: "momentary" } } } }));
    if (section === "commands") return [
      { label: "Show Voicemeeter", icon_data: icon, buttonActions: [{ label: "Show", value: "SetMainOutputDevice", behavior: "momentary" }], target: { Integration: { integration_id: INTEGRATION_ID, kind: "command", data: { command: "show", label: "Show Voicemeeter", action_kind: "momentary" } } } },
      { label: "Restart Audio Engine", icon_data: icon, buttonActions: [{ label: "Restart", value: "SetMainOutputDevice", behavior: "momentary" }], target: { Integration: { integration_id: INTEGRATION_ID, kind: "command", data: { command: "restart", label: "Restart Voicemeeter Audio Engine", action_kind: "momentary" } } } },
    ];
    return [];
  }

  async function onTriggered(payload) {
    const target = payload?.target || {}; const data = target.data || {}; const value = clamp01(payload?.value);
    if (target.kind === "parameter") {
      const min = Number(data.min ?? 0); const max = Number(data.max ?? 1);
      const raw = payload.action === "Volume" ? denormalizeContinuous(value, min, max, data.property) : (max > 1 ? (value > 0.5 ? max : 0) : (value > 0.5 ? 1 : 0));
      scheduleWrite({ scope: data.scope, index: Number(data.index), property: data.property }, raw);
      if (payload.binding_id && payload.is_primary_target !== false) await ctx.feedback.set(payload.binding_id, value, payload.action);
      return;
    }
    if (value <= 0) return;
    if (target.kind === "device_assignment") {
      await ctx.tauri.invoke("voicemeeter_assign_device", { assignment: { scope: data.scope, index: Number(data.index), direction: data.direction, driver_type: data.driver_type || null, name: data.device_name || "" } });
      await poll(true); return;
    }
    if (target.kind === "preset") { await ctx.tauri.invoke("voicemeeter_safe_command", { action: "preset", index: Number(data.slot) }); return; }
    if (target.kind === "command") { await ctx.tauri.invoke("voicemeeter_safe_command", { action: data.command, index: null }); return; }
  }

  function renderMeters() {
    if (!state.ui.meters) return;
    const meters = new Map((state.meters || []).map((entry) => [`${entry.scope}:${entry.index}`, entry.level]));
    const caps = state.status.capabilities || {};
    const layoutSignature = JSON.stringify([state.stripLabels, state.busLabels, state.inputDevices, state.outputDevices, caps.strip_count, caps.bus_count]);
    if (layoutSignature !== state.meterLayoutSignature) {
      const rows = [];
      for (const scope of ["strip", "bus"]) {
        const count = Number(scope === "strip" ? caps.strip_count : caps.bus_count);
        for (let index = 0; index < count; index += 1) {
          const level = clamp01(meters.get(`${scope}:${index}`) || 0);
          const device = scope === "strip" ? state.inputDevices[index] : state.outputDevices[index];
          rows.push(`<div class="vm-channel"><div class="vm-channel-copy"><strong>${escapeHtml(displayChannelLabel(scope, index, state))}</strong><span>${escapeHtml(device || (scope === "strip" ? "Input strip" : "Output bus"))}</span></div><div class="vm-meter"><i style="--level:${Math.round(level * 100)}%"></i></div><span class="vm-state">${scope === "strip" ? `IN ${index + 1}` : `BUS ${index + 1}`}</span></div>`);
        }
      }
      state.meterLayoutSignature = layoutSignature;
      state.ui.meters.innerHTML = rows.join("") || `<div class="vm-empty">Connect to see channels and live levels.</div>`;
      state.meterElements = new Map(Array.from(state.ui.meters.querySelectorAll(".vm-meter i")).map((element, index) => {
        const stripCount = Number(caps.strip_count || 0);
        return [index < stripCount ? `strip:${index}` : `bus:${index - stripCount}`, element];
      }));
    }
    for (const [key, element] of state.meterElements) element.style.setProperty("--level", `${Math.round(clamp01(meters.get(key) || 0) * 100)}%`);
  }

  function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value || ""); return node.innerHTML; }

  async function saveDashboardSettings() {
    state.settings = {
      ...state.settings,
      auto_connect: Boolean(state.ui.auto?.checked),
      preferred_edition: state.ui.launchEdition?.value || "banana",
      macro_aliases: parseNumberedAliases(state.ui.aliases?.value),
      presets: parsePresetLines(state.ui.presets?.value),
    };
    await ctx.profile.set(state.settings);
  }

  function dashboardStyles() {
    return `<style>
      .vm-shell{display:grid;gap:10px;color:var(--text-primary)}.vm-hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--control-border);border-radius:8px;background:linear-gradient(110deg,color-mix(in srgb,var(--surface-raised) 92%,#ff9e2c 8%),var(--surface-raised))}.vm-kicker{font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}.vm-hero h3{margin:2px 0;font-size:17px}.vm-hero p{margin:0;color:var(--text-muted);font-size:11px}.vm-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.vm-grid{display:grid;grid-template-columns:minmax(250px,.7fr) minmax(420px,1.6fr);gap:10px}.vm-card{padding:12px;border:1px solid var(--control-border);border-radius:8px;background:var(--surface-raised)}.vm-card h4{margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary)}.vm-field{display:grid;gap:4px;margin:0 0 8px}.vm-field label,.vm-help{font-size:10px;color:var(--text-muted)}.vm-field select,.vm-field textarea{width:100%;box-sizing:border-box;border:1px solid var(--control-border);border-radius:6px;background:var(--control-bg);color:var(--text-primary);padding:7px;font:inherit}.vm-field textarea{min-height:56px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px}.vm-check{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--text-secondary);margin:2px 0 8px}.vm-channels{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:6px;align-content:start;overflow:visible}.vm-channel{display:grid;grid-template-columns:minmax(95px,.9fr) minmax(55px,1fr) 40px;gap:6px;align-items:center;padding:6px 7px;border:1px solid color-mix(in srgb,var(--control-border) 72%,transparent);border-radius:5px;background:color-mix(in srgb,var(--surface) 58%,transparent)}.vm-channel-copy{display:grid;min-width:0}.vm-channel-copy strong,.vm-channel-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vm-channel-copy strong{font-size:10px}.vm-channel-copy span{font-size:8px;color:var(--text-muted)}.vm-meter{height:6px;border-radius:2px;background:var(--slider-track);overflow:hidden}.vm-meter i{display:block;width:var(--level);height:100%;background:linear-gradient(90deg,#53d18b 0 72%,#ffcc4d 72% 90%,#ff6262 90%);transition:width 70ms linear}.vm-state{font-size:8px;letter-spacing:.06em;color:var(--text-muted);text-align:right}.vm-empty{padding:24px;text-align:center;color:var(--text-muted);font-size:11px}.vm-statusline{display:flex;align-items:center;gap:8px}.vm-note{padding:8px 10px;border-left:3px solid #ff9e2c;background:color-mix(in srgb,#ff9e2c 8%,var(--surface));font-size:10px;color:var(--text-secondary)}@media(max-width:900px){.vm-grid{grid-template-columns:1fr}.vm-hero{grid-template-columns:1fr}.vm-actions{justify-content:flex-start}}
    </style>`;
  }

  function renderDashboard() {
    if (!state.mounted || !state.ui.root) return;
    const root = state.ui.root;
    state.meterLayoutSignature = "";
    state.meterElements.clear();
    const editions = state.status.installed_editions || [];
    const preferred = editions.includes(state.settings.preferred_edition) ? state.settings.preferred_edition : editions.includes("banana") ? "banana" : editions.at(-1) || "banana";
    const aliasesText = Object.entries(state.settings.macro_aliases || {}).map(([index, name]) => `${Number(index) + 1}: ${name}`).join("\n");
    const presetsText = (state.settings.presets || []).map((entry) => `${Number(entry.slot) + 1}: ${entry.label}`).join("\n");
    root.innerHTML = `${dashboardStyles()}<div class="vm-shell">
      <div class="connection-item-header"><div class="connection-info"><img class="connection-icon" src="${icon || ""}" alt=""><div><div class="connection-name">Voicemeeter</div><div class="vm-kicker">Native mixer bridge</div></div></div><div class="connection-status vm-statusline"><span class="connection-status-dot" data-role="dot"></span><span data-role="status">${escapeHtml(state.status.detail || "Not connected")}</span></div></div>
      <section class="vm-hero"><div><div class="vm-kicker">Signal desk</div><h3 data-role="edition">${escapeHtml(state.status.edition || "Voicemeeter")}</h3><p>MIDI control for strips, buses, routing, devices, MacroButtons, and presets.</p></div><div class="vm-actions"><button class="connection-button" data-role="connect">${state.status.connected ? "Disconnect" : "Connect"}</button><button class="connection-button" data-role="launch">Launch</button><button class="connection-button" data-role="show">Show</button><button class="connection-button" data-role="restart">Restart engine</button><button class="connection-button" data-role="refresh">Refresh</button></div></section>
      <div class="vm-grid"><section class="vm-card"><h4>Connection & target setup</h4><label class="vm-check"><input type="checkbox" data-role="auto" ${state.settings.auto_connect ? "checked" : ""}> Auto connect when Voicemeeter is running</label><div class="vm-field"><label>Edition used by the Launch button</label><select data-role="launch-edition">${editions.map((edition) => `<option value="${edition}" ${edition === preferred ? "selected" : ""}>${edition[0].toUpperCase()}${edition.slice(1)}</option>`).join("") || `<option value="banana">Banana</option>`}</select></div><div class="vm-field"><label>MacroButton aliases — one per line</label><textarea data-role="aliases" placeholder="1: Stream mute\n2: Push to talk">${escapeHtml(aliasesText)}</textarea></div><div class="vm-field"><label>Preset slots — one per line</label><textarea data-role="presets" placeholder="1: Streaming\n2: Headphones">${escapeHtml(presetsText)}</textarea></div><button class="connection-button" data-role="save">Save target setup</button><p class="vm-help">Aliases and preset labels are stored per MIDIMaster profile. Slot numbers are shown as 1-based here.</p></section><section class="vm-card"><h4>Live channels</h4><div class="vm-channels" data-role="meters"></div></section></div>
      <div class="vm-note">Changing a hardware device can interrupt audio. Auto connect never launches Voicemeeter; use Launch explicitly.</div></div>`;
    state.ui = { root, status: root.querySelector('[data-role="status"]'), dot: root.querySelector('[data-role="dot"]'), edition: root.querySelector('[data-role="edition"]'), connect: root.querySelector('[data-role="connect"]'), auto: root.querySelector('[data-role="auto"]'), launchEdition: root.querySelector('[data-role="launch-edition"]'), aliases: root.querySelector('[data-role="aliases"]'), presets: root.querySelector('[data-role="presets"]'), meters: root.querySelector('[data-role="meters"]') };
    state.ui.connect.onclick = () => state.status.connected ? disconnect({ manual: true }) : connect({ manual: true });
    root.querySelector('[data-role="launch"]').onclick = async () => { await saveDashboardSettings(); await ctx.tauri.invoke("voicemeeter_launch", { edition: state.ui.launchEdition.value }); setTimeout(() => connect({ manual: true }), 900); };
    root.querySelector('[data-role="show"]').onclick = () => ctx.tauri.invoke("voicemeeter_safe_command", { action: "show", index: null }).catch(() => {});
    root.querySelector('[data-role="restart"]').onclick = async () => {
      const confirmed = await ctx.app.showConfirm({
        title: "Restart Voicemeeter audio engine?",
        message: "Audio will be interrupted briefly while Voicemeeter restarts its audio engine.",
        confirmLabel: "Restart engine",
        cancelLabel: "Cancel",
        confirmVariant: "danger",
      });
      if (confirmed) await ctx.tauri.invoke("voicemeeter_safe_command", { action: "restart", index: null });
    };
    root.querySelector('[data-role="refresh"]').onclick = async () => { await refreshDevices(); await poll(true); renderDashboard(); };
    root.querySelector('[data-role="save"]').onclick = async () => { await saveDashboardSettings(); ctx.app.invalidateBindingsUI(); };
    state.ui.auto.onchange = async () => {
      await saveDashboardSettings();
      if (state.settings.auto_connect) {
        state.disconnectedByUser = false;
        connect().catch(() => {});
      } else {
        state.disconnectedByUser = true;
      }
    };
    state.lastStatusUiSignature = "";
    updateStatusUi(); renderMeters();
  }

  ctx.registerIntegration({
    id: INTEGRATION_ID, name: "Voicemeeter", icon_data: icon,
    buttonActions: [{ label: "Set State", value: "ToggleEffect", behavior: "stateful" }],
    describeTarget: (raw) => {
      const target = raw?.Integration || raw?.integration || {}; const data = target.data || {};
      return { label: data.label || "Voicemeeter", icon_data: icon, ghost: !state.status.connected };
    },
    getTargetOptions: targetOptions,
    onBindingTriggered: onTriggered,
  });

  if (!isOsdWindow()) ctx.connections.registerTab({
    id: INTEGRATION_ID, name: "Voicemeeter", icon_data: icon, order: 35,
    mount: (container) => { state.mounted = true; state.ui.root = container; renderDashboard(); poll(true).catch(() => {}); },
    unmount: () => { state.mounted = false; state.meterElements.clear(); state.meterLayoutSignature = ""; state.ui = {}; },
  });

  const applyProfile = (value) => {
    const settings = profileSettingsFromEvent(value);
    state.settings = { auto_connect: settings?.auto_connect ?? true, preferred_edition: settings?.preferred_edition || "banana", macro_aliases: settings?.macro_aliases || {}, presets: Array.isArray(settings?.presets) ? settings.presets : [] };
    if (state.mounted) renderDashboard();
  };
  applyProfile(ctx.profile.get());
  ctx.profile.onChanged(applyProfile);
  rebuildBindingCache();
  ctx.bindings.onChanged(() => { rebuildBindingCache(); if (state.status.connected) poll(true).catch(() => {}); });

  const pollTimer = setInterval(() => poll(false).catch(() => {}), POLL_MS);
  const reconnectTimer = setInterval(() => {
    if (state.settings.auto_connect && !state.disconnectedByUser && !state.status.connected && !state.connecting) connect().catch(() => {});
  }, RECONNECT_MS);
  if (state.settings.auto_connect) connect().catch(() => {});

  ctx.lifecycle.onDispose(() => {
    state.disposed = true; clearInterval(pollTimer); clearInterval(reconnectTimer);
    if (state.writeTimer) clearTimeout(state.writeTimer);
    state.pendingWrites.clear(); state.localIntents.clear();
    ctx.tauri.invoke("voicemeeter_disconnect").catch(() => {});
  });
}

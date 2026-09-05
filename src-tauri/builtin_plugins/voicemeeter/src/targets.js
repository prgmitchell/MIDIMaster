import {
  displayChannelLabel,
  STRIP_BUTTONS,
  STRIP_CONTINUOUS,
  BUS_BUTTONS,
  BUS_CONTINUOUS,
  specApplies,
  parameterOption,
  routeProperties,
  editionCode,
  buttonAction,
  INTEGRATION_ID,
  assignableDevices,
  deviceSlotKey,
  deviceFeedbackMatches,
  makeParameterTarget,
  clamp01,
  isOneShotVoicemeeterTarget,
  denormalizeContinuous,
} from "./protocol.js";

/** targets workflow. */
export function createTargets({
  assignAndVerifyDevice,
  ctx,
  icon,
  resetLegacyOneShotFeedback,
  scheduleWrite,
  state,
}) {
  function targetOptions({ controlType, nav } = {}) {
    if (!state.status.connected) return [];
    const isButton = controlType === "button";
    const section = String(nav?.section || "");
    const caps = state.status.capabilities || {};
    const channelOptions = (scope, nextSection) =>
      Array.from({ length: Number(scope === "strip" ? caps.strip_count : caps.bus_count) }, (_, index) => ({
        label: displayChannelLabel(scope, index, state),
        icon_data: icon,
        nav: { section: nextSection, scope, index },
      }));

    if (!section) {
      const groups = [
        {
          label: "Input Strips",
          nav: { section: "strips" },
          description: "Gain, dynamics, EQ, mute, solo, and processing.",
        },
        {
          label: "Output Buses",
          nav: { section: "buses" },
          description: "Bus gain, modes, EQ, mute, and returns.",
        },
      ];
      if (isButton)
        groups.push(
          {
            label: "Strip Routing",
            nav: { section: "routing" },
            description: "Toggle strip assignments to A and B buses.",
          },
          {
            label: "Hardware Devices",
            nav: { section: "devices" },
            description: "Assign physical inputs and hardware output devices.",
          },
          {
            label: "MacroButtons",
            nav: { section: "macros", offset: 0 },
            description: "Trigger any of the 80 Voicemeeter MacroButtons.",
          },
          {
            label: "Presets",
            nav: { section: "presets" },
            description: "Recall preset slots configured on the dashboard.",
          },
          {
            label: "Engine Actions",
            nav: { section: "commands" },
            description: "Show Voicemeeter or restart its audio engine.",
          },
        );
      return groups.map((item) => ({ ...item, icon_data: icon }));
    }
    if (section === "strips") return channelOptions("strip", "controls");
    if (section === "buses") return channelOptions("bus", "controls");
    if (section === "routing") return channelOptions("strip", "routes");
    if (section === "controls") {
      const scope = String(nav.scope);
      const index = Number(nav.index);
      const specs =
        scope === "strip"
          ? isButton
            ? STRIP_BUTTONS
            : STRIP_CONTINUOUS
          : isButton
            ? BUS_BUTTONS
            : BUS_CONTINUOUS;
      return specs
        .filter((spec) => specApplies(spec, scope, index, state))
        .map((spec) => parameterOption(scope, index, spec, state, isButton));
    }
    if (section === "routes")
      return routeProperties(editionCode(state.status)).map((spec) =>
        parameterOption("strip", Number(nav.index), spec, state, true),
      );
    if (section === "devices")
      return [
        {
          label: "Hardware Inputs",
          icon_data: icon,
          nav: { section: "device_slots", direction: "input", scope: "strip" },
        },
        {
          label: "Hardware Outputs",
          icon_data: icon,
          nav: { section: "device_slots", direction: "output", scope: "bus" },
        },
      ];
    if (section === "device_slots") {
      const count = nav.direction === "input" ? caps.physical_strip_count : caps.physical_bus_count;
      return Array.from({ length: Number(count) }, (_, index) => ({
        label: nav.direction === "input" ? `Hardware Input ${index + 1}` : `Hardware Output A${index + 1}`,
        icon_data: icon,
        nav: { section: "device_choices", direction: nav.direction, scope: nav.scope, index },
      }));
    }
    if (section === "device_choices") {
      const current =
        nav.direction === "input" ? state.inputDevices[nav.index] : state.outputDevices[nav.index];
      const clear = {
        label: "Clear device",
        icon_data: icon,
        buttonActions: [buttonAction("Clear Device", "momentary")],
        target: {
          Integration: {
            integration_id: INTEGRATION_ID,
            kind: "device_assignment",
            data: {
              scope: nav.scope,
              index: Number(nav.index),
              direction: nav.direction,
              driver_type: null,
              device_name: "",
              label: `Clear ${nav.direction} device`,
              action_kind: "momentary",
            },
          },
        },
      };
      const devices = assignableDevices(state.devices[nav.direction], nav.direction, nav.index);
      const confirmed = state.confirmedDevices.get(deviceSlotKey(nav.scope, nav.index));
      return [
        clear,
        ...devices.map((device) => {
          const selected = deviceFeedbackMatches(
            { device_name: device.name, driver_type: device.driver_type },
            current,
            confirmed,
            state.devices[nav.direction],
          );
          return {
            label: `${device.driver_type.toUpperCase()}: ${device.name}${selected ? " (Selected)" : ""}`,
            icon_data: icon,
            buttonActions: [buttonAction("Select Device", "momentary")],
            target: {
              Integration: {
                integration_id: INTEGRATION_ID,
                kind: "device_assignment",
                data: {
                  scope: nav.scope,
                  index: Number(nav.index),
                  direction: nav.direction,
                  driver_type: device.driver_type,
                  device_name: device.name,
                  label: `${nav.direction === "input" ? "Input" : `A${Number(nav.index) + 1}`}: ${device.name}`,
                  action_kind: "momentary",
                },
              },
            },
          };
        }),
      ];
    }
    if (section === "macros") {
      const offset = Number(nav.offset || 0);
      const aliases = state.settings.macro_aliases || {};
      const options = Array.from({ length: Math.min(20, 80 - offset) }, (_, item) => {
        const index = offset + item;
        const name = aliases[String(index)] || `MacroButton ${index + 1}`;
        const target = makeParameterTarget("macro", index, "state", name, 0, 1, "stateful");
        return {
          label: name,
          icon_data: icon,
          buttonActions: [
            { label: "Toggle", value: "ToggleEffect", behavior: "stateful" },
            { label: "Push / Release", value: "Volume", behavior: "momentary" },
          ],
          target,
        };
      });
      if (offset + 20 < 80)
        options.push({
          label: `MacroButtons ${offset + 21}–${Math.min(80, offset + 40)}`,
          icon_data: icon,
          nav: { section: "macros", offset: offset + 20 },
        });
      return options;
    }
    if (section === "presets")
      return (state.settings.presets || []).map((preset) => ({
        label: preset.label,
        icon_data: icon,
        buttonActions: [buttonAction("Recall Preset", "momentary")],
        target: {
          Integration: {
            integration_id: INTEGRATION_ID,
            kind: "preset",
            data: { slot: preset.slot, label: preset.label, action_kind: "momentary" },
          },
        },
      }));
    if (section === "commands")
      return [
        {
          label: "Show Voicemeeter",
          icon_data: icon,
          buttonActions: [buttonAction("Show", "momentary")],
          target: {
            Integration: {
              integration_id: INTEGRATION_ID,
              kind: "command",
              data: { command: "show", label: "Show Voicemeeter", action_kind: "momentary" },
            },
          },
        },
        {
          label: "Restart Audio Engine",
          icon_data: icon,
          buttonActions: [buttonAction("Restart", "momentary")],
          target: {
            Integration: {
              integration_id: INTEGRATION_ID,
              kind: "command",
              data: {
                command: "restart",
                label: "Restart Voicemeeter Audio Engine",
                action_kind: "momentary",
              },
            },
          },
        },
      ];
    return [];
  }

  async function onTriggered(payload) {
    const target = payload?.target || {};
    const data = target.data || {};
    const value = clamp01(payload?.value);
    if (target.kind === "parameter") {
      const oneShot = isOneShotVoicemeeterTarget(target);
      const pressRelease = !oneShot && String(data.action_kind || "").toLowerCase() === "momentary";
      if (oneShot && value <= 0) return;
      const min = Number(data.min ?? 0);
      const max = Number(data.max ?? 1);
      const raw = oneShot
        ? 1
        : payload.action === "Volume"
          ? denormalizeContinuous(value, min, max, data.property)
          : max > 1
            ? value > 0.5
              ? max
              : 0
            : value > 0.5
              ? 1
              : 0;
      scheduleWrite({ scope: data.scope, index: Number(data.index), property: data.property }, raw);
      if (oneShot) await resetLegacyOneShotFeedback(payload);
      else if (!pressRelease && payload.binding_id && payload.is_primary_target !== false)
        await ctx.feedback.set(payload.binding_id, value, payload.action);
      return;
    }
    if (value <= 0) return;
    if (target.kind === "device_assignment") {
      const assignment = assignAndVerifyDevice(data);
      await resetLegacyOneShotFeedback(payload);
      await assignment;
      return;
    }
    if (target.kind === "preset") {
      try {
        await ctx.tauri.invoke("voicemeeter_safe_command", { action: "preset", index: Number(data.slot) });
      } finally {
        await resetLegacyOneShotFeedback(payload);
      }
      return;
    }
    if (target.kind === "command") {
      try {
        await ctx.tauri.invoke("voicemeeter_safe_command", { action: data.command, index: null });
      } finally {
        await resetLegacyOneShotFeedback(payload);
      }
    }
  }

  return { targetOptions, onTriggered };
}

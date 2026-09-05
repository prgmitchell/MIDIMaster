import {
  HUE_BUTTON_POWER_ACTIONS,
  createHueButtonActionOption,
  isHumanFriendlyHueGroupName,
  MAX_TRANSIENT_WRITE_FAILURES,
} from "./protocol.js";

/** integration workflow. */
export function createIntegration({
  ctx,
  handleHuePowerAction,
  handleHueToggle,
  handleHueVolumeTargets,
  iconDataUrl,
  markDisconnected,
  normalizeBatchTargets,
  normalizeIntegrationTarget,
  state,
  stateByKey,
  targetKey,
}) {
  function registerPluginIntegration() {
    ctx.registerIntegration({
      id: "hue",
      name: "Philips Hue",
      icon_data: iconDataUrl || null,
      buttonActions: [{ label: "Toggle On/Off", value: "ToggleMute", behavior: "stateful" }],
      describeTarget: (target) => {
        const t = normalizeIntegrationTarget(target);
        if (!t) {
          return { label: "Philips Hue", icon_data: iconDataUrl || null, ghost: !state.connected };
        }

        const key = targetKey(t.kind, t.id);
        const state = stateByKey.get(key);
        const fallbackType = t.kind === "group" ? "Room" : "Light";
        const label = state?.name || t.name || `${fallbackType} ${t.id}`;

        return {
          label: String(label),
          icon_data: t.icon_data || iconDataUrl || null,
          ghost: !state.connected,
        };
      },
      getTargetOptions: async (ctx2 = null) => {
        if (!state.connected) {
          return [];
        }

        const controlType = ctx2 && typeof ctx2 === "object" ? String(ctx2.controlType || "") : "";
        const nav = ctx2 && typeof ctx2 === "object" ? ctx2.nav : null;

        if (controlType === "button" && nav?.screen === "hue_power_actions") {
          const kind = String(nav.kind || "");
          const id = String(nav.id || "");
          const key = targetKey(kind, id);
          const state = stateByKey.get(key);
          if (!state || (kind !== "light" && kind !== "group")) {
            return [
              {
                label: "Hue target not found",
                kind: "placeholder",
                ghost: true,
                icon_data: iconDataUrl || null,
              },
            ];
          }
          const name = String(state.name || `${kind} ${id}`);
          const target = { kind, id, name, icon_data: iconDataUrl || null };
          return HUE_BUTTON_POWER_ACTIONS.map((action) =>
            createHueButtonActionOption(target, action.button_action, iconDataUrl || null),
          );
        }

        const opts = [];
        const groups = [];
        const lights = [];

        for (const [key, state] of stateByKey.entries()) {
          if (!state) continue;
          const [kind, id] = String(key).split("::");
          if (kind === "group" && !isHumanFriendlyHueGroupName(state.name)) {
            continue;
          }
          const label = String(state.name || `${kind} ${id}`);
          const entry =
            controlType === "button"
              ? {
                  label,
                  icon_data: iconDataUrl || null,
                  nav: {
                    screen: "hue_power_actions",
                    kind,
                    id: String(id),
                  },
                }
              : {
                  label,
                  icon_data: iconDataUrl || null,
                  target: {
                    Integration: {
                      integration_id: "hue",
                      kind,
                      data: {
                        id: String(id),
                        name: label,
                      },
                    },
                  },
                };
          if (kind === "group") groups.push(entry);
          if (kind === "light") lights.push(entry);
        }

        groups.sort((a, b) => a.label.localeCompare(b.label));
        lights.sort((a, b) => a.label.localeCompare(b.label));

        if (groups.length > 0) {
          opts.push({ kind: "divider", label: "Rooms / Groups" });
          opts.push(...groups);
        }
        if (lights.length > 0) {
          opts.push({ kind: "divider", label: "Lights" });
          opts.push(...lights);
        }

        if (opts.length === 0) {
          opts.push({ label: "No Hue lights or groups found", kind: "placeholder", ghost: true });
        }

        return opts;
      },
      onBindingTriggeredBatch: async (payload) => {
        if (String(payload?.action || "Volume") !== "Volume") return;
        try {
          const targets = normalizeBatchTargets(payload);
          const volumeTargets = [];
          for (const entry of targets) {
            if (entry.target.button_action === "turn_on" || entry.target.button_action === "turn_off") {
              await handleHuePowerAction(payload, entry);
            } else {
              volumeTargets.push(entry);
            }
          }
          if (volumeTargets.length > 0) {
            await handleHueVolumeTargets(payload, volumeTargets);
          }
        } catch {
          state.transientWriteFailures += 1;
          if (state.transientWriteFailures >= MAX_TRANSIENT_WRITE_FAILURES) {
            markDisconnected("Disconnected");
          }
        }
      },
      onBindingTriggered: async (payload) => {
        try {
          const action = String(payload?.action || "Volume");
          if (action === "ToggleMute") {
            await handleHueToggle(payload);
            return;
          }
          const target = normalizeIntegrationTarget(payload?.target);
          if (!target) return;
          if (target.button_action === "turn_on" || target.button_action === "turn_off") {
            await handleHuePowerAction(payload, { target });
            return;
          }
          await handleHueVolumeTargets(payload, [
            {
              target,
              target_index: Number(payload?.target_index ?? 0),
              target_count: Number(payload?.target_count ?? 1),
              is_primary_target: payload?.is_primary_target !== false,
            },
          ]);
        } catch {
          state.transientWriteFailures += 1;
          if (state.transientWriteFailures >= MAX_TRANSIENT_WRITE_FAILURES) {
            markDisconnected("Disconnected");
          }
        }
      },
    });
  }

  return { registerPluginIntegration };
}

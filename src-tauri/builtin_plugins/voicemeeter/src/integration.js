import { INTEGRATION_ID, isOneShotVoicemeeterTarget, parameterKey } from "./protocol.js";

/** integration workflow. */
export function createIntegration({ ctx, icon, onTriggered, state, targetOptions }) {
  function registerPluginIntegration() {
    ctx.registerIntegration({
      id: INTEGRATION_ID,
      name: "Voicemeeter",
      icon_data: icon,
      buttonActions: [{ label: "Set State", value: "ToggleEffect", behavior: "stateful" }],
      describeTarget: (raw) => {
        const target = raw?.Integration || raw?.integration || {};
        const data = target.data || {};
        return { label: data.label || "Voicemeeter", icon_data: icon, ghost: !state.status.connected };
      },
      getTargetOptions: targetOptions,
      onBindingTriggered: onTriggered,
      prepareStateCapture: async ({ refresh }) => {
        if (!refresh || !state.status.connected) return;
        const writes = Array.from(state.pendingWrites?.values() || []);
        if (!writes.length) return;
        clearTimeout(state.writeTimer);
        state.writeTimer = null;
        state.pendingWrites.clear();
        await ctx.tauri.invoke("voicemeeter_write_parameters", { writes });
      },
      captureTargetState: async (target) => {
        if (!state.status.connected || target.kind !== "parameter" || isOneShotVoicemeeterTarget(target)) return null;
        const { scope, index, property } = target.data;
        const result = await ctx.tauri.invoke("voicemeeter_snapshot", { parameters: [{ scope, index, property }], includeMeters: false, force: true });
        const value = result.values?.[0]?.value;
        return result.status?.connected && Number.isFinite(value) ? { value } : null;
      },
      restoreTargetState: async (target, saved) => {
        if (!state.status.connected || target.kind !== "parameter" || isOneShotVoicemeeterTarget(target) || !Number.isFinite(saved.value)) return false;
        const { scope, index, property } = target.data;
        const key = parameterKey({ scope, index, property });
        state.pendingWrites?.delete(key);
        state.localIntents?.delete(key);
        await ctx.tauri.invoke("voicemeeter_write_parameters", { writes: [{ scope, index, property, value: saved.value }] });
        return true;
      },
    });
  }

  return { registerPluginIntegration };
}

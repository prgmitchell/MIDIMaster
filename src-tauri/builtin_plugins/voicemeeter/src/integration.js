import { INTEGRATION_ID } from "./protocol.js";

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
    });
  }

  return { registerPluginIntegration };
}

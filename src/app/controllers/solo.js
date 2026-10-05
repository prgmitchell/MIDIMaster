import { t } from "../i18n.js";

/** Serialize hardware presses so rapid toggles cannot replace a mute snapshot. */
export function createSoloController({
  invoke,
  getPluginHost,
  diagnosticError,
  showAlert,
}) {
  let queue = Promise.resolve();
  let disposed = false;
  let activeBindingId = null;
  const inputs = new Map();
  async function handle(input) {
    if (disposed || !input?.binding_id) return;
    const pressed = Number(input.value) > 0;
    if (input.behavior === "SetFromValue") {
      const previous = inputs.get(input.control_key) ?? false;
      inputs.set(input.control_key, pressed);
      if (previous === pressed) return;
    } else if (!pressed) return;
    let context = await invoke("get_binding_solo_context", {
      bindingId: input.binding_id,
    });
    activeBindingId = context.active_binding_id;
    const active =
      input.behavior === "SetFromValue"
        ? pressed
        : context.active_binding_id !== input.binding_id;
    if (!active && context.active_binding_id !== input.binding_id) return;
    // Restore the previous Solo before reading a fresh mixer snapshot.
    if (context.active_binding_id) {
      await invoke("set_binding_solo", {
        bindingId: context.active_binding_id,
        active: false,
        waveLink: null,
      });
      activeBindingId = null;
      if (!active) return;
      context = await invoke("get_binding_solo_context", {
        bindingId: input.binding_id,
      });
    }
    const waveTargets = context.targets.filter(
      (target) => target?.Integration?.integration_id === "wavelink",
    );
    const nativeChannelIds = context.wave_link_channel_ids || [];
    let waveLink = null;
    if (waveTargets.length || nativeChannelIds.length) {
      const integration = getPluginHost()?.getIntegration?.("wavelink");
      if (!integration?.createSoloPlan)
        throw new Error(
          "Enable and connect the Wave Link plugin before using Solo",
        );
      waveLink = await integration.createSoloPlan({
        targets: waveTargets,
        nativeChannelIds,
      });
    }
    await invoke("set_binding_solo", {
      bindingId: input.binding_id,
      active: true,
      waveLink,
    });
    activeBindingId = input.binding_id;
  }
  function enqueue(input) {
    queue = queue
      .then(() => handle(input))
      .catch((error) => {
        diagnosticError("solo_failed", error);
        showAlert(t("dialogs.soloUnavailableTitle"), String(error?.message || error));
      });
    return queue;
  }
  async function dispose() {
    disposed = true;
    await queue;
    if (activeBindingId)
      await invoke("set_binding_solo", {
        bindingId: "",
        active: false,
        waveLink: null,
      });
  }
  return {
    enqueue,
    resetInputs: () => {
      inputs.clear();
      activeBindingId = null;
    },
    dispose,
  };
}

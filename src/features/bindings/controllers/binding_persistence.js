import { ensureBindingShape } from "../shape_helpers.js";

/** binding persistence workflow. */
export function createBindingPersistence({ getBindings, getHost, invoke, saveProfile }) {
  async function persistBindingBackend(binding) {
    ensureBindingShape(binding);
    await invoke("add_binding", { binding });
  }

  function syncPluginHostBindings() {
    try {
      getHost()?.setBindings?.(getBindings());
    } catch {}
  }

  function scheduleProfileSave(reason = "binding update") {
    const promise = saveProfile();
    promise.catch((err) => {
      console.error(`Failed to save profile after ${reason}:`, err);
    });
    return promise;
  }

  function finishBindingUiMutation(reason = "binding update") {
    syncPluginHostBindings();
    scheduleProfileSave(reason);
  }

  return { persistBindingBackend, syncPluginHostBindings, finishBindingUiMutation };
}

import { buildHotkeyMappingFromEvent } from "../../core/binding_model.js";

export function createHotkeyLearnController({
  dom,
  translate,
  canStart = () => true,
  windowRef = window,
}) {
  let activeBindingId = null;
  let cleanup = null;

  function hidePanel() {
    dom.learnPanel?.classList.add("hidden");
  }

  function showPanel() {
    dom.learnPanel?.classList.remove("hidden");
  }

  function stop(result = null) {
    cleanup?.();
    cleanup = null;
    activeBindingId = null;
    hidePanel();
    return result;
  }

  async function start(binding) {
    if (!binding || activeBindingId || !canStart()) return null;
    activeBindingId = binding.id;
    if (dom.learnPanelTitle) dom.learnPanelTitle.textContent = translate("bindings.pressHotkey");
    if (dom.learnPanelMessage) dom.learnPanelMessage.textContent = translate("bindings.pressHotkeyMessage");
    dom.learnPanelSpinner?.classList.add("hidden");
    dom.learnPanelActions?.classList.remove("hidden");
    if (dom.learnPanelCancel) dom.learnPanelCancel.textContent = translate("common.cancel");
    dom.learnPanelConfirm?.classList.add("hidden");
    showPanel();

    return new Promise((resolve) => {
      let settled = false;
      const finish = (mapping) => {
        if (settled) return;
        settled = true;
        stop(mapping);
        resolve(mapping);
      };
      const onCancel = () => finish(null);
      const onOverlay = (event) => {
        if (event.target === dom.learnPanel) finish(null);
      };
      const onKeydown = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          finish(null);
          return;
        }
        const mapping = buildHotkeyMappingFromEvent(event);
        if (mapping) finish(mapping);
      };

      windowRef.addEventListener("keydown", onKeydown, true);
      dom.learnPanelCancel?.addEventListener("click", onCancel);
      dom.learnPanelClose?.addEventListener("click", onCancel);
      dom.learnPanel?.addEventListener("click", onOverlay);
      cleanup = () => {
        windowRef.removeEventListener("keydown", onKeydown, true);
        dom.learnPanelCancel?.removeEventListener("click", onCancel);
        dom.learnPanelClose?.removeEventListener("click", onCancel);
        dom.learnPanel?.removeEventListener("click", onOverlay);
      };
    });
  }

  return {
    isActive: () => activeBindingId !== null,
    start,
    stop,
  };
}

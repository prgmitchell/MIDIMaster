import { findControlConflict } from "../../core/control_mapping.js";
import { t } from "../i18n.js";
import { normalizeCustomCurvePoints } from "../../core/binding_model.js";

/** binding creation workflow. */
export function createBindingCreation({
  invoke,
  features,
  viewState,
  showAlert,
  scheduleBindingsSave,
  syncPluginHostBindings,
  learnPanel,
  learnPanelActions,
  learnPanelCancel,
  learnPanelClose,
  learnPanelConfirm,
  learnPanelMessage,
  learnPanelSpinner,
  learnPanelTitle,
  profileState,
}) {
  function resetCreateLearnPanelUi() {
    if (!learnPanel) return;
    if (learnPanelTitle) learnPanelTitle.textContent = t("bindings.waitingMidiTitle");
    if (learnPanelMessage) learnPanelMessage.textContent = t("bindings.learnMessage");
    if (learnPanelSpinner) learnPanelSpinner.classList.remove("hidden");
    if (learnPanelActions) learnPanelActions.classList.add("hidden");
    if (learnPanelConfirm) learnPanelConfirm.textContent = t("common.transfer");
  }

  function hideCreateLearnPanel() {
    if (!learnPanel) return;
    learnPanel.classList.add("hidden");
    resetCreateLearnPanelUi();
  }

  function normalizeLearnedControlMapping(learned) {
    return {
      device_id: String(learned?.device_id || ""),
      channel: Number(learned?.channel),
      controller: Number(learned?.controller),
      msg_type: String(learned?.msg_type || "ControlChange"),
    };
  }

  function findCreateBindingConflict(mapping) {
    return findControlConflict(profileState.bindings, mapping);
  }

  async function promptCreateLearnTransfer(message) {
    if (!learnPanel) return false;
    if (learnPanelTitle) learnPanelTitle.textContent = t("bindings.transferMapping");
    if (learnPanelMessage) learnPanelMessage.textContent = message || "";
    if (learnPanelSpinner) learnPanelSpinner.classList.add("hidden");
    if (learnPanelActions) learnPanelActions.classList.remove("hidden");
    if (learnPanelConfirm) learnPanelConfirm.textContent = "Transfer";
    learnPanel.classList.remove("hidden");

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onCancel = () => finish(false);
      const onConfirm = () => finish(true);
      const onOverlay = (event) => {
        if (event.target === learnPanel) {
          finish(false);
        }
      };
      const cleanup = () => {
        learnPanelCancel?.removeEventListener("click", onCancel);
        learnPanelClose?.removeEventListener("click", onCancel);
        learnPanelConfirm?.removeEventListener("click", onConfirm);
        learnPanel?.removeEventListener("click", onOverlay);
      };

      learnPanelCancel?.addEventListener("click", onCancel);
      learnPanelClose?.addEventListener("click", onCancel);
      learnPanelConfirm?.addEventListener("click", onConfirm);
      learnPanel?.addEventListener("click", onOverlay);
    });
  }

  function createBindingFromLearn(payload) {
    const msgType = payload.msg_type || "ControlChange";
    const controlKind = payload.control_kind || "Auto";
    const isButton =
      controlKind === "Button" ||
      (controlKind === "Auto" && (msgType === "Note" || msgType === "ProgramChange"));
    const control = {
      channel: payload.channel,
      controller: payload.controller,
      msg_type: msgType,
    };
    const defaultName = t("bindings.bindingFallback", { number: profileState.bindings.length + 1 });
    return {
      id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: defaultName,
      device_id: payload.device_id,
      control,
      control_kind: controlKind,
      targets: ["Unset"],
      target: "Unset",
      action: isButton ? "ToggleMute" : "Volume",
      mode: "Absolute",
      relative_format: "Auto",
      fader_curve: "Linear",
      custom_curve: normalizeCustomCurvePoints([]),
      deadzone: 0,
      debounce_ms: 0,
      mute_behavior: "ToggleOnPress",
      indicator_control: null,
      mute_control: null,
      assign_control: null,
      assign_mode: "Add",
      hotkey: null,
      open_application: null,
    };
  }

  async function addBindingFromLearn(learned) {
    try {
      const learnedMapping = normalizeLearnedControlMapping(learned);
      const conflict = findCreateBindingConflict(learnedMapping);

      if (conflict && conflict.field === "control") {
        hideCreateLearnPanel();
        const owner = conflict.binding?.name || t("bindings.unnamedBinding");
        showAlert(t("bindings.alreadyAssignedTitle"), t("bindings.alreadyAssignedMessage", { name: owner }));
        return;
      }

      if (
        conflict &&
        (conflict.field === "mute_control" ||
          conflict.field === "assign_control" ||
          conflict.field === "indicator_control")
      ) {
        const owner = conflict.binding?.name || t("bindings.unnamedBinding");
        const ownerSlot =
          conflict.field === "mute_control"
            ? t("bindings.mute")
            : conflict.field === "assign_control"
              ? t("common.assign")
              : "Indicator";
        const confirmed = await promptCreateLearnTransfer(
          t("bindings.transferFromAuxMessage", { slot: ownerSlot, name: owner }),
        );
        if (!confirmed) {
          hideCreateLearnPanel();
          return;
        }

        conflict.binding[conflict.field] = null;
        await invoke("add_binding", { binding: conflict.binding });
      }

      const binding = createBindingFromLearn(learned);
      profileState.bindings.push(binding);
      await invoke("add_binding", { binding });
      viewState.editingBindingId = null;
      viewState.pendingFocusBindingId = null;
      features.bindings?.renderBindings();
      syncPluginHostBindings();
      scheduleBindingsSave("add binding learn");
      await features.bindings?.openBindingTargetPicker?.(binding.id);
      hideCreateLearnPanel();
    } catch (error) {
      hideCreateLearnPanel();
      showAlert(t("bindings.createFailedTitle"), String(error));
    }
  }

  return {
    addBindingFromLearn,
    resetCreateLearnPanelUi,
    hideCreateLearnPanel,
    normalizeLearnedControlMapping,
    findCreateBindingConflict,
    promptCreateLearnTransfer,
    createBindingFromLearn,
  };
}

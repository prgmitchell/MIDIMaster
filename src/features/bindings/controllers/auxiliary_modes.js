import { assignModeTooltip, normalizeMuteBehavior, muteBehaviorTooltip } from "../shape_helpers.js";

/** auxiliary modes workflow. */
export function createAuxiliaryModes({
  buttonLightSelectValue,
  elements,
  listState,
  renderButtonLightDropdown,
  syncIndicatorUi,
  t,
}) {
  function syncButtonLightUi(binding) {
    const select = elements.bindingConfigButtonLightSelect;
    if (!select) return;
    select.value = buttonLightSelectValue(binding);
    select.disabled = false;
    select.title = t("bindings.toggleMuteLight");
    const row = elements.bindingConfigButtonLightSelectRow || select.closest?.(".binding-config-select-row");
    if (row) {
      row.classList.remove("is-disabled");
      row.classList.remove("hidden");
    }
    if (listState.buttonLightDropdown) {
      listState.buttonLightDropdown.button.disabled = false;
      listState.buttonLightDropdown.button.title = t("bindings.toggleMuteLight");
      listState.buttonLightDropdown.button.setAttribute("aria-disabled", "false");
      listState.buttonLightDropdown.root.classList.remove("is-disabled");
      renderButtonLightDropdown();
    }
    syncIndicatorUi(binding);
  }

  function closeMuteModeMenu() {
    if (elements.bindingConfigMuteModeMenu) elements.bindingConfigMuteModeMenu.classList.add("hidden");
    if (elements.bindingConfigMuteModeButton)
      elements.bindingConfigMuteModeButton.setAttribute("aria-expanded", "false");
  }

  function openMuteModeMenu() {
    if (elements.bindingConfigMuteModeMenu) elements.bindingConfigMuteModeMenu.classList.remove("hidden");
    if (elements.bindingConfigMuteModeButton)
      elements.bindingConfigMuteModeButton.setAttribute("aria-expanded", "true");
  }

  function closeAssignModeMenu() {
    if (elements.bindingConfigAssignModeMenu) elements.bindingConfigAssignModeMenu.classList.add("hidden");
    if (elements.bindingConfigAssignModeButton)
      elements.bindingConfigAssignModeButton.setAttribute("aria-expanded", "false");
  }

  function openAssignModeMenu() {
    if (elements.bindingConfigAssignModeMenu) elements.bindingConfigAssignModeMenu.classList.remove("hidden");
    if (elements.bindingConfigAssignModeButton)
      elements.bindingConfigAssignModeButton.setAttribute("aria-expanded", "true");
  }

  function syncAssignModeUi(mode) {
    const currentMode = mode === "Replace" ? "Replace" : mode === "Clear" ? "Clear" : "Add";
    const tooltip = assignModeTooltip(currentMode);
    if (elements.bindingConfigAssignModeButton) {
      elements.bindingConfigAssignModeButton.title = tooltip;
      elements.bindingConfigAssignModeButton.setAttribute("aria-label", tooltip);
    }
    if (elements.bindingConfigAssignModeAdd) {
      elements.bindingConfigAssignModeAdd.classList.toggle("is-selected", currentMode === "Add");
      elements.bindingConfigAssignModeAdd.title = assignModeTooltip("Add");
    }
    if (elements.bindingConfigAssignModeReplace) {
      elements.bindingConfigAssignModeReplace.classList.toggle("is-selected", currentMode === "Replace");
      elements.bindingConfigAssignModeReplace.title = assignModeTooltip("Replace");
    }
    if (elements.bindingConfigAssignModeClear) {
      elements.bindingConfigAssignModeClear.classList.toggle("is-selected", currentMode === "Clear");
      elements.bindingConfigAssignModeClear.title = assignModeTooltip("Clear");
    }
  }

  function syncMuteModeUi(mode) {
    const currentMode = normalizeMuteBehavior(mode);
    const tooltip = muteBehaviorTooltip(currentMode);
    if (elements.bindingConfigMuteModeButton) {
      elements.bindingConfigMuteModeButton.title = tooltip;
      elements.bindingConfigMuteModeButton.setAttribute("aria-label", tooltip);
    }
    if (elements.bindingConfigMuteModeToggle) {
      elements.bindingConfigMuteModeToggle.classList.toggle("is-selected", currentMode === "ToggleOnPress");
      elements.bindingConfigMuteModeToggle.title = muteBehaviorTooltip("ToggleOnPress");
    }
    if (elements.bindingConfigMuteModeValue) {
      elements.bindingConfigMuteModeValue.classList.toggle("is-selected", currentMode === "SetFromValue");
      elements.bindingConfigMuteModeValue.title = muteBehaviorTooltip("SetFromValue");
    }
  }

  return {
    syncButtonLightUi,
    closeMuteModeMenu,
    openMuteModeMenu,
    closeAssignModeMenu,
    openAssignModeMenu,
    syncAssignModeUi,
    syncMuteModeUi,
  };
}

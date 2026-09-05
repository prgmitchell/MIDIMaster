import { normalizeActionRole } from "../selection_model.js";

/** selection workflow. */
export function createSelection({
  normalizeOpenApplication,
  normalizeAutoHotkeyScript,
  closeTargetPanel,
  t,
  container,
  macroAlreadyConfigured,
  macroBlockedBySoundboard,
  mapOptionToTarget,
  onMacroAlreadyConfigured,
  onSoundboardAlreadyConfigured,
  onSpecialActionConflict,
  optionForTarget,
  selection,
  setDisplay,
  soundboardAlreadyConfigured,
  soundboardBlockedByMacro,
  targetDisplayCache,
  targetIdentity,
}) {
  function syncContainerValue(markUnavailable = false) {
    container.__selectedTargets = [...selection.selectedTargets];
    container.__selectedTarget = selection.selectedTargets[0] || "Unset";
    container.__selectedTargetOption =
      selection.selectedTargetOption || optionForTarget(selection.selectedTargets[0]);
    container.__openApplication = selection.selectedOpenApplication;
    container.__autoHotkeyScript = selection.selectedAutoHotkeyScript;
    container.value = selection.selectedTargets.length ? targetIdentity(selection.selectedTargets[0]) : "";
    container.dataset.kind = selection.selectedTargets.length ? "multi" : "placeholder";
    container.classList.toggle(
      "target-unavailable",
      Boolean(markUnavailable && selection.selectedTargets.length <= 1),
    );
    container.dataset.action = selection.selectedAction;
    container.dataset.actionKind = selection.selectedActionKind;
    container.dataset.actionRole = selection.selectedActionRole;
    container.dataset.actionLabel = selection.selectedActionLabel;
    container.dataset.valueKind = selection.selectedValueKind;
    setDisplay();
  }

  function selectOption(option, actionChoice = null, emit = true) {
    let nextActionValue = null;
    let nextActionLabel = null;
    let nextActionRole = null;
    let nextValueKind = null;
    let actionTargetOption = null;
    if (typeof actionChoice === "string") {
      nextActionValue = actionChoice;
    } else if (actionChoice && typeof actionChoice === "object") {
      nextActionValue = String(actionChoice.value || "");
      nextActionLabel = String(actionChoice.label || "").trim() || null;
      nextActionRole = normalizeActionRole(actionChoice.role || actionChoice.action_role, nextActionValue);
      nextValueKind = String(actionChoice.value_kind || actionChoice.valueKind || "").trim() || null;
      actionTargetOption = actionChoice.targetOption || actionChoice.target_option || null;
    }
    if (nextActionValue) {
      selection.selectedAction = nextActionValue;
      selection.selectedActionRole = nextActionRole || normalizeActionRole(null, nextActionValue);
      selection.selectedActionLabel = nextActionLabel || "";
      selection.selectedValueKind = nextValueKind || "";
    }
    selection.selectedActionKind = String(actionChoice?.behavior || actionChoice?.action_kind || "").trim();
    if (nextActionValue !== "OpenApplication") {
      selection.selectedOpenApplication = null;
    }
    if (nextActionValue !== "RunAutoHotkeyScript") {
      selection.selectedAutoHotkeyScript = null;
    }
    const chosenOpenApplication = normalizeOpenApplication(
      actionChoice?.openApplication || actionChoice?.open_application,
    );
    if (chosenOpenApplication) {
      selection.selectedOpenApplication = chosenOpenApplication;
    }
    const chosenAutoHotkeyScript = normalizeAutoHotkeyScript(
      actionChoice?.autoHotkeyScript || actionChoice?.autohotkey_script,
    );
    if (chosenAutoHotkeyScript) {
      selection.selectedAutoHotkeyScript = chosenAutoHotkeyScript;
    }
    const targetSourceOption = actionTargetOption || option;
    if (
      nextActionLabel &&
      selection.selectedActionRole !== "value" &&
      targetSourceOption &&
      typeof targetSourceOption === "object"
    ) {
      targetSourceOption.__selectedActionLabel = nextActionLabel;
    }
    if (nextActionValue && targetSourceOption && typeof targetSourceOption === "object") {
      targetSourceOption.__selectedActionValue = nextActionValue;
    }
    if (selection.selectedActionKind && targetSourceOption && typeof targetSourceOption === "object") {
      targetSourceOption.__selectedActionKind = selection.selectedActionKind;
    }

    const mapped = mapOptionToTarget(targetSourceOption);
    if (
      (mapped === "Macro" && macroBlockedBySoundboard) ||
      (mapped === "Soundboard" && soundboardBlockedByMacro)
    ) {
      onSpecialActionConflict?.();
      closeTargetPanel();
      syncContainerValue(false);
      return;
    }
    if (mapped === "Macro" && macroAlreadyConfigured) {
      onMacroAlreadyConfigured?.();
      closeTargetPanel();
      syncContainerValue(false);
      return;
    }
    if (mapped === "Soundboard" && soundboardAlreadyConfigured) {
      onSoundboardAlreadyConfigured?.();
      closeTargetPanel();
      syncContainerValue(false);
      return;
    }
    if (mapped === "Hotkey") {
      selection.selectedAction = "Hotkey";
    }
    if (mapped === "Macro") {
      selection.selectedAction = "Macro";
    }
    if (mapped === "Soundboard") {
      selection.selectedAction = "Soundboard";
    }
    if (mapped === "OpenApplication") {
      selection.selectedAction = "OpenApplication";
    }
    if (mapped === "AutoHotkeyScript") {
      selection.selectedAction = "RunAutoHotkeyScript";
    }
    if (mapped?.Profile || mapped?.profile) {
      selection.selectedAction = "SwitchProfile";
    }
    const key = targetIdentity(mapped);
    const mappedIsProfile = Boolean(mapped?.Profile || mapped?.profile);
    const replacesProfileTarget =
      !mappedIsProfile &&
      selection.selectedTargets.some((target) => Boolean(target?.Profile || target?.profile));
    selection.selectedTargetOption =
      targetSourceOption &&
      typeof targetSourceOption === "object" &&
      targetSourceOption.kind !== "placeholder"
        ? targetSourceOption
        : null;
    const cachedLabel = String(targetSourceOption?.label || option?.label || "").trim();
    if (cachedLabel || targetSourceOption?.icon_data || option?.icon_data) {
      targetDisplayCache.set(key, {
        label: cachedLabel || t("common.target"),
        icon_data: targetSourceOption?.icon_data ?? option?.icon_data ?? null,
      });
    }
    const exists = selection.selectedTargets.findIndex((t) => targetIdentity(t) === key);
    const updatesExistingAction = exists >= 0 && nextActionValue;
    const updatesExistingFileTarget =
      exists >= 0 &&
      (option?.kind === "open-application-target" || option?.kind === "autohotkey-script-target");
    if (mappedIsProfile || replacesProfileTarget) {
      selection.selectedTargets = [mapped];
    } else if (updatesExistingAction || updatesExistingFileTarget) {
      selection.selectedTargets[exists] = mapped;
    } else if (exists >= 0) {
      selection.selectedTargets.splice(exists, 1);
    } else if (selection.selectedTargets.length < 8) {
      selection.selectedTargets.push(mapped);
    }
    syncContainerValue(Boolean(option.ghost));
    if (emit) container.dispatchEvent(new Event("change"));
  }

  return { syncContainerValue, selectOption };
}

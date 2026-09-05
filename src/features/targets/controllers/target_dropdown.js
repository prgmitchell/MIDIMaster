import { createPicker } from "./picker.js";
import { createSelection } from "./selection.js";
import { createActionPolicy } from "./action_policy.js";
import { createSelectionDisplay } from "./selection_display.js";
import {
  normalizeSelectedTargets,
  targetIdentity as canonicalTargetIdentity,
  mapTargetOptionToTarget,
} from "../selection_model.js";

/** target dropdown workflow. */
export function createTargetDropdown({
  buildMonitorBrightnessOptions,
  buildTargetOptions,
  callInvoke,
  closeTargetPanel,
  createTargetIcon,
  elements,
  displayNameFromPath,
  focusIconData,
  friendlyAppName,
  getHost,
  getPlayback,
  getRecording,
  getSess,
  masterIconData,
  mediaActionOptions,
  mediaPlayPauseIconData,
  normalizeAutoHotkeyScript,
  normalizeKey,
  normalizeOpenApplication,
  openTargetPanel,
  pickAutoHotkeyScript,
  pickOpenApplication,
  refreshBrightnessMonitors,
  resolveDisplay,
  resolveOpenApplicationIcon,
  t,
  targetKey,
}) {
  function buildTargetSelect(
    currentTarget,
    isBindingButton = false,
    currentAction = "Volume",
    currentHotkeyDisplay = "",
    currentOpenApplication = null,
    currentAutoHotkeyScript = null,
    selectOptions = {},
  ) {
    const container = document.createElement("div");
    container.className = "target-dropdown binding-target-dropdown";
    const allowEmptyInitial = Boolean(selectOptions?.allowEmptyInitial);
    const excludeMacroTarget = Boolean(selectOptions?.excludeMacroTarget);
    const overConfigModal = Boolean(selectOptions?.overConfigModal);
    const includeValueAction = Boolean(selectOptions?.includeValueAction);
    const targetOnly = Boolean(selectOptions?.targetOnly);
    const includeWindowFocusAction = Boolean(selectOptions?.includeWindowFocusAction);
    const macroDisplayName = String(selectOptions?.macroDisplayName || "").trim();
    const suppressActionTags = Boolean(selectOptions?.suppressActionTags);
    const macroAlreadyConfigured = Boolean(selectOptions?.macroAlreadyConfigured);
    const onMacroAlreadyConfigured =
      typeof selectOptions?.onMacroAlreadyConfigured === "function"
        ? selectOptions.onMacroAlreadyConfigured
        : null;
    const soundboardAlreadyConfigured = Boolean(selectOptions?.soundboardAlreadyConfigured);
    const onSoundboardAlreadyConfigured =
      typeof selectOptions?.onSoundboardAlreadyConfigured === "function"
        ? selectOptions.onSoundboardAlreadyConfigured
        : null;
    const macroBlockedBySoundboard = Boolean(selectOptions?.macroBlockedBySoundboard);
    const soundboardBlockedByMacro = Boolean(selectOptions?.soundboardBlockedByMacro);
    const onSpecialActionConflict =
      typeof selectOptions?.onSpecialActionConflict === "function"
        ? selectOptions.onSpecialActionConflict
        : null;

    function filterPickerOptions(list) {
      return (Array.isArray(list) ? list : [])
        .filter((option) => !(excludeMacroTarget && option?.kind === "macro-target"))
        .filter((option) => !(excludeMacroTarget && option?.kind === "soundboard-target"))
        .filter((option) => !(targetOnly && option?.kind === "profile-switch-root"));
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "target-button";

    const display = document.createElement("span");
    display.className = "target-display";

    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "\u25be";

    button.appendChild(display);
    button.appendChild(caret);

    const normalizeTargets = normalizeSelectedTargets;
    function targetIdentity(target) {
      return canonicalTargetIdentity(target, targetKey);
    }

    const selection = {
      selectedTargets: normalizeTargets(currentTarget),
      hotkeyDisplay: String(currentHotkeyDisplay || ""),
      selectedTargetOption: null,
      selectedAction: isBindingButton ? currentAction || "ToggleMute" : "Volume",
      selectedActionKind: "",
      selectedActionRole: String(selectOptions?.currentActionRole || "")
        .trim()
        .toLowerCase(),
      selectedActionLabel: String(selectOptions?.currentActionLabel || "").trim(),
      selectedValueKind: String(selectOptions?.currentValueKind || "").trim(),
      selectedOpenApplication: isBindingButton ? normalizeOpenApplication(currentOpenApplication) : null,
      selectedAutoHotkeyScript: isBindingButton ? normalizeAutoHotkeyScript(currentAutoHotkeyScript) : null,
    };

    const targetDisplayCache = new Map();

    const {
      options: rawOptions,
      selectedValue,
      selectedKind,
      activeIntegrationOption,
    } = buildTargetOptions(selection.selectedTargets[0] || currentTarget, isBindingButton);
    const options = filterPickerOptions(rawOptions);
    const placeholderOption = {
      value: "",
      label: t("targets.selectApplicationOrDevice"),
      icon_data: null,
      kind: "placeholder",
    };

    function integrationFromTarget(target) {
      return target?.Integration || target?.integration || null;
    }

    function escapeRegExp(value) {
      return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    const unavailableSuffixPattern = new RegExp(
      `\\s*\\(\\s*(?:Unavailable|${escapeRegExp(t("targets.unavailable"))})\\s*\\)\\s*$`,
      "i",
    );
    function hasUnavailableSuffix(label) {
      return unavailableSuffixPattern.test(String(label || ""));
    }
    function stripUnavailableSuffix(label) {
      const raw = String(label || "");
      const stripped = raw.replace(unavailableSuffixPattern, "").trim();
      return stripped || raw;
    }

    selection.selectedActionKind = String(
      integrationFromTarget(selection.selectedTargets[0])?.data?.action_kind || "",
    ).trim();

    if (!selection.selectedActionRole && selection.selectedAction === "Volume") {
      const integ = integrationFromTarget(selection.selectedTargets[0]);
      const data = integ?.data || {};
      selection.selectedActionRole =
        integ &&
        (data.action_label ||
          data.action_value ||
          data.action_kind ||
          data.button_action ||
          data.osd_value_text)
          ? "command"
          : "value";
    }

    function mapOptionToTarget(option) {
      return mapTargetOptionToTarget(option, { fallbackTarget: selection.selectedTargets[0] });
    }

    const { actionLabel, cachedDisplayForTarget, optionForTarget, renderChip, setDisplay } =
      createSelectionDisplay({
        t,
        getHost,
        friendlyAppName,
        resolveOpenApplicationIcon,
        displayNameFromPath,
        resolveDisplay,
        masterIconData,
        focusIconData,
        mediaPlayPauseIconData,
        targetKey,
        createTargetIcon,
        container,
        display,
        hasUnavailableSuffix: (...args) => hasUnavailableSuffix(...args),
        includeValueAction,
        integrationFromTarget: (...args) => integrationFromTarget(...args),
        isBindingButton,
        macroDisplayName,
        placeholderOption,
        selection,
        stripUnavailableSuffix: (...args) => stripUnavailableSuffix(...args),
        suppressActionTags,
        syncContainerValue: (...args) => syncContainerValue(...args),
        targetDisplayCache,
        targetIdentity: (...args) => targetIdentity(...args),
      });

    const {
      normalizeButtonActionOption,
      valueActionOption,
      addValueAction,
      captureActionOptions,
      collectIntegrationTargetOptions,
      hydrateIntegrationActionsForTarget,
      loadMacroNavActionOptionsForDropdown,
      buildActionOptionsForTargetOption,
    } = createActionPolicy({
      t,
      getSess,
      getPlayback,
      getRecording,
      targetKey,
      getHost,
      mediaActionOptions,
      includeValueAction,
      includeWindowFocusAction,
      targetIdentity: (...args) => targetIdentity(...args),
    });

    const { syncContainerValue, selectOption } = createSelection({
      normalizeOpenApplication,
      normalizeAutoHotkeyScript,
      closeTargetPanel,
      t,
      container,
      macroAlreadyConfigured,
      macroBlockedBySoundboard,
      mapOptionToTarget: (...args) => mapOptionToTarget(...args),
      onMacroAlreadyConfigured,
      onSoundboardAlreadyConfigured,
      onSpecialActionConflict,
      optionForTarget: (...args) => optionForTarget(...args),
      selection,
      setDisplay: (...args) => setDisplay(...args),
      soundboardAlreadyConfigured,
      soundboardBlockedByMacro,
      targetDisplayCache,
      targetIdentity: (...args) => targetIdentity(...args),
    });

    const { openTargetPicker } = createPicker({
      elements,
      refreshBrightnessMonitors,
      buildTargetOptions,
      getSess,
      normalizeKey,
      t,
      openTargetPanel,
      callInvoke,
      buildMonitorBrightnessOptions,
      pickOpenApplication,
      closeTargetPanel,
      pickAutoHotkeyScript,
      getHost,
      getPlayback,
      getRecording,
      targetKey,
      buildActionOptionsForTargetOption: (...args) => buildActionOptionsForTargetOption(...args),
      currentTarget,
      filterPickerOptions: (...args) => filterPickerOptions(...args),
      includeValueAction,
      isBindingButton,
      overConfigModal,
      selectOption: (...args) => selectOption(...args),
      selection,
      stripUnavailableSuffix: (...args) => stripUnavailableSuffix(...args),
      targetIdentity: (...args) => targetIdentity(...args),
      targetOnly,
    });

    let initial =
      selectedKind === "placeholder"
        ? placeholderOption
        : options.find((option) => option.value === selectedValue && option.kind === selectedKind);

    if (!initial && activeIntegrationOption) {
      initial = activeIntegrationOption;
    }

    if (!initial) {
      initial = options.find((option) => option.kind !== "divider") || options[0];
    }

    container.dataset.action = selection.selectedAction;
    if (
      !allowEmptyInitial &&
      selection.selectedTargets.length === 0 &&
      initial &&
      initial.kind !== "placeholder"
    ) {
      selection.selectedTargets = [mapOptionToTarget(initial)];
      selection.selectedTargetOption = initial;
    }
    syncContainerValue(false);

    container.getActionOptions = async () => {
      const targetOption = selection.selectedTargetOption || optionForTarget(selection.selectedTargets[0]);
      return buildActionOptionsForTargetOption(targetOption);
    };

    container.setActionOption = (actionOption, emit = true) => {
      const targetOption = selection.selectedTargetOption || optionForTarget(selection.selectedTargets[0]);
      if (!targetOption) return;
      selectOption(targetOption, actionOption, emit);
    };

    button.addEventListener("click", openTargetPicker);

    container.appendChild(button);
    container.openTargetPicker = () => openTargetPicker();
    container.setHotkeyDisplay = (nextDisplay = "") => {
      selection.hotkeyDisplay = String(nextDisplay || "");
      setDisplay();
    };
    container.refreshTargetDisplay = () => {
      setDisplay();
    };
    container.getOpenApplication = () => selection.selectedOpenApplication;
    container.getAutoHotkeyScript = () => selection.selectedAutoHotkeyScript;
    return container;
  }

  return { buildTargetSelect };
}

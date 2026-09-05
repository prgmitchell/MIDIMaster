import {
  MACRO_MAX_TOP_LEVEL_STEPS,
  normalizeHotkeyMapping,
  normalizeOpenApplicationMapping,
  normalizeAutoHotkeyScriptMapping,
  normalizeMacroActionState,
} from "../../../core/binding_model.js";
import {
  defaultMacroActionStep,
  defaultMacroWaitStep,
  defaultMacroParallelStep,
  prepareMacroDraftBinding,
  normalizeMacroDraftSteps,
  clearMacroActionStep,
} from "../macro_draft.js";
import {
  isMacroTarget,
  isHotkeyTarget,
  isOpenApplicationTarget,
  isAutoHotkeyScriptTarget,
} from "../shape_helpers.js";

/** macro config workflow. */
export function createMacroConfig({
  lifetime,
  createBindingConfigButton,
  elements,
  getConfigBinding,
  macroPathForFirstStep,
  macroState,
  normalizeMacroSelectedPath,
  renderConfigModal,
  renderConfigPreview,
  renderMacroEditor,
  t,
  wireMacroButton,
}) {
  function wireMacroConfigControls() {
    wireMacroButton(elements.bindingConfigBack, (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMacroConfigPage();
    });
    wireMacroButton(elements.bindingConfigMacroAddAction, () => {
      updateMacroDraft(
        (steps) => {
          if (steps.length >= MACRO_MAX_TOP_LEVEL_STEPS) return;
          steps.push(defaultMacroActionStep());
          macroState.selectedPath = { type: "top", index: steps.length - 1 };
        },
        { scrollSelected: true },
      );
    });
    wireMacroButton(elements.bindingConfigMacroAddWait, () => {
      updateMacroDraft(
        (steps) => {
          if (steps.length >= MACRO_MAX_TOP_LEVEL_STEPS) return;
          steps.push(defaultMacroWaitStep());
          macroState.selectedPath = { type: "top", index: steps.length - 1 };
        },
        { scrollSelected: true },
      );
    });
    wireMacroButton(elements.bindingConfigMacroAddParallel, () => {
      updateMacroDraft(
        (steps) => {
          if (steps.length >= MACRO_MAX_TOP_LEVEL_STEPS) return;
          steps.push(defaultMacroParallelStep());
          macroState.selectedPath = { type: "top", index: steps.length - 1 };
        },
        { scrollSelected: true },
      );
    });
    wireMacroButton(elements.bindingConfigMacroEdit, (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMacroConfigPage();
    });
  }

  function ensureMacroConfigDom() {
    const panel = elements.bindingConfigPanel;
    const main = panel?.querySelector?.(".binding-config-main-column");
    const header = panel?.querySelector?.(".target-panel-header");

    if (panel) {
      elements.bindingConfigBack ||= panel.querySelector("#binding-config-back");
      elements.bindingConfigMacroSummarySection ||= panel.querySelector(
        "#binding-config-macro-summary-section",
      );
      elements.bindingConfigMacroSummary ||= panel.querySelector("#binding-config-macro-summary");
      elements.bindingConfigMacroEdit ||= panel.querySelector("#binding-config-macro-edit");
      elements.bindingConfigMacroSection ||= panel.querySelector("#binding-config-macro-section");
      elements.bindingConfigMacroList ||= panel.querySelector("#binding-config-macro-list");
      elements.bindingConfigMacroAddAction ||= panel.querySelector("#binding-config-macro-add-action");
      elements.bindingConfigMacroAddWait ||= panel.querySelector("#binding-config-macro-add-wait");
      elements.bindingConfigMacroAddParallel ||= panel.querySelector("#binding-config-macro-add-parallel");
    }

    if (!elements.bindingConfigBack && header) {
      const back = document.createElement("button");
      back.id = "binding-config-back";
      back.type = "button";
      back.className = "target-panel-back binding-config-back hidden";
      back.setAttribute("aria-label", t("common.back"));
      back.dataset.i18nAriaLabel = "common.back";
      back.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6" /></svg>';
      header.insertBefore(back, elements.bindingConfigTitle || header.firstChild);
      elements.bindingConfigBack = back;
    }

    if (main && !elements.bindingConfigMacroSummarySection) {
      const summarySection = document.createElement("section");
      summarySection.id = "binding-config-macro-summary-section";
      summarySection.className = "binding-config-section binding-config-section--macro-summary hidden";

      const titleRow = document.createElement("div");
      titleRow.className = "binding-config-title-row";
      const title = document.createElement("span");
      title.className = "binding-config-title";
      title.textContent = t("macro.title");
      title.dataset.i18n = "macro.title";
      const actions = document.createElement("div");
      actions.className = "binding-config-title-actions";
      const edit = createBindingConfigButton("binding-config-macro-edit", t("macro.edit"), "primary");
      edit.dataset.i18n = "macro.edit";
      actions.appendChild(edit);
      titleRow.appendChild(title);
      titleRow.appendChild(actions);

      const summary = document.createElement("div");
      summary.id = "binding-config-macro-summary";
      summary.className = "binding-config-macro-summary";
      summarySection.appendChild(titleRow);
      summarySection.appendChild(summary);

      main.insertBefore(summarySection, elements.bindingConfigCurveSection || null);
      elements.bindingConfigMacroSummarySection = summarySection;
      elements.bindingConfigMacroSummary = summary;
      elements.bindingConfigMacroEdit = edit;
    }

    if (main && !elements.bindingConfigMacroSection) {
      const macroSection = document.createElement("section");
      macroSection.id = "binding-config-macro-section";
      macroSection.className = "binding-config-section binding-config-section--macro hidden";

      const titleRow = document.createElement("div");
      titleRow.className = "binding-config-title-row";
      const title = document.createElement("span");
      title.className = "binding-config-title";
      title.textContent = t("macro.title");
      title.dataset.i18n = "macro.title";
      const actions = document.createElement("div");
      actions.className = "binding-config-title-actions";
      const addAction = createBindingConfigButton("binding-config-macro-add-action", t("macro.step.action"));
      const addWait = createBindingConfigButton("binding-config-macro-add-wait", t("macro.step.wait"));
      const addParallel = createBindingConfigButton(
        "binding-config-macro-add-parallel",
        t("macro.step.parallelGroup"),
      );
      addAction.dataset.i18n = "macro.step.action";
      addWait.dataset.i18n = "macro.step.wait";
      addParallel.dataset.i18n = "macro.step.parallelGroup";
      actions.appendChild(addAction);
      actions.appendChild(addWait);
      actions.appendChild(addParallel);
      titleRow.appendChild(title);
      titleRow.appendChild(actions);

      const list = document.createElement("div");
      list.id = "binding-config-macro-list";
      list.className = "binding-config-macro-list";
      macroSection.appendChild(titleRow);
      macroSection.appendChild(list);

      main.insertBefore(macroSection, elements.bindingConfigCurveSection || null);
      elements.bindingConfigMacroSection = macroSection;
      elements.bindingConfigMacroList = list;
      elements.bindingConfigMacroAddAction = addAction;
      elements.bindingConfigMacroAddWait = addWait;
      elements.bindingConfigMacroAddParallel = addParallel;
    }

    wireMacroConfigControls();
  }

  function openMacroConfigPage() {
    const binding = getConfigBinding();
    if (!binding || binding.action !== "Macro") return;
    ensureMacroConfigDom();
    prepareMacroDraftBinding(binding, { preservePlaceholders: true });
    normalizeMacroSelectedPath(binding, macroState.selectedPath || macroPathForFirstStep(binding));
    macroState.pageOpen = true;
    renderConfigModal();
  }

  function closeMacroConfigPage() {
    macroState.pageOpen = false;
    macroState.selectedPath = null;
    renderConfigModal();
  }

  function updateMacroDraft(mutator, options = {}) {
    const binding = getConfigBinding();
    if (!binding || binding.action !== "Macro") return;
    const steps = Array.isArray(binding.macro_steps) ? binding.macro_steps : [];
    mutator(steps);
    binding.macro_steps = normalizeMacroDraftSteps(steps);
    normalizeMacroSelectedPath(binding, options.selectPath || macroState.selectedPath);
    if (options.scrollSelected) macroState.pendingSelectedScroll = true;
    renderMacroEditor(binding);
    renderConfigPreview();
  }

  function commitMacroDraftEdit(binding, { rerender = true } = {}) {
    if (!binding || binding.action !== "Macro") return;
    binding.macro_steps = normalizeMacroDraftSteps(binding.macro_steps);
    normalizeMacroSelectedPath(binding);
    if (rerender) renderMacroEditor(binding);
    renderConfigPreview();
  }

  function setMacroActionFromTargetSelect(step, targetSelect, previous = {}) {
    const selectedTargets = Array.isArray(targetSelect.__selectedTargets)
      ? targetSelect.__selectedTargets
      : targetSelect.__selectedTarget
        ? [targetSelect.__selectedTarget]
        : [];
    if (selectedTargets.some(isMacroTarget) || targetSelect.dataset.action === "Macro") {
      Object.assign(step, previous);
      return false;
    }
    const usableTargets = selectedTargets.filter(
      (target) => target && target !== "Unset" && !isMacroTarget(target),
    );
    if (usableTargets.length === 0) {
      clearMacroActionStep(step);
      return true;
    }

    const hasHotkeyTarget = usableTargets.some(isHotkeyTarget);
    const hasOpenApplicationTarget = usableTargets.some(isOpenApplicationTarget);
    const hasAutoHotkeyScriptTarget = usableTargets.some(isAutoHotkeyScriptTarget);
    step.targets = usableTargets;
    step.action = hasHotkeyTarget
      ? "Hotkey"
      : hasOpenApplicationTarget
        ? "OpenApplication"
        : hasAutoHotkeyScriptTarget
          ? "RunAutoHotkeyScript"
          : targetSelect.dataset.action || step.action || "ToggleMute";

    const usesDirectUtilityTarget = hasHotkeyTarget || hasOpenApplicationTarget || hasAutoHotkeyScriptTarget;
    const actionRole = usesDirectUtilityTarget
      ? ""
      : String(targetSelect.dataset.actionRole || "")
          .trim()
          .toLowerCase();
    const actionLabel = usesDirectUtilityTarget ? "" : String(targetSelect.dataset.actionLabel || "").trim();
    const valueKind = usesDirectUtilityTarget ? "" : String(targetSelect.dataset.valueKind || "").trim();
    if (actionRole) step.action_role = actionRole;
    else delete step.action_role;
    if (actionLabel) step.action_label = actionLabel;
    else delete step.action_label;
    if (valueKind) step.value_kind = valueKind;
    else delete step.value_kind;
    if (step.action === "Volume" && step.action_role === "value") {
      step.value = Math.min(1, Math.max(0, Number(step.value ?? previous.value ?? 1)));
    } else {
      delete step.value;
    }

    step.hotkey = step.action === "Hotkey" ? normalizeHotkeyMapping(step.hotkey) : null;
    step.open_application =
      step.action === "OpenApplication"
        ? normalizeOpenApplicationMapping(
            targetSelect?.getOpenApplication?.() || targetSelect?.__openApplication,
          )
        : null;
    step.autohotkey_script =
      step.action === "RunAutoHotkeyScript"
        ? normalizeAutoHotkeyScriptMapping(
            targetSelect?.getAutoHotkeyScript?.() || targetSelect?.__autoHotkeyScript,
          )
        : null;
    step.state = normalizeMacroActionState(
      step.state || (step.action === "ToggleMute" || step.action === "ToggleEffect" ? "Toggle" : "Default"),
    );
    return true;
  }

  function sameMacroTargets(a = [], b = []) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((target, index) => JSON.stringify(target) === JSON.stringify(b[index]));
  }

  function setMacroActionTargetFromTargetSelect(step, targetSelect, previous = {}) {
    const selectedTargets = Array.isArray(targetSelect.__selectedTargets)
      ? targetSelect.__selectedTargets
      : targetSelect.__selectedTarget
        ? [targetSelect.__selectedTarget]
        : [];
    if (selectedTargets.some(isMacroTarget) || targetSelect.dataset.action === "Macro") {
      Object.assign(step, previous);
      return false;
    }
    const usableTargets = selectedTargets.filter(
      (target) => target && target !== "Unset" && !isMacroTarget(target),
    );
    if (usableTargets.length === 0) {
      clearMacroActionStep(step);
      return true;
    }

    const targetChanged = !sameMacroTargets(previous.targets || [], usableTargets);
    const hasHotkeyTarget = usableTargets.some(isHotkeyTarget);
    const hasOpenApplicationTarget = usableTargets.some(isOpenApplicationTarget);
    const hasAutoHotkeyScriptTarget = usableTargets.some(isAutoHotkeyScriptTarget);
    step.targets = usableTargets;
    if (targetChanged && !hasHotkeyTarget && !hasOpenApplicationTarget && !hasAutoHotkeyScriptTarget) {
      step.action = "";
      delete step.action_role;
      delete step.action_label;
      delete step.value_kind;
      delete step.value;
      step.state = "Default";
      step.hotkey = null;
      step.open_application = null;
      step.autohotkey_script = null;
      return true;
    }

    if (hasHotkeyTarget) {
      step.action = "Hotkey";
      step.hotkey = normalizeHotkeyMapping(step.hotkey);
    } else if (hasOpenApplicationTarget) {
      step.action = "OpenApplication";
      step.open_application = normalizeOpenApplicationMapping(
        targetSelect?.getOpenApplication?.() || targetSelect?.__openApplication,
      );
    } else if (hasAutoHotkeyScriptTarget) {
      step.action = "RunAutoHotkeyScript";
      step.autohotkey_script = normalizeAutoHotkeyScriptMapping(
        targetSelect?.getAutoHotkeyScript?.() || targetSelect?.__autoHotkeyScript,
      );
    }
    return true;
  }

  function applyMacroActionOptionToStep(step, actionOption, targetSelect = null) {
    if (!step || !actionOption) return;
    const action = String(actionOption.value || "");
    step.action = action;
    const role = String(actionOption.role || actionOption.action_role || "")
      .trim()
      .toLowerCase();
    const label = String(actionOption.label || "").trim();
    const valueKind = String(actionOption.value_kind || actionOption.valueKind || "").trim();
    if (role) step.action_role = role;
    else delete step.action_role;
    if (label && role !== "value") step.action_label = label;
    else delete step.action_label;
    if (valueKind) step.value_kind = valueKind;
    else delete step.value_kind;
    if (action === "Volume" && role === "value") {
      step.value = Math.min(1, Math.max(0, Number(step.value ?? 1)));
    } else {
      delete step.value;
    }
    step.state = normalizeMacroActionState(
      step.state || (action === "ToggleMute" || action === "ToggleEffect" ? "Toggle" : "Default"),
    );
    step.hotkey = action === "Hotkey" ? normalizeHotkeyMapping(step.hotkey) : null;
    step.open_application =
      action === "OpenApplication"
        ? normalizeOpenApplicationMapping(
            targetSelect?.getOpenApplication?.() || targetSelect?.__openApplication || step.open_application,
          )
        : null;
    step.autohotkey_script =
      action === "RunAutoHotkeyScript"
        ? normalizeAutoHotkeyScriptMapping(
            targetSelect?.getAutoHotkeyScript?.() ||
              targetSelect?.__autoHotkeyScript ||
              step.autohotkey_script,
          )
        : null;
  }

  function buildMacroStateSelect(step, onChange) {
    const select = document.createElement("select");
    select.className = "binding-config-macro-select";
    const isMute = step.action === "ToggleMute";
    const options = isMute
      ? [
          ["Toggle", "Toggle"],
          ["Mute", "Mute"],
          ["Unmute", "Unmute"],
        ]
      : [
          ["Toggle", "Toggle"],
          ["On", "On"],
          ["Off", "Off"],
        ];
    options.forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    });
    select.value = options.some(([value]) => value === step.state) ? step.state : "Toggle";
    lifetime.listen(select, "change", () => {
      step.state = select.value;
      onChange({ rerender: false });
    });
    return select;
  }

  return {
    ensureMacroConfigDom,
    updateMacroDraft,
    commitMacroDraftEdit,
    setMacroActionFromTargetSelect,
    setMacroActionTargetFromTargetSelect,
    applyMacroActionOptionToStep,
    buildMacroStateSelect,
  };
}

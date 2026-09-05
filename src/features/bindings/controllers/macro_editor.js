import {
  prepareMacroDraftBinding,
  ensureMacroName,
  normalizeMacroName,
  defaultMacroActionStep,
  defaultMacroWaitStep,
  defaultMacroParallelStep,
} from "../macro_draft.js";
import { MACRO_MAX_TOP_LEVEL_STEPS } from "../../../core/binding_model.js";

/** macro editor workflow. */
export function createMacroEditor({
  createBindingConfigButton,
  elements,
  macroPathForFirstStep,
  macroState,
  normalizeMacroSelectedPath,
  renderConfigPreview,
  renderMacroProperties,
  renderMacroStepCard,
  scrollSelectedMacroStepIntoView,
  t,
  updateMacroDraft,
}) {
  function renderMacroEditor(binding) {
    const section = elements.bindingConfigMacroSection;
    if (!section) return;
    prepareMacroDraftBinding(binding, { preservePlaceholders: true });
    normalizeMacroSelectedPath(binding, macroState.selectedPath || macroPathForFirstStep(binding));
    section.innerHTML = "";

    const shell = document.createElement("div");
    shell.className = "binding-config-macro-designer";

    const header = document.createElement("div");
    header.className = "binding-config-macro-designer-header";
    const nameField = document.createElement("label");
    nameField.className = "binding-config-macro-name-field";
    const nameLabel = document.createElement("span");
    nameLabel.textContent = t("macro.name");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 80;
    nameInput.value = ensureMacroName(binding, { defaultIfBlank: true });
    nameInput.addEventListener("input", () => {
      binding.macro_name = normalizeMacroName(nameInput.value);
      renderConfigPreview();
    });
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);
    header.appendChild(nameField);

    const addGroup = document.createElement("div");
    addGroup.className = "binding-config-macro-add-group";
    const addLabel = document.createElement("span");
    addLabel.className = "binding-config-macro-add-label";
    addLabel.textContent = t("macro.addStep");
    addGroup.appendChild(addLabel);

    const addActions = document.createElement("div");
    addActions.className = "binding-config-title-actions binding-config-macro-add-actions";
    [
      [t("macro.addAction"), defaultMacroActionStep],
      [t("macro.addWait"), defaultMacroWaitStep],
      [t("macro.addParallel"), defaultMacroParallelStep],
    ].forEach(([label, factory]) => {
      const button = createBindingConfigButton("", label, "secondary");
      button.disabled = binding.macro_steps.length >= MACRO_MAX_TOP_LEVEL_STEPS;
      button.addEventListener("click", () =>
        updateMacroDraft(
          (steps) => {
            if (steps.length >= MACRO_MAX_TOP_LEVEL_STEPS) return;
            steps.push(factory());
            macroState.selectedPath = { type: "top", index: steps.length - 1 };
          },
          { scrollSelected: true },
        ),
      );
      addActions.appendChild(button);
    });
    addGroup.appendChild(addActions);
    header.appendChild(addGroup);
    shell.appendChild(header);

    const body = document.createElement("div");
    body.className = "binding-config-macro-designer-body";
    const stepsPanel = document.createElement("div");
    stepsPanel.className = "binding-config-macro-steps-panel";
    const stepsTitle = document.createElement("div");
    stepsTitle.className = "binding-config-macro-panel-title";
    const titleText = document.createElement("span");
    titleText.textContent = t("macro.steps");
    const count = document.createElement("span");
    count.className = "binding-config-macro-count";
    count.textContent = String(binding.macro_steps.length);
    stepsTitle.appendChild(titleText);
    stepsTitle.appendChild(count);
    stepsPanel.appendChild(stepsTitle);
    const list = document.createElement("div");
    list.id = "binding-config-macro-list";
    list.className = "binding-config-macro-list binding-config-macro-timeline";
    elements.bindingConfigMacroList = list;

    binding.macro_steps.forEach((step, index) => {
      const path = { type: "top", index };
      renderMacroStepCard(list, binding, step, path);
      if (step.kind === "parallel" && Array.isArray(step.steps) && step.steps.length > 0) {
        const children = document.createElement("div");
        children.className = "binding-config-macro-parallel-children";
        step.steps.forEach((child, childIndex) => {
          renderMacroStepCard(
            children,
            binding,
            child,
            { type: "parallel", groupIndex: index, index: childIndex },
            { child: true },
          );
        });
        list.appendChild(children);
      }
    });
    if (binding.macro_steps.length === 0) {
      const empty = document.createElement("div");
      empty.className = "binding-config-macro-empty-state";
      empty.textContent = t("macro.noStepsYet");
      list.appendChild(empty);
    }
    stepsPanel.appendChild(list);

    const propertiesPanel = document.createElement("div");
    propertiesPanel.className = "binding-config-macro-properties-panel";
    renderMacroProperties(propertiesPanel, binding);

    body.appendChild(stepsPanel);
    body.appendChild(propertiesPanel);
    shell.appendChild(body);
    section.appendChild(shell);
    scrollSelectedMacroStepIntoView();
  }

  return { renderMacroEditor };
}

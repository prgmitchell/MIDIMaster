import {
  macroActionRole,
  clonePlain,
  macroActionHasTarget,
  macroActionIsLegacyTriggerPlaceholder,
  macroActionUsesValue,
} from "../macro_draft.js";
import {
  renderLabelWithBadges,
  positionFloatingDropdownMenu,
  wireDropdownToggle,
} from "../../ui/dropdown_badges.js";
import { isMacroTarget } from "../shape_helpers.js";

/** macro action properties workflow. */
export function createMacroActionProperties({
  applyMacroActionOptionToStep,
  buildMacroStateSelect,
  buildTarget,
  commitMacroDraftEdit,
  createBindingConfigButton,
  macroActionTitle,
  macroStepOrdinalLabel,
  renderMacroEditor,
  setMacroActionTargetFromTargetSelect,
  startHotkeyLearn,
  t,
}) {
  function createMacroField(labelText) {
    const field = document.createElement("label");
    field.className = "binding-config-macro-property-field";
    const label = document.createElement("span");
    label.className = "binding-config-macro-property-label";
    label.textContent = labelText;
    field.appendChild(label);
    return field;
  }

  function macroActionOptionMatchesStep(option, step) {
    if (!option || !step) return false;
    if (String(option.value || "") !== String(step.action || "")) return false;
    if (String(step.action || "") === "Volume") {
      return String(option.role || "") === macroActionRole(step);
    }
    const stepLabel = String(step.action_label || "").trim();
    return !stepLabel || String(option.label || "").trim() === stepLabel;
  }

  function macroActionOptionBadge(option) {
    const role = String(option?.role || "")
      .trim()
      .toLowerCase();
    if (role === "value") return { text: "Value", kind: "mix" };
    if (role === "state") return { text: "State", kind: "state" };
    return null;
  }

  function renderMacroActionOptionLabel(container, option, placeholder = t("macro.chooseAction")) {
    if (!container) return;
    container.innerHTML = "";
    if (!option) {
      const label = document.createElement("span");
      label.className = "target-placeholder";
      label.textContent = placeholder;
      container.appendChild(label);
      return;
    }
    renderLabelWithBadges(container, {
      text: option.label || option.value || t("macro.step.action"),
      badges: [macroActionOptionBadge(option)].filter(Boolean),
      truncate: true,
    });
  }

  function renderMacroActionTypeDropdown(
    slot,
    {
      options = [],
      selectedOption = null,
      disabled = false,
      placeholder = t("macro.chooseAction"),
      emptyLabel = t("macro.noActionsAvailable"),
      onSelect = null,
    } = {},
  ) {
    if (!slot) return;
    slot.innerHTML = "";

    const root = document.createElement("div");
    root.className = "target-dropdown binding-config-macro-action-dropdown";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "target-button";
    button.disabled = disabled;
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const display = document.createElement("span");
    display.className = "target-display";
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "\u25be";
    button.appendChild(display);
    button.appendChild(caret);

    const menu = document.createElement("div");
    menu.className = "target-menu hidden";
    menu.setAttribute("role", "listbox");

    renderMacroActionOptionLabel(display, selectedOption, placeholder);

    if (!disabled && options.length > 0) {
      options.forEach((option) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "target-option";
        item.setAttribute("role", "option");
        if (
          macroActionOptionMatchesStep(option, {
            action: selectedOption?.value,
            action_role: selectedOption?.role,
            action_label: selectedOption?.label,
          })
        ) {
          item.classList.add("selected");
          item.setAttribute("aria-selected", "true");
        }
        const label = document.createElement("span");
        label.className = "target-label";
        renderMacroActionOptionLabel(label, option);
        item.appendChild(label);
        item.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          root.classList.remove("open");
          menu.classList.add("hidden");
          button.setAttribute("aria-expanded", "false");
          onSelect?.(option);
        });
        menu.appendChild(item);
      });
    } else {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "target-option is-disabled";
      empty.disabled = true;
      empty.textContent = disabled ? placeholder : emptyLabel;
      menu.appendChild(empty);
    }

    root.__positionDropdownMenu = () => {
      positionFloatingDropdownMenu({
        menu,
        trigger: button,
        minHeight: 120,
        maxHeight: 260,
      });
    };

    if (!disabled) {
      wireDropdownToggle({ root, menu, trigger: button });
    }
    root.appendChild(button);
    root.appendChild(menu);
    slot.appendChild(root);
  }

  function renderMacroActionProperties(panel, binding, step, path) {
    const targetField = createMacroField(t("macro.target"));
    const targetSelect = buildTarget(
      step.targets,
      true,
      step.action || "",
      step.hotkey?.display || "",
      step.open_application || null,
      step.autohotkey_script || null,
      {
        allowEmptyInitial: true,
        excludeMacroTarget: true,
        includeValueAction: true,
        includeWindowFocusAction: true,
        overConfigModal: true,
        targetOnly: true,
        suppressActionTags: true,
        currentActionRole: step.action_role || "",
        currentActionLabel: step.action_label || "",
        currentValueKind: step.value_kind || "",
      },
    );
    targetSelect.addEventListener("change", async () => {
      const previous = clonePlain(step);
      const changed = setMacroActionTargetFromTargetSelect(step, targetSelect, previous);
      if (!changed) {
        commitMacroDraftEdit(binding);
        return;
      }
      const newlyHotkey = step.action === "Hotkey" && !previous.hotkey;
      if (newlyHotkey) {
        const learned = await startHotkeyLearn({ id: `${binding.id}-macro-${macroStepOrdinalLabel(path)}` });
        if (learned) step.hotkey = learned;
        else Object.assign(step, previous);
      }
      commitMacroDraftEdit(binding);
    });
    targetField.appendChild(targetSelect);
    panel.appendChild(targetField);

    const actionField = createMacroField(t("macro.actionType"));
    const hasTarget = macroActionHasTarget(step);
    const actionSlot = document.createElement("div");
    actionSlot.className = "binding-config-macro-action-type-slot";
    renderMacroActionTypeDropdown(actionSlot, {
      disabled: true,
      placeholder: hasTarget ? t("macro.loadingActions") : t("macro.selectTargetFirst"),
    });
    actionField.appendChild(actionSlot);
    panel.appendChild(actionField);

    if (hasTarget) {
      targetSelect
        .getActionOptions?.()
        .then((loadedOptions = []) => {
          if (!actionSlot.isConnected) return;
          const options = [...loadedOptions];
          if (
            step.action &&
            !macroActionIsLegacyTriggerPlaceholder(step) &&
            !options.some((option) => macroActionOptionMatchesStep(option, step))
          ) {
            options.unshift({
              label: macroActionTitle(step.action, step),
              value: step.action,
              kind: "action",
              role: macroActionRole(step) || "command",
              value_kind: step.value_kind || "",
            });
          }
          renderMacroActionTypeDropdown(actionSlot, {
            options,
            selectedOption: options.find((option) => macroActionOptionMatchesStep(option, step)) || null,
            disabled: options.length === 0,
            placeholder: options.length === 0 ? t("macro.noActionsAvailable") : t("macro.chooseAction"),
            onSelect: (option) => {
              targetSelect.setActionOption?.(option, false);
              const selectedTargets = Array.isArray(targetSelect.__selectedTargets)
                ? targetSelect.__selectedTargets.filter(
                    (target) => target && target !== "Unset" && !isMacroTarget(target),
                  )
                : [];
              if (selectedTargets.length > 0) step.targets = selectedTargets;
              applyMacroActionOptionToStep(step, option, targetSelect);
              commitMacroDraftEdit(binding);
            },
          });
        })
        .catch(() => {
          if (actionSlot.isConnected) {
            renderMacroActionTypeDropdown(actionSlot, {
              disabled: true,
              placeholder: t("macro.noActionsAvailable"),
            });
          }
        });
    }

    if (macroActionUsesValue(step)) {
      const valueField = createMacroField(t("macro.value"));
      const control = document.createElement("div");
      control.className = "binding-config-macro-value-editor";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = "100";
      input.step = "1";
      input.value = String(Math.round(Math.min(1, Math.max(0, Number(step.value ?? 1))) * 100));
      const suffix = document.createElement("span");
      suffix.textContent = "%";
      const range = document.createElement("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.step = "1";
      range.value = input.value;
      const syncValue = (raw) => {
        const value = Math.min(100, Math.max(0, Number(raw) || 0));
        input.value = String(Math.round(value));
        range.value = String(Math.round(value));
        step.value = value / 100;
        commitMacroDraftEdit(binding, { rerender: false });
      };
      input.addEventListener("input", () => syncValue(input.value));
      range.addEventListener("input", () => syncValue(range.value));
      input.addEventListener("change", () => renderMacroEditor(binding));
      range.addEventListener("change", () => renderMacroEditor(binding));
      control.appendChild(input);
      control.appendChild(suffix);
      valueField.appendChild(control);
      valueField.appendChild(range);
      panel.appendChild(valueField);
    }

    if (step.action === "ToggleMute" || step.action === "ToggleEffect") {
      const stateField = createMacroField(t("macro.state"));
      stateField.appendChild(buildMacroStateSelect(step, () => commitMacroDraftEdit(binding)));
      panel.appendChild(stateField);
    }

    if (step.action === "Hotkey") {
      const hotkeyButton = createBindingConfigButton(
        "",
        step.hotkey?.display ? t("macro.changeHotkey") : t("macro.learnHotkey"),
        "secondary",
      );
      hotkeyButton.addEventListener("click", async () => {
        const learned = await startHotkeyLearn({ id: `${binding.id}-macro-${macroStepOrdinalLabel(path)}` });
        if (!learned) return;
        step.hotkey = learned;
        commitMacroDraftEdit(binding);
      });
      panel.appendChild(hotkeyButton);
    }
  }

  return { createMacroField, renderMacroActionProperties };
}

import { macroActionHasTarget, macroActionUsesValue, clonePlain } from "../macro_draft.js";
import { MACRO_MAX_PARALLEL_STEPS, MACRO_MAX_TOP_LEVEL_STEPS } from "../../../core/binding_model.js";

/** macro cards workflow. */
export function createMacroCards({
  createMacroDragHandle,
  elements,
  macroActionCountLabel,
  macroActionTitle,
  macroPathKey,
  macroPathsEqual,
  macroState,
  macroStepOrdinalLabel,
  macroTargetTitle,
  macroWaitDurationLabel,
  renderMacroEditor,
  t,
  updateMacroDraft,
}) {
  function macroSelectablePaths(binding) {
    const steps = Array.isArray(binding?.macro_steps) ? binding.macro_steps : [];
    const paths = [];
    steps.forEach((step, index) => {
      paths.push({ type: "top", index });
      if (step?.kind === "parallel" && Array.isArray(step.steps)) {
        step.steps.forEach((_child, childIndex) => {
          paths.push({ type: "parallel", groupIndex: index, index: childIndex });
        });
      }
    });
    return paths;
  }

  function macroPathListIndex(binding, path) {
    const key = macroPathKey(path);
    return macroSelectablePaths(binding).findIndex((candidate) => macroPathKey(candidate) === key);
  }

  function macroStepTitle(step) {
    if (step?.kind === "wait") return t("macro.step.wait");
    if (step?.kind === "parallel") return t("macro.step.parallelGroup");
    return t("macro.step.action");
  }

  function macroStepMeta(step) {
    if (step?.kind === "wait") return macroWaitDurationLabel(step) || t("macro.zeroMs");
    if (step?.kind === "parallel") {
      const count = Array.isArray(step.steps) ? step.steps.length : 0;
      return macroActionCountLabel(count);
    }
    if (!macroActionHasTarget(step)) return t("macro.selectTarget");
    if (!String(step.action || "").trim()) return `${macroTargetTitle(step)} -> ${t("macro.chooseAction")}`;
    const suffix =
      macroActionUsesValue(step) && typeof step.value === "number"
        ? ` -> ${Math.round(step.value * 100)}%`
        : "";
    return `${macroTargetTitle(step)} -> ${macroActionTitle(step.action, step)}${suffix}`;
  }

  function macroIconSvg(kind) {
    if (kind === "wait")
      return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8"></circle><path d="M12 7v5l3 2"></path></svg>';
    if (kind === "parallel")
      return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 4 7 4-7 4-7-4 7-4Z"></path><path d="m5 12 7 4 7-4"></path><path d="m5 16 7 4 7-4"></path></svg>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12h3M17 12h3M8 7v10M12 5v14M16 8v8"></path></svg>';
  }

  function createMacroIconButton(label, svg) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "binding-config-macro-icon-button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = svg;
    return button;
  }

  function duplicateMacroStep(path) {
    updateMacroDraft(
      (steps) => {
        if (path.type === "parallel") {
          const group = steps[path.groupIndex];
          if (!group || !Array.isArray(group.steps) || group.steps.length >= MACRO_MAX_PARALLEL_STEPS) return;
          group.steps.splice(path.index + 1, 0, clonePlain(group.steps[path.index]));
          macroState.selectedPath = { type: "parallel", groupIndex: path.groupIndex, index: path.index + 1 };
          return;
        }
        if (steps.length >= MACRO_MAX_TOP_LEVEL_STEPS) return;
        steps.splice(path.index + 1, 0, clonePlain(steps[path.index]));
        macroState.selectedPath = { type: "top", index: path.index + 1 };
      },
      { scrollSelected: true },
    );
  }

  function deleteMacroStep(path) {
    updateMacroDraft((steps) => {
      if (path.type === "parallel") {
        const group = steps[path.groupIndex];
        if (!group || !Array.isArray(group.steps)) return;
        group.steps.splice(path.index, 1);
        if (group.steps.length === 0) {
          steps.splice(path.groupIndex, 1);
          macroState.selectedPath = {
            type: "top",
            index: Math.max(0, Math.min(path.groupIndex, steps.length - 1)),
          };
        } else {
          macroState.selectedPath = {
            type: "parallel",
            groupIndex: path.groupIndex,
            index: Math.max(0, Math.min(path.index, group.steps.length - 1)),
          };
        }
        return;
      }
      steps.splice(path.index, 1);
      macroState.selectedPath =
        steps.length > 0 ? { type: "top", index: Math.max(0, Math.min(path.index, steps.length - 1)) } : null;
    });
  }

  function positionMacroOverflowMenu(menu, button) {
    if (!menu || !button || menu.classList.contains("hidden")) return;
    menu.classList.remove("is-open-up");
    const scrollContainer =
      menu.closest(".binding-config-macro-timeline") || menu.closest(".binding-config-macro-steps-panel");
    if (!scrollContainer) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const menuHeight = menu.offsetHeight || 72;
    const availableBelow = containerRect.bottom - buttonRect.bottom - 6;
    const availableAbove = buttonRect.top - containerRect.top - 6;
    if (availableBelow < menuHeight && availableAbove > availableBelow) {
      menu.classList.add("is-open-up");
    }
  }

  function renderMacroOverflow(row, path) {
    const wrap = document.createElement("div");
    wrap.className = "binding-config-macro-overflow";
    const button = createMacroIconButton(
      "Step actions",
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="5" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><circle cx="12" cy="19" r="1.5"></circle></svg>',
    );
    const menu = document.createElement("div");
    menu.className = "binding-config-macro-overflow-menu hidden";
    [
      {
        label: "Duplicate",
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 15V7a2 2 0 0 1 2-2h8"></path></svg>',
        handler: () => duplicateMacroStep(path),
      },
      {
        label: "Delete",
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"></path><path d="M9 7V4h6v3"></path></svg>',
        danger: true,
        handler: () => deleteMacroStep(path),
      },
    ].forEach(({ label, icon, danger = false, handler }) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = danger ? "is-danger" : "";
      const iconEl = document.createElement("span");
      iconEl.className = "binding-config-macro-menu-icon";
      iconEl.innerHTML = icon;
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      item.appendChild(iconEl);
      item.appendChild(labelEl);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        menu.classList.add("hidden");
        handler();
      });
      menu.appendChild(item);
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const opening = menu.classList.contains("hidden");
      elements.bindingConfigMacroSection
        ?.querySelectorAll(".binding-config-macro-overflow-menu")
        .forEach((existing) => {
          if (existing !== menu) {
            existing.classList.add("hidden");
            existing.classList.remove("is-open-up");
          }
        });
      menu.classList.toggle("hidden", !opening);
      if (opening) {
        requestAnimationFrame(() => positionMacroOverflowMenu(menu, button));
      } else {
        menu.classList.remove("is-open-up");
      }
    });
    wrap.appendChild(button);
    wrap.appendChild(menu);
    return wrap;
  }

  function renderMacroStepCard(parent, binding, step, path, { child = false } = {}) {
    const row = document.createElement("div");
    row.className = child
      ? "binding-config-macro-action binding-config-macro-step-card"
      : "binding-config-macro-step binding-config-macro-step-card";
    row.classList.toggle("is-selected", macroPathsEqual(path, macroState.selectedPath));
    row.dataset.path = macroPathKey(path);
    row.addEventListener("click", (event) => {
      if (
        event.target?.closest?.(
          ".binding-config-macro-drag, .binding-config-macro-overflow, .binding-config-macro-overflow-menu",
        )
      )
        return;
      macroState.selectedPath = path;
      renderMacroEditor(binding);
    });

    const dragInfo = child
      ? { type: "parallel", groupIndex: path.groupIndex, index: path.index }
      : { type: "top", index: path.index };
    row.appendChild(createMacroDragHandle(child ? "Drag parallel action" : "Drag step", dragInfo));

    const number = document.createElement("button");
    number.type = "button";
    number.className = "binding-config-macro-step-number";
    number.textContent = macroStepOrdinalLabel(path);
    number.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      macroState.selectedPath = path;
      renderMacroEditor(binding);
    });
    row.appendChild(number);

    const icon = document.createElement("span");
    icon.className = `binding-config-macro-step-icon binding-config-macro-step-icon--${step?.kind || "action"}`;
    icon.innerHTML = macroIconSvg(step?.kind || "action");
    row.appendChild(icon);

    const copy = document.createElement("div");
    copy.className = "binding-config-macro-step-copy";
    const title = document.createElement("span");
    title.className = "binding-config-macro-row-title";
    title.textContent = macroStepTitle(step);
    const meta = document.createElement("span");
    meta.className = "binding-config-macro-row-summary";
    meta.textContent = macroStepMeta(step);
    copy.appendChild(title);
    copy.appendChild(meta);
    row.appendChild(copy);

    row.appendChild(renderMacroOverflow(row, path));
    parent.appendChild(row);
  }

  return {
    macroSelectablePaths,
    macroPathListIndex,
    macroStepTitle,
    macroIconSvg,
    createMacroIconButton,
    renderMacroStepCard,
  };
}

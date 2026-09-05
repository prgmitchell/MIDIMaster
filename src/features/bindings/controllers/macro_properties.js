import { MACRO_MAX_WAIT_MS, MACRO_MAX_PARALLEL_STEPS } from "../../../core/binding_model.js";
import { defaultMacroParallelActionStep } from "../macro_draft.js";

/** macro properties workflow. */
export function createMacroProperties({
  commitMacroDraftEdit,
  createBindingConfigButton,
  createMacroField,
  createMacroIconButton,
  getMacroStepAtPath,
  macroIconSvg,
  macroPathListIndex,
  macroSelectablePaths,
  macroState,
  macroStepOrdinalLabel,
  macroStepTitle,
  normalizeMacroSelectedPath,
  renderMacroActionProperties,
  renderMacroEditor,
  t,
  updateMacroDraft,
}) {
  function renderMacroWaitProperties(panel, binding, step) {
    const secondsField = createMacroField(t("macro.seconds"));
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "60";
    input.step = "0.1";
    input.value = String((Number(step.duration_ms) || 0) / 1000);
    input.addEventListener("input", () => {
      step.duration_ms = Math.min(
        MACRO_MAX_WAIT_MS,
        Math.max(0, Math.round((Number(input.value) || 0) * 1000)),
      );
      commitMacroDraftEdit(binding, { rerender: false });
    });
    input.addEventListener("change", () => renderMacroEditor(binding));
    secondsField.appendChild(input);
    panel.appendChild(secondsField);
  }

  function renderMacroParallelProperties(panel, binding, step, path) {
    const count = Array.isArray(step.steps) ? step.steps.length : 0;
    const summary = document.createElement("div");
    summary.className = "binding-config-macro-info-box";
    summary.textContent = t(count === 1 ? "macro.parallelInfoOne" : "macro.parallelInfoOther", { count });
    panel.appendChild(summary);
    const addChild = createBindingConfigButton("", t("macro.addAction"), "secondary");
    addChild.disabled = count >= MACRO_MAX_PARALLEL_STEPS;
    addChild.addEventListener("click", () =>
      updateMacroDraft(
        (steps) => {
          const group = steps[path.index];
          if (!group || group.kind !== "parallel") return;
          group.steps = Array.isArray(group.steps) ? group.steps : [];
          if (group.steps.length >= MACRO_MAX_PARALLEL_STEPS) return;
          group.steps.push(defaultMacroParallelActionStep());
          macroState.selectedPath = {
            type: "parallel",
            groupIndex: path.index,
            index: group.steps.length - 1,
          };
        },
        { scrollSelected: true },
      ),
    );
    panel.appendChild(addChild);
  }

  function renderMacroProperties(panel, binding) {
    panel.innerHTML = "";
    const path = normalizeMacroSelectedPath(binding);
    const step = getMacroStepAtPath(binding, path);
    const paths = macroSelectablePaths(binding);

    const header = document.createElement("div");
    header.className = "binding-config-macro-properties-header";
    const title = document.createElement("span");
    title.textContent = t("macro.stepProperties");
    const nav = document.createElement("div");
    nav.className = "binding-config-macro-properties-nav";
    const currentIndex = macroPathListIndex(binding, path);
    const position = document.createElement("span");
    position.textContent =
      currentIndex >= 0
        ? t("macro.stepPosition", { current: currentIndex + 1, total: paths.length })
        : t("macro.noStep");
    const prev = createMacroIconButton(
      t("macro.previousStep"),
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 6-6 6 6 6"></path></svg>',
    );
    const next = createMacroIconButton(
      t("macro.nextStep"),
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6"></path></svg>',
    );
    prev.disabled = currentIndex <= 0;
    next.disabled = currentIndex < 0 || currentIndex >= paths.length - 1;
    prev.addEventListener("click", () => {
      macroState.selectedPath = paths[currentIndex - 1];
      renderMacroEditor(binding);
    });
    next.addEventListener("click", () => {
      macroState.selectedPath = paths[currentIndex + 1];
      renderMacroEditor(binding);
    });
    nav.appendChild(position);
    nav.appendChild(prev);
    nav.appendChild(next);
    header.appendChild(title);
    header.appendChild(nav);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "binding-config-macro-properties-body";
    if (!step) {
      const empty = document.createElement("div");
      empty.className = "binding-config-macro-empty";
      empty.textContent = t("macro.addStepToConfigure");
      body.appendChild(empty);
      panel.appendChild(body);
      return;
    }

    const type = document.createElement("div");
    type.className = "binding-config-macro-selected-type";
    type.innerHTML = `<span class="binding-config-macro-step-icon binding-config-macro-step-icon--${step.kind || "action"}">${macroIconSvg(step.kind || "action")}</span><span>${macroStepTitle(step)} ${macroStepOrdinalLabel(path)}</span>`;
    body.appendChild(type);
    if (step.kind === "wait") renderMacroWaitProperties(body, binding, step, path);
    else if (step.kind === "parallel") renderMacroParallelProperties(body, binding, step, path);
    else renderMacroActionProperties(body, binding, step, path);
    panel.appendChild(body);
  }

  return { renderMacroProperties };
}

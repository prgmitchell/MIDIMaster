import { macroActionHasTarget, macroActionUsesValue } from "../macro_draft.js";

/** macro action controls workflow. */
export function createMacroActionControls({ buildMacroStateSelect, getConfigBinding, startHotkeyLearn }) {
  function buildMacroActionControls(step, onChange) {
    const controls = document.createElement("div");
    controls.className = "binding-config-macro-controls";

    if (!String(step.action || "").trim() || !macroActionHasTarget(step)) {
      return controls;
    }

    if (macroActionUsesValue(step)) {
      const label = document.createElement("label");
      label.className = "binding-config-macro-number";
      const text = document.createElement("span");
      text.textContent = "Value";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = "100";
      input.step = "1";
      input.value = String(Math.round(Math.min(1, Math.max(0, Number(step.value ?? 1))) * 100));
      input.addEventListener("input", () => {
        step.value = Math.min(1, Math.max(0, (Number(input.value) || 0) / 100));
        onChange({ rerender: false });
      });
      label.appendChild(text);
      label.appendChild(input);
      const suffix = document.createElement("span");
      suffix.textContent = "%";
      label.appendChild(suffix);
      controls.appendChild(label);
    }

    if (step.action === "ToggleMute" || step.action === "ToggleEffect") {
      controls.appendChild(buildMacroStateSelect(step, onChange));
    }

    if (step.action === "Hotkey") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "binding-config-button binding-config-button--secondary";
      button.textContent = step.hotkey?.display ? "Change Hotkey" : "Learn Hotkey";
      button.addEventListener("click", async () => {
        const binding = getConfigBinding();
        const learned = await startHotkeyLearn({ id: `${binding?.id || "macro"}-hotkey` });
        if (!learned) return;
        step.hotkey = learned;
        onChange({ rerender: true });
      });
      controls.appendChild(button);
    }

    return controls;
  }

  return { buildMacroActionControls };
}

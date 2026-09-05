import { macroActionUsesValue, macroIntegrationActionLabel, macroActionHasTarget } from "../macro_draft.js";

/** macro tree workflow. */
export function createMacroTree({ elements, macroState, resolveTargetDisplay, t }) {
  function macroActionTitle(action, step = null) {
    const explicit = String(step?.action_label || step?.actionLabel || "").trim();
    if (explicit && !(String(action || "") === "Volume" && macroActionUsesValue(step))) {
      return explicit;
    }
    switch (String(action || "")) {
      case "":
        return "Choose Action";
      case "Volume":
        return step && !macroActionUsesValue(step)
          ? macroIntegrationActionLabel(step) || "Choose Action"
          : "Set Value";
      case "ToggleMute":
        return "Mute";
      case "ToggleEffect":
        return "State";
      case "SetMainOutputDevice":
        return "Trigger";
      case "SetDefaultDevice":
        return "Set Default Device";
      case "FocusWindow":
        return "Focus Window";
      case "FullScreenshot":
        return "Full Screenshot";
      case "SnipScreenshot":
        return "Snip";
      case "ToggleScreenRecording":
        return "Screen Recording";
      case "MediaPlayPause":
        return "Play/Pause";
      case "MediaNextTrack":
        return "Next Track";
      case "MediaPrevTrack":
        return "Previous Track";
      case "MediaStop":
        return "Stop";
      case "Hotkey":
        return "Hotkey";
      case "OpenApplication":
        return "Open App";
      case "RunAutoHotkeyScript":
        return "AutoHotkey";
      default:
        return String(action || "Action");
    }
  }

  function macroTargetTitle(step) {
    const targets = Array.isArray(step?.targets) ? step.targets : [];
    if (targets.length === 0) {
      return "No target selected";
    }
    if (step?.action === "Hotkey") {
      return step?.hotkey?.display || "Hotkey";
    }
    if (step?.action === "OpenApplication") {
      return step?.open_application?.display || step?.open_application?.path || "Application";
    }
    if (step?.action === "RunAutoHotkeyScript") {
      return step?.autohotkey_script?.display || step?.autohotkey_script?.path || "Script";
    }
    const display = resolveTargetDisplay(targets[0]);
    const label = String(display?.label || "")
      .replace(/\s*\([^()]+\)\s*$/g, "")
      .trim();
    if (targets.length > 1) return `${label || "Targets"} +${targets.length - 1}`;
    return label || "Target";
  }

  function macroStepSummary(step) {
    if (!step) return "";
    if (step.kind === "wait") {
      return t("macro.waitSummary", { duration: macroWaitDurationLabel(step) });
    }
    if (step.kind === "parallel") {
      const count = Array.isArray(step.steps) ? step.steps.length : 0;
      return t("macro.parallelSummary", { actions: macroActionCountLabel(count) });
    }
    if (!String(step.action || "").trim() || !macroActionHasTarget(step)) {
      return t("macro.chooseAction");
    }
    return `${macroActionTitle(step.action, step)} - ${macroTargetTitle(step)}`;
  }

  function macroWaitDurationLabel(step) {
    return `${((Number(step?.duration_ms) || 0) / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  }

  function macroActionCountLabel(count) {
    return t(count === 1 ? "macro.actionCountOne" : "macro.actionCountOther", { count });
  }

  function macroPathKey(path) {
    if (!path) return "";
    return path.type === "parallel" ? `parallel:${path.groupIndex}:${path.index}` : `top:${path.index}`;
  }

  function macroPathsEqual(a, b) {
    return macroPathKey(a) === macroPathKey(b);
  }

  function macroPathForFirstStep(binding) {
    const steps = Array.isArray(binding?.macro_steps) ? binding.macro_steps : [];
    return steps.length > 0 ? { type: "top", index: 0 } : null;
  }

  function normalizeMacroSelectedPath(binding, preferred = macroState.selectedPath) {
    const steps = Array.isArray(binding?.macro_steps) ? binding.macro_steps : [];
    if (steps.length === 0) {
      macroState.selectedPath = null;
      return null;
    }
    const path = preferred || { type: "top", index: 0 };
    if (path.type === "parallel") {
      const groupIndex = Math.min(Math.max(Number(path.groupIndex) || 0, 0), steps.length - 1);
      const group = steps[groupIndex];
      if (group?.kind === "parallel" && Array.isArray(group.steps) && group.steps.length > 0) {
        macroState.selectedPath = {
          type: "parallel",
          groupIndex,
          index: Math.min(Math.max(Number(path.index) || 0, 0), group.steps.length - 1),
        };
        return macroState.selectedPath;
      }
    }
    macroState.selectedPath = {
      type: "top",
      index: Math.min(Math.max(Number(path.index) || 0, 0), steps.length - 1),
    };
    return macroState.selectedPath;
  }

  function getMacroStepAtPath(binding, path = macroState.selectedPath) {
    const steps = Array.isArray(binding?.macro_steps) ? binding.macro_steps : [];
    const normalized = normalizeMacroSelectedPath(binding, path);
    if (!normalized) return null;
    if (normalized.type === "parallel") {
      return steps[normalized.groupIndex]?.steps?.[normalized.index] || null;
    }
    return steps[normalized.index] || null;
  }

  function scrollSelectedMacroStepIntoView() {
    if (!macroState.pendingSelectedScroll) return;
    macroState.pendingSelectedScroll = false;
    const section = elements.bindingConfigMacroSection;
    requestAnimationFrame(() => {
      const selected = section?.querySelector?.(".binding-config-macro-step-card.is-selected");
      if (!selected) return;
      const reduceMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
      selected.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
    });
  }

  function findMacroPathForStep(steps, stepRef) {
    if (!stepRef || !Array.isArray(steps)) return null;
    for (let index = 0; index < steps.length; index += 1) {
      if (steps[index] === stepRef) return { type: "top", index };
      if (steps[index]?.kind === "parallel" && Array.isArray(steps[index].steps)) {
        const childIndex = steps[index].steps.findIndex((child) => child === stepRef);
        if (childIndex >= 0) return { type: "parallel", groupIndex: index, index: childIndex };
      }
    }
    return null;
  }

  function macroStepOrdinalLabel(path) {
    if (!path) return "";
    return path.type === "parallel"
      ? `${(Number(path.groupIndex) || 0) + 1}.${(Number(path.index) || 0) + 1}`
      : `${(Number(path.index) || 0) + 1}`;
  }

  function createBindingConfigButton(id, text, variant = "secondary") {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = `binding-config-button binding-config-button--${variant}`;
    button.textContent = text;
    return button;
  }

  function wireMacroButton(button, handler) {
    if (!button || button.__macroConfigBound) return;
    button.__macroConfigBound = true;
    button.addEventListener("click", handler);
  }

  return {
    macroActionTitle,
    macroTargetTitle,
    macroStepSummary,
    macroWaitDurationLabel,
    macroActionCountLabel,
    macroPathKey,
    macroPathsEqual,
    macroPathForFirstStep,
    normalizeMacroSelectedPath,
    getMacroStepAtPath,
    scrollSelectedMacroStepIntoView,
    findMacroPathForStep,
    macroStepOrdinalLabel,
    createBindingConfigButton,
    wireMacroButton,
  };
}

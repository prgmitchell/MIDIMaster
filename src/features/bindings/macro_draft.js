import { normalizeMacroName } from "../../core/binding_model.js";
export { normalizeMacroName };
import {
  MACRO_MAX_PARALLEL_STEPS,
  MACRO_MAX_TOP_LEVEL_STEPS,
  MACRO_MAX_WAIT_MS,
  normalizeAutoHotkeyScriptMapping,
  normalizeHotkeyMapping,
  normalizeMacroActionState,
  normalizeMacroActionStep,
  normalizeMacroSteps,
  normalizeOpenApplicationMapping,
  setBindingTargets,
} from "../../core/binding_model.js";
import { isMacroTarget } from "./shape_helpers.js";

export function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

export function defaultMacroName(binding) {
  const name = String(binding?.name || "").trim();
  return name && !/^Binding\s+\d+$/i.test(name) ? name.slice(0, 80) : "My Macro";
}

export function ensureMacroName(binding, { defaultIfBlank = false } = {}) {
  if (!binding || typeof binding !== "object") return "";
  const normalized = normalizeMacroName(binding.macro_name);
  binding.macro_name = normalized || (defaultIfBlank ? defaultMacroName(binding) : "");
  return binding.macro_name;
}

export function blankMacroActionStep({ includeKind = true } = {}) {
  const step = { action: "", targets: [], state: "Default" };
  return includeKind ? { kind: "action", ...step } : step;
}

export function defaultMacroActionStep() {
  return blankMacroActionStep();
}

export function defaultMacroParallelActionStep() {
  return blankMacroActionStep({ includeKind: false });
}

export function defaultMacroWaitStep() {
  return { kind: "wait", duration_ms: 500 };
}

export function defaultMacroParallelStep() {
  return {
    kind: "parallel",
    steps: [defaultMacroParallelActionStep(), defaultMacroParallelActionStep()],
  };
}

function macroDraftHasCommandMetadata(step) {
  const explicit = String(step?.action_label || step?.actionLabel || "").trim();
  if (explicit) return true;
  const targets = Array.isArray(step?.targets) ? step.targets : [];
  return targets.some((target) => {
    const data = (target?.Integration || target?.integration)?.data || {};
    return Boolean(
      data.action_label || data.action_value || data.action_kind || data.button_action || data.osd_value_text,
    );
  });
}

function macroDraftLooksLikeLegacyTriggerPlaceholder(step) {
  if (String(step?.action || "") !== "Volume") return false;
  const role = String(step?.action_role || step?.actionRole || "")
    .trim()
    .toLowerCase();
  return role !== "value" && !macroDraftHasCommandMetadata(step);
}

export function normalizeMacroDraftActionStep(step, { includeKind = false } = {}) {
  if (macroDraftLooksLikeLegacyTriggerPlaceholder(step)) {
    const draft = blankMacroActionStep({ includeKind });
    draft.targets = (Array.isArray(step?.targets) ? step.targets : [])
      .filter((target) => target && target !== "Unset" && !isMacroTarget(target))
      .slice(0, 8);
    draft.state = normalizeMacroActionState(step?.state || "Default");
    return draft;
  }
  const normalized = normalizeMacroActionStep(step);
  if (normalized) {
    return includeKind ? { kind: "action", ...normalized } : normalized;
  }
  const draft = blankMacroActionStep({ includeKind });
  const targets = (Array.isArray(step?.targets) ? step.targets : [])
    .filter((target) => target && target !== "Unset" && !isMacroTarget(target))
    .slice(0, 8);
  if (targets.length > 0) {
    draft.targets = targets;
    draft.action = "";
    draft.state = normalizeMacroActionState(step?.state || "Default");
    draft.hotkey = normalizeHotkeyMapping(step?.hotkey);
    draft.open_application = normalizeOpenApplicationMapping(step?.open_application);
    draft.autohotkey_script = normalizeAutoHotkeyScriptMapping(step?.autohotkey_script);
  }
  return draft;
}

export function normalizeMacroDraftStep(step) {
  if (!step || typeof step !== "object") return null;
  const kind = String(step.kind || "action");
  if (kind === "wait") {
    const durationMs = Math.round(Number(step.duration_ms ?? step.durationMs ?? 0));
    return {
      kind: "wait",
      duration_ms: Math.min(MACRO_MAX_WAIT_MS, Math.max(0, Number.isFinite(durationMs) ? durationMs : 0)),
    };
  }
  if (kind === "parallel") {
    const steps = (Array.isArray(step.steps) ? step.steps : [])
      .map((child) => normalizeMacroDraftActionStep(child))
      .slice(0, MACRO_MAX_PARALLEL_STEPS);
    return {
      kind: "parallel",
      steps: steps.length > 0 ? steps : [defaultMacroParallelActionStep()],
    };
  }
  return normalizeMacroDraftActionStep(step, { includeKind: true });
}

export function normalizeMacroDraftSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map(normalizeMacroDraftStep)
    .filter(Boolean)
    .slice(0, MACRO_MAX_TOP_LEVEL_STEPS);
}

export function prepareMacroDraftBinding(binding, { preservePlaceholders = false } = {}) {
  if (!binding || typeof binding !== "object") return;
  binding.action = "Macro";
  setBindingTargets(binding, ["Macro"]);
  binding.hotkey = null;
  binding.open_application = null;
  binding.autohotkey_script = null;
  ensureMacroName(binding, { defaultIfBlank: preservePlaceholders });
  binding.macro_steps = preservePlaceholders
    ? normalizeMacroDraftSteps(binding.macro_steps)
    : normalizeMacroSteps(binding.macro_steps);
}

export function clearMacroActionStep(step) {
  Object.keys(step).forEach((key) => delete step[key]);
  Object.assign(step, blankMacroActionStep());
}

export function macroActionHasTarget(step) {
  return (
    Array.isArray(step?.targets) &&
    step.targets.some((target) => target && target !== "Unset" && !isMacroTarget(target))
  );
}

export function macroIntegrationTarget(step) {
  const targets = Array.isArray(step?.targets) ? step.targets : [];
  const target = targets.find((candidate) => candidate?.Integration || candidate?.integration);
  return target?.Integration || target?.integration || null;
}

export function macroIntegrationActionLabel(step) {
  const stepLabel = String(step?.action_label || step?.actionLabel || "").trim();
  if (stepLabel) return stepLabel;
  const data = macroIntegrationTarget(step)?.data || {};
  const explicit = String(data.action_label || "").trim();
  if (explicit) return explicit;
  const normalized = String(data.button_action || data.action_value || data.action || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (normalized === "turn_on" || normalized === "on") return "Turn On";
  if (normalized === "turn_off" || normalized === "off") return "Turn Off";
  if (normalized === "toggle" || normalized === "toggle_on_off") return "Toggle";
  const osdText = String(data.osd_value_text || "")
    .trim()
    .toUpperCase();
  if (osdText === "ON") return "Turn On";
  if (osdText === "OFF") return "Turn Off";
  return "";
}

export function macroActionRole(step) {
  const role = String(step?.action_role || step?.actionRole || "")
    .trim()
    .toLowerCase();
  if (role) return role;
  if (String(step?.action || "") !== "Volume") return "";
  const integration = macroIntegrationTarget(step);
  if (!integration) return "value";
  const data = integration.data || {};
  if (
    data.action_label ||
    data.action_value ||
    data.action_kind ||
    data.button_action ||
    data.osd_value_text
  ) {
    return "command";
  }
  return typeof step?.value === "number" ? "value" : "command";
}

export function macroActionUsesValue(step) {
  return String(step?.action || "") === "Volume" && macroActionRole(step) === "value";
}

export function macroActionIsLegacyTriggerPlaceholder(step) {
  return (
    String(step?.action || "") === "Volume" &&
    !macroActionUsesValue(step) &&
    !macroIntegrationActionLabel(step)
  );
}

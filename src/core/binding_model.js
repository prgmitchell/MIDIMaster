export const MACRO_MAX_TOP_LEVEL_STEPS = 25;
export const MACRO_MAX_PARALLEL_STEPS = 8;
export const MACRO_MAX_WAIT_MS = 60000;

const MACRO_ACTION_STATES = new Set(["Default", "Toggle", "On", "Off", "Mute", "Unmute"]);
const MACRO_ACTION_ROLES = new Set(["value", "command", "state", "momentary"]);
const MACRO_ACTIONS = new Set([
  "Volume",
  "ToggleMute",
  "ToggleEffect",
  "SetMainOutputDevice",
  "SetDefaultDevice",
  "FocusWindow",
  "FullScreenshot",
  "SnipScreenshot",
  "ToggleScreenRecording",
  "MediaPlayPause",
  "MediaNextTrack",
  "MediaPrevTrack",
  "MediaStop",
  "Hotkey",
  "OpenApplication",
  "RunAutoHotkeyScript",
]);

function normalizeMacroName(raw) {
  return String(raw || "").trim().slice(0, 80);
}

export function getBindingTargets(binding) {
  if (!binding || typeof binding !== "object") return [];
  if (Array.isArray(binding.targets) && binding.targets.length > 0) {
    const normalized = binding.targets.filter(Boolean).filter((t) => t !== "Unset").slice(0, 8);
    if (normalized.length > 0) return normalized;
  }
  if (binding.target != null) {
    return [binding.target];
  }
  return [];
}

export function setBindingTargets(binding, targets) {
  if (!binding || typeof binding !== "object") return;
  const normalized = Array.isArray(targets) ? targets.filter(Boolean).slice(0, 8) : [];
  if (normalized.length === 0) normalized.push("Unset");
  binding.targets = normalized;
  binding.target = normalized[0] || "Unset";
}

export function getPrimaryBindingTarget(binding) {
  return getBindingTargets(binding)[0] || "Unset";
}

export function bindingHasIntegrationTarget(binding) {
  return getBindingTargets(binding).some((target) => {
    const integ = target?.Integration || target?.integration;
    return Boolean(integ && typeof integ === "object" && integ.integration_id);
  });
}

function normalizeControlKind(raw) {
  const value = String(raw || "Auto");
  return value === "Button" || value === "Continuous" ? value : "Auto";
}

function normalizeMidiMapping(raw, { indicator = false, allowPitchBendIndicator = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const deviceId = String(raw.device_id || "").trim();
  if (!deviceId) return null;
  const msgType = String(raw.msg_type || "ControlChange");
  const pitchBendAllowed = indicator && allowPitchBendIndicator && msgType === "PitchBend";
  if (indicator && msgType !== "ControlChange" && msgType !== "Note" && !pitchBendAllowed) {
    return null;
  }
  const safeMsgType = msgType === "Note" || msgType === "PitchBend" || msgType === "ProgramChange"
    ? msgType
    : "ControlChange";
  const channel = Math.min(15, Math.max(0, Math.trunc(Number(raw.channel) || 0)));
  const controller = indicator && safeMsgType === "PitchBend"
    ? 0
    : Math.min(127, Math.max(0, Math.trunc(Number(raw.controller) || 0)));
  const indicatorMsgType = safeMsgType === "Note" || safeMsgType === "PitchBend"
    ? safeMsgType
    : "ControlChange";
  return {
    ...raw,
    device_id: deviceId,
    channel,
    controller,
    msg_type: indicator ? indicatorMsgType : safeMsgType,
    control_kind: normalizeControlKind(raw.control_kind),
    mode: raw.mode === "Relative" ? "Relative" : "Absolute",
    deadzone: Number.isFinite(Number(raw.deadzone)) ? Number(raw.deadzone) : 0,
    debounce_ms: Number.isFinite(Number(raw.debounce_ms)) ? Number(raw.debounce_ms) : 0,
    mute_behavior: raw.mute_behavior === "SetFromValue" ? "SetFromValue" : "ToggleOnPress",
  };
}

function bindingLooksLikeButton(binding) {
  const controlKind = normalizeControlKind(binding?.control_kind);
  if (controlKind === "Button") return true;
  if (controlKind === "Continuous") return false;
  return binding?.control?.msg_type === "Note" || binding?.control?.msg_type === "ProgramChange";
}

function integrationFromTarget(target) {
  return target?.Integration || target?.integration || null;
}

function targetIsAssigned(target) {
  return Boolean(
    target
    && target !== "Unset"
    && !("Unset" in Object(target))
    && !("unset" in Object(target))
  );
}

function targetIsCompleteForMappedLight(target) {
  if (!targetIsAssigned(target)) return false;
  if (
    target === "Master"
    || target === "Focus"
    || target === "MediaControl"
    || target === "CaptureControl"
    || target === "Macro"
  ) {
    return true;
  }
  const session = target?.Session || target?.session;
  if (session) return Boolean(String(session.session_id || "").trim());
  const app = target?.Application || target?.application;
  if (app) return Boolean(String(app.name || "").trim());
  const device = target?.Device || target?.device;
  if (device) return Boolean(String(device.device_id || "").trim());
  const integration = integrationFromTarget(target);
  if (integration) {
    return Boolean(String(integration.integration_id || "").trim())
      && Boolean(String(integration.kind || "").trim());
  }
  return false;
}

function isMacroTarget(target) {
  return target === "Macro";
}

function mappedButtonLightTargetComplete(binding) {
  const targets = getBindingTargets(binding);
  const action = String(binding?.action || "");
  if (action === "OpenApplication") {
    return targets.some((target) => target === "OpenApplication")
      && Boolean(String(normalizeOpenApplicationMapping(binding?.open_application)?.path || "").trim());
  }
  if (action === "RunAutoHotkeyScript") {
    return targets.some((target) => target === "AutoHotkeyScript")
      && Boolean(String(normalizeAutoHotkeyScriptMapping(binding?.autohotkey_script)?.path || "").trim());
  }
  if (action === "Hotkey") {
    return targets.some((target) => target === "Hotkey")
      && Boolean(normalizeHotkeyMapping(binding?.hotkey)?.keys?.length);
  }
  if (action === "Macro") {
    return targets.some(isMacroTarget)
      && normalizeMacroSteps(binding?.macro_steps).length > 0;
  }
  if (
    action === "MediaPlayPause"
    || action === "MediaNextTrack"
    || action === "MediaPrevTrack"
    || action === "MediaStop"
  ) {
    return targets.some((target) => target === "MediaControl");
  }
  if (action === "FocusWindow") {
    return targets.some((target) => {
      const app = target?.Application || target?.application;
      return Boolean(String(app?.name || "").trim());
    });
  }
  if (
    action === "FullScreenshot"
    || action === "SnipScreenshot"
    || action === "ToggleScreenRecording"
  ) {
    return targets.some((target) => target === "CaptureControl");
  }
  if (action === "SetDefaultDevice") {
    return targets.some((target) => Boolean(String((target?.Device || target?.device)?.device_id || "").trim()));
  }
  return targets.some(targetIsCompleteForMappedLight);
}

function mappedButtonLightVisualActive(binding) {
  const targets = getBindingTargets(binding);
  if (!targets.some(targetIsAssigned)) return false;
  return mappedButtonLightTargetComplete(binding);
}

function integrationVisualBehavior(integration) {
  if (!integration || typeof integration !== "object") return null;
  const integrationId = String(integration.integration_id || "").toLowerCase();
  const kind = String(integration.kind || "").toLowerCase();
  const data = integration.data || {};
  const actionKind = String(data.action_kind || "").toLowerCase();
  if (actionKind === "stateful") return "stateful";
  if (actionKind === "momentary") return "momentary";
  if (integrationId === "obs" && kind === "action") {
    return String(data.action || "").startsWith("Toggle") ? "stateful" : "momentary";
  }
  if (integrationId === "obs" && (kind === "scene" || kind === "media")) {
    return "momentary";
  }
  return null;
}

export function buttonVisualBehavior(binding) {
  if (!bindingLooksLikeButton(binding)) return null;

  const action = String(binding?.action || "");
  const targets = getBindingTargets(binding);
  if (!targets.some(targetIsAssigned)) return "momentary";
  if (action === "Macro") return "momentary";
  if (action === "ToggleMute" || action === "ToggleEffect") return "stateful";

  let momentaryIntegration = false;
  for (const target of targets) {
    const behavior = integrationVisualBehavior(integrationFromTarget(target));
    if (behavior === "stateful") return "stateful";
    if (behavior === "momentary") momentaryIntegration = true;
  }
  if (momentaryIntegration) return "momentary";

  if (action === "SetMainOutputDevice") return "momentary";
  return "momentary";
}

function activeFromNumeric(value) {
  if (value == null) return null;
  const next = Number(value);
  if (!Number.isFinite(next)) return null;
  return next > 0.5;
}

function activeFromInputValue(value) {
  if (value == null) return null;
  const next = Number(value);
  if (!Number.isFinite(next)) return null;
  return next > 0;
}

function activeFromStateValue(value) {
  if (typeof value === "boolean") return value;
  return activeFromNumeric(value);
}

export function resolveButtonVisualActive(binding, options = {}) {
  const behavior = buttonVisualBehavior(binding);
  if (!behavior) return false;

  const lightMode = effectiveButtonLightMode(binding);
  if (lightMode === "MappedWhenAssigned") {
    return mappedButtonLightVisualActive(binding);
  }

  const inputActive = activeFromInputValue(options.inputValue) === true;
  const stateActive = behavior === "stateful" ? activeFromStateValue(options.stateValue) : null;
  const muteState = typeof options.muted === "boolean"
    ? options.muted
    : (typeof options.fallbackMuted === "boolean" ? options.fallbackMuted : null);
  const effectiveState = stateActive
    ?? (behavior === "stateful" && String(binding?.action || "") === "ToggleMute" ? muteState : null);

  if (lightMode === "Pressed") {
    return inputActive;
  }
  if (lightMode === "InvertState") {
    return effectiveState != null ? !effectiveState : !inputActive;
  }

  return effectiveState != null ? effectiveState : inputActive;
}

const HOTKEY_MODIFIERS = new Set(["Ctrl", "Shift", "Alt", "Meta"]);
const HOTKEY_CODE_KEYS = new Map(Object.entries({
  Space: "Space",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  Backquote: "Backquote",
  Minus: "Minus",
  Equal: "Equal",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Backslash: "Backslash",
  NumpadDecimal: "NumpadDecimal",
  NumpadAdd: "NumpadAdd",
  NumpadSubtract: "NumpadSubtract",
  NumpadMultiply: "NumpadMultiply",
  NumpadDivide: "NumpadDivide",
  NumpadEnter: "NumpadEnter",
}));
const HOTKEY_KEY_ALIASES = new Map(Object.entries({
  " ": "Space",
  ",": "Comma",
  "<": "Comma",
  ".": "Period",
  ">": "Period",
  "/": "Slash",
  "?": "Slash",
  ";": "Semicolon",
  ":": "Semicolon",
  "'": "Quote",
  "\"": "Quote",
  "`": "Backquote",
  "~": "Backquote",
  "-": "Minus",
  "_": "Minus",
  "=": "Equal",
  "+": "Equal",
  "[": "BracketLeft",
  "{": "BracketLeft",
  "]": "BracketRight",
  "}": "BracketRight",
  "\\": "Backslash",
  "|": "Backslash",
  "!": "1",
  "@": "2",
  "#": "3",
  "$": "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
}));

function normalizeHotkeyCode(code) {
  const value = String(code || "").trim();
  if (!value) return null;
  const letterMatch = /^Key([A-Z])$/.exec(value);
  if (letterMatch) return letterMatch[1];
  const digitMatch = /^Digit([0-9])$/.exec(value);
  if (digitMatch) return digitMatch[1];
  const numpadDigitMatch = /^Numpad([0-9])$/.exec(value);
  if (numpadDigitMatch) return `Numpad${numpadDigitMatch[1]}`;
  return HOTKEY_CODE_KEYS.get(value) || null;
}

export function normalizeHotkeyKeyFromEvent(event) {
  const key = String(event?.key || "").trim();
  const lower = key.toLowerCase();
  if (lower === "control") return "Ctrl";
  if (lower === "shift") return "Shift";
  if (lower === "alt") return "Alt";
  if (lower === "meta") return "Meta";

  const codeKey = normalizeHotkeyCode(event?.code);
  if (codeKey) return codeKey;
  if (!key) return null;

  if (lower === "escape") return "Esc";
  if (lower === "arrowup") return "Up";
  if (lower === "arrowdown") return "Down";
  if (lower === "arrowleft") return "Left";
  if (lower === "arrowright") return "Right";
  if (HOTKEY_KEY_ALIASES.has(key)) return HOTKEY_KEY_ALIASES.get(key);
  if (key.length === 1) return key.toUpperCase();
  if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase();
  return key.length <= 16 ? key[0].toUpperCase() + key.slice(1) : null;
}

function hotkeyKeyIsModifier(key) {
  return HOTKEY_MODIFIERS.has(key);
}

export function buildHotkeyMappingFromEvent(event) {
  const key = normalizeHotkeyKeyFromEvent(event);
  if (!key || hotkeyKeyIsModifier(key)) return null;

  const keys = [];
  if (event?.ctrlKey) keys.push("Ctrl");
  if (event?.shiftKey) keys.push("Shift");
  if (event?.altKey) keys.push("Alt");
  if (event?.metaKey) keys.push("Meta");
  if (!keys.includes(key)) keys.push(key);

  return {
    keys,
    display: keys.join("+"),
  };
}

function normalizeHotkeyMapping(rawHotkey) {
  if (!rawHotkey || typeof rawHotkey !== "object") return null;
  const keys = Array.isArray(rawHotkey.keys)
    ? rawHotkey.keys.map((key) => String(key || "").trim()).filter(Boolean)
    : [];
  if (keys.length === 0) return null;
  const display = String(rawHotkey.display || "").trim() || keys.join("+");
  return { keys, display };
}

function normalizeOpenApplicationMapping(rawOpenApplication) {
  if (!rawOpenApplication || typeof rawOpenApplication !== "object") return null;
  const path = String(rawOpenApplication.path || "").trim();
  const display = String(rawOpenApplication.display || "").trim();
  const icon_data = typeof rawOpenApplication.icon_data === "string" && rawOpenApplication.icon_data.trim()
    ? rawOpenApplication.icon_data.trim()
    : null;
  return path ? { path, display: display || path, icon_data } : null;
}

function normalizeAutoHotkeyScriptMapping(rawScript) {
  if (!rawScript || typeof rawScript !== "object") return null;
  const path = String(rawScript.path || "").trim();
  const display = String(rawScript.display || "").trim();
  return path ? { path, display: display || path } : null;
}

export function normalizeMacroActionState(raw) {
  const value = String(raw || "Default");
  return MACRO_ACTION_STATES.has(value) ? value : "Default";
}

function normalizeMacroActionRole(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return MACRO_ACTION_ROLES.has(value) ? value : null;
}

function normalizeMacroActionText(raw) {
  const value = String(raw || "").trim();
  return value ? value.slice(0, 80) : null;
}

function normalizeMacroTargets(rawTargets) {
  const targets = Array.isArray(rawTargets) ? rawTargets : [];
  return targets
    .filter((target) => targetIsAssigned(target) && !isMacroTarget(target))
    .slice(0, 8);
}

export function normalizeMacroActionStep(step) {
  if (!step || typeof step !== "object") return null;
  const action = String(step.action || "Volume");
  if (!MACRO_ACTIONS.has(action)) return null;
  const targets = normalizeMacroTargets(step.targets);
  if (targets.length === 0) return null;

  const value = Number(step.value);
  const normalized = {
    action,
    targets,
    value: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null,
    state: normalizeMacroActionState(step.state),
    action_role: normalizeMacroActionRole(step.action_role ?? step.actionRole),
    action_label: normalizeMacroActionText(step.action_label ?? step.actionLabel),
    value_kind: normalizeMacroActionText(step.value_kind ?? step.valueKind),
    hotkey: normalizeHotkeyMapping(step.hotkey),
    open_application: normalizeOpenApplicationMapping(step.open_application),
    autohotkey_script: normalizeAutoHotkeyScriptMapping(step.autohotkey_script),
  };

  if (normalized.value == null) delete normalized.value;
  if (!normalized.action_role) delete normalized.action_role;
  if (!normalized.action_label) delete normalized.action_label;
  if (!normalized.value_kind) delete normalized.value_kind;
  if (!normalized.hotkey) delete normalized.hotkey;
  if (!normalized.open_application) delete normalized.open_application;
  if (!normalized.autohotkey_script) delete normalized.autohotkey_script;
  return normalized;
}

export function normalizeMacroStep(step) {
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
      .map(normalizeMacroActionStep)
      .filter(Boolean)
      .slice(0, MACRO_MAX_PARALLEL_STEPS);
    return steps.length > 0 ? { kind: "parallel", steps } : null;
  }
  const actionStep = normalizeMacroActionStep(step);
  return actionStep ? { kind: "action", ...actionStep } : null;
}

export function normalizeMacroSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map(normalizeMacroStep)
    .filter(Boolean)
    .slice(0, MACRO_MAX_TOP_LEVEL_STEPS);
}

function normalizeMacroDraftActionStep(step) {
  if (!step || typeof step !== "object") return null;
  const rawAction = String(step.action || "");
  const isNestedMacroAction = rawAction === "Macro";
  const action = !isNestedMacroAction && MACRO_ACTIONS.has(rawAction) ? rawAction : "Volume";
  const targets = isNestedMacroAction ? [] : normalizeMacroTargets(step.targets);
  const value = Number(step.value);
  const normalized = {
    action,
    targets,
    value: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null,
    state: normalizeMacroActionState(step.state),
    action_role: normalizeMacroActionRole(step.action_role ?? step.actionRole),
    action_label: normalizeMacroActionText(step.action_label ?? step.actionLabel),
    value_kind: normalizeMacroActionText(step.value_kind ?? step.valueKind),
    hotkey: normalizeHotkeyMapping(step.hotkey),
    open_application: normalizeOpenApplicationMapping(step.open_application),
    autohotkey_script: normalizeAutoHotkeyScriptMapping(step.autohotkey_script),
  };

  if (normalized.value == null) delete normalized.value;
  if (!normalized.action_role) delete normalized.action_role;
  if (!normalized.action_label) delete normalized.action_label;
  if (!normalized.value_kind) delete normalized.value_kind;
  if (!normalized.hotkey) delete normalized.hotkey;
  if (!normalized.open_application) delete normalized.open_application;
  if (!normalized.autohotkey_script) delete normalized.autohotkey_script;
  return normalized;
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
      .map(normalizeMacroDraftActionStep)
      .filter(Boolean)
      .slice(0, MACRO_MAX_PARALLEL_STEPS);
    return { kind: "parallel", steps };
  }
  const actionStep = normalizeMacroDraftActionStep(step);
  return actionStep ? { kind: "action", ...actionStep } : null;
}

export function normalizeMacroDraftSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map(normalizeMacroDraftStep)
    .filter(Boolean)
    .slice(0, MACRO_MAX_TOP_LEVEL_STEPS);
}

export function normalizeBinding(binding) {
  if (!binding || typeof binding !== "object") return binding;
  const out = { ...binding };
  setBindingTargets(out, getBindingTargets(out));
  if (getBindingTargets(out).some(isMacroTarget)) {
    out.action = "Macro";
  }
  out.macro_name = normalizeMacroName(out.macro_name);
  out.mode = (out.mode === "Relative") ? "Relative" : "Absolute";
  out.relative_format = normalizeRelativeFormat(out.relative_format);
  out.fader_curve = normalizeFaderCurve(out.fader_curve);
  out.custom_curve = normalizeCustomCurvePoints(out.custom_curve);
  if (out.custom_curve.length < 2) {
    out.custom_curve = presetCurvePoints(out.fader_curve);
  }
  out.mute_behavior = out.mute_behavior === "SetFromValue" ? "SetFromValue" : "ToggleOnPress";
  if (out.mute_control && typeof out.mute_control === "object") {
    out.mute_control = normalizeMidiMapping(out.mute_control);
  }
  const indicatorIsFeedbackOutput = !bindingLooksLikeButton(out);
  out.indicator_control = normalizeMidiMapping(out.indicator_control, {
    indicator: true,
    allowPitchBendIndicator: indicatorIsFeedbackOutput,
  });
  if (out.indicator_control && indicatorIsFeedbackOutput) {
    out.indicator_control.control_kind = "Continuous";
  }
  if (out.assign_mode !== "Replace") out.assign_mode = "Add";
  normalizeButtonLightFields(out);
  delete out.toggle_mute_light_mode;
  if (!out.hotkey || typeof out.hotkey !== "object") out.hotkey = null;
  if (!out.open_application || typeof out.open_application !== "object") {
    out.open_application = null;
  } else {
    const path = String(out.open_application.path || "").trim();
    const display = String(out.open_application.display || "").trim();
    const icon_data = typeof out.open_application.icon_data === "string" && out.open_application.icon_data.trim()
      ? out.open_application.icon_data.trim()
      : null;
    out.open_application = path ? { path, display: display || path, icon_data } : null;
  }
  if (!out.autohotkey_script || typeof out.autohotkey_script !== "object") {
    out.autohotkey_script = null;
  } else {
    const path = String(out.autohotkey_script.path || "").trim();
    const display = String(out.autohotkey_script.display || "").trim();
    out.autohotkey_script = path ? { path, display: display || path } : null;
  }
  if (out.action === "Macro" && !getBindingTargets(out).some(isMacroTarget)) {
    setBindingTargets(out, ["Macro"]);
  }
  out.macro_steps = out.action === "Macro" || getBindingTargets(out).some(isMacroTarget)
    ? normalizeMacroDraftSteps(out.macro_steps)
    : normalizeMacroSteps(out.macro_steps);
  return out;
}

export function normalizeRelativeFormat(raw) {
  const value = String(raw || "Auto");
  if (
    value === "Auto"
    || value === "TwosComplement"
    || value === "BinaryOffset"
    || value === "SignMagnitude"
  ) {
    return value;
  }
  return "Auto";
}

export function normalizeButtonLightMode(raw) {
  return raw === "MappedWhenAssigned" ? "MappedWhenAssigned" : "Activity";
}

export function normalizeButtonLightBehavior(raw) {
  const value = String(raw || "FollowState");
  if (value === "FollowState" || value === "InvertState" || value === "Pressed") {
    return value;
  }
  return "FollowState";
}

export function effectiveButtonLightMode(binding) {
  const rawMode = String(binding?.button_light_mode || "Activity");
  if (rawMode === "MappedWhenAssigned") return "MappedWhenAssigned";
  if (rawMode === "FollowState" || rawMode === "InvertState" || rawMode === "Pressed") {
    return rawMode;
  }
  return normalizeButtonLightBehavior(binding?.button_light_behavior);
}

export function normalizeButtonLightFields(binding) {
  if (!binding || typeof binding !== "object") return binding;
  const rawMode = String(binding.button_light_mode || "Activity");
  if (rawMode === "MappedWhenAssigned") {
    binding.button_light_mode = "MappedWhenAssigned";
    binding.button_light_behavior = normalizeButtonLightBehavior(binding.button_light_behavior);
  } else if (rawMode === "FollowState" || rawMode === "InvertState" || rawMode === "Pressed") {
    binding.button_light_mode = "Activity";
    binding.button_light_behavior = rawMode;
  } else {
    binding.button_light_mode = "Activity";
    binding.button_light_behavior = normalizeButtonLightBehavior(binding.button_light_behavior);
  }
  return binding;
}

export function decodeRelativeTwosComplement(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return value;
  if (value >= 65 && value <= 127) return value - 128;
  return null;
}

export function decodeRelativeBinaryOffset(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return -(64 - value);
  if (value >= 65 && value <= 127) return value - 64;
  return null;
}

export function decodeRelativeSignMagnitude(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return value;
  if (value >= 65 && value <= 127) return -(value - 64);
  return null;
}

function coerceRelativeAutoState(previousState) {
  if (previousState && typeof previousState === "object") {
    const previousFormat = normalizeRelativeFormat(previousState.format);
    return {
      format: previousFormat === "Auto" ? null : previousFormat,
      seenMidpoint: Boolean(previousState.seenMidpoint),
      seenSignBand: Boolean(previousState.seenSignBand),
      seenHighNegative: Boolean(previousState.seenHighNegative),
      seenLowNegativeHint: Boolean(previousState.seenLowNegativeHint),
    };
  }
  const previousFormat = normalizeRelativeFormat(previousState);
  return {
    format: previousFormat === "Auto" ? null : previousFormat,
    seenMidpoint: false,
    seenSignBand: false,
    seenHighNegative: false,
    seenLowNegativeHint: false,
  };
}

export function updateRelativeAutoDetection(value, previousState = null) {
  const state = coerceRelativeAutoState(previousState);
  if (!state.format) {
    if (value === 63) state.seenLowNegativeHint = true;
    if (value === 64) state.seenMidpoint = true;
    if (value >= 65 && value <= 95) state.seenSignBand = true;
    if (value >= 96 && value <= 127) state.seenHighNegative = true;

    if (state.seenHighNegative) {
      state.format = "TwosComplement";
    } else if (state.seenLowNegativeHint) {
      state.format = "BinaryOffset";
    } else if (state.seenMidpoint && state.seenSignBand) {
      state.format = "BinaryOffset";
    } else if (state.seenSignBand) {
      state.format = "SignMagnitude";
    }
  }
  return state;
}

export function detectRelativeFormatAuto(value, previousState) {
  return updateRelativeAutoDetection(value, previousState).format;
}

export function decodeRelativeDeltaAutoFallback(value, sawMidpoint = false) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 62) return value;
  if (value === 63) return -1;
  if (value >= 96 && value <= 127) return value - 128;
  if (value >= 65 && value <= 95 && sawMidpoint) return value - 64;
  if (value >= 65 && value <= 95) return -(value - 64);
  return null;
}

export function decodeRelativeDelta(binding, value, autoFormatByBinding = null) {
  const configured = normalizeRelativeFormat(binding?.relative_format);
  let format = configured;
  let autoState = null;
  if (format === "Auto") {
    const key = String(binding?.id || "");
    const previousState = key && autoFormatByBinding ? autoFormatByBinding.get(key) : null;
    autoState = updateRelativeAutoDetection(value, previousState);
    if (key && autoFormatByBinding) {
      autoFormatByBinding.set(key, autoState);
    }
    format = autoState.format || "Auto";
  }

  if (format === "TwosComplement") return decodeRelativeTwosComplement(value);
  if (format === "BinaryOffset") return decodeRelativeBinaryOffset(value);
  if (format === "SignMagnitude") return decodeRelativeSignMagnitude(value);
  if (format === "Auto") return decodeRelativeDeltaAutoFallback(value, autoState?.seenMidpoint);
  return null;
}

export function normalizeFaderCurve(raw) {
  const value = String(raw || "Linear");
  return ["Linear", "Exponential", "Logarithmic", "SCurve", "Custom"].includes(value)
    ? value
    : "Linear";
}

export function presetCurvePoints(curve) {
  switch (normalizeFaderCurve(curve)) {
    case "Exponential":
      return [
        { x: 0, y: 0 },
        { x: 0.18, y: 0.04 },
        { x: 0.42, y: 0.16 },
        { x: 0.72, y: 0.5 },
        { x: 1, y: 1 },
      ];
    case "Logarithmic":
      return [
        { x: 0, y: 0 },
        { x: 0.08, y: 0.34 },
        { x: 0.24, y: 0.58 },
        { x: 0.52, y: 0.8 },
        { x: 1, y: 1 },
      ];
    case "SCurve":
      return [
        { x: 0, y: 0 },
        { x: 0.18, y: 0.06 },
        { x: 0.5, y: 0.5 },
        { x: 0.82, y: 0.94 },
        { x: 1, y: 1 },
      ];
    case "Custom":
      return [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ];
    case "Linear":
    default:
      return [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ];
  }
}

export function normalizeCustomCurvePoints(points) {
  const normalized = Array.isArray(points)
    ? points
        .map((point) => ({
          x: Math.min(1, Math.max(0, Number(point?.x) || 0)),
          y: Math.min(1, Math.max(0, Number(point?.y) || 0)),
          curve: Math.min(1, Math.max(-1, Number(point?.curve) || 0)),
        }))
        .sort((a, b) => a.x - b.x)
    : [];
  if (normalized.length >= 2) {
    normalized[0].x = 0;
    normalized[normalized.length - 1].x = 1;
    normalized[normalized.length - 1].curve = 0;
  }
  return normalized.map((point) => (
    Math.abs(point.curve) < 0.0001
      ? { x: point.x, y: point.y }
      : point
  ));
}

export function applyCustomFaderCurve(points, normalized) {
  const clamped = Math.min(1, Math.max(0, Number(normalized) || 0));
  const normalizedPoints = normalizeCustomCurvePoints(points);
  if (normalizedPoints.length < 2) return clamped;
  if (clamped <= normalizedPoints[0].x) return normalizedPoints[0].y;
  for (let index = 0; index < normalizedPoints.length - 1; index += 1) {
    const start = normalizedPoints[index];
    const end = normalizedPoints[index + 1];
    if (clamped > end.x) continue;
    const span = end.x - start.x;
    if (Math.abs(span) < 0.00001) return end.y;
    const t = Math.min(1, Math.max(0, (clamped - start.x) / span));
    const linear = start.y + ((end.y - start.y) * t);
    const curveOffset = (Number(start.curve) || 0) * 2 * (1 - t) * t;
    return Math.min(1, Math.max(0, linear + curveOffset));
  }
  return normalizedPoints[normalizedPoints.length - 1].y;
}

export function applyFaderCurve(curve, normalized) {
  const clamped = Math.min(1, Math.max(0, Number(normalized) || 0));
  switch (normalizeFaderCurve(curve)) {
    case "Exponential":
      return Math.pow(clamped, 0.55);
    case "Logarithmic":
      return Math.pow(clamped, 2.2);
    case "SCurve":
      return clamped * clamped * (3 - (2 * clamped));
    default:
      return clamped;
  }
}

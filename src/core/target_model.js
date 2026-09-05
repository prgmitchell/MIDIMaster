const descriptorList = [
  {
    type: "Master",
    pickerKind: "master",
    pickerValue: "master",
    labelKey: "targets.master",
    category: "system",
    iconKind: "master",
    key: "::master::",
    controls: ["continuous", "button"],
    actions: ["Volume", "ToggleMute"],
    capabilities: { value: true, mute: true, feedback: true },
  },
  {
    type: "Focus",
    pickerKind: "focus",
    pickerValue: "focus",
    labelKey: "targets.focus",
    category: "applications",
    iconKind: "focus",
    key: "::focus::",
    controls: ["continuous", "button"],
    actions: ["Volume", "ToggleMute"],
    capabilities: { value: true, mute: true, feedback: true },
  },
  {
    type: "MonitorBrightness",
    pickerKind: "monitor-brightness",
    pickerValue: "monitor-brightness",
    labelKey: "targets.monitorBrightness",
    category: "system",
    iconKind: "monitor-brightness",
    key: "::monitor-brightness::",
    controls: ["continuous"],
    actions: ["Volume"],
    capabilities: { value: true, mute: false, feedback: false },
  },
  {
    type: "MediaControl",
    pickerKind: "media-control",
    pickerValue: "media-control",
    labelKey: "targets.mediaControls",
    category: "system",
    iconKind: "media-play-pause",
    key: "::media-control::",
    controls: ["button"],
    actions: ["MediaPlayPause", "MediaNextTrack", "MediaPrevTrack", "MediaStop"],
    capabilities: { value: false, mute: false, feedback: false },
  },
  {
    type: "CaptureControl",
    pickerKind: "capture-control",
    pickerValue: "capture-control",
    labelKey: "targets.captureControls",
    category: "system",
    iconKind: "capture",
    key: "::capture-control::",
    controls: ["button"],
    actions: ["FullScreenshot", "SnipScreenshot", "ToggleScreenRecording"],
    capabilities: { value: false, mute: false, feedback: false },
  },
  {
    type: "Macro",
    pickerKind: "macro-target",
    pickerValue: "macro-target",
    labelKey: "macro.title",
    category: "system",
    iconKind: "macro",
    key: "::macro::",
    controls: ["button"],
    actions: ["Macro"],
    capabilities: { value: false, mute: false, feedback: false },
  },
  {
    type: "Soundboard",
    pickerKind: "soundboard-target",
    pickerValue: "soundboard-target",
    labelKey: "soundboard.title",
    category: "system",
    iconKind: "soundboard",
    key: "::soundboard::",
    controls: ["button"],
    actions: ["Soundboard"],
    capabilities: { value: false, mute: false, feedback: false },
  },
  {
    type: "Hotkey",
    pickerKind: "hotkey-target",
    pickerValue: "hotkey-target",
    labelKey: "targets.hotkey",
    category: "system",
    iconKind: "hotkey",
    key: "::hotkey::",
    controls: ["button"],
    actions: ["Hotkey"],
    capabilities: { value: false, mute: false, feedback: false },
  },
  {
    type: "OpenApplication",
    pickerKind: "open-application-target",
    pickerValue: "open-application-target",
    labelKey: "targets.openApplication",
    category: "system",
    iconKind: "open-application",
    key: "::open-application::",
    controls: ["button"],
    actions: ["OpenApplication"],
    capabilities: { value: false, mute: false, feedback: false },
  },
  {
    type: "AutoHotkeyScript",
    pickerKind: "autohotkey-script-target",
    pickerValue: "autohotkey-script-target",
    labelKey: "targets.autoHotkeyScript",
    category: "system",
    iconKind: "autohotkey-script",
    key: "::autohotkey-script::",
    controls: ["button"],
    actions: ["RunAutoHotkeyScript"],
    capabilities: { value: false, mute: false, feedback: false },
  },
];

export const BUILT_IN_TARGETS = Object.freeze(
  Object.fromEntries(
    descriptorList.map((descriptor) => [
      descriptor.type,
      Object.freeze({
        ...descriptor,
        controls: Object.freeze([...descriptor.controls]),
        actions: Object.freeze([...descriptor.actions]),
        capabilities: Object.freeze({ ...descriptor.capabilities }),
      }),
    ]),
  ),
);

const descriptorByPickerKind = new Map(
  Object.values(BUILT_IN_TARGETS).map((descriptor) => [descriptor.pickerKind, descriptor]),
);

export const ACTION_CATALOG = Object.freeze({
  Volume: { labelKey: "targets.action.setValue", role: "value" },
  ToggleMute: { labelKey: "targets.action.toggleMute", role: "state" },
  ToggleEffect: { labelKey: null, role: "state" },
  SetMainOutputDevice: { labelKey: null, role: "command" },
  SetDefaultDevice: { labelKey: "targets.action.setDefault", role: "command" },
  OpenApplication: { labelKey: "targets.openApplication", role: "command" },
  FocusWindow: { labelKey: "targets.action.focusWindow", role: "command" },
  FullScreenshot: { labelKey: "targets.action.fullScreenshot", role: "command" },
  SnipScreenshot: { labelKey: "targets.action.snipScreenshot", role: "command" },
  ToggleScreenRecording: { labelKey: "targets.action.toggleScreenRecording", role: "command" },
  MediaPlayPause: { labelKey: "targets.action.mediaPlayPause", role: "command" },
  MediaNextTrack: { labelKey: "targets.action.mediaNextTrack", role: "command" },
  MediaPrevTrack: { labelKey: "targets.action.mediaPrevTrack", role: "command" },
  MediaStop: { labelKey: "targets.action.mediaStop", role: "command" },
  Hotkey: { labelKey: "targets.hotkey", role: "command" },
  RunAutoHotkeyScript: { labelKey: "targets.autoHotkeyScript", role: "command" },
  SwitchProfile: { macroAllowed: false, labelKey: "targets.switchProfile", role: "command" },
  Macro: { macroAllowed: false, labelKey: "macro.title", role: "command" },
  Soundboard: { macroAllowed: false, labelKey: "soundboard.title", role: "command" },
});

export const MEDIA_ACTIONS = BUILT_IN_TARGETS.MediaControl.actions;

export function targetType(target) {
  if (!target) return null;
  if (typeof target === "string") return target === "Unset" ? null : target;
  if (typeof target !== "object") return null;

  for (const type of Object.keys(BUILT_IN_TARGETS)) {
    if (Object.hasOwn(target, type) || Object.hasOwn(target, lowerFirst(type))) return type;
  }

  const explicit = String(target.type || target.kind || target.target || "");
  if (BUILT_IN_TARGETS[explicit]) return explicit;
  if (target.Profile || target.profile || explicit === "Profile") return "Profile";
  if (target.Session || target.session || explicit === "Session") return "Session";
  if (target.Application || target.application || explicit === "Application") return "Application";
  if (target.Device || target.device || explicit === "Device") return "Device";
  if (target.Integration || target.integration || explicit === "Integration") return "Integration";
  return null;
}

export function targetDescriptor(target) {
  return BUILT_IN_TARGETS[targetType(target)] || null;
}

export function isTargetAssigned(target) {
  return Boolean(targetType(target));
}

export function isTargetComplete(target) {
  const type = targetType(target);
  if (!type) return false;
  if (BUILT_IN_TARGETS[type]) return true;

  const payload = target?.[type] || target?.[lowerFirst(type)] || target;
  if (type === "Profile") return hasText(payload?.name);
  if (type === "Session") return hasText(payload?.session_id ?? payload?.sessionId);
  if (type === "Application") return hasText(payload?.name ?? payload?.appName);
  if (type === "Device") return hasText(payload?.device_id ?? payload?.deviceId);
  if (type === "Integration") {
    return hasText(payload?.integration_id ?? payload?.integrationId) && hasText(payload?.kind);
  }
  return false;
}

export function builtInTargetKey(target) {
  const descriptor = targetDescriptor(target);
  if (!descriptor) return null;
  if (descriptor.type !== "MonitorBrightness") return descriptor.key;
  const payload = target?.MonitorBrightness || target?.monitorBrightness;
  const monitorId = payload?.monitor_id ?? payload?.monitorId;
  return monitorId ? `monitor-brightness:${monitorId}` : descriptor.key;
}

export function targetFromPickerKind(kind) {
  return descriptorByPickerKind.get(String(kind || ""))?.type;
}

export function pickerMetadataForTarget(target) {
  const descriptor = targetDescriptor(target);
  if (!descriptor) return null;
  if (descriptor.type !== "MonitorBrightness") {
    return {
      value: descriptor.pickerValue,
      kind: descriptor.pickerKind,
      labelKey: descriptor.labelKey,
      iconKind: descriptor.iconKind,
    };
  }

  const payload = target?.MonitorBrightness || target?.monitorBrightness;
  const monitorId = payload?.monitor_id ?? payload?.monitorId;
  return {
    value: monitorId ? `monitor-brightness:${monitorId}` : descriptor.pickerValue,
    kind: descriptor.pickerKind,
    labelKey: descriptor.labelKey,
    label: payload?.display_name ?? payload?.displayName ?? null,
    iconKind: descriptor.iconKind,
  };
}

export function actionDefinition(action) {
  return ACTION_CATALOG[String(action || "")] || null;
}

function lowerFirst(value) {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function hasText(value) {
  return Boolean(String(value ?? "").trim());
}

/** Navigation entries are distinct from assignable targets; order is part of the picker UI. */
const PICKER_ROOTS = [
  { type: "Master" },
  { type: "Focus" },
  { type: "MonitorBrightness", value: "monitor-brightness-root", kind: "monitor-brightness-root" },
  { type: "Macro" },
  { type: "Soundboard" },
  { type: "MediaControl" },
  {
    value: "window-focus",
    kind: "action-root",
    labelKey: "targets.windowFocus",
    iconKind: "window-focus",
    controls: ["button"],
  },
  { type: "CaptureControl", value: "capture", kind: "action-root" },
  { type: "Hotkey" },
  { type: "OpenApplication" },
  { type: "AutoHotkeyScript" },
  {
    value: "profile-switch-root",
    kind: "profile-switch-root",
    labelKey: "targets.switchProfile",
    iconKind: "profile-switch",
    controls: ["button"],
  },
];

/** @returns {Array<object>} Built-in picker roots, before discovered applications/devices/plugins. */
export function builtInPickerOptions(isButton, translate, icons = {}) {
  const control = isButton ? "button" : "continuous";
  return PICKER_ROOTS.flatMap((entry) => {
    const descriptor = entry.type ? BUILT_IN_TARGETS[entry.type] : entry;
    if (!descriptor.controls.includes(control)) return [];
    const icon = icons[descriptor.iconKind];
    return [
      {
        value: entry.value ?? descriptor.pickerValue,
        label: translate(descriptor.labelKey),
        ...(descriptor.type === "MonitorBrightness"
          ? { icon_kind: descriptor.iconKind }
          : { icon_data: icon }),
        kind: entry.kind ?? descriptor.pickerKind,
      },
    ];
  });
}

/** Shared labels and roles; context may override a label without redefining the action. */
export function actionPickerOption(action, translate, iconData, overrides = {}) {
  const definition = actionDefinition(action);
  return {
    value: action,
    label: translate(definition?.labelKey || action),
    kind: "action",
    icon_data: iconData,
    role: definition?.role || "command",
    ...overrides,
  };
}

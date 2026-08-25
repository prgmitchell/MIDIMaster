import { iconDataForApplicationName } from "../../core/target_core.js";
import { targetFromPickerKind } from "../../core/target_model.js";

export function normalizeSelectedTargets(value) {
  if (Array.isArray(value)) return value.filter((target) => target && target !== "Unset").slice(0, 8);
  return value != null && value !== "Unset" ? [value] : [];
}

export function targetIdentity(target, integrationTargetKey = () => "") {
  if (!target) return "";
  if (target === "Master" || target?.Master != null) return "master";
  if (target === "Focus" || target?.Focus != null) return "focus";
  if (target === "MonitorBrightness") return "monitor-brightness";
  if (target?.MonitorBrightness != null || target?.monitorBrightness != null) {
    const brightness = target.MonitorBrightness || target.monitorBrightness;
    const monitorId = brightness?.monitor_id ?? brightness?.monitorId;
    return monitorId ? `monitor-brightness:${monitorId}` : "monitor-brightness";
  }
  const builtIn = new Map([
    ["MediaControl", "media-control"],
    ["CaptureControl", "capture-control"],
    ["Macro", "macro-target"],
    ["Soundboard", "soundboard-target"],
    ["Hotkey", "hotkey-target"],
    ["OpenApplication", "open-application-target"],
    ["AutoHotkeyScript", "autohotkey-script-target"],
  ]).get(target);
  if (builtIn) return builtIn;
  const profile = target?.Profile || target?.profile;
  if (profile?.name) return `profile:${profile.name}`;
  const integration = target?.Integration || target?.integration;
  if (integration) return `integration:${integrationTargetKey(integration)}`;
  const app = target?.Application || target?.application;
  if (app?.name) return `app:${String(app.name).toLowerCase()}`;
  const session = target?.Session || target?.session;
  if (session?.session_id || session?.sessionId) return `session:${session.session_id ?? session.sessionId}`;
  const device = target?.Device || target?.device;
  if (device?.device_id || device?.deviceId) return `device:${device.device_id ?? device.deviceId}`;
  return JSON.stringify(target);
}

export function resolveTargetSelection(currentTarget, {
  sessions = [],
  normalizeSessionKey = () => "",
  integrationTargetKey = () => "",
} = {}) {
  const integration = currentTarget?.Integration || currentTarget?.integration;
  const selectedAppContainer = currentTarget?.Application || currentTarget?.application;
  const selectedAppName = selectedAppContainer?.name || selectedAppContainer?.appName;
  const selectedAppKey = selectedAppName ? String(selectedAppName).toLowerCase() : "";
  const selectedAppDisplayName = selectedAppContainer?.display_name || selectedAppContainer?.displayName || "";
  const selectedAppIconData = selectedAppContainer?.icon_data
    || selectedAppContainer?.iconData
    || iconDataForApplicationName(selectedAppName)
    || null;
  const sessionContainer = currentTarget?.Session || currentTarget?.session;
  const selectedSessionId = sessionContainer && typeof sessionContainer === "object"
    ? (sessionContainer.session_id ?? sessionContainer.sessionId)
    : (sessionContainer != null ? sessionContainer : null);
  const selectedSessionKey = selectedSessionId != null
    ? (() => {
      const session = sessions.find((candidate) => String(candidate.id) === String(selectedSessionId));
      return session ? normalizeSessionKey(session) : null;
    })()
    : null;
  const selectedDeviceId = currentTarget?.Device?.device_id || currentTarget?.device?.device_id;
  const selectedProfileName = currentTarget?.Profile?.name || currentTarget?.profile?.name;
  const selectedBrightness = currentTarget?.MonitorBrightness || currentTarget?.monitorBrightness;
  const selectedBrightnessId = selectedBrightness && typeof selectedBrightness === "object"
    ? String(selectedBrightness.monitor_id ?? selectedBrightness.monitorId ?? "").trim()
    : "";

  const isUnset = currentTarget == null || currentTarget === "" || currentTarget === "Unset";
  let selectedKind = "placeholder";
  if (!isUnset) {
    if (integration) selectedKind = "integration-target";
    else if (currentTarget?.Session || currentTarget?.session || selectedAppContainer) selectedKind = "session";
    else if (currentTarget?.Device || currentTarget?.device) selectedKind = "device";
    else if (currentTarget?.Profile || currentTarget?.profile) selectedKind = "profile-target";
    else if (currentTarget === "Master" || currentTarget?.Master != null) selectedKind = "master";
    else if (currentTarget === "Focus" || currentTarget?.Focus != null) selectedKind = "focus";
    else if (currentTarget === "MonitorBrightness" || selectedBrightness != null) selectedKind = "monitor-brightness";
    else if (currentTarget === "MediaControl") selectedKind = "media-control";
    else if (currentTarget === "CaptureControl") selectedKind = "capture-control";
    else if (currentTarget === "Macro") selectedKind = "macro-target";
    else if (currentTarget === "Soundboard") selectedKind = "soundboard-target";
    else if (currentTarget === "Hotkey") selectedKind = "hotkey-target";
    else if (currentTarget === "OpenApplication") selectedKind = "open-application-target";
    else if (currentTarget === "AutoHotkeyScript") selectedKind = "autohotkey-script-target";
  }

  let selectedValue = "";
  if (selectedKind === "integration-target") selectedValue = integrationTargetKey(integration);
  else if (selectedKind === "session") selectedValue = selectedAppKey || selectedSessionKey || "";
  else if (selectedKind === "device") selectedValue = selectedDeviceId || "";
  else if (selectedKind === "profile-target") selectedValue = selectedProfileName || "";
  else if (selectedKind === "monitor-brightness") {
    selectedValue = selectedBrightnessId ? `monitor-brightness:${selectedBrightnessId}` : "monitor-brightness";
  } else if (selectedKind !== "placeholder") selectedValue = selectedKind;
  else selectedValue = "placeholder";

  return {
    integration,
    selectedAppName,
    selectedAppKey,
    selectedAppDisplayName,
    selectedAppIconData,
    selectedDeviceId,
    selectedBrightnessId,
    selectedKind,
    selectedValue,
  };
}

export function mapTargetOptionToTarget(option, { fallbackTarget = "Unset" } = {}) {
  if (option?.target) {
    const target = option.target;
    const integration = target?.Integration || target?.integration;
    if (integration && typeof integration === "object" && integration.integration_id) {
      const next = {
        Integration: {
          integration_id: String(integration.integration_id),
          kind: String(integration.kind || ""),
          data: { ...(integration.data || {}) },
        },
      };
      if (option.label && !String(next.Integration.data.label || "").trim()) next.Integration.data.label = String(option.label);
      if (option.icon_data && !String(next.Integration.data.icon_data || "").trim()) next.Integration.data.icon_data = option.icon_data;
      if (option.__selectedActionLabel) next.Integration.data.action_label = String(option.__selectedActionLabel);
      if (option.__selectedActionValue) next.Integration.data.action_value = String(option.__selectedActionValue);
      if (option.__selectedActionKind) next.Integration.data.action_kind = String(option.__selectedActionKind);
      return next;
    }
    return target;
  }
  const builtInTarget = targetFromPickerKind(option?.kind);
  if (builtInTarget) return builtInTarget;
  if (option?.kind === "capture-action") return "CaptureControl";
  if (option?.kind === "device") return { Device: { device_id: option.value } };
  if (option?.kind === "session") {
    const displayName = String(option.display_name || option.label || "").replace(/\s*\(Unavailable\)\s*$/i, "").trim();
    const app = { name: option.value };
    if (displayName) app.display_name = displayName;
    if (option.icon_data) app.icon_data = option.icon_data;
    return { Application: app };
  }
  if (option?.kind === "placeholder") return "Unset";
  return fallbackTarget || "Unset";
}

export function normalizeActionRole(role, action = "") {
  const value = String(role || "").trim().toLowerCase();
  if (["value", "state", "momentary", "command"].includes(value)) return value;
  if (action === "ToggleMute" || action === "ToggleEffect") return "state";
  return "command";
}

export function normalizeButtonActionOption(action, targetOption, translate, extra = {}) {
  const value = String(action?.value || "Volume");
  const behavior = String(action?.behavior || action?.action_kind || "").trim();
  const role = normalizeActionRole(
    action?.role
      || action?.action_role
      || (behavior.toLowerCase() === "stateful" ? "state" : "")
      || (behavior.toLowerCase() === "momentary" ? "momentary" : ""),
    value,
  );
  return {
    label: action?.label || value || translate("targets.category.actions"),
    value,
    kind: "action",
    icon_data: action?.icon_data || targetOption?.icon_data || null,
    behavior,
    role,
    value_kind: action?.value_kind || action?.valueKind || "",
    targetOption: extra.targetOption || action?.targetOption || null,
  };
}

function actionKey(option) {
  return [option?.value, option?.role, option?.behavior, option?.label].map((value) => String(value || "")).join("\u0000");
}

export function pushUniqueAction(actions, option) {
  if (!option) return;
  const key = actionKey(option);
  if (!actions.some((existing) => actionKey(existing) === key)) actions.push(option);
}

import {
  AUTOHOTKEY_SCRIPT_ICON_DATA,
  CAPTURE_ICON_DATA,
  HOTKEY_ICON_DATA,
  MACRO_ICON_DATA,
  OPEN_APPLICATION_TARGET_ICON_DATA,
  PROFILE_SWITCH_ICON_DATA,
  SOUNDBOARD_ICON_DATA,
  WINDOW_FOCUS_ICON_DATA,
} from "../catalog_presentation.js";
import { builtInPickerOptions } from "../../../core/target_model.js";
import { resolveTargetSelection } from "../selection_model.js";
import { iconDataForSession } from "../../../core/target_core.js";

/** discovery workflow. */
export function createDiscovery({
  focusIconData,
  getHost,
  getPlayback,
  getRecording,
  getSess,
  masterIconData,
  mediaPlayPauseIconData,
  normalizeKey,
  processTagForSession,
  resolveDisplay,
  t,
  targetKey,
}) {
  function buildTargetOptions(currentTarget, isButton = false) {
    const pluginHost = getHost();
    const sessions = getSess();
    const playbackDevices = getPlayback();
    const recordingDevices = getRecording();

    const {
      integration,
      selectedAppName,
      selectedAppKey,
      selectedAppDisplayName,
      selectedAppIconData,
      selectedDeviceId,
      selectedBrightnessId,
      selectedKind,
      selectedValue,
    } = resolveTargetSelection(currentTarget, {
      sessions,
      normalizeSessionKey: normalizeKey,
      integrationTargetKey: targetKey,
    });

    const options = builtInPickerOptions(isButton, t, {
      master: masterIconData,
      focus: focusIconData,
      macro: MACRO_ICON_DATA,
      soundboard: SOUNDBOARD_ICON_DATA,
      "media-play-pause": mediaPlayPauseIconData,
      "window-focus": WINDOW_FOCUS_ICON_DATA,
      capture: CAPTURE_ICON_DATA,
      hotkey: HOTKEY_ICON_DATA,
      "open-application": OPEN_APPLICATION_TARGET_ICON_DATA,
      "autohotkey-script": AUTOHOTKEY_SCRIPT_ICON_DATA,
      "profile-switch": PROFILE_SWITCH_ICON_DATA,
    });

    if (pluginHost) {
      const integrations = pluginHost.getIntegrations();
      if (Array.isArray(integrations) && integrations.length > 0) {
        options.push({ kind: "divider", label: t("targets.category.integrations") });
        for (const integ of integrations) {
          if (!integ || !integ.id) continue;
          options.push({
            kind: "integration-root",
            value: String(integ.id),
            label: integ.name || String(integ.id),
            icon_data: integ.icon_data || null,
          });
        }
      }
    }

    const seen = new Set();
    const sessionsAdded = sessions.filter((session) => !session.is_master && session.id !== "master");
    if (sessionsAdded.length > 0) {
      options.push({ kind: "divider", label: t("targets.category.applications") });
      sessionsAdded.forEach((session) => {
        const key = normalizeKey(session);
        if (!key) return;

        if (seen.has(key)) {
          return;
        }

        seen.add(key);
        options.push({
          value: key,
          label: session.display_name,
          display_name: session.display_name,
          icon_data: iconDataForSession(session),
          title_tags: [processTagForSession(session)].filter(Boolean),
          kind: "session",
        });
      });
    }

    if (selectedAppName && !seen.has(selectedAppKey)) {
      if (sessionsAdded.length === 0) {
        options.push({ kind: "divider", label: t("targets.category.applications") });
      }
      const label =
        selectedAppDisplayName || selectedAppName.charAt(0).toUpperCase() + selectedAppName.slice(1);
      options.push({
        value: selectedAppKey,
        label: t("targets.unavailableName", { name: label }),
        display_name: label,
        icon_data: selectedAppIconData,
        kind: "session",
        ghost: true,
      });
    }

    if (playbackDevices.length > 0) {
      options.push({ kind: "divider", label: t("targets.category.playback") });
      playbackDevices.forEach((device) => {
        options.push({
          value: `playback:${device.id}`,
          label: device.display_name,
          icon_data: device.icon_data,
          icon_kind: "playback-device",
          kind: "device",
        });
      });
    }

    if (recordingDevices.length > 0) {
      options.push({ kind: "divider", label: t("targets.category.recording") });
      recordingDevices.forEach((device) => {
        options.push({
          value: `recording:${device.id}`,
          label: device.display_name,
          icon_data: device.icon_data,
          icon_kind: "recording-device",
          kind: "device",
        });
      });
    }

    if (selectedDeviceId) {
      const found = options.some((opt) => opt.value === selectedDeviceId);
      if (!found) {
        if (playbackDevices.length === 0 && recordingDevices.length === 0) {
          options.push({ kind: "divider", label: t("targets.category.devices") });
        }
        options.push({
          value: selectedDeviceId,
          label: t("targets.unavailableName", { name: t("targets.category.devices") }),
          kind: "device",
          ghost: true,
        });
      }
    }

    let activeIntegrationOption = null;
    if (selectedKind === "integration-target" && selectedValue) {
      let label = t("targets.integrationTarget");
      let ghost = false;
      let icon_data = null;
      if (integration) {
        const handler = pluginHost?.getIntegration?.(integration.integration_id);
        if (handler && typeof handler.describeTarget === "function") {
          try {
            const desc = handler.describeTarget({ Integration: integration });
            if (desc?.label) label = desc.label;
            if (desc?.icon_data) icon_data = desc.icon_data;
            if (typeof desc?.ghost === "boolean") ghost = desc.ghost;
          } catch {}
        }

        if (!icon_data || label === t("targets.integrationTarget")) {
          try {
            const fallback = resolveDisplay({ Integration: integration });
            if (fallback?.label) label = fallback.label;
            if (fallback?.icon_data) icon_data = fallback.icon_data;
          } catch {}
        }

        if (!handler) {
          ghost = true;
        }

        if (ghost && label && typeof label === "string" && !label.includes(t("targets.unavailable"))) {
          label = t("targets.unavailableName", { name: label });
        }
      }
      activeIntegrationOption = {
        kind: "integration-target",
        value: selectedValue,
        label,
        ghost,
        icon_data,
        target: integration ? { Integration: integration } : null,
      };
    }

    return { options, selectedValue, selectedKind, activeIntegrationOption };
  }

  return { buildTargetOptions };
}

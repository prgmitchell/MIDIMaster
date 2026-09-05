import {
  CAPTURE_ICON_DATA,
  SNIP_ICON_DATA,
  RECORD_ICON_DATA,
  HOTKEY_ICON_DATA,
  SOUNDBOARD_ICON_DATA,
  OPEN_APPLICATION_TARGET_ICON_DATA,
  AUTOHOTKEY_SCRIPT_ICON_DATA,
  PROFILE_SWITCH_ICON_DATA,
  TOGGLE_MUTE_ICON_DATA,
  WINDOW_FOCUS_ICON_DATA,
  SET_DEFAULT_DEVICE_ICON_DATA,
} from "../catalog_presentation.js";
import { BUILT_IN_TARGETS, actionPickerOption } from "../../../core/target_model.js";
import {
  normalizeButtonActionOption as normalizeCanonicalButtonActionOption,
  pushUniqueAction,
} from "../selection_model.js";

/** action policy workflow. */
export function createActionPolicy({
  t,
  getSess,
  getPlayback,
  getRecording,
  targetKey,
  getHost,
  mediaActionOptions,
  includeValueAction,
  includeWindowFocusAction,
  targetIdentity,
}) {
  function normalizeButtonActionOption(action, targetOption, extra = {}) {
    return normalizeCanonicalButtonActionOption(action, targetOption, t, extra);
  }

  function valueActionOption(targetOption) {
    return {
      label: t("targets.action.setValue"),
      value: "Volume",
      kind: "action",
      icon_data: targetOption?.icon_data || null,
      role: "value",
      value_kind: "percent",
    };
  }

  function addValueAction(actions, targetOption) {
    if (!includeValueAction || !targetOption?.__valueCapable) return;
    const option = valueActionOption(targetOption);
    if (actions.some((existing) => existing?.value === "Volume" && existing?.role === "value")) return;
    actions.unshift(option);
  }

  function captureActionOptions() {
    const icons = [CAPTURE_ICON_DATA, SNIP_ICON_DATA, RECORD_ICON_DATA];
    return BUILT_IN_TARGETS.CaptureControl.actions.map((action, index) =>
      actionPickerOption(action, t, icons[index]),
    );
  }

  async function collectIntegrationTargetOptions(handler, integrationId, controlType) {
    if (!handler || typeof handler.getTargetOptions !== "function") return [];
    const collected = [];
    const queue = [null];
    const seen = new Set();
    let guard = 0;
    while (queue.length > 0 && guard < 64) {
      guard += 1;
      const nav = queue.shift();
      const key = JSON.stringify(nav || null);
      if (seen.has(key)) continue;
      seen.add(key);
      let list = [];
      try {
        const res = handler.getTargetOptions({
          sessions: getSess(),
          playbackDevices: getPlayback(),
          recordingDevices: getRecording(),
          controlType,
          nav,
        });
        list = res && typeof res.then === "function" ? await res : res || [];
      } catch {
        list = [];
      }
      (Array.isArray(list) ? list : []).forEach((raw) => {
        if (!raw || typeof raw !== "object") return;
        if (raw.nav) {
          queue.push(raw.nav);
          return;
        }
        if (!raw.target) return;
        collected.push({
          label: raw.label || t("targets.integrationTarget"),
          icon_data: raw.icon_data || handler?.icon_data || null,
          kind: raw.kind || "integration-target",
          value: targetKey(raw.target?.Integration || raw.target?.integration || {}),
          target: raw.target,
          category: raw.category || "integrations",
          integrationId,
          buttonActions: Array.isArray(raw.buttonActions) ? raw.buttonActions : [],
        });
      });
    }
    return collected;
  }

  async function hydrateIntegrationActionsForTarget(targetOption, actions) {
    const integ = targetOption?.target?.Integration || targetOption?.target?.integration;
    if (!integ?.integration_id) return;
    const handler = getHost()?.getIntegration?.(integ.integration_id);
    if (!handler) return;
    const identity = targetIdentity(targetOption.target);
    const [buttonOptions, faderOptions] = await Promise.all([
      collectIntegrationTargetOptions(handler, integ.integration_id, "button"),
      includeValueAction
        ? collectIntegrationTargetOptions(handler, integ.integration_id, "fader")
        : Promise.resolve([]),
    ]);

    if (includeValueAction && faderOptions.some((option) => targetIdentity(option.target) === identity)) {
      targetOption.__valueCapable = true;
      addValueAction(actions, targetOption);
    }

    buttonOptions
      .filter((option) => targetIdentity(option.target) === identity)
      .forEach((option) => {
        option.buttonActions.forEach((action) => {
          pushUniqueAction(actions, normalizeButtonActionOption(action, option, { targetOption: option }));
        });
      });
  }

  async function loadMacroNavActionOptionsForDropdown(targetOption) {
    if (!includeValueAction || !targetOption?.macroActionNav || !targetOption?.integrationId) return [];
    const pluginHost = getHost();
    const handler = pluginHost?.getIntegration(targetOption.integrationId);
    if (!handler || typeof handler.getTargetOptions !== "function") return [];
    let sub = [];
    try {
      const res = handler.getTargetOptions({
        sessions: getSess(),
        playbackDevices: getPlayback(),
        recordingDevices: getRecording(),
        controlType: "button",
        nav: targetOption.macroActionNav,
      });
      sub = res && typeof res.then === "function" ? await res : res || [];
    } catch {
      sub = [];
    }
    const targetIdentityKey = targetIdentity(targetOption.target);
    return (Array.isArray(sub) ? sub : [])
      .filter((raw) => raw && raw.target && Array.isArray(raw.buttonActions) && raw.buttonActions.length > 0)
      .map((raw) => {
        const mapped = {
          label: raw.label || targetOption.label || t("targets.integrationTarget"),
          icon_data: raw.icon_data || targetOption.icon_data || handler?.icon_data || null,
          kind: raw.kind || "integration-target",
          value: targetKey(raw.target?.Integration || raw.target?.integration || {}),
          target: raw.target,
          category: raw.category || "integrations",
          integrationId: targetOption.integrationId,
          buttonActions: raw.buttonActions,
        };
        return targetIdentity(mapped.target) === targetIdentityKey ? mapped : null;
      })
      .filter(Boolean)
      .flatMap((mapped) =>
        mapped.buttonActions.map((action) =>
          normalizeButtonActionOption(action, mapped, { targetOption: mapped }),
        ),
      );
  }

  async function buildActionOptionsForTargetOption(targetOption, { source = "selected" } = {}) {
    if (!targetOption) return [];
    if (targetOption.kind === "hotkey-target") {
      return [
        {
          label: t("targets.hotkey"),
          value: "Hotkey",
          kind: "action",
          icon_data: HOTKEY_ICON_DATA,
          role: "command",
        },
      ];
    }
    if (targetOption.kind === "soundboard-target") {
      return [
        {
          label: t("soundboard.title"),
          value: "Soundboard",
          kind: "action",
          icon_data: SOUNDBOARD_ICON_DATA,
          role: "command",
        },
      ];
    }
    if (targetOption.kind === "open-application-target") {
      return [
        {
          label: t("targets.openApplication"),
          value: "OpenApplication",
          kind: "action",
          icon_data: OPEN_APPLICATION_TARGET_ICON_DATA,
          role: "command",
        },
      ];
    }
    if (targetOption.kind === "autohotkey-script-target") {
      return [
        {
          label: t("targets.autoHotkeyScript"),
          value: "RunAutoHotkeyScript",
          kind: "action",
          icon_data: AUTOHOTKEY_SCRIPT_ICON_DATA,
          role: "command",
        },
      ];
    }
    if (targetOption.kind === "profile-target") {
      return [
        {
          label: t("targets.switchProfile"),
          value: "SwitchProfile",
          kind: "action",
          icon_data: PROFILE_SWITCH_ICON_DATA,
          role: "command",
        },
      ];
    }
    if (targetOption.kind === "capture-control") {
      return captureActionOptions();
    }
    if (targetOption.kind === "media-control") {
      return mediaActionOptions();
    }
    if (
      targetOption.kind === "master" ||
      targetOption.kind === "focus" ||
      targetOption.kind === "session" ||
      targetOption.kind === "application"
    ) {
      const actions = [
        {
          label: t("targets.action.toggleMute"),
          value: "ToggleMute",
          kind: "action",
          icon_data: TOGGLE_MUTE_ICON_DATA,
          role: "state",
        },
      ];
      if (
        source === "selected" &&
        includeWindowFocusAction &&
        (targetOption.kind === "session" || targetOption.kind === "application")
      ) {
        actions.push({
          label: t("targets.action.focusWindow"),
          value: "FocusWindow",
          kind: "action",
          icon_data: WINDOW_FOCUS_ICON_DATA,
          role: "command",
        });
      }
      if (includeValueAction) {
        actions.push(valueActionOption(targetOption));
      }
      return actions;
    }
    if (targetOption.kind === "device") {
      const actions = [
        {
          label: t("targets.action.toggleMute"),
          value: "ToggleMute",
          kind: "action",
          icon_data: TOGGLE_MUTE_ICON_DATA,
          role: "state",
        },
        {
          label: t("targets.action.setDefaultDevice"),
          value: "SetDefaultDevice",
          kind: "action",
          icon_data: SET_DEFAULT_DEVICE_ICON_DATA,
          role: "command",
        },
      ];
      if (includeValueAction) {
        actions.splice(1, 0, valueActionOption(targetOption));
      }
      return actions;
    }

    const actions = [];
    addValueAction(actions, targetOption);
    const perTarget = Array.isArray(targetOption.buttonActions) ? targetOption.buttonActions : [];
    const integration = targetOption?.target?.Integration || targetOption?.target?.integration;
    const handler = integration?.integration_id
      ? getHost()?.getIntegration?.(integration.integration_id)
      : null;
    const integrationActions = Array.isArray(handler?.buttonActions) ? handler.buttonActions : [];
    const appendActions = (options) =>
      options.forEach((action) =>
        pushUniqueAction(actions, normalizeButtonActionOption(action, targetOption)),
      );
    // Menus honor the plugin's per-target override. A selected macro target
    // combines all declared actions and hydrates navigation on demand.
    appendActions(source === "menu" && perTarget.length === 0 ? integrationActions : perTarget);
    const navActions = await loadMacroNavActionOptionsForDropdown(targetOption);
    navActions.forEach((action) => pushUniqueAction(actions, action));
    if (source === "selected") {
      await hydrateIntegrationActionsForTarget(targetOption, actions);
      appendActions(integrationActions);
    }
    return actions;
  }

  return {
    normalizeButtonActionOption,
    valueActionOption,
    addValueAction,
    captureActionOptions,
    collectIntegrationTargetOptions,
    hydrateIntegrationActionsForTarget,
    loadMacroNavActionOptionsForDropdown,
    buildActionOptionsForTargetOption,
  };
}

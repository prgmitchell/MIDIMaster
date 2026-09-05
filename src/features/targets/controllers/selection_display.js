import {
  HOTKEY_ICON_DATA,
  OPEN_APPLICATION_TARGET_ICON_DATA,
  AUTOHOTKEY_SCRIPT_ICON_DATA,
  PROFILE_SWITCH_ICON_DATA,
  CAPTURE_ICON_DATA,
  MACRO_ICON_DATA,
  SOUNDBOARD_ICON_DATA,
} from "../catalog_presentation.js";
import { actionDefinition, pickerMetadataForTarget } from "../../../core/target_model.js";
import { iconDataForApplicationName } from "../../../core/target_core.js";
import { renderLabelFromRawWithTags } from "../../ui/dropdown_badges.js";

/** selection display workflow. */
export function createSelectionDisplay({
  t,
  getHost,
  friendlyAppName,
  resolveOpenApplicationIcon,
  displayNameFromPath,
  resolveDisplay,
  masterIconData,
  focusIconData,
  mediaPlayPauseIconData,
  targetKey,
  createTargetIcon,
  container,
  display,
  hasUnavailableSuffix,
  includeValueAction,
  integrationFromTarget,
  isBindingButton,
  macroDisplayName,
  placeholderOption,
  selection,
  stripUnavailableSuffix,
  suppressActionTags,
  syncContainerValue,
  targetDisplayCache,
  targetIdentity,
}) {
  function actionLabel(action, target = null) {
    if (target === "Macro") return t("macro.title");
    if (target === "Soundboard") return t("soundboard.title");
    const integ = integrationFromTarget(target);
    if (action === "Volume" && selection.selectedActionRole === "value") {
      return t("targets.action.setValue");
    }
    if (selection.selectedActionLabel) {
      return selection.selectedActionLabel;
    }
    const persistedActionLabel = String(integ?.data?.action_label || "").trim();
    if (persistedActionLabel) {
      const display = cachedDisplayForTarget(target);
      const targetLabel = String(display?.label || "")
        .replace(/\s*\([^()]+\)\s*$/g, "")
        .trim();
      if (targetLabel && targetLabel.toLowerCase() === persistedActionLabel.toLowerCase()) {
        return "";
      }
      return persistedActionLabel;
    }

    // Check if the integration declares a custom label for this action
    if (integ?.integration_id) {
      const pluginHost = getHost();
      const handler = pluginHost?.getIntegration(integ.integration_id);
      if (Array.isArray(handler?.buttonActions)) {
        const match = handler.buttonActions.find((a) => a.value === action);
        if (match?.label) return match.label;
      }
    }
    if (action === "Volume" && isBindingButton) {
      const targetKind = String(integ?.kind || "").toLowerCase();
      if (targetKind === "action" || targetKind === "scene") return "";
      if (includeValueAction && !integ) return t("targets.action.setValue");
      return t("targets.action.trigger");
    }
    const definition = actionDefinition(action);
    if (definition?.labelKey) return t(definition.labelKey);
    return action;
  }

  function cachedDisplayForTarget(target) {
    const key = targetIdentity(target);
    const cached = targetDisplayCache.get(key);
    if (target === "Hotkey") {
      return {
        label: selection.hotkeyDisplay
          ? t("targets.hotkeyWithValue", { value: selection.hotkeyDisplay })
          : t("targets.hotkeyNotSet"),
        icon_data: cached?.icon_data ?? HOTKEY_ICON_DATA,
      };
    }
    if (target === "OpenApplication") {
      const openAppLabel =
        friendlyAppName(
          selection.selectedOpenApplication?.display || selection.selectedOpenApplication?.path || "",
        ) || t("targets.openApplication");
      return {
        label: openAppLabel,
        icon_data:
          selection.selectedOpenApplication?.icon_data ||
          resolveOpenApplicationIcon(selection.selectedOpenApplication) ||
          cached?.icon_data ||
          OPEN_APPLICATION_TARGET_ICON_DATA,
      };
    }
    if (target === "AutoHotkeyScript") {
      const scriptLabel =
        displayNameFromPath(
          selection.selectedAutoHotkeyScript?.display || selection.selectedAutoHotkeyScript?.path || "",
        ) || t("targets.autoHotkeyScript");
      return {
        label: scriptLabel,
        icon_data: AUTOHOTKEY_SCRIPT_ICON_DATA,
      };
    }
    const profile = target?.Profile || target?.profile;
    if (profile?.name) {
      return {
        label: t("targets.profileNamed", { name: profile.name }),
        icon_data: PROFILE_SWITCH_ICON_DATA,
      };
    }
    if (target === "CaptureControl") {
      return {
        label: t("targets.captureControls"),
        icon_data: CAPTURE_ICON_DATA,
      };
    }
    if (target === "Macro") {
      return {
        label: macroDisplayName || "Macro",
        icon_data: MACRO_ICON_DATA,
      };
    }
    if (target === "Soundboard") {
      return {
        label: t("soundboard.title"),
        icon_data: SOUNDBOARD_ICON_DATA,
      };
    }
    const resolved = resolveDisplay(target);
    const merged = {
      label: resolved?.label || cached?.label || "Target",
      icon_data: resolved?.icon_data ?? cached?.icon_data ?? null,
      ghost: Boolean(resolved?.ghost),
    };
    const iconKind = resolved?.icon_kind || cached?.icon_kind || null;
    if (iconKind) merged.icon_kind = iconKind;
    targetDisplayCache.set(key, merged);
    return merged;
  }

  function optionForTarget(target) {
    if (!target || target === "Unset") return null;
    const displayOption = cachedDisplayForTarget(target);
    const builtIn = pickerMetadataForTarget(target);
    if (builtIn) {
      const iconData =
        {
          master: masterIconData,
          focus: focusIconData,
          "media-play-pause": mediaPlayPauseIconData,
          capture: CAPTURE_ICON_DATA,
          macro: MACRO_ICON_DATA,
          soundboard: SOUNDBOARD_ICON_DATA,
          hotkey: HOTKEY_ICON_DATA,
          "open-application": OPEN_APPLICATION_TARGET_ICON_DATA,
          "autohotkey-script": AUTOHOTKEY_SCRIPT_ICON_DATA,
        }[builtIn.iconKind] || null;
      const option = {
        value: builtIn.value,
        label: builtIn.label || t(builtIn.labelKey),
        icon_data: iconData,
        kind: builtIn.kind,
      };
      if (!iconData && builtIn.iconKind) option.icon_kind = builtIn.iconKind;
      if (builtIn.kind === "monitor-brightness" && typeof target === "object") option.target = target;
      return option;
    }
    const profile = target?.Profile || target?.profile;
    if (profile?.name) {
      return {
        value: profile.name,
        label: t("targets.profileNamed", { name: profile.name }),
        icon_data: PROFILE_SWITCH_ICON_DATA,
        kind: "profile-target",
        target,
      };
    }
    const integration = target?.Integration || target?.integration;
    if (integration) {
      const data = integration.data || {};
      return {
        value: targetKey(integration),
        label: displayOption?.label || t("targets.integrationTarget"),
        icon_data: displayOption?.icon_data || null,
        kind: "integration-target",
        target,
        integrationId: integration.integration_id,
        __valueCapable:
          selection.selectedActionRole === "value" ||
          (selection.selectedAction === "Volume" &&
            !data.action_label &&
            !data.action_value &&
            !data.action_kind &&
            !data.button_action &&
            !data.osd_value_text),
      };
    }
    const app = target?.Application || target?.application;
    if (app?.name) {
      return {
        value: String(app.name).toLowerCase(),
        label: displayOption?.label || app.display_name || app.name,
        display_name: app.display_name || displayOption?.label || app.name,
        icon_data: displayOption?.icon_data || app.icon_data || iconDataForApplicationName(app.name) || null,
        kind: "session",
      };
    }
    const session = target?.Session || target?.session;
    if (session?.session_id || session?.sessionId) {
      return {
        value: String(session.session_id ?? session.sessionId),
        label: displayOption?.label || t("targets.category.applications"),
        icon_data: displayOption?.icon_data || null,
        kind: "session",
      };
    }
    const device = target?.Device || target?.device;
    if (device?.device_id || device?.deviceId) {
      const deviceId = device.device_id ?? device.deviceId;
      return {
        value: deviceId,
        label: displayOption?.label || t("targets.category.devices"),
        icon_data: displayOption?.icon_data || null,
        kind: "device",
      };
    }
    return null;
  }

  function renderChip(target, index) {
    const displayOption = cachedDisplayForTarget(target);
    const chip = document.createElement("span");
    chip.className = "target-chip";
    if (
      displayOption?.ghost ||
      hasUnavailableSuffix(displayOption?.label) ||
      String(displayOption?.label || "").includes(t("targets.unavailable"))
    ) {
      chip.classList.add("unavailable");
    }
    chip.dataset.index = String(index);

    const icon = createTargetIcon(displayOption);
    icon.classList.add("target-chip-icon");
    chip.appendChild(icon);

    const label = document.createElement("span");
    label.className = "target-chip-label";
    const actionTags =
      isBindingButton && selection.selectedAction && !suppressActionTags
        ? [actionLabel(selection.selectedAction, target)]
        : [];
    renderLabelFromRawWithTags(label, {
      rawLabel: stripUnavailableSuffix(displayOption.label),
      extraTags: actionTags.filter(Boolean),
      truncateMain: true,
      collapseTags: false,
    });
    chip.appendChild(label);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "target-chip-remove";
    remove.title = t("targets.removeTarget");
    remove.setAttribute("aria-label", t("targets.removeTarget"));
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const idx = Number(chip.dataset.index);
      if (Number.isNaN(idx)) return;
      selection.selectedTargets = selection.selectedTargets.filter((_, i) => i !== idx);
      syncContainerValue(false);
      container.dispatchEvent(new Event("change"));
    });
    chip.appendChild(remove);
    return chip;
  }

  function setDisplay() {
    display.innerHTML = "";
    if (selection.selectedTargets.length === 0) {
      const label = document.createElement("span");
      label.className = "target-placeholder";
      label.textContent = placeholderOption.label;
      display.appendChild(label);
      return;
    }
    const chipsWrap = document.createElement("span");
    chipsWrap.className = "target-chips-wrap";
    if (selection.selectedTargets.length > 1) {
      chipsWrap.classList.add("is-scrollable");
    }
    selection.selectedTargets.forEach((target, index) => {
      chipsWrap.appendChild(renderChip(target, index));
    });
    display.appendChild(chipsWrap);
  }

  return { actionLabel, cachedDisplayForTarget, optionForTarget, renderChip, setDisplay };
}

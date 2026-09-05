import { HOTKEY_ICON_DATA, SYSTEM_TARGET_ICON_MARKUP } from "../catalog_presentation.js";
import { MEDIA_ACTIONS, actionDefinition } from "../../../core/target_model.js";
import { closeOpenDropdowns } from "../../ui/dropdown_badges.js";

/** icons workflow. */
export function createIcons({
  focusIconData,
  masterIconData,
  mediaNextTrackIconData,
  mediaPlayPauseIconData,
  mediaPrevTrackIconData,
  mediaStopIconData,
  t,
}) {
  function mediaIconForAction(action) {
    if (action === "MediaNextTrack") return mediaNextTrackIconData;
    if (action === "MediaPrevTrack") return mediaPrevTrackIconData;
    if (action === "MediaStop") return mediaStopIconData;
    return mediaPlayPauseIconData;
  }

  function mediaActionOptions() {
    return MEDIA_ACTIONS.map((action) => ({
      label: t(actionDefinition(action).labelKey),
      value: action,
      kind: "action",
      icon_data: mediaIconForAction(action),
      role: actionDefinition(action).role,
    }));
  }

  function closeTargetMenus(except = null) {
    closeOpenDropdowns({ except });
  }

  function systemTargetIconKind(option) {
    const requestedKind = String(option?.icon_kind || "");
    const source = option?.icon_data;
    if (SYSTEM_TARGET_ICON_MARKUP[requestedKind] && (!source || !requestedKind.endsWith("-device"))) {
      return requestedKind;
    }

    if (source) {
      if (source === masterIconData) return "master";
      if (source === focusIconData) return "focus";
      if (source === mediaPlayPauseIconData) return "media-play-pause";
      if (source === mediaNextTrackIconData) return "media-next";
      if (source === mediaPrevTrackIconData) return "media-previous";
      if (source === mediaStopIconData) return "media-stop";
      if (source === HOTKEY_ICON_DATA) return "hotkey";
    }

    if (!source && option?.kind === "device") {
      return String(option.value || "").startsWith("recording:") ? "recording-device" : "playback-device";
    }
    return null;
  }

  function createSystemTargetIcon(kind) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 18 18");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    icon.classList.add("target-icon", "target-icon--system", `target-icon--${kind}`);
    if (kind.endsWith("-device")) icon.classList.add("target-icon--device");
    icon.innerHTML = SYSTEM_TARGET_ICON_MARKUP[kind];
    return icon;
  }

  function createFallbackTargetIcon(option) {
    const systemKind = systemTargetIconKind({ ...option, icon_data: null });
    if (systemKind) return createSystemTargetIcon(systemKind);

    const fallback = document.createElement("span");
    fallback.className = "target-icon fallback";
    fallback.textContent = option?.label?.[0]?.toUpperCase() || "?";
    return fallback;
  }

  function createTargetIcon(option) {
    const systemKind = systemTargetIconKind(option);
    if (systemKind) return createSystemTargetIcon(systemKind);

    if (option?.icon_data) {
      const icon = document.createElement("img");
      icon.className = "target-icon";
      icon.alt = "";
      const src = String(option.icon_data);
      icon.src = src.startsWith("data:") || src.startsWith("assets/") ? src : `data:image/png;base64,${src}`;
      icon.addEventListener(
        "error",
        () => {
          const fallback = createFallbackTargetIcon(option);
          if (icon.classList.contains("target-chip-icon")) {
            fallback.classList.add("target-chip-icon");
          }
          icon.replaceWith(fallback);
        },
        { once: true },
      );
      return icon;
    }
    return createFallbackTargetIcon(option);
  }

  return {
    mediaIconForAction,
    mediaActionOptions,
    closeTargetMenus,
    systemTargetIconKind,
    createSystemTargetIcon,
    createFallbackTargetIcon,
    createTargetIcon,
  };
}

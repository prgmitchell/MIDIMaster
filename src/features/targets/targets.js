import { closeOpenDropdowns, renderLabelFromRawWithTags } from "../ui/dropdown_badges.js";

export function createTargetsFeature({
  dom,
  masterIconData,
  focusIconData,
  mediaPlayPauseIconData,
  mediaNextTrackIconData,
  mediaPrevTrackIconData,
  mediaStopIconData,
  getPluginHost,
  getSessions,
  getPlaybackDevices,
  getRecordingDevices,
  normalizeSessionKey,
  integrationTargetKey,
  resolveOsdTarget,
}) {
  const d = (dom && typeof dom === "object") ? dom : {};
  const getHost = (typeof getPluginHost === "function") ? getPluginHost : (() => null);
  const getSess = (typeof getSessions === "function") ? getSessions : (() => []);
  const getPlayback = (typeof getPlaybackDevices === "function") ? getPlaybackDevices : (() => []);
  const getRecording = (typeof getRecordingDevices === "function") ? getRecordingDevices : (() => []);
  const normalizeKey = (typeof normalizeSessionKey === "function") ? normalizeSessionKey : (() => "");
  const targetKey = (typeof integrationTargetKey === "function") ? integrationTargetKey : (() => "");
  const resolveDisplay = (typeof resolveOsdTarget === "function") ? resolveOsdTarget : (() => null);

  let activeTargetPanelSelect = null;
  let activeTargetPanelBack = null;
  const HOTKEY_ICON_DATA = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' fill='none'><rect x='2' y='4' width='16' height='12' rx='3' fill='%231a2446' stroke='%2398a6cc' stroke-width='1.2'/><rect x='4' y='7' width='2.2' height='2.2' rx='0.6' fill='%23c7d2f3'/><rect x='7' y='7' width='2.2' height='2.2' rx='0.6' fill='%23c7d2f3'/><rect x='10' y='7' width='2.2' height='2.2' rx='0.6' fill='%23c7d2f3'/><rect x='13' y='7' width='2.2' height='2.2' rx='0.6' fill='%23c7d2f3'/><rect x='5.2' y='10.6' width='9.6' height='2.2' rx='0.8' fill='%23c7d2f3'/></svg>";

  function mediaIconForAction(action) {
    if (action === "MediaNextTrack") return mediaNextTrackIconData;
    if (action === "MediaPrevTrack") return mediaPrevTrackIconData;
    if (action === "MediaStop") return mediaStopIconData;
    return mediaPlayPauseIconData;
  }

  function closeTargetMenus(except = null) {
    closeOpenDropdowns({ except });
  }

  function createTargetIcon(option) {
    if (option?.icon_data) {
      const icon = document.createElement("img");
      icon.className = "target-icon";
      icon.alt = "";
      const src = String(option.icon_data);
      icon.src = src.startsWith("data:") || src.startsWith("assets/")
        ? src
        : `data:image/png;base64,${src}`;
      return icon;
    }
    const fallback = document.createElement("span");
    fallback.className = "target-icon fallback";
    fallback.textContent = option?.label?.[0]?.toUpperCase() || "?";
    return fallback;
  }

  function closeTargetPanel() {
    if (!d.targetPanel) {
      return;
    }
    d.targetPanel.classList.add("hidden");
    if (d.targetPanelList) {
      d.targetPanelList.innerHTML = "";
    }
    activeTargetPanelSelect = null;
    activeTargetPanelBack = null;

    if (d.targetPanelBack) {
      d.targetPanelBack.style.display = "none";
      d.targetPanelBack.onclick = null;
    }
  }

  function openTargetPanel(options, selectedValue, selectedKind, onSelect, title = "Select Target", nav = null) {
    if (!d.targetPanel || !d.targetPanelList) {
      return;
    }
    activeTargetPanelSelect = onSelect;
    activeTargetPanelBack = nav && typeof nav === "object" ? (nav.onBack || null) : null;

    if (d.targetPanelBack) {
      if (typeof activeTargetPanelBack === "function") {
        d.targetPanelBack.style.display = "inline-flex";
        d.targetPanelBack.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          activeTargetPanelBack();
        };
      } else {
        d.targetPanelBack.style.display = "none";
        d.targetPanelBack.onclick = null;
      }
    }

    d.targetPanelList.innerHTML = "";
    if (d.targetPanelTitle) {
      d.targetPanelTitle.textContent = title;
    }
    (options || []).forEach((option) => {
      if (option.kind === "divider") {
        const divider = document.createElement("div");
        divider.className = "target-divider";
        divider.textContent = option.label;
        d.targetPanelList.appendChild(divider);
        return;
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "target-option";
      item.appendChild(createTargetIcon(option));
      const label = document.createElement("span");
      label.className = "target-label";
      renderLabelFromRawWithTags(label, {
        rawLabel: option.label,
        extraTags: [],
        truncateMain: false,
      });
      item.appendChild(label);
      item.classList.toggle(
        "selected",
        option.value === selectedValue && option.kind === selectedKind,
      );
      if (option.ghost) {
        item.classList.add("unavailable");
        item.style.opacity = "0.6";
      }

      if (option.kind === "placeholder" || option.disabled) {
        item.disabled = true;
      }
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (activeTargetPanelSelect) {
          const res = activeTargetPanelSelect(option);
          if (res === false) {
            item.classList.toggle("selected");
            return;
          }
        }
        closeTargetPanel();
      });
      d.targetPanelList.appendChild(item);
    });
    d.targetPanel.classList.remove("hidden");
  }

  function buildTargetOptions(currentTarget, isButton = false) {
    const pluginHost = getHost();
    const sessions = getSess();
    const playbackDevices = getPlayback();
    const recordingDevices = getRecording();

    const integration = currentTarget?.Integration || currentTarget?.integration;
    const selectedAppName = currentTarget?.Application?.name || currentTarget?.application?.name;
    const sessionContainer = currentTarget?.Session || currentTarget?.session;
    const selectedSessionId = (sessionContainer && typeof sessionContainer === "object")
      ? (sessionContainer.session_id ?? sessionContainer.sessionId)
      : (sessionContainer != null ? sessionContainer : null);
    const selectedSessionKey = (selectedSessionId != null)
      ? (() => {
        const s = sessions.find((x) => String(x.id) === String(selectedSessionId));
        return s ? normalizeKey(s) : null;
      })()
      : null;
    const selectedDeviceId = currentTarget?.Device?.device_id || currentTarget?.device?.device_id;

    const isUnset = currentTarget == null || currentTarget === "" || currentTarget === "Unset";
    const selectedKind = isUnset
      ? "placeholder"
      : (integration ? "integration-target"
        : (currentTarget?.Session || currentTarget?.session || currentTarget?.Application || currentTarget?.application) ? "session"
          : (currentTarget?.Device || currentTarget?.device) ? "device"
            : (currentTarget === "Master" || currentTarget?.Master != null) ? "master"
              : (currentTarget === "Focus" || currentTarget?.Focus != null) ? "focus"
                : currentTarget === "MediaControl" ? "media-control"
                  : currentTarget === "Hotkey" ? "hotkey-target"
                : "placeholder"
      );

    let selectedValue = "";
    if (selectedKind === "integration-target") selectedValue = targetKey(integration);
    else if (selectedKind === "session") selectedValue = selectedAppName || selectedSessionKey || "";
    else if (selectedKind === "device") selectedValue = selectedDeviceId || "";
    else if (selectedKind === "master" || selectedKind === "focus" || selectedKind === "media-control" || selectedKind === "hotkey-target") selectedValue = selectedKind;
    else if (selectedKind === "placeholder") selectedValue = "placeholder";

    const options = [
      {
        value: "master",
        label: "Master",
        icon_data: masterIconData,
        kind: "master",
      },
      {
        value: "focus",
        label: "Focus",
        icon_data: focusIconData,
        kind: "focus",
      },
    ];

    if (isButton) {
      options.push({
        value: "media-control",
        label: "Media Controls",
        icon_data: mediaPlayPauseIconData,
        kind: "media-control",
      });
      options.push({
        value: "hotkey-target",
        label: "Hotkey",
        icon_data: HOTKEY_ICON_DATA,
        kind: "hotkey-target",
      });
    }

    if (pluginHost) {
      const integrations = pluginHost.getIntegrations();
      if (Array.isArray(integrations) && integrations.length > 0) {
        options.push({ kind: "divider", label: "Integrations" });
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
      options.push({ kind: "divider", label: "Applications" });
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
          icon_data: session.icon_data,
          kind: "session",
        });
      });
    }

    if (selectedAppName && !seen.has(selectedAppName)) {
      if (sessionsAdded.length === 0) {
        options.push({ kind: "divider", label: "Applications" });
      }
      const label = selectedAppName.charAt(0).toUpperCase() + selectedAppName.slice(1);
      options.push({
        value: selectedAppName,
        label: `${label} (Unavailable)`,
        kind: "session",
        ghost: true,
      });
    }

    if (playbackDevices.length > 0) {
      options.push({ kind: "divider", label: "Playback Devices" });
      playbackDevices.forEach((device) => {
        options.push({
          value: `playback:${device.id}`,
          label: device.display_name,
          icon_data: device.icon_data,
          kind: "device",
        });
      });
    }

    if (recordingDevices.length > 0) {
      options.push({ kind: "divider", label: "Recording Devices" });
      recordingDevices.forEach((device) => {
        options.push({
          value: `recording:${device.id}`,
          label: device.display_name,
          icon_data: device.icon_data,
          kind: "device",
        });
      });
    }

    if (selectedDeviceId) {
      const found = options.some((opt) => opt.value === selectedDeviceId);
      if (!found) {
        if (playbackDevices.length === 0 && recordingDevices.length === 0) {
          options.push({ kind: "divider", label: "Devices" });
        }
        options.push({
          value: selectedDeviceId,
          label: "Device (Unavailable)",
          kind: "device",
          ghost: true,
        });
      }
    }

    let activeIntegrationOption = null;
    if (selectedKind === "integration-target" && selectedValue) {
      let label = "Integration Target";
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
          } catch { }
        }

        if (!icon_data || label === "Integration Target") {
          try {
            const fallback = resolveDisplay({ Integration: integration });
            if (fallback?.label) label = fallback.label;
            if (fallback?.icon_data) icon_data = fallback.icon_data;
          } catch { }
        }

        if (!handler) {
          ghost = true;
        }

        if (ghost && label && typeof label === "string" && !label.includes("Unavailable")) {
          label = `${label} (Unavailable)`;
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

  function buildTargetSelect(currentTarget, isBindingButton = false, currentAction = "Volume", currentHotkeyDisplay = "") {
    const container = document.createElement("div");
    container.className = "target-dropdown binding-target-dropdown";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "target-button";

    const display = document.createElement("span");
    display.className = "target-display";

    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "\u25be";

    button.appendChild(display);
    button.appendChild(caret);

    const normalizeTargets = (value) => {
      if (Array.isArray(value)) {
        return value.filter((v) => v && v !== "Unset").slice(0, 8);
      }
      if (value != null && value !== "Unset") {
        return [value];
      }
      return [];
    };

    const targetIdentity = (target) => {
      if (!target) return "";
      if (target === "Master" || target?.Master != null) return "master";
      if (target === "Focus" || target?.Focus != null) return "focus";
      if (target === "MediaControl") return "media-control";
      if (target === "Hotkey") return "hotkey-target";
      const integration = target?.Integration || target?.integration;
      if (integration) {
        return `integration:${targetKey(integration)}`;
      }
      const app = target?.Application || target?.application;
      if (app?.name) return `app:${String(app.name).toLowerCase()}`;
      const session = target?.Session || target?.session;
      if (session?.session_id || session?.sessionId) {
        return `session:${session.session_id ?? session.sessionId}`;
      }
      const device = target?.Device || target?.device;
      if (device?.device_id || device?.deviceId) {
        return `device:${device.device_id ?? device.deviceId}`;
      }
      return JSON.stringify(target);
    };

    let selectedTargets = normalizeTargets(currentTarget);
    let hotkeyDisplay = String(currentHotkeyDisplay || "");
    const targetDisplayCache = new Map();
    let selectedAction = isBindingButton ? (currentAction || "ToggleMute") : "Volume";

    const { options, selectedValue, selectedKind, activeIntegrationOption } = buildTargetOptions(selectedTargets[0] || currentTarget, isBindingButton);
    const placeholderOption = {
      value: "",
      label: "Select an application or device",
      icon_data: null,
      kind: "placeholder",
    };

    const integrationFromTarget = (target) => {
      return target?.Integration || target?.integration || null;
    };

    const actionLabel = (action, target = null) => {
      const integ = integrationFromTarget(target);
      const persistedActionLabel = String(integ?.data?.action_label || "").trim();
      if (persistedActionLabel) return persistedActionLabel;

      // Check if the integration declares a custom label for this action
      if (integ?.integration_id) {
        const pluginHost = getHost();
        const handler = pluginHost?.getIntegration(integ.integration_id);
        if (Array.isArray(handler?.buttonActions)) {
          const match = handler.buttonActions.find((a) => a.value === action);
          if (match?.label) return match.label;
        }
      }
      if (action === "MediaPlayPause") return "Media Play/Pause";
      if (action === "MediaNextTrack") return "Media Next Track";
      if (action === "MediaPrevTrack") return "Media Previous Track";
      if (action === "MediaStop") return "Media Stop";
      if (action === "Hotkey") return "Hotkey";
      if (action === "ToggleMute") return "Toggle Mute";
      if (action === "Volume" && isBindingButton) return "Trigger";
      return action;
    };

    const cachedDisplayForTarget = (target) => {
      const key = targetIdentity(target);
      const cached = targetDisplayCache.get(key);
      if (target === "Hotkey") {
        return {
          label: hotkeyDisplay ? `Hotkey (${hotkeyDisplay})` : "Hotkey (Not Set)",
          icon_data: cached?.icon_data ?? HOTKEY_ICON_DATA,
        };
      }
      const resolved = resolveDisplay(target);
      const merged = {
        label: (resolved?.label || cached?.label || "Target"),
        icon_data: (resolved?.icon_data ?? cached?.icon_data ?? null),
      };
      targetDisplayCache.set(key, merged);
      return merged;
    };

    const renderChip = (target, index) => {
      const displayOption = cachedDisplayForTarget(target);
      const chip = document.createElement("span");
      chip.className = "target-chip";
      chip.dataset.index = String(index);

      const icon = createTargetIcon(displayOption);
      icon.classList.add("target-chip-icon");
      chip.appendChild(icon);

      const label = document.createElement("span");
      label.className = "target-chip-label";
      const actionTags = (isBindingButton && selectedAction)
        ? [actionLabel(selectedAction, target)]
        : [];
      renderLabelFromRawWithTags(label, {
        rawLabel: displayOption.label,
        extraTags: actionTags,
        truncateMain: !isBindingButton,
      });
      chip.appendChild(label);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "target-chip-remove";
      remove.title = "Remove target";
      remove.setAttribute("aria-label", "Remove target");
      remove.textContent = "×";
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const idx = Number(chip.dataset.index);
        if (Number.isNaN(idx)) return;
        selectedTargets = selectedTargets.filter((_, i) => i !== idx);
        syncContainerValue(false);
        container.dispatchEvent(new Event("change"));
      });
      chip.appendChild(remove);
      return chip;
    };

    const setDisplay = () => {
      display.innerHTML = "";
      if (selectedTargets.length === 0) {
        const label = document.createElement("span");
        label.className = "target-placeholder";
        label.textContent = placeholderOption.label;
        display.appendChild(label);
        return;
      }
      const chipsWrap = document.createElement("span");
      chipsWrap.className = "target-chips-wrap";
      if (selectedTargets.length > 1) {
        chipsWrap.classList.add("is-scrollable");
      }
      selectedTargets.forEach((target, index) => {
        chipsWrap.appendChild(renderChip(target, index));
      });
      display.appendChild(chipsWrap);
    };

    const mapOptionToTarget = (option) => {
      if (option && option.target) {
        const t = option.target;
        const integ = t?.Integration || t?.integration;
        if (integ && typeof integ === "object" && integ.integration_id) {
          const next = {
            Integration: {
              integration_id: String(integ.integration_id),
              kind: String(integ.kind || ""),
              data: { ...(integ.data || {}) },
            },
          };
          if (option.label) next.Integration.data.label = String(option.label);
          if (option.icon_data) next.Integration.data.icon_data = option.icon_data;
          if (option.__selectedActionLabel) {
            next.Integration.data.action_label = String(option.__selectedActionLabel);
          }
          if (option.__selectedActionValue) {
            next.Integration.data.action_value = String(option.__selectedActionValue);
          }
          return next;
        }
        return t;
      }
      if (option.kind === "master") {
        return "Master";
      }
      if (option.kind === "focus") {
        return "Focus";
      }
      if (option.kind === "media-control") {
        return "MediaControl";
      }
      if (option.kind === "hotkey-target") {
        return "Hotkey";
      }
      if (option.kind === "device") {
        return { Device: { device_id: option.value } };
      }
      if (option.kind === "session") {
        return { Application: { name: option.value } };
      }
      if (option.kind === "placeholder") {
        return "Unset";
      }
      return selectedTargets[0] || "Unset";
    };

    const syncContainerValue = (markUnavailable = false) => {
      container.__selectedTargets = [...selectedTargets];
      container.__selectedTarget = selectedTargets[0] || "Unset";
      container.value = selectedTargets.length ? targetIdentity(selectedTargets[0]) : "";
      container.dataset.kind = selectedTargets.length ? "multi" : "placeholder";
      container.classList.toggle("target-unavailable", Boolean(markUnavailable));
      container.dataset.action = selectedAction;
      setDisplay();
    };

    const selectOption = (option, actionChoice = null, emit = true) => {
      let nextActionValue = null;
      let nextActionLabel = null;
      if (typeof actionChoice === "string") {
        nextActionValue = actionChoice;
      } else if (actionChoice && typeof actionChoice === "object") {
        nextActionValue = String(actionChoice.value || "");
        nextActionLabel = String(actionChoice.label || "").trim() || null;
      }
      if (nextActionValue) {
        selectedAction = nextActionValue;
      }
      if (nextActionLabel && option && typeof option === "object") {
        option.__selectedActionLabel = nextActionLabel;
      }
      if (nextActionValue && option && typeof option === "object") {
        option.__selectedActionValue = nextActionValue;
      }

      const mapped = mapOptionToTarget(option);
      if (mapped === "Hotkey") {
        selectedAction = "Hotkey";
      }
      const key = targetIdentity(mapped);
      const cachedLabel = String(option?.label || "").trim();
      if (cachedLabel || option?.icon_data) {
        targetDisplayCache.set(key, {
          label: cachedLabel || "Target",
          icon_data: option?.icon_data ?? null,
        });
      }
      const exists = selectedTargets.findIndex((t) => targetIdentity(t) === key);
      if (exists >= 0) {
        selectedTargets.splice(exists, 1);
      } else if (selectedTargets.length < 8) {
        selectedTargets.push(mapped);
      }
      syncContainerValue(Boolean(option.ghost));
      if (emit) container.dispatchEvent(new Event("change"));
    };

    let initial = selectedKind === "placeholder"
      ? placeholderOption
      : options.find((option) => option.value === selectedValue && option.kind === selectedKind);

    if (!initial && activeIntegrationOption) {
      initial = activeIntegrationOption;
    }

    if (!initial) {
      initial = options.find((option) => option.kind !== "divider") || options[0];
    }

    container.dataset.action = selectedAction;
    if (selectedTargets.length === 0 && initial && initial.kind !== "placeholder") {
      selectedTargets = [mapOptionToTarget(initial)];
    }
    syncContainerValue(false);

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const { options } = buildTargetOptions(selectedTargets[0] || currentTarget, isBindingButton);

      const buildButtonActionOptions = (targetOption) => {
        if (targetOption?.kind === "media-control") {
          return [
            { label: "Media Play/Pause", value: "MediaPlayPause", kind: "action", icon_data: mediaPlayPauseIconData },
            { label: "Media Next Track", value: "MediaNextTrack", kind: "action", icon_data: mediaNextTrackIconData },
            { label: "Media Previous Track", value: "MediaPrevTrack", kind: "action", icon_data: mediaPrevTrackIconData },
            { label: "Media Stop", value: "MediaStop", kind: "action", icon_data: mediaStopIconData },
          ];
        }
        if (targetOption?.kind === "master" || targetOption?.kind === "focus") {
          return [{ label: "Toggle Mute", value: "ToggleMute", kind: "action" }];
        }

        // Check per-target buttonActions first (set by plugins in getTargetOptions)
        if (Array.isArray(targetOption?.buttonActions) && targetOption.buttonActions.length > 0) {
          return targetOption.buttonActions.map((a) => ({
            label: a.label || a.value || "Action",
            value: a.value || "Volume",
            kind: "action",
            icon_data: a.icon_data || null,
          }));
        }

        // Then check integration-level buttonActions (set by plugins in registerIntegration)
        const integ = targetOption?.target?.Integration || targetOption?.target?.integration;
        if (integ?.integration_id) {
          const pluginHost = getHost();
          const handler = pluginHost?.getIntegration(integ.integration_id);
          if (Array.isArray(handler?.buttonActions) && handler.buttonActions.length > 0) {
            return handler.buttonActions.map((a) => ({
              label: a.label || a.value || "Action",
              value: a.value || "Volume",
              kind: "action",
              icon_data: a.icon_data || null,
            }));
          }
        }

        // Default fallback for integrations without declared actions
        return [
          { label: "Trigger", value: "Volume", kind: "action" },
          { label: "Toggle Mute", value: "ToggleMute", kind: "action" },
        ];
      };

      const openRootTargetPanel = () => {
        openTargetPanel(
          options,
          null,
          null,
          (targetOption) => {
            if (targetOption.kind === "integration-root") {
              showIntegrationSubmenu(targetOption.value, [], null).catch(() => { });
              return false;
            }

            if (isBindingButton && targetOption.kind !== "hotkey-target") {
              const actionOptions = buildButtonActionOptions(targetOption);
              setTimeout(() => {
                openTargetPanel(actionOptions, selectedAction, "action", (actionOption) => {
                  selectOption(targetOption, actionOption);
                }, "Select Action");
              }, 10);
              return false;
            }

            selectOption(targetOption);
            return true;
          },
          "Select Targets",
        );
      };

      const showIntegrationSubmenu = async (integrationId, navStack = [], navState = null) => {
        const pluginHost = getHost();
        const handler = pluginHost?.getIntegration(integrationId);
        let sub = [];
        try {
          const sessions = getSess();
          const playbackDevices = getPlayback();
          const recordingDevices = getRecording();
          const res = handler?.getTargetOptions?.({
            sessions,
            playbackDevices,
            recordingDevices,
            controlType: isBindingButton ? "button" : "fader",
            nav: navState,
          });
          sub = (res && typeof res.then === "function") ? (await res) : (res || []);
        } catch {
          sub = [];
        }
        if (!Array.isArray(sub) || sub.length === 0) {
          sub = [{
            label: "No targets yet. Connect in Plugins to load targets.",
            value: "",
            kind: "placeholder",
            ghost: true,
          }];
        }

        const subOptions = sub
          .filter((o) => o && typeof o === "object")
          .map((o) => {
            if (o.nav) {
              return {
                label: o.label || "Open",
                icon_data: o.icon_data || handler?.icon_data || null,
                kind: "integration-nav",
                value: JSON.stringify(o.nav),
                nav: o.nav,
              };
            }
            const mapped = {
              label: o.label || "Integration Target",
              icon_data: o.icon_data || handler?.icon_data || null,
              kind: o.kind || "integration-target",
              value: targetKey((o.target?.Integration || o.target?.integration) || {}),
              target: o.target,
            };
            // Carry per-target buttonActions from plugin's getTargetOptions
            if (Array.isArray(o.buttonActions) && o.buttonActions.length > 0) {
              mapped.buttonActions = o.buttonActions;
            }
            return mapped;
          });

        openTargetPanel(
          subOptions,
          null,
          null,
          (opt) => {
            if (opt.kind === "integration-nav") {
              const nextStack = navStack.concat([opt.nav]);
              showIntegrationSubmenu(integrationId, nextStack, opt.nav).catch(() => { });
              return false;
            }

            if (isBindingButton) {
              const actionOptions = buildButtonActionOptions(opt);
              setTimeout(() => {
                openTargetPanel(actionOptions, selectedAction, "action", (actionOption) => {
                  selectOption(opt, actionOption);
                }, "Select Action");
              }, 10);
              return false;
            }

            selectOption(opt);
            return true;
          },
          handler?.name ? `Select ${handler.name} Target` : "Select Integration Target",
          {
            onBack: () => {
              if (navStack.length === 0) {
                openRootTargetPanel();
                return;
              }
              const nextStack = navStack.slice(0, -1);
              const nextNav = nextStack.length > 0 ? nextStack[nextStack.length - 1] : null;
              showIntegrationSubmenu(integrationId, nextStack, nextNav).catch(() => { });
            },
          },
        );
      };

      openRootTargetPanel();
    });

    container.appendChild(button);
    container.setHotkeyDisplay = (nextDisplay = "") => {
      hotkeyDisplay = String(nextDisplay || "");
      setDisplay();
    };
    return container;
  }

  function bindUi() {
    if (d.targetPanel) {
      d.targetPanel.addEventListener("click", (event) => {
        if (event.target === d.targetPanel) {
          closeTargetPanel();
        }
      });
    }
    if (d.targetPanelClose) {
      d.targetPanelClose.addEventListener("click", closeTargetPanel);
    }
  }

  return {
    bindUi,
    closeTargetMenus,
    createTargetIcon,
    openTargetPanel,
    closeTargetPanel,
    buildTargetOptions,
    buildTargetSelect,
  };
}

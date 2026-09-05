import {
  WINDOW_FOCUS_ICON_DATA,
  CAPTURE_ICON_DATA,
  SNIP_ICON_DATA,
  RECORD_ICON_DATA,
  PROFILE_SWITCH_ICON_DATA,
} from "../catalog_presentation.js";
import { BUILT_IN_TARGETS, actionDefinition } from "../../../core/target_model.js";

/** picker workflow. */
export function createPicker({
  elements,
  refreshBrightnessMonitors,
  buildTargetOptions,
  getSess,
  normalizeKey,
  t,
  openTargetPanel,
  callInvoke,
  buildMonitorBrightnessOptions,
  pickOpenApplication,
  closeTargetPanel,
  pickAutoHotkeyScript,
  getHost,
  getPlayback,
  getRecording,
  targetKey,
  buildActionOptionsForTargetOption,
  currentTarget,
  filterPickerOptions,
  includeValueAction,
  isBindingButton,
  overConfigModal,
  selectOption,
  selection,
  stripUnavailableSuffix,
  targetIdentity,
  targetOnly,
}) {
  async function openTargetPicker(event = null) {
    event?.stopPropagation?.();
    elements.targetPanel?.classList.toggle("target-panel--over-config", overConfigModal);
    if (!isBindingButton) await refreshBrightnessMonitors();
    const { options: rawPickerOptions } = buildTargetOptions(
      selection.selectedTargets[0] || currentTarget,
      isBindingButton,
    );
    const options = filterPickerOptions(rawPickerOptions);

    const buildButtonActionOptions = (targetOption) =>
      buildActionOptionsForTargetOption(targetOption, { source: "menu" });

    const buildWindowFocusOptions = () => {
      const seen = new Set();
      return getSess()
        .filter((session) => session && !session.is_master && session.id !== "master")
        .map((session) => {
          const key = normalizeKey(session);
          if (!key || seen.has(key)) return null;
          seen.add(key);
          return {
            value: key,
            label: session.display_name || key,
            display_name: session.display_name || key,
            icon_data: session.icon_data || WINDOW_FOCUS_ICON_DATA,
            kind: "session",
            category: "applications",
            description: t("targets.description.windowFocusApp"),
          };
        })
        .filter(Boolean);
    };

    const captureOptions = () =>
      BUILT_IN_TARGETS.CaptureControl.actions.map((action, index) => ({
        value: action,
        label: t(actionDefinition(action).labelKey),
        kind: "capture-action",
        icon_data: [CAPTURE_ICON_DATA, SNIP_ICON_DATA, RECORD_ICON_DATA][index],
      }));

    const showWindowFocusSubmenu = () => {
      const focusOptions = buildWindowFocusOptions();
      openTargetPanel(
        focusOptions.length > 0
          ? focusOptions
          : [
              {
                value: "",
                label: t("targets.noRunningApplications"),
                kind: "placeholder",
                icon_data: WINDOW_FOCUS_ICON_DATA,
              },
            ],
        null,
        null,
        (option) => {
          if (targetOnly) {
            selectOption(option);
            return;
          }
          selectOption(option, {
            value: "FocusWindow",
            label: t("targets.action.focusWindow"),
          });
        },
        t("targets.windowFocus"),
        { onBack: openRootTargetPanel },
      );
    };

    const showCaptureSubmenu = () => {
      openTargetPanel(
        captureOptions(),
        selection.selectedAction,
        "capture-action",
        (option) => {
          selectOption(option, {
            value: option.value,
            label: option.label,
          });
        },
        t("targets.captureControls"),
        { onBack: openRootTargetPanel },
      );
    };

    const showProfileSubmenu = async () => {
      let profiles = [];
      try {
        profiles = callInvoke ? await callInvoke("list_profiles") : [];
      } catch {
        profiles = [];
      }
      const profileOptions = (Array.isArray(profiles) ? profiles : [])
        .map((profile) => String(profile?.name || "").trim())
        .filter(Boolean)
        .map((name) => ({
          value: name,
          label: name,
          kind: "profile-target",
          icon_data: PROFILE_SWITCH_ICON_DATA,
          target: { Profile: { name } },
        }));
      openTargetPanel(
        profileOptions.length > 0
          ? profileOptions
          : [
              {
                value: "",
                label: t("targets.noProfilesAvailable"),
                kind: "placeholder",
                icon_data: PROFILE_SWITCH_ICON_DATA,
              },
            ],
        String((selection.selectedTargets[0]?.Profile || selection.selectedTargets[0]?.profile)?.name || ""),
        "profile-target",
        (option) => {
          if (option.kind === "placeholder") return false;
          selectOption(option, {
            value: "SwitchProfile",
            label: t("targets.switchProfile"),
          });
          return true;
        },
        t("targets.selectProfile"),
        { onBack: openRootTargetPanel },
      );
    };

    const showMonitorBrightnessSubmenu = () => {
      const brightness =
        selection.selectedTargets[0]?.MonitorBrightness || selection.selectedTargets[0]?.monitorBrightness;
      const monitorId =
        brightness && typeof brightness === "object"
          ? String(brightness.monitor_id ?? brightness.monitorId ?? "").trim()
          : "";
      openTargetPanel(
        buildMonitorBrightnessOptions(),
        monitorId ? `monitor-brightness:${monitorId}` : "monitor-brightness",
        "monitor-brightness",
        (option) => {
          selectOption(option);
          return true;
        },
        t("targets.monitorBrightness"),
        { onBack: openRootTargetPanel },
      );
    };

    const openRootTargetPanel = () => {
      openTargetPanel(
        options,
        null,
        null,
        (targetOption) => {
          if (targetOption.kind === "integration-root") {
            showIntegrationSubmenu(targetOption.value, [], null).catch(() => {});
            return false;
          }

          if (targetOption.kind === "action-root" && targetOption.value === "window-focus") {
            showWindowFocusSubmenu();
            return false;
          }

          if (targetOption.kind === "action-root" && targetOption.value === "capture") {
            if (targetOnly) {
              selectOption({
                value: "capture-control",
                label: t("targets.captureControls"),
                kind: "capture-control",
                icon_data: CAPTURE_ICON_DATA,
              });
              return true;
            }
            showCaptureSubmenu();
            return false;
          }

          if (targetOption.kind === "profile-switch-root") {
            showProfileSubmenu().catch(() => {});
            return false;
          }

          if (targetOption.kind === "monitor-brightness-root") {
            showMonitorBrightnessSubmenu();
            return false;
          }

          if (isBindingButton && targetOption.kind === "macro-target") {
            selectOption(targetOption, {
              value: "Macro",
              label: "Macro",
            });
            return true;
          }

          if (isBindingButton && targetOption.kind === "soundboard-target") {
            selectOption(targetOption, {
              value: "Soundboard",
              label: t("soundboard.title"),
            });
            return true;
          }

          if (isBindingButton && targetOption.kind === "open-application-target") {
            (async () => {
              try {
                const openApplication = await pickOpenApplication();
                if (!openApplication) return;
                selectOption(targetOption, {
                  value: "OpenApplication",
                  label: t("targets.openApplication"),
                  openApplication,
                });
                closeTargetPanel();
              } catch {}
            })();
            return false;
          }

          if (isBindingButton && targetOption.kind === "autohotkey-script-target") {
            (async () => {
              try {
                const autoHotkeyScript = await pickAutoHotkeyScript();
                if (!autoHotkeyScript) return;
                selectOption(targetOption, {
                  value: "RunAutoHotkeyScript",
                  label: t("targets.autoHotkeyScript"),
                  autoHotkeyScript,
                });
                closeTargetPanel();
              } catch {}
            })();
            return false;
          }

          if (isBindingButton && targetOnly) {
            selectOption(targetOption);
            return true;
          }

          if (isBindingButton && targetOption.kind !== "hotkey-target") {
            return chooseButtonTarget(targetOption, openRootTargetPanel);
          }

          selectOption(targetOption);
          return true;
        },
        t("targets.selectTargets"),
      );
    };

    const chooseButtonTarget = (targetOption, onBack = openRootTargetPanel) => {
      (async () => {
        const actionOptions = await buildButtonActionOptions(targetOption);
        if (actionOptions.length === 0) {
          selectOption(targetOption);
          closeTargetPanel();
          return;
        }
        openTargetPanel(
          actionOptions,
          selection.selectedAction,
          "action",
          (actionOption) => {
            selectOption(targetOption, actionOption);
          },
          t("targets.selectAction"),
          { onBack },
        );
      })();
      return false;
    };

    const showIntegrationSubmenu = async (integrationId, navStack = [], navState = null) => {
      const pluginHost = getHost();
      const handler = pluginHost?.getIntegration(integrationId);
      const loadSubOptions = async (controlType) => {
        const sessions = getSess();
        const playbackDevices = getPlayback();
        const recordingDevices = getRecording();
        try {
          const res = handler?.getTargetOptions?.({
            sessions,
            playbackDevices,
            recordingDevices,
            controlType,
            nav: navState,
          });
          const loaded = res && typeof res.then === "function" ? await res : res || [];
          return Array.isArray(loaded) ? loaded : [];
        } catch {
          return [];
        }
      };

      const mapIntegrationOption = (o) => {
        if (!o || typeof o !== "object") return null;
        if (o.nav) {
          return {
            label: o.label || t("common.open"),
            icon_data: o.icon_data || handler?.icon_data || null,
            kind: "integration-nav",
            value: JSON.stringify(o.nav),
            nav: o.nav,
            category: "integrations",
            integrationId,
            description: o.description || null,
            tags: Array.isArray(o.tags) ? o.tags : [],
          };
        }
        const mapped = {
          label: o.label || t("targets.integrationTarget"),
          icon_data: o.icon_data || handler?.icon_data || null,
          kind: o.kind || "integration-target",
          value: targetKey(o.target?.Integration || o.target?.integration || {}),
          target: o.target,
          category: o.category || "integrations",
          integrationId,
          description: o.description || null,
          tags: Array.isArray(o.tags) ? o.tags : [],
          suppressUnavailableTag: Boolean(o.suppressUnavailableTag),
        };
        // Carry per-target buttonActions from plugin's getTargetOptions.
        if (Array.isArray(o.buttonActions) && o.buttonActions.length > 0) {
          mapped.buttonActions = o.buttonActions;
        }
        return mapped;
      };

      const labelKey = (option) =>
        stripUnavailableSuffix(option?.label || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      let buttonSub = await loadSubOptions(isBindingButton ? "button" : "fader");
      let faderSub = isBindingButton && includeValueAction ? await loadSubOptions("fader") : [];

      if (
        (!Array.isArray(buttonSub) || buttonSub.length === 0) &&
        (!Array.isArray(faderSub) || faderSub.length === 0)
      ) {
        let isDisconnected = true;
        try {
          const desc = handler?.describeTarget?.({});
          if (desc && typeof desc.ghost === "boolean") {
            isDisconnected = desc.ghost;
          }
        } catch {}
        buttonSub = [
          {
            label: isDisconnected ? t("targets.integrationNotConnected") : t("targets.noCompatibleTargets"),
            value: "",
            kind: "placeholder",
            ghost: true,
            icon_data: handler?.icon_data || null,
            category: "integrations",
            integrationId,
            suppressUnavailableTag: true,
          },
        ];
      }

      const buttonOptions = (Array.isArray(buttonSub) ? buttonSub : [])
        .map(mapIntegrationOption)
        .filter(Boolean);
      const faderOptions = (Array.isArray(faderSub) ? faderSub : [])
        .map(mapIntegrationOption)
        .filter(Boolean);
      const faderByKey = new Map();
      const faderByLabel = new Map();
      faderOptions.forEach((option) => {
        if (!option?.target) return;
        const key = targetIdentity(option.target);
        if (!key) return;
        option.__valueCapable = true;
        faderByKey.set(key, option);
        const normalizedLabel = labelKey(option);
        if (normalizedLabel && !faderByLabel.has(normalizedLabel)) {
          faderByLabel.set(normalizedLabel, option);
        }
      });

      const matchedFaderKeys = new Set();
      const subOptions = [];
      buttonOptions.forEach((option) => {
        if (option.kind === "integration-nav" && includeValueAction) {
          const matchingFader = faderByLabel.get(labelKey(option));
          if (matchingFader) {
            const key = targetIdentity(matchingFader.target);
            matchedFaderKeys.add(key);
            subOptions.push({
              ...matchingFader,
              description: option.description || matchingFader.description,
              tags: Array.isArray(option.tags) && option.tags.length > 0 ? option.tags : matchingFader.tags,
              macroActionNav: option.nav,
              __valueCapable: true,
            });
            return;
          }
        }

        if (option.target) {
          const key = targetIdentity(option.target);
          if (faderByKey.has(key)) {
            option.__valueCapable = true;
            matchedFaderKeys.add(key);
          }
        }
        subOptions.push(option);
      });
      faderOptions.forEach((option) => {
        if (!option?.target) return;
        const key = targetIdentity(option.target);
        if (!key || matchedFaderKeys.has(key)) return;
        subOptions.push(option);
      });
      if (subOptions.length === 0) {
        const placeholder =
          buttonOptions.find((option) => option?.kind === "placeholder") ||
          faderOptions.find((option) => option?.kind === "placeholder");
        if (placeholder) subOptions.push(placeholder);
      }

      openTargetPanel(
        subOptions,
        null,
        null,
        (opt) => {
          if (opt.kind === "integration-nav") {
            const nextStack = navStack.concat([opt.nav]);
            showIntegrationSubmenu(integrationId, nextStack, opt.nav).catch(() => {});
            return false;
          }

          if (isBindingButton && targetOnly) {
            selectOption(opt);
            return true;
          }

          if (isBindingButton) {
            return chooseButtonTarget(opt, () => {
              showIntegrationSubmenu(integrationId, navStack, navState).catch(() => {});
            });
          }

          selectOption(opt);
          return true;
        },
        handler?.name
          ? t("targets.selectNamedTarget", { name: handler.name })
          : t("targets.selectIntegrationTarget"),
        {
          integrationId,
          refresh: () => showIntegrationSubmenu(integrationId, navStack, navState).catch(() => {}),
          onBack: () => {
            if (navStack.length === 0) {
              openRootTargetPanel();
              return;
            }
            const nextStack = navStack.slice(0, -1);
            const nextNav = nextStack.length > 0 ? nextStack[nextStack.length - 1] : null;
            showIntegrationSubmenu(integrationId, nextStack, nextNav).catch(() => {});
          },
        },
      );
    };

    openRootTargetPanel();
  }

  return { openTargetPicker };
}

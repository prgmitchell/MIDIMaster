import { createTargetDropdown } from "./controllers/target_dropdown.js";
import { createDiscovery } from "./controllers/discovery.js";
import { createPanel } from "./controllers/panel.js";
import { createPanelMetadata } from "./controllers/panel_metadata.js";
import { createIcons } from "./controllers/icons.js";
import { createApplicationTargets } from "./controllers/application_targets.js";
import { createBrightness } from "./controllers/brightness.js";

export function createTargetsFeature({
  invoke,
  i18n,
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
  const elements = dom && typeof dom === "object" ? dom : {};
  const getHost = typeof getPluginHost === "function" ? getPluginHost : () => null;
  const getSess = typeof getSessions === "function" ? getSessions : () => [];
  const getPlayback = typeof getPlaybackDevices === "function" ? getPlaybackDevices : () => [];
  const getRecording = typeof getRecordingDevices === "function" ? getRecordingDevices : () => [];
  const normalizeKey = typeof normalizeSessionKey === "function" ? normalizeSessionKey : () => "";
  const targetKey = typeof integrationTargetKey === "function" ? integrationTargetKey : () => "";
  const resolveDisplay = typeof resolveOsdTarget === "function" ? resolveOsdTarget : () => null;
  const callInvoke = typeof invoke === "function" ? invoke : null;
  const t = (key, params = {}) =>
    i18n && typeof i18n.t === "function" ? i18n.t(key, params) : String(key || "");

  const panelState = {
    activeTargetPanelSelect: null,
    activeTargetPanelBack: null,
    activeTargetPanelIntegrationId: null,
    activeTargetPanelRefresh: null,
  };

  const discovery = {
    brightnessMonitors: [],
    brightnessMonitorRequest: null,
  };

  let uiBound = false;

  function onTargetPanelClick(event) {
    if (event.target === elements.targetPanel) closeTargetPanel();
  }

  function onTargetPanelKeydown(event) {
    if (
      event.key !== "Escape" ||
      !elements.targetPanel ||
      elements.targetPanel.classList.contains("hidden")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeTargetPanel();
  }

  function onIntegrationTargetsChanged(event) {
    const integrationId = String(event?.detail?.integrationId || event?.detail?.integration_id || "");
    if (!integrationId || integrationId !== panelState.activeTargetPanelIntegrationId) return;
    panelState.activeTargetPanelRefresh?.();
  }

  function bindUi() {
    if (uiBound) return;
    uiBound = true;
    elements.targetPanel?.addEventListener("click", onTargetPanelClick);
    elements.targetPanelClose?.addEventListener("click", closeTargetPanel);
    window.addEventListener("keydown", onTargetPanelKeydown, true);
    window.addEventListener("midimaster:integration-targets-changed", onIntegrationTargetsChanged);
  }

  function start() {
    return refreshBrightnessMonitors();
  }

  function dispose() {
    if (!uiBound) return;
    uiBound = false;
    elements.targetPanel?.removeEventListener("click", onTargetPanelClick);
    elements.targetPanelClose?.removeEventListener("click", closeTargetPanel);
    window.removeEventListener("keydown", onTargetPanelKeydown, true);
    window.removeEventListener("midimaster:integration-targets-changed", onIntegrationTargetsChanged);
    closeTargetPanel();
  }

  const { refreshBrightnessMonitors, buildMonitorBrightnessOptions } = createBrightness({
    callInvoke,
    discovery,
    t,
  });

  const {
    normalizeOpenApplication,
    normalizeAutoHotkeyScript,
    displayNameFromPath,
    friendlyAppName,
    normalizeCompareName,
    resolveOpenApplicationIcon,
    exeNameFromPath,
    processTagForSession,
    pickOpenApplication,
    pickAutoHotkeyScript,
  } = createApplicationTargets({
    callInvoke,
    getSess,
  });

  const {
    mediaIconForAction,
    mediaActionOptions,
    closeTargetMenus,
    systemTargetIconKind,
    createSystemTargetIcon,
    createFallbackTargetIcon,
    createTargetIcon,
  } = createIcons({
    focusIconData,
    masterIconData,
    mediaNextTrackIconData,
    mediaPlayPauseIconData,
    mediaPrevTrackIconData,
    mediaStopIconData,
    t,
  });

  const {
    categoryLabel,
    targetPanelParts,
    categoryForOption,
    descriptionForOption,
    tagsForOption,
    optionSearchText,
    normalizePanelOptions,
    categorySvg,
    createCategoryIcon,
  } = createPanelMetadata({ elements, t });

  const { closeTargetPanel, openTargetPanel } = createPanel({
    categoryLabel: (...args) => categoryLabel(...args),
    createCategoryIcon: (...args) => createCategoryIcon(...args),
    createTargetIcon: (...args) => createTargetIcon(...args),
    elements,
    normalizePanelOptions: (...args) => normalizePanelOptions(...args),
    panelState,
    t,
    targetPanelParts: (...args) => targetPanelParts(...args),
  });

  const { buildTargetOptions } = createDiscovery({
    focusIconData,
    getHost,
    getPlayback,
    getRecording,
    getSess,
    masterIconData,
    mediaPlayPauseIconData,
    normalizeKey,
    processTagForSession: (...args) => processTagForSession(...args),
    resolveDisplay,
    t,
    targetKey,
  });

  const { buildTargetSelect } = createTargetDropdown({
    buildMonitorBrightnessOptions: (...args) => buildMonitorBrightnessOptions(...args),
    buildTargetOptions: (...args) => buildTargetOptions(...args),
    callInvoke,
    closeTargetPanel: (...args) => closeTargetPanel(...args),
    createTargetIcon: (...args) => createTargetIcon(...args),
    elements,
    displayNameFromPath: (...args) => displayNameFromPath(...args),
    focusIconData,
    friendlyAppName: (...args) => friendlyAppName(...args),
    getHost,
    getPlayback,
    getRecording,
    getSess,
    masterIconData,
    mediaActionOptions: (...args) => mediaActionOptions(...args),
    mediaPlayPauseIconData,
    normalizeAutoHotkeyScript: (...args) => normalizeAutoHotkeyScript(...args),
    normalizeKey,
    normalizeOpenApplication: (...args) => normalizeOpenApplication(...args),
    openTargetPanel: (...args) => openTargetPanel(...args),
    pickAutoHotkeyScript: (...args) => pickAutoHotkeyScript(...args),
    pickOpenApplication: (...args) => pickOpenApplication(...args),
    refreshBrightnessMonitors: (...args) => refreshBrightnessMonitors(...args),
    resolveDisplay,
    resolveOpenApplicationIcon: (...args) => resolveOpenApplicationIcon(...args),
    t,
    targetKey,
  });

  return {
    bindUi,
    start,
    dispose,
    closeTargetMenus,
    createTargetIcon,
    openTargetPanel,
    closeTargetPanel,
    buildTargetOptions,
    buildMonitorBrightnessOptions,
    buildTargetSelect,
  };
}

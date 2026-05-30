export function createDomRefs() {
  const midiSelect = document.getElementById("midi-device");
  const midiOutputSelect = document.getElementById("midi-output-device");
  const midiStatus = document.getElementById("midi-status");
  const sessionsContainer = document.getElementById("sessions");
  const profileDropdown = document.getElementById("profiles-dropdown");
  const profileToggle = document.getElementById("profile-toggle");
  const profileCurrent = document.getElementById("profile-current");
  const profileList = document.getElementById("profile-list");
  const profilePageList = document.getElementById("profile-page-list");
  const profilePageCreateInput = document.getElementById("profile-page-create-input");
  const profilePageCreateButton = document.getElementById("profile-page-create-button");
  const profilePageImportButton = document.getElementById("profile-page-import");
  const profilePageExportCurrentButton = document.getElementById("profile-page-export-current");
  const bindingsContainer = document.getElementById("bindings");
  const bindingTypeFilter = document.getElementById("binding-type-filter");
  const bindingTypeFilterButton = document.getElementById("binding-type-filter-button");
  const bindingTypeFilterCurrent = document.getElementById("binding-type-filter-current");
  const bindingTypeFilterMenu = document.getElementById("binding-type-filter-menu");
  const bindingSearchInput = document.getElementById("binding-search");
  const mainScreen = document.getElementById("main-screen");
  const appShell = document.querySelector(".app-shell");
  const sidebarNav = document.querySelector(".sidebar-nav");
  const sidebarCollapseToggle = document.getElementById("sidebar-collapse-toggle");
  const appPages = Array.from(document.querySelectorAll("[data-page-panel]"));
  const appNavItems = Array.from(document.querySelectorAll("[data-page]"));
  const targetPanel = document.getElementById("target-panel");
  const targetPanelList = document.getElementById("target-panel-list");
  const targetPanelTitle = document.getElementById("target-panel-title");
  const targetPanelClose = document.getElementById("target-panel-close");
  const targetPanelBack = document.getElementById("target-panel-back");
  const bindingConfigPanel = document.getElementById("binding-config-panel");
  const bindingConfigTitle = document.getElementById("binding-config-title");
  const bindingConfigClose = document.getElementById("binding-config-close");
  const bindingConfigCancel = document.getElementById("binding-config-cancel");
  const bindingConfigSave = document.getElementById("binding-config-save");
  const bindingConfigName = document.getElementById("binding-config-name");
  const bindingConfigButtonLightSection = document.getElementById("binding-config-button-light-section");
  const bindingConfigButtonLightToggle = document.getElementById("binding-config-button-light-toggle");
  const bindingConfigButtonLightHelp = document.getElementById("binding-config-button-light-help");
  const bindingConfigButtonLearnSection = document.getElementById("binding-config-button-learn-section");
  const bindingConfigButtonLearnButton = document.getElementById("binding-config-button-learn-button");
  const bindingConfigButtonLearnIndicator = document.getElementById("binding-config-button-learn-indicator");
  const bindingConfigButtonLearnStatus = document.getElementById("binding-config-button-learn-status");
  const bindingConfigCurveSection = document.getElementById("binding-config-curve-section");
  const bindingConfigMuteSection = document.getElementById("binding-config-mute-section");
  const bindingConfigAssignSection = document.getElementById("binding-config-assign-section");
  const bindingConfigMuteLabel = document.getElementById("binding-config-mute-label");
  const bindingConfigMuteLearn = document.getElementById("binding-config-mute-learn");
  const bindingConfigMuteClear = document.getElementById("binding-config-mute-clear");
  const bindingConfigMuteModeRoot = document.getElementById("binding-config-mute-mode-root");
  const bindingConfigMuteModeButton = document.getElementById("binding-config-mute-mode-button");
  const bindingConfigMuteModeMenu = document.getElementById("binding-config-mute-mode-menu");
  const bindingConfigMuteModeToggle = document.getElementById("binding-config-mute-mode-toggle");
  const bindingConfigMuteModeValue = document.getElementById("binding-config-mute-mode-value");
  const bindingConfigAssignLabel = document.getElementById("binding-config-assign-label");
  const bindingConfigAssignLearn = document.getElementById("binding-config-assign-learn");
  const bindingConfigAssignClear = document.getElementById("binding-config-assign-clear");
  const bindingConfigAssignModeRoot = document.getElementById("binding-config-assign-mode-root");
  const bindingConfigAssignModeButton = document.getElementById("binding-config-assign-mode-button");
  const bindingConfigAssignModeMenu = document.getElementById("binding-config-assign-mode-menu");
  const bindingConfigAssignModeAdd = document.getElementById("binding-config-assign-mode-add");
  const bindingConfigAssignModeReplace = document.getElementById("binding-config-assign-mode-replace");
  const bindingConfigCurveCards = document.getElementById("binding-config-curve-cards");
  const bindingConfigCurveHelp = document.getElementById("binding-config-curve-help");
  const bindingConfigCustomEditor = document.getElementById("binding-config-custom-editor");
  const bindingConfigCustomSurface = document.getElementById("binding-config-custom-surface");
  const bindingConfigCustomReset = document.getElementById("binding-config-custom-reset");
  const bindingConfigAssignHelp = document.getElementById("binding-config-assign-help");
  const bindingConfigPreviewLearnShell = document.getElementById("binding-config-preview-learn-shell");
  const bindingConfigPreviewLearnButton = document.getElementById("binding-config-preview-learn-button");
  const bindingConfigPreviewLearnIndicator = document.getElementById("binding-config-preview-learn-indicator");
  const bindingConfigPreviewLearnStatus = document.getElementById("binding-config-preview-learn-status");
  const bindingConfigPreviewTargetIcon = document.getElementById("binding-config-preview-target-icon");
  const bindingConfigPreviewTargetLabel = document.getElementById("binding-config-preview-target-label");
  const bindingConfigPreviewTargetTags = document.getElementById("binding-config-preview-target-tags");
  const bindingConfigPreviewFill = document.getElementById("binding-config-preview-fill");
  const bindingConfigPreviewThumb = document.getElementById("binding-config-preview-thumb");
  const bindingConfigPreviewButton = document.getElementById("binding-config-preview-button");
  const bindingConfigPreviewButtonFace = document.getElementById("binding-config-preview-button-face");
  const bindingConfigPreviewButtonLabel = document.getElementById("binding-config-preview-button-label");
  const bindingConfigPreviewValue = document.getElementById("binding-config-preview-value");
  const bindingConfigPreviewStatus = document.getElementById("binding-config-preview-status");
  const bindingConfigPreviewMainMidi = document.getElementById("binding-config-preview-main-midi");
  const bindingConfigPreviewMuteRow = document.getElementById("binding-config-preview-mute-row");
  const bindingConfigPreviewMute = document.getElementById("binding-config-preview-mute");
  const bindingConfigPreviewAssignRow = document.getElementById("binding-config-preview-assign-row");
  const bindingConfigPreviewAssign = document.getElementById("binding-config-preview-assign");
  const bindingConfigPreviewCurveRow = document.getElementById("binding-config-preview-curve-row");
  const bindingConfigPreviewCurve = document.getElementById("binding-config-preview-curve");
  const bindingConfigPreviewLightRow = document.getElementById("binding-config-preview-light-row");
  const bindingConfigPreviewLight = document.getElementById("binding-config-preview-light");
  const bindingConfigPreviewMidiValue = document.getElementById("binding-config-preview-midi-value");
  
  // Defensive cleanup for older builds that injected extra back buttons.
  try {
    const header = targetPanelTitle?.closest?.(".target-panel-header");
    if (header) {
      header.querySelectorAll(".target-panel-back").forEach((btn) => {
        if (btn.id !== "target-panel-back") {
          btn.remove();
        }
      });
      // Flatten any nested header-left wrappers.
      const left = header.querySelector(".target-panel-header-left");
      if (left) {
        left.querySelectorAll(".target-panel-header-left").forEach((inner) => {
          if (inner === left) return;
          while (inner.firstChild) {
            left.appendChild(inner.firstChild);
          }
          inner.remove();
        });
        if (targetPanelBack && targetPanelBack.parentElement !== left) {
          left.insertBefore(targetPanelBack, left.firstChild);
        }
        if (targetPanelTitle && targetPanelTitle.parentElement !== left) {
          left.appendChild(targetPanelTitle);
        }
      }
    }
  } catch (e) {
    // ignore
  }
  const learnPanel = document.getElementById("learn-panel");
  const learnPanelTitle = document.getElementById("learn-panel-title");
  const learnPanelMessage = document.getElementById("learn-panel-message");
  const learnPanelSpinner = document.getElementById("learn-panel-spinner");
  const learnPanelActions = document.getElementById("learn-panel-actions");
  const learnPanelCancel = document.getElementById("learn-panel-cancel");
  const learnPanelConfirm = document.getElementById("learn-panel-confirm");
  const learnPanelClose = document.getElementById("learn-panel-close");
  const settingsButton = document.getElementById("settings-button");
  const themeToggleButton = document.getElementById("theme-toggle-button");
  const topbarUpdateButton = document.getElementById("topbar-update-button");
  const settingsPanel = document.getElementById("settings-panel");
  const settingsPanelClose = document.getElementById("settings-panel-close");
  const connectionsButton = document.getElementById("connections-button");
  const connectionsPanel = document.getElementById("connections-panel");
  const connectionsPanelClose = document.getElementById("connections-panel-close");
  const connectionsSidebar = document.getElementById("connections-sidebar");
  const connectionsContent = document.getElementById("connections-content");
  const osdEnabledToggle = document.getElementById("osd-enabled");
  const osdMonitorSelect = document.getElementById("osd-monitor");
  const osdStyleSelect = document.getElementById("osd-style");
  const osdTransparencyInput = document.getElementById("osd-transparency");
  const osdTransparencyValue = document.getElementById("osd-transparency-value");
  const osdScaleInput = document.getElementById("osd-scale");
  const osdScaleValue = document.getElementById("osd-scale-value");
  const osdPositionPicker = document.getElementById("osd-position-picker");
  const startWithWindowsSelect = document.getElementById("start-with-windows");
  const startInTraySelect = document.getElementById("start-in-tray");
  const minimizeToTraySelect = document.getElementById("minimize-to-tray");
  const exitToTraySelect = document.getElementById("exit-to-tray");
  const languageSelect = document.getElementById("language-select");
  const autoCheckUpdatesButton = document.getElementById("auto-check-updates-button");
  const openLogsFolderButton = document.getElementById("open-logs-folder");
  const resetAppDataButton = document.getElementById("reset-app-data");
  const checkForUpdatesButton = document.getElementById("check-for-updates");
  const settingsUpdateStatus = document.getElementById("settings-update-status");
  const updateCurrentVersion = document.getElementById("update-current-version");
  const updateLatestVersion = document.getElementById("update-latest-version");
  const sidebarAppVersion = document.getElementById("sidebar-app-version");
  const osd = document.getElementById("volume-osd");
  // OSD elements are now dynamic
  const alertOverlay = document.getElementById("alert-overlay");
  const alertTitle = document.getElementById("alert-title");
  const alertMessage = document.getElementById("alert-message");
  const alertClose = document.getElementById("alert-close");
  const alertSecondary = document.getElementById("alert-secondary");
  const alertCancel = document.getElementById("alert-cancel");
  const alertOk = document.getElementById("alert-ok");

  return {
    midiSelect,
    midiOutputSelect,
    midiStatus,
    sessionsContainer,
    profileDropdown,
    profileToggle,
    profileCurrent,
    profileList,
    profilePageList,
    profilePageCreateInput,
    profilePageCreateButton,
    profilePageImportButton,
    profilePageExportCurrentButton,
    bindingsContainer,
    bindingTypeFilter,
    bindingTypeFilterButton,
    bindingTypeFilterCurrent,
    bindingTypeFilterMenu,
    bindingSearchInput,
    mainScreen,
    appShell,
    sidebarNav,
    sidebarCollapseToggle,
    appPages,
    appNavItems,
    targetPanel,
    targetPanelList,
    targetPanelTitle,
    targetPanelClose,
    targetPanelBack,
    bindingConfigPanel,
    bindingConfigTitle,
    bindingConfigClose,
    bindingConfigCancel,
    bindingConfigSave,
    bindingConfigName,
    bindingConfigButtonLightSection,
    bindingConfigButtonLightToggle,
    bindingConfigButtonLightHelp,
    bindingConfigButtonLearnSection,
    bindingConfigButtonLearnButton,
    bindingConfigButtonLearnIndicator,
    bindingConfigButtonLearnStatus,
    bindingConfigCurveSection,
    bindingConfigMuteSection,
    bindingConfigAssignSection,
    bindingConfigMuteLabel,
    bindingConfigMuteLearn,
    bindingConfigMuteClear,
    bindingConfigMuteModeRoot,
    bindingConfigMuteModeButton,
    bindingConfigMuteModeMenu,
    bindingConfigMuteModeToggle,
    bindingConfigMuteModeValue,
    bindingConfigAssignLabel,
    bindingConfigAssignLearn,
    bindingConfigAssignClear,
    bindingConfigAssignModeRoot,
    bindingConfigAssignModeButton,
    bindingConfigAssignModeMenu,
    bindingConfigAssignModeAdd,
    bindingConfigAssignModeReplace,
    bindingConfigCurveCards,
    bindingConfigCurveHelp,
    bindingConfigCustomEditor,
    bindingConfigCustomSurface,
    bindingConfigCustomReset,
    bindingConfigAssignHelp,
    bindingConfigPreviewLearnShell,
    bindingConfigPreviewLearnButton,
    bindingConfigPreviewLearnIndicator,
    bindingConfigPreviewLearnStatus,
    bindingConfigPreviewTargetIcon,
    bindingConfigPreviewTargetLabel,
    bindingConfigPreviewTargetTags,
    bindingConfigPreviewFill,
    bindingConfigPreviewThumb,
    bindingConfigPreviewButton,
    bindingConfigPreviewButtonFace,
    bindingConfigPreviewButtonLabel,
    bindingConfigPreviewValue,
    bindingConfigPreviewStatus,
    bindingConfigPreviewMainMidi,
    bindingConfigPreviewMuteRow,
    bindingConfigPreviewMute,
    bindingConfigPreviewAssignRow,
    bindingConfigPreviewAssign,
    bindingConfigPreviewCurveRow,
    bindingConfigPreviewCurve,
    bindingConfigPreviewLightRow,
    bindingConfigPreviewLight,
    bindingConfigPreviewMidiValue,
    learnPanel,
    learnPanelTitle,
    learnPanelMessage,
    learnPanelSpinner,
    learnPanelActions,
    learnPanelCancel,
    learnPanelConfirm,
    learnPanelClose,
    settingsButton,
    themeToggleButton,
    topbarUpdateButton,
    settingsPanel,
    settingsPanelClose,
    connectionsButton,
    connectionsPanel,
    connectionsPanelClose,
    connectionsSidebar,
    connectionsContent,
    osdEnabledToggle,
    osdMonitorSelect,
    osdStyleSelect,
    osdTransparencyInput,
    osdTransparencyValue,
    osdScaleInput,
    osdScaleValue,
    osdPositionPicker,
    startWithWindowsSelect,
    startInTraySelect,
    minimizeToTraySelect,
    exitToTraySelect,
    languageSelect,
    autoCheckUpdatesButton,
    openLogsFolderButton,
    resetAppDataButton,
    checkForUpdatesButton,
    settingsUpdateStatus,
    updateCurrentVersion,
    updateLatestVersion,
    sidebarAppVersion,
    osd,
    alertOverlay,
    alertTitle,
    alertMessage,
    alertClose,
    alertSecondary,
    alertCancel,
    alertOk,
  };
}

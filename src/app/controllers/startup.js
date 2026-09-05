import { t, initI18n, applyTranslations } from "../i18n.js";
import { performanceAudit } from "../performance_audit_api.js";
import { hasMidiPreference } from "../../core/midi_preferences.js";
import { scheduleRetry } from "../bootstrap.js";

/** startup workflow. */
export function createStartup({
  applyGlobalAppearance,
  applyOsdAppearanceAttributes,
  bindSystemAppearanceListener,
  bindTauriApi,
  clientPreferences,
  diagnosticError,
  diagnosticInfo,
  features,
  getSavedMidiDeviceIds,
  hydrateClientPreferences,
  invoke,
  loadStoredAppearance,
  mainScreen,
  maybePromptMidiDeviceInventoryConsent,
  midiStatus,
  osdState,
  profileState,
  queueMidiDeviceInventorySubmit,
  recordPerformanceResult,
  requestBindingsRerender,
  settingsStore,
  setupListeners,
  showAlert,
  showUpdateAvailableDialog,
  startupState,
  viewState,
}) {
  function getStartupProfileName() {
    try {
      return (
        String(
          localStorage.getItem("activeProfileName") ||
            clientPreferences.persistedActiveProfileName ||
            "Default",
        ).trim() || "Default"
      );
    } catch {
      return String(clientPreferences.persistedActiveProfileName || "Default").trim() || "Default";
    }
  }

  function applyCurrentOsdAppearance() {
    document.body.setAttribute("data-anchor", osdState.settings.anchor || "top-right");
    applyOsdAppearanceAttributes(osdState.settings);
  }

  async function loadStartupProfile(preferredName) {
    const startupProfileOptions = {
      applyOsd: false,
      persistActiveProfile: false,
      render: false,
      startPlugins: false,
      syncMidi: false,
    };
    const names = [preferredName, "Default"]
      .map((name) => String(name || "").trim())
      .filter(Boolean)
      .filter((name, index, list) => list.indexOf(name) === index);

    for (const name of names) {
      try {
        await features.profiles.loadProfileByName(name, startupProfileOptions);
        return true;
      } catch (error) {
        diagnosticError(`startup_load_profile_failed_${name === "Default" ? "default" : "preferred"}`, error);
      }
    }

    try {
      profileState.bindings = [];
    } catch (error) {
      diagnosticError("startup_empty_bindings_render_failed", error);
    }
    return false;
  }

  function storageRecoveryStoreLabel(notices) {
    const stores = new Set(notices.map((notice) => String(notice?.store || "")));
    if (stores.has("profiles") && stores.has("app_settings")) {
      return t("storage.profilesAndSettings");
    }
    if (stores.has("profiles")) {
      return t("storage.profiles");
    }
    return t("storage.appSettings");
  }

  async function showStorageRecoveryNotices() {
    try {
      const notices = await invoke("take_storage_recovery_notices");
      if (!Array.isArray(notices) || notices.length === 0) {
        return;
      }

      const stores = storageRecoveryStoreLabel(notices);
      const quarantinedPaths = Array.from(
        new Set(
          notices.flatMap((notice) =>
            Array.isArray(notice?.quarantinedPaths)
              ? notice.quarantinedPaths.map((path) => String(path || "").trim()).filter(Boolean)
              : [],
          ),
        ),
      );
      const details =
        quarantinedPaths.length > 0
          ? t("storage.recoveryPreserved", { paths: quarantinedPaths.join("\n") })
          : "";
      const resetToDefaults = notices.some((notice) => notice?.action === "reset_to_defaults");
      startupState.storageRecoveryNoticeShown = true;
      showAlert(
        t(resetToDefaults ? "storage.recoveryResetTitle" : "storage.recoveryTitle"),
        t(resetToDefaults ? "storage.recoveryResetMessage" : "storage.recoveryRestoredMessage", {
          stores,
          details,
        }),
      );
    } catch (error) {
      diagnosticError("storage_recovery_notice_failed", error);
    }
  }

  async function startMainApp() {
    if (startupState.appStarted) {
      return;
    }
    startupState.appStarted = true;
    const savedMidi = getSavedMidiDeviceIds();
    const savedDevice = savedMidi.inputId || savedMidi.routes?.[0]?.inputDeviceId || "";
    if (!savedDevice && midiStatus) {
      midiStatus.textContent = t("bindings.selectDevicesSentence");
    }
    const startupProfileName = getStartupProfileName();
    const pluginManifestsPromise = features.plugins?.preloadPluginManifests?.().catch(() => []);
    await features.profiles.refreshProfiles(startupProfileName);
    await loadStartupProfile(startupProfileName);
    await pluginManifestsPromise;
    await features.plugins?.preloadBindingDisplayMetadata?.().catch(() => {});
    features.bindings.renderBindings();
    performanceAudit.mark("bindings-usable", {
      bindingCount: Array.isArray(profileState.bindings) ? profileState.bindings.length : 0,
      profile: profileState.name || startupProfileName,
    });
    const bindingsUsable = performanceAudit.measure(
      "bootstrap-to-bindings-usable",
      "bootstrap-start",
      "bindings-usable",
    );
    recordPerformanceResult("startup.bindings_usable", bindingsUsable?.durationMs, "milestone", {
      window: "main",
      binding_count: Array.isArray(profileState.bindings) ? profileState.bindings.length : 0,
    });
    applyCurrentOsdAppearance();
    if (profileState.name) {
      invoke("set_active_profile_preference", { profileName: profileState.name }).catch(() => {});
    }

    const pluginStartPromise = features.plugins
      .startPluginHostIfNeeded({ suppressInitialBindingsInvalidation: true })
      .then((result) => {
        if (result?.metadataChanged) {
          requestBindingsRerender("plugin_metadata_hydrated");
        }
        const pluginsReady = performanceAudit.mark("plugins-ready", { started: Boolean(result?.started) });
        recordPerformanceResult("startup.plugins_ready", pluginsReady?.startTimeMs, "milestone", {
          window: "main",
        });
        return result;
      })
      .catch((error) => {
        console.error("startPluginHostIfNeeded failed", error);
        diagnosticError("start_plugin_host_failed", error);
        const pluginsReady = performanceAudit.mark("plugins-ready", {
          error: String(error?.message || error),
        });
        recordPerformanceResult("startup.plugins_ready", pluginsReady?.startTimeMs, "milestone", {
          window: "main",
          error: true,
        });
        return null;
      });
    const [deviceData] = await Promise.all([
      features.midi.loadMidiDevicesWithRetry(),
      features.settings.loadMonitorOptions(),
      features.settings.loadOsdSettings(),
    ]);
    applyCurrentOsdAppearance();

    const profileHasMidiPreference = hasMidiPreference(profileState.midiPreference);
    let usedLegacyFallback = false;

    try {
      if (profileHasMidiPreference) {
        await features.midi?.syncToProfileDevice?.(profileState.midiPreference);
      } else {
        usedLegacyFallback = true;
        await features.midi.attemptAutoConnect(deviceData);
      }
    } finally {
      features.midi?.completeInitialDeviceLoad?.();
    }

    if (usedLegacyFallback && savedDevice && midiStatus) {
      midiStatus.textContent = t("midi.selectAvailableReconnect");
    }
    const midiReady = performanceAudit.mark("midi-ready", {
      connectedRouteCount: viewState.activeMidiRouteCount,
    });
    recordPerformanceResult("startup.midi_ready", midiReady?.startTimeMs, "milestone", {
      window: "main",
      connected_route_count: viewState.activeMidiRouteCount,
    });
    await pluginStartPromise;
    await showStorageRecoveryNotices();
    queueMidiDeviceInventorySubmit("startup");
  }

  async function init() {
    performanceAudit.mark("app-init-start");
    if (!bindTauriApi()) {
      scheduleRetry(() => init(), 200);
      return;
    }
    diagnosticInfo("setup_listeners_start");
    await setupListeners().catch((error) => {
      diagnosticError("setup_listeners_failed", error);
    });
    diagnosticInfo("setup_listeners_done");
    diagnosticInfo("load_app_settings_start");
    const loadedSettings = await features.settings.loadAppSettings({ applyLocale: false });
    diagnosticInfo("load_app_settings_done");
    await initI18n(settingsStore.get().language || "en").catch((error) => {
      diagnosticError("i18n_init_failed", error);
    });
    applyTranslations();
    applyGlobalAppearance(settingsStore.get().appearance || loadStoredAppearance());
    bindSystemAppearanceListener();
    diagnosticInfo("hydrate_client_preferences_start");
    await hydrateClientPreferences(loadedSettings);
    diagnosticInfo("hydrate_client_preferences_done");
    mainScreen?.classList?.remove?.("hidden");
    diagnosticInfo("start_main_app_start");
    await startMainApp();
    diagnosticInfo("start_main_app_done");
    setTimeout(() => {
      if (startupState.storageRecoveryNoticeShown) {
        return;
      }
      maybePromptMidiDeviceInventoryConsent().catch((error) => {
        diagnosticError("midi_device_inventory_prompt_failed", error);
      });
    }, 0);
    try {
      const resetSkipOnceKey = "updaterResetSkipOnce";
      if (localStorage.getItem(resetSkipOnceKey) !== "1") {
        localStorage.removeItem("updaterSkippedVersion");
        localStorage.setItem(resetSkipOnceKey, "1");
      }
    } catch {
      // ignore storage failures
    }
    if (settingsStore.get().autoCheckUpdates !== false) {
      features.settings
        ?.checkForUpdates?.({ silent: true })
        .then((info) => {
          if (!info || !info.available) return;
          if (startupState.storageRecoveryNoticeShown) return;
          const latest = String(info.latestVersion || "").trim();
          const current = String(info.currentVersion || "").trim();
          if (!latest) return;
          const skippedVersionKey = "updaterSkippedVersion";
          try {
            if (localStorage.getItem(skippedVersionKey) === latest) return;
          } catch {
            // ignore storage failures
          }
          showUpdateAvailableDialog(
            { latestVersion: latest, currentVersion: current },
            { standaloneIfMainHidden: true },
          );
        })
        .catch((error) => {
          diagnosticError("auto_update_check_failed", error);
        });
    }
    const backgroundReady = performanceAudit.mark("background-init-complete");
    recordPerformanceResult("startup.background_complete", backgroundReady?.startTimeMs, "milestone", {
      window: "main",
    });
  }

  return { init };
}

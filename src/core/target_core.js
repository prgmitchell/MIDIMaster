export const SYSTEM_SOUNDS_ICON_DATA = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' fill='none'><rect x='1.5' y='1.5' width='17' height='17' rx='4' fill='%2317263d'/><path d='M4.4 8.1v3.8h2.7l3.5 3V5.1L7.1 8.1H4.4z' fill='%23d8e7ff'/><path d='M13.1 7.1a4.1 4.1 0 0 1 0 5.8M14.9 5.4a6.6 6.6 0 0 1 0 9.2' stroke='%238fd5ff' stroke-width='1.35' stroke-linecap='round'/><circle cx='15.4' cy='4.5' r='1.2' fill='%2386d6a7'/></svg>";

function stableStringify(value) {
  if (value == null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${parts.join(",")}}`;
}

function integrationTargetKey(integration) {
  if (!integration) return "";
  const id = integration.integration_id || "";
  const kind = integration.kind || "";
  const data = integration.data || {};

  // Exclude non-stable, display-only fields so keys persist across reconnects.
  // Do not strip *_name fields here: some integrations, including OBS, use
  // those as the actual stable identity for stored targets.
  const stableData = { ...data };
  delete stableData.label;
  delete stableData.icon_data;
  delete stableData.iconData;
  delete stableData.display_label;
  delete stableData.displayLabel;
  delete stableData.action_label;
  delete stableData.action_value;
  delete stableData.action_kind;
  delete stableData.button_action;
  delete stableData.osd_value_text;
  return `${id}:${kind}:${stableStringify(stableData)}`;
}

function getIntegrationTarget(target) {
  if (!target || typeof target !== "object") return null;
  return target.Integration || target.integration || null;
}

function normalizeSessionKey(session) {
  const applicationKey = String(session?.application_key || session?.applicationKey || "").trim();
  if (applicationKey) {
    return applicationKey.toLowerCase();
  }
  const isGenericProcessName = (name) => /^(pid\s+\d+|msedgewebview2)$/i.test(name);
  if (session?.process_path) {
    const filename = session.process_path.split(/[\\/]/).pop() || "";
    const stem = filename.replace(/\.[^/.]+$/, "");
    if (stem && !isGenericProcessName(stem)) {
      return stem.toLowerCase();
    }
  }
  if (session?.process_name) {
    const processName = session.process_name.replace(/\.[^/.]+$/, "").trim();
    if (processName && !isGenericProcessName(processName)) {
      return processName.toLowerCase();
    }
  }
  const displayName = String(session?.display_name || "").trim();
  if (!displayName || isGenericProcessName(displayName)) {
    return "";
  }
  return displayName.toLowerCase();
}

function packageProductKey(value) {
  let raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  raw = raw.replace(/^(package|aumid):/, "");
  raw = raw.split("!")[0];
  raw = raw.split("_")[0];
  const product = raw.split(".").filter(Boolean).pop() || "";
  return product;
}

function sessionMatchesAppName(session, appName) {
  const target = String(appName || "").trim().toLowerCase();
  if (!target) return false;

  const candidates = new Set();
  const key = normalizeSessionKey(session);
  if (key) {
    candidates.add(key);
    const productKey = packageProductKey(key);
    if (productKey) candidates.add(productKey);
  }
  const displayName = String(session?.display_name || "").trim().toLowerCase();
  if (displayName) candidates.add(displayName);

  return candidates.has(target);
}

function isSystemSoundsName(value) {
  return String(value || "").trim().toLowerCase() === "system sounds";
}

export function iconDataForApplicationName(name) {
  return isSystemSoundsName(name) ? SYSTEM_SOUNDS_ICON_DATA : null;
}

export function iconDataForSession(session) {
  if (session?.icon_data) return session.icon_data;
  if (isSystemSoundsName(normalizeSessionKey(session)) || isSystemSoundsName(session?.display_name)) {
    return SYSTEM_SOUNDS_ICON_DATA;
  }
  return null;
}

function friendlyAppLabel(name) {
  const raw = String(name || "").trim();
  if (!raw) return "Application";
  const base = raw.split(/[\\/]/).pop().replace(/\.exe$/i, "");
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : raw;
}

function withUnavailableSuffix(label) {
  const raw = String(label || "").trim();
  if (!raw) return "Unavailable";
  return /\(\s*Unavailable\s*\)\s*$/i.test(raw) ? raw : `${raw} (Unavailable)`;
}

function itemIsMuted(item) {
  return Boolean(item?.is_muted ?? item?.muted ?? false);
}

export function createTargetCore({
  masterIconData,
  focusIconData,
  mediaPlayPauseIconData,
  getSessions,
  getPlaybackDevices,
  getRecordingDevices,
  getFocusedSession,
  getPluginHost,
  getIntegrationDisplayMetadata,
  getIntegrationTargetState,
}) {
  const getSess = (typeof getSessions === "function") ? getSessions : (() => []);
  const getPlayback = (typeof getPlaybackDevices === "function") ? getPlaybackDevices : (() => []);
  const getRecording = (typeof getRecordingDevices === "function") ? getRecordingDevices : (() => []);
  const getFocus = (typeof getFocusedSession === "function") ? getFocusedSession : (() => null);
  const getHost = (typeof getPluginHost === "function") ? getPluginHost : (() => null);
  const getIntegrationMetadata = (typeof getIntegrationDisplayMetadata === "function")
    ? getIntegrationDisplayMetadata
    : (() => null);
  const getIntegrationState = (typeof getIntegrationTargetState === "function")
    ? getIntegrationTargetState
    : (() => null);

  function resolveOsdTarget(target, focusSession) {
    const sessions = getSess();
    const playbackDevices = getPlayback();
    const recordingDevices = getRecording();
    const pluginHost = getHost();
    const currentFocusSession = focusSession || getFocus();

    if (!target) {
      return { label: "Volume", icon_data: masterIconData };
    }
    const focusName = currentFocusSession?.display_name?.trim();
    if (typeof target === "string") {
      if (target === "Master") {
        return { label: "Master", icon_data: masterIconData };
      }
      if (target === "Focus") {
        return {
          label: focusName ? `Focused: ${focusName}` : "Focused App",
          icon_data: currentFocusSession?.icon_data ?? focusIconData,
        };
      }
      if (target === "MonitorBrightness") {
        return { label: "Monitor Brightness", icon_data: null, icon_kind: "monitor-brightness" };
      }
      if (target === "MediaControl") {
        return { label: "Media Controls", icon_data: mediaPlayPauseIconData || null };
      }
      if (target === "CaptureControl") {
        return { label: "Capture Controls", icon_data: null };
      }
      if (target === "Macro") {
        return { label: "Macro", icon_data: null };
      }
      if (target === "Soundboard") {
        return { label: "Soundboard", icon_data: null };
      }
      if (target === "Hotkey") {
        return { label: "Hotkey", icon_data: null };
      }
      if (target === "OpenApplication") {
        return { label: "Open Application", icon_data: null };
      }
      if (target === "AutoHotkeyScript") {
        return { label: "AutoHotkey Script", icon_data: null };
      }
      if (target === "Unset") {
        return null;
      }
    }
    const targetType = target.type || target.kind || target.target;
    const profile = target.Profile || target.profile || (targetType === "Profile" ? target : null);
    const profileName = typeof profile === "string" ? profile : profile?.name;
    if (profileName) {
      return { label: `Profile: ${profileName}`, icon_data: null };
    }
    if (targetType === "Master" || target?.Master != null) {
      return { label: "Master", icon_data: masterIconData };
    }
    if (targetType === "Focus" || target?.Focus != null) {
      return {
        label: focusName ? `Focused: ${focusName}` : "Focused App",
        icon_data: currentFocusSession?.icon_data ?? focusIconData,
      };
    }
    const brightness = target.MonitorBrightness || target.monitorBrightness || (targetType === "MonitorBrightness" ? target : null);
    if (brightness) {
      const displayName = String(brightness.display_name || brightness.displayName || "").trim();
      return {
        label: displayName ? `Monitor Brightness: ${displayName}` : "Monitor Brightness",
        icon_data: null,
        icon_kind: "monitor-brightness",
      };
    }

    const appContainer = target.Application || target.application || (targetType === "Application" ? target : null);
    const appName = (typeof appContainer === "string")
      ? appContainer
      : (appContainer?.name ?? appContainer?.appName ?? target.name ?? target.appName);

    if (appName) {
      const session = sessions.find((item) => sessionMatchesAppName(item, appName));
      const storedLabel = (typeof appContainer === "object" && appContainer)
        ? (appContainer.display_name || appContainer.displayName || appContainer.label)
        : null;
      const storedIcon = (typeof appContainer === "object" && appContainer)
        ? (appContainer.icon_data || appContainer.iconData)
        : null;
      const label = session?.display_name || storedLabel || friendlyAppLabel(appName);
      return {
        label: session ? label : `${label} (Unavailable)`,
        icon_data: iconDataForSession(session) ?? storedIcon ?? iconDataForApplicationName(appName),
      };
    }

    const sessionContainer = target.Session || target.session || (targetType === "Session" ? target : null);
    let sessionId = sessionContainer?.session_id ?? sessionContainer?.sessionId ?? target.session_id ?? target.sessionId;
    if (!sessionId && sessionContainer && (typeof sessionContainer === "string" || typeof sessionContainer === "number")) {
      sessionId = sessionContainer;
    }
    if (sessionId) {
      const session = sessions.find((item) => String(item.id) === String(sessionId));
      return {
        label: session?.display_name || "Application",
        icon_data: iconDataForSession(session),
      };
    }

    const deviceContainer = target.Device || target.device || (targetType === "Device" ? target : null);
    let deviceId = deviceContainer?.device_id ?? deviceContainer?.deviceId ?? target.device_id ?? target.deviceId;
    if (!deviceId && deviceContainer && (typeof deviceContainer === "string" || typeof deviceContainer === "number")) {
      deviceId = deviceContainer;
    }
    if (deviceId) {
      let rawId = deviceId;
      let kind = "playback";
      if (deviceId.startsWith("recording:")) {
        rawId = deviceId.slice("recording:".length);
        kind = "recording";
      } else if (deviceId.startsWith("playback:")) {
        rawId = deviceId.slice("playback:".length);
      }
      const deviceList = kind === "recording" ? recordingDevices : playbackDevices;
      const device = deviceList.find((item) => item.id === rawId);
      return {
        label: device?.display_name || "Audio Device",
        icon_data: device?.icon_data ?? null,
        icon_kind: `${kind}-device`,
      };
    }

    const integration = target.Integration || target.integration;
    if (integration && integration.integration_id) {
      if (pluginHost) {
        const handler = pluginHost.getIntegration(integration.integration_id);
        if (handler && typeof handler.describeTarget === "function") {
          try {
            const desc = handler.describeTarget({ Integration: integration });
            if (desc && desc.label) {
              return {
                ...desc,
                label: desc.ghost ? withUnavailableSuffix(desc.label) : desc.label,
              };
            }
          } catch {
            // ignore
          }
        }
      }

      const data = integration.data || {};
      const metadata = getIntegrationMetadata(integration.integration_id);
      const label = data.label || data.display_label || metadata?.label || null;
      const icon_data = data.icon_data || metadata?.icon_data || null;
      if (label || icon_data) {
        return { label: label || "Integration", icon_data: icon_data || null };
      }
      return { label: "Integration", icon_data: null };
    }

    return { label: "Volume", icon_data: masterIconData };
  }

  function resolveTargetKey(target) {
    const sessions = getSess();

    if (!target) return null;
    if (target === "Master" || target.Master !== undefined) return "::master::";
    if (target === "Focus" || target.Focus !== undefined) return "::focus::";
    if (target === "MonitorBrightness") return "::monitor-brightness::";
    const brightness = target.MonitorBrightness || target.monitorBrightness;
    if (brightness) {
      const monitorId = brightness.monitor_id || brightness.monitorId;
      return monitorId ? `monitor-brightness:${monitorId}` : "::monitor-brightness::";
    }
    if (target === "MediaControl") return "::media-control::";
    if (target === "CaptureControl") return "::capture-control::";
    if (target === "Macro") return "::macro::";
    if (target === "Hotkey") return "::hotkey::";
    if (target === "OpenApplication") return "::open-application::";
    if (target === "AutoHotkeyScript") return "::autohotkey-script::";
    const profile = target.Profile || target.profile;
    if (profile?.name) return `profile:${profile.name}`;

    const integration = getIntegrationTarget(target);
    if (integration && integration.integration_id) {
      const key = integrationTargetKey(integration);
      if (key) {
        return `integration:${key}`;
      }
    }

    const appContainer = target.Application || target.application;
    if (appContainer) {
      if (typeof appContainer === "string") return appContainer.toLowerCase();
      const name = appContainer.name ?? appContainer.appName;
      if (name) return String(name).toLowerCase();
    }
    if (target.type === "Application" && (target.name || target.appName)) {
      return String(target.name || target.appName).toLowerCase();
    }
    if (target.name) return String(target.name).toLowerCase();

    const sessionContainer = target.Session || target.session;
    let sessionId = null;
    if (sessionContainer) {
      if (typeof sessionContainer === "string" || typeof sessionContainer === "number") {
        sessionId = sessionContainer;
      } else {
        sessionId = sessionContainer.session_id ?? sessionContainer.sessionId;
      }
    } else if (target.session_id || target.sessionId) {
      sessionId = target.session_id || target.sessionId;
    }
    if (sessionId) {
      if (typeof sessionId === "object" && sessionId !== null) {
        sessionId = sessionId.id ?? sessionId.value ?? sessionId;
      }
      const session = sessions.find((s) => String(s.id) === String(sessionId));
      if (session) return normalizeSessionKey(session);
      return `session:${sessionId}`;
    }

    const deviceContainer = target.Device || target.device;
    let deviceId = null;
    if (deviceContainer) {
      if (typeof deviceContainer === "string") {
        deviceId = deviceContainer;
      } else {
        deviceId = deviceContainer.device_id ?? deviceContainer.deviceId;
      }
    } else if (target.device_id || target.deviceId) {
      deviceId = target.device_id || target.deviceId;
    }
    if (deviceId) return String(deviceId);
    return null;
  }

  function targetsMatch(t1, t2, focusSession) {
    if (!t1 || !t2) return false;
    if (t1 === t2) return true;
    if (JSON.stringify(t1) === JSON.stringify(t2)) return true;

    const k1 = resolveTargetKey(t1);
    const k2 = resolveTargetKey(t2);
    if (k1 && k2 && k1 === k2) return true;

    // Integration labels are not unique across plugins or target kinds. For
    // example, OBS and Wave Link can both expose a target named "Browser".
    // Once stable integration keys differ, falling back to display labels would
    // incorrectly mirror UI state between unrelated targets.
    if (getIntegrationTarget(t1) || getIntegrationTarget(t2)) return false;

    const r1 = resolveOsdTarget(t1, focusSession);
    const r2 = resolveOsdTarget(t2, focusSession);
    if (r1 && r2) {
      if (r1.label === r2.label) return true;
      const l1 = String(r1.label).toLowerCase();
      const l2 = String(r2.label).toLowerCase();
      if (l1.includes(l2) || l2.includes(l1)) return true;
    }

    return false;
  }

  function resolveTargetVolume(target) {
    const sessions = getSess();
    const playbackDevices = getPlayback();
    const recordingDevices = getRecording();
    const currentFocusSession = getFocus();

    if (!target) return null;
    if (target === "Master") {
      const master = sessions.find((s) => s.is_master || s.id === "master");
      return master?.volume ?? null;
    }
    if (target === "Focus" || target?.Focus != null) {
      return currentFocusSession?.volume ?? null;
    }
    if (target === "MonitorBrightness" || target === "MediaControl" || target === "CaptureControl" || target === "Macro" || target === "Hotkey" || target === "OpenApplication" || target?.Profile || target?.profile) {
      return null;
    }

    const targetType = target.type || target.kind || target.target;
    const appContainer = target.Application || target.application || (targetType === "Application" ? target : null);
    const appName = (typeof appContainer === "string") ? appContainer : (appContainer?.name ?? appContainer?.appName);
    if (appName) {
      const matching = sessions.filter((item) => sessionMatchesAppName(item, appName));
      if (matching.length === 0) return null;
      return Math.max(...matching.map((s) => s.volume));
    }

    const sessionContainer = target.Session || target.session || (targetType === "Session" ? target : null);
    let sessionId = sessionContainer?.session_id ?? sessionContainer?.sessionId;
    if (!sessionId && sessionContainer && (typeof sessionContainer === "string" || typeof sessionContainer === "number")) {
      sessionId = sessionContainer;
    }
    if (sessionId) {
      const session = sessions.find((item) => String(item.id) === String(sessionId));
      return session?.volume ?? null;
    }

    const deviceContainer = target.Device || target.device || (targetType === "Device" ? target : null);
    let deviceId = deviceContainer?.device_id ?? deviceContainer?.deviceId;
    if (!deviceId && deviceContainer && (typeof deviceContainer === "string" || typeof deviceContainer === "number")) {
      deviceId = deviceContainer;
    }
    if (deviceId) {
      let rawId = deviceId;
      let kind = "playback";
      if (deviceId.startsWith("recording:")) {
        rawId = deviceId.slice("recording:".length);
        kind = "recording";
      } else if (deviceId.startsWith("playback:")) {
        rawId = deviceId.slice("playback:".length);
      }
      const deviceList = kind === "recording" ? recordingDevices : playbackDevices;
      const device = deviceList.find((item) => item.id === rawId);
      return device?.volume ?? null;
    }

    const integration = target.Integration || target.integration;
    if (integration && integration.integration_id) {
      const integrationState = getIntegrationState(target);
      if (integrationState && typeof integrationState.volume === "number") {
        return integrationState.volume;
      }
    }

    return null;
  }

  function getVolumeForTarget(target) {
    const sessions = getSess();
    const playbackDevices = getPlayback();
    const recordingDevices = getRecording();
    const currentFocusSession = getFocus();

    if (!target) return null;

    if (target === "Master" || target?.Master != null) {
      const session = sessions.find((s) => s.is_master);
      return session ? session.volume : null;
    }

    if (target === "Focus" || target?.Focus != null) {
      return currentFocusSession?.volume ?? null;
    }

    if (target === "MediaControl" || target === "CaptureControl" || target === "Macro" || target === "Hotkey" || target === "OpenApplication" || target?.Profile || target?.profile) {
      return null;
    }

    const appContainer = target.Application || target.application;
    const appName = appContainer?.name ?? target.name;
    if (appName) {
      const matching = sessions.filter((item) => sessionMatchesAppName(item, appName));
      if (matching.length === 0) return null;
      return Math.max(...matching.map((s) => s.volume));
    }

    const sessionContainer = target.Session || target.session;
    const sessionId = sessionContainer?.session_id ?? sessionContainer?.sessionId ?? target.session_id;
    if (sessionId) {
      const session = sessions.find((item) => String(item.id) === String(sessionId));
      return session ? session.volume : null;
    }

    const deviceContainer = target.Device || target.device;
    const deviceId = deviceContainer?.device_id ?? deviceContainer?.deviceId ?? target.device_id;
    if (deviceId) {
      let rawId = deviceId;
      let kind = "playback";
      if (typeof deviceId === "string") {
        if (deviceId.startsWith("recording:")) {
          rawId = deviceId.slice("recording:".length);
          kind = "recording";
        } else if (deviceId.startsWith("playback:")) {
          rawId = deviceId.slice("playback:".length);
        }
      }
      const deviceList = kind === "recording" ? recordingDevices : playbackDevices;
      const device = deviceList.find((d) => d.id === rawId);
      return device ? device.volume : null;
    }

    const integration = target.Integration || target.integration;
    if (integration && integration.integration_id) {
      const integrationState = getIntegrationState(target);
      if (integrationState && typeof integrationState.volume === "number") {
        return integrationState.volume;
      }
    }

    return null;
  }

  function getMuteForTarget(target) {
    const sessions = getSess();
    const playbackDevices = getPlayback();
    const recordingDevices = getRecording();
    const currentFocusSession = getFocus();

    if (!target) return false;

    if (target === "Master" || target?.Master != null) {
      const session = sessions.find((s) => s.is_master);
      return itemIsMuted(session);
    }

    if (target === "Focus" || target?.Focus != null) {
      return Boolean(currentFocusSession?.is_muted ?? currentFocusSession?.muted ?? false);
    }

    if (target === "MediaControl" || target === "CaptureControl" || target === "Macro" || target === "Hotkey" || target === "OpenApplication" || target?.Profile || target?.profile) {
      return false;
    }

    const appContainer = target.Application || target.application;
    const appName = appContainer?.name ?? target.name;
    if (appName) {
      const session = sessions.find((item) => sessionMatchesAppName(item, appName));
      return itemIsMuted(session);
    }

    const sessionContainer = target.Session || target.session;
    const sessionId = sessionContainer?.session_id ?? sessionContainer?.sessionId ?? target.session_id;
    if (sessionId) {
      const session = sessions.find((item) => item.id === sessionId);
      return itemIsMuted(session);
    }

    const deviceContainer = target.Device || target.device;
    const deviceId = deviceContainer?.device_id ?? deviceContainer?.deviceId ?? target.device_id;
    if (deviceId) {
      const device = playbackDevices.find((d) => d.id === deviceId)
        || recordingDevices.find((d) => d.id === deviceId);
      return itemIsMuted(device);
    }

    const integration = target.Integration || target.integration;
    if (integration && integration.integration_id) {
      const integrationState = getIntegrationState(target);
      if (integrationState && typeof integrationState.muted === "boolean") {
        return integrationState.muted;
      }
    }

    return false;
  }

  return {
    stableStringify,
    integrationTargetKey,
    normalizeSessionKey,
    resolveOsdTarget,
    resolveTargetKey,
    targetsMatch,
    resolveTargetVolume,
    getVolumeForTarget,
    getMuteForTarget,
  };
}

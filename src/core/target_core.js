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
  const stableData = { ...data };
  for (const k of Object.keys(stableData)) {
    if (k.endsWith("_name") || k.endsWith("Name") || k === "label" || k === "icon_data") {
      delete stableData[k];
    }
  }
  return `${id}:${kind}:${stableStringify(stableData)}`;
}

function normalizeSessionKey(session) {
  if (session?.process_path) {
    const filename = session.process_path.split(/[\\/]/).pop() || "";
    const stem = filename.replace(/\.[^/.]+$/, "");
    if (stem) {
      return stem.toLowerCase();
    }
  }
  if (session?.process_name) {
    return session.process_name.replace(/\.[^/.]+$/, "").toLowerCase();
  }
  return session?.display_name?.toLowerCase() || "";
}

export function createTargetCore({
  masterIconData,
  focusIconData,
  getSessions,
  getPlaybackDevices,
  getRecordingDevices,
  getPluginHost,
}) {
  const getSess = (typeof getSessions === "function") ? getSessions : (() => []);
  const getPlayback = (typeof getPlaybackDevices === "function") ? getPlaybackDevices : (() => []);
  const getRecording = (typeof getRecordingDevices === "function") ? getRecordingDevices : (() => []);
  const getHost = (typeof getPluginHost === "function") ? getPluginHost : (() => null);

  function resolveOsdTarget(target, focusSession) {
    const sessions = getSess();
    const playbackDevices = getPlayback();
    const recordingDevices = getRecording();
    const pluginHost = getHost();

    if (!target) {
      return { label: "Volume", icon_data: masterIconData };
    }
    const focusName = focusSession?.display_name?.trim();
    if (typeof target === "string") {
      if (target === "Master") {
        return { label: "Master", icon_data: masterIconData };
      }
      if (target === "Focus") {
        return {
          label: focusName ? `Focused: ${focusName}` : "Focused App",
          icon_data: focusSession?.icon_data ?? focusIconData,
        };
      }
      if (target === "Unset") {
        return null;
      }
    }
    const targetType = target.type || target.kind || target.target;
    if (targetType === "Master" || target?.Master != null) {
      return { label: "Master", icon_data: masterIconData };
    }
    if (targetType === "Focus" || target?.Focus != null) {
      return {
        label: focusName ? `Focused: ${focusName}` : "Focused App",
        icon_data: focusSession?.icon_data ?? focusIconData,
      };
    }

    const appContainer = target.Application || target.application || (targetType === "Application" ? target : null);
    const appName = (typeof appContainer === "string")
      ? appContainer
      : (appContainer?.name ?? appContainer?.appName ?? target.name ?? target.appName);

    if (appName) {
      const session = sessions.find((item) => normalizeSessionKey(item) === appName.toLowerCase());
      return {
        label: session?.display_name || appName,
        icon_data: session?.icon_data ?? null,
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
        icon_data: session?.icon_data ?? null,
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
              return desc;
            }
          } catch {
            // ignore
          }
        }
      }

      const data = integration.data || {};
      const label = data.label || data.display_label || null;
      const icon_data = data.icon_data || null;
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

    const integration = target.Integration || target.integration;
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

    if (!target) return null;
    if (target === "Master") {
      const master = sessions.find((s) => s.is_master || s.id === "master");
      return master?.volume ?? null;
    }
    if (target === "Focus" || target?.Focus != null) {
      return null;
    }

    const targetType = target.type || target.kind || target.target;
    const appContainer = target.Application || target.application || (targetType === "Application" ? target : null);
    const appName = (typeof appContainer === "string") ? appContainer : (appContainer?.name ?? appContainer?.appName);
    if (appName) {
      const matching = sessions.filter((item) => normalizeSessionKey(item) === appName.toLowerCase());
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

    return null;
  }

  function getVolumeForTarget(target) {
    const sessions = getSess();
    const playbackDevices = getPlayback();
    const recordingDevices = getRecording();

    if (!target) return null;

    if (target === "Master" || target?.Master != null) {
      const session = sessions.find((s) => s.is_master);
      return session ? session.volume : null;
    }

    if (target === "Focus" || target?.Focus != null) {
      return null;
    }

    const appContainer = target.Application || target.application;
    const appName = appContainer?.name ?? target.name;
    if (appName) {
      const matching = sessions.filter((item) => normalizeSessionKey(item) === appName.toLowerCase());
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

    return null;
  }

  function getMuteForTarget(target) {
    const sessions = getSess();
    const playbackDevices = getPlayback();
    const recordingDevices = getRecording();

    if (!target) return false;

    if (target === "Master" || target?.Master != null) {
      const session = sessions.find((s) => s.is_master);
      return session ? session.muted : false;
    }

    if (target === "Focus" || target?.Focus != null) {
      return false;
    }

    const appContainer = target.Application || target.application;
    const appName = appContainer?.name ?? target.name;
    if (appName) {
      const session = sessions.find((item) => normalizeSessionKey(item) === appName.toLowerCase());
      return session ? session.muted : false;
    }

    const sessionContainer = target.Session || target.session;
    const sessionId = sessionContainer?.session_id ?? sessionContainer?.sessionId ?? target.session_id;
    if (sessionId) {
      const session = sessions.find((item) => item.id === sessionId);
      return session ? session.muted : false;
    }

    const deviceContainer = target.Device || target.device;
    const deviceId = deviceContainer?.device_id ?? deviceContainer?.deviceId ?? target.device_id;
    if (deviceId) {
      const device = playbackDevices.find((d) => d.id === deviceId)
        || recordingDevices.find((d) => d.id === deviceId);
      return device ? device.muted : false;
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

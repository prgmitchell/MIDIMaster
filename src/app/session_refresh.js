const DEFAULT_DEVICE_REFRESH_INTERVAL_MS = 15000;
const ACTIVE_VOLUME_REFRESH_DEFER_MS = 350;

function normalizedNumber(value) {
  const next = Number(value);
  return Number.isFinite(next) ? next.toFixed(4) : "";
}

function booleanPart(value) {
  return value ? "1" : "0";
}

function compactPart(value) {
  return String(value ?? "");
}

function listSignature(list, itemSignature) {
  if (!Array.isArray(list)) return "";
  return list.map(itemSignature).join("\n");
}

function sessionStructureSignature(session) {
  if (!session || typeof session !== "object") return compactPart(session);
  return [
    compactPart(session.id),
    compactPart(session.display_name),
    compactPart(session.application_key),
    compactPart(session.process_name),
    compactPart(session.process_path),
    booleanPart(session.is_master),
  ].join("|");
}

function sessionValueSignature(session) {
  if (!session || typeof session !== "object") return compactPart(session);
  return [
    sessionStructureSignature(session),
    normalizedNumber(session.volume),
    booleanPart(session.is_muted),
  ].join("|");
}

function deviceStructureSignature(device) {
  if (!device || typeof device !== "object") return compactPart(device);
  return [
    compactPart(device.id),
    compactPart(device.display_name),
    booleanPart(device.is_default),
  ].join("|");
}

function deviceValueSignature(device) {
  if (!device || typeof device !== "object") return compactPart(device);
  return [
    deviceStructureSignature(device),
    normalizedNumber(device.volume),
    booleanPart(device.is_muted),
  ].join("|");
}

function listValuesEqual(list1, list2, itemSignature) {
  return listSignature(list1, itemSignature) === listSignature(list2, itemSignature);
}

export function createSessionRefresher({
  invoke,
  getState,
  setState,
  actions,
  getLastVolumeUpdateAt = () => 0,
  deviceRefreshIntervalMs = DEFAULT_DEVICE_REFRESH_INTERVAL_MS,
} = {}) {
  let refreshInFlight = null;
  let lastDeviceRefreshAt = 0;

  function structurallyEqual(list1, list2) {
    if (!Array.isArray(list1) || !Array.isArray(list2)) return false;
    const sample = list1.find((item) => item && typeof item === "object")
      || list2.find((item) => item && typeof item === "object")
      || null;
    const signature = sample && (
      Object.prototype.hasOwnProperty.call(sample, "process_path")
      || Object.prototype.hasOwnProperty.call(sample, "process_name")
      || Object.prototype.hasOwnProperty.call(sample, "is_master")
    )
      ? sessionStructureSignature
      : deviceStructureSignature;
    return listSignature(list1, signature) === listSignature(list2, signature);
  }

  function volumeInputIsActive() {
    const lastUpdate = Number(getLastVolumeUpdateAt?.() || 0);
    return lastUpdate > 0 && Date.now() - lastUpdate < ACTIVE_VOLUME_REFRESH_DEFER_MS;
  }

  async function refreshSessionsInternal(options = {}) {
    const force = Boolean(options.force);
    if (!force && volumeInputIsActive()) {
      return { deferred: true };
    }

    let sessionsChanged = false;
    let sessionsStructureChanged = false;
    let focusedSessionChanged = false;

    const stateBefore = getState();
    try {
      const nextSessions = await invoke("list_sessions");
      if (!listValuesEqual(nextSessions, stateBefore.sessions, sessionValueSignature)) {
        if (!listValuesEqual(nextSessions, stateBefore.sessions, sessionStructureSignature)) {
          sessionsStructureChanged = true;
        }
        setState({ sessions: nextSessions });
        sessionsChanged = true;
      }
    } catch (error) {
      console.warn("Failed to refresh sessions, keeping previous state:", error);
    }

    const stateAfterSessions = getState();
    try {
      const nextFocusedSession = await invoke("focused_session");
      if (sessionValueSignature(nextFocusedSession) !== sessionValueSignature(stateAfterSessions.focusedSession ?? null)) {
        setState({ focusedSession: nextFocusedSession ?? null });
        focusedSessionChanged = true;
      }
    } catch (error) {
      console.warn("Failed to refresh focused session, keeping previous state:", error);
    }

    let devicesChanged = false;
    let devicesStructureChanged = false;
    const now = Date.now();
    const shouldRefreshDevices = force
      || options.includeDevices === true
      || now - lastDeviceRefreshAt >= deviceRefreshIntervalMs;

    if (shouldRefreshDevices) {
      lastDeviceRefreshAt = now;
      const stateAfterFocus = getState();
      try {
        const nextPlayback = await invoke("list_playback_devices");
        if (!listValuesEqual(nextPlayback, stateAfterFocus.playbackDevices, deviceValueSignature)) {
          if (!listValuesEqual(nextPlayback, stateAfterFocus.playbackDevices, deviceStructureSignature)) {
            devicesStructureChanged = true;
          }
          setState({ playbackDevices: nextPlayback });
          devicesChanged = true;
        }
      } catch (error) {
        console.warn("Failed to refresh playback devices, keeping previous state:", error);
      }

      const stateAfterPlayback = getState();
      try {
        const nextRecording = await invoke("list_recording_devices");
        if (!listValuesEqual(nextRecording, stateAfterPlayback.recordingDevices, deviceValueSignature)) {
          if (!listValuesEqual(nextRecording, stateAfterPlayback.recordingDevices, deviceStructureSignature)) {
            devicesStructureChanged = true;
          }
          setState({ recordingDevices: nextRecording });
          devicesChanged = true;
        }
      } catch (error) {
        console.warn("Failed to refresh recording devices, keeping previous state:", error);
      }
    }

    const state = getState();
    if (sessionsStructureChanged && state.sessionsContainer) {
      state.sessionsContainer.innerHTML = "";
      state.sessions.forEach((session) => {
        if (session.is_master || session.id === "master") {
          return;
        }
        const item = document.createElement("div");
        item.className = "list-item";
        const title = document.createElement("div");
        title.textContent = session.display_name;
        const detail = document.createElement("div");
        detail.className = "path";
        detail.textContent = session.process_path || "System";
        item.appendChild(title);
        item.appendChild(detail);
        state.sessionsContainer.appendChild(item);
      });
    }

    if (focusedSessionChanged) {
      actions.updateBindingTargetDisplays?.();
    }

    if ((sessionsStructureChanged || devicesStructureChanged) && !actions.isBindingInteractionActive()) {
      actions.renderBindings();
    } else if ((sessionsChanged || devicesChanged || focusedSessionChanged) && !actions.isBindingInteractionActive()) {
      actions.updateBindingValues();
    }

    return {
      deferred: false,
      sessionsChanged,
      sessionsStructureChanged,
      focusedSessionChanged,
      devicesChanged,
      devicesStructureChanged,
    };
  }

  async function refreshSessions(options = {}) {
    if (refreshInFlight) {
      return refreshInFlight;
    }
    refreshInFlight = refreshSessionsInternal(options).finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  return {
    refreshSessions,
    structurallyEqual,
  };
}

export function createSessionRefresher({ invoke, getState, setState, actions }) {
  function simplifyForComparison(value) {
    if (!value || typeof value !== "object") return value;
    const { volume, muted, ...rest } = value;
    return rest;
  }

  function structurallyEqual(list1, list2) {
    if (!Array.isArray(list1) || !Array.isArray(list2)) return false;
    if (list1.length !== list2.length) return false;
    const s1 = list1.map(simplifyForComparison);
    const s2 = list2.map(simplifyForComparison);
    return JSON.stringify(s1) === JSON.stringify(s2);
  }

  async function refreshSessions() {
    let sessionsChanged = false;
    let sessionsStructureChanged = false;
    let focusedSessionChanged = false;

    const stateBefore = getState();
    try {
      const nextSessions = await invoke("list_sessions");
      if (JSON.stringify(nextSessions) !== JSON.stringify(stateBefore.sessions)) {
        if (!structurallyEqual(nextSessions, stateBefore.sessions)) {
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
      if (JSON.stringify(nextFocusedSession) !== JSON.stringify(stateAfterSessions.focusedSession ?? null)) {
        setState({ focusedSession: nextFocusedSession ?? null });
        focusedSessionChanged = true;
      }
    } catch (error) {
      console.warn("Failed to refresh focused session, keeping previous state:", error);
    }

    let devicesChanged = false;
    let devicesStructureChanged = false;

    const stateAfterFocus = getState();
    try {
      const nextPlayback = await invoke("list_playback_devices");
      if (JSON.stringify(nextPlayback) !== JSON.stringify(stateAfterFocus.playbackDevices)) {
        if (!structurallyEqual(nextPlayback, stateAfterFocus.playbackDevices)) {
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
      if (JSON.stringify(nextRecording) !== JSON.stringify(stateAfterPlayback.recordingDevices)) {
        if (!structurallyEqual(nextRecording, stateAfterPlayback.recordingDevices)) {
          devicesStructureChanged = true;
        }
        setState({ recordingDevices: nextRecording });
        devicesChanged = true;
      }
    } catch (error) {
      console.warn("Failed to refresh recording devices, keeping previous state:", error);
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
  }

  return {
    refreshSessions,
    structurallyEqual,
  };
}

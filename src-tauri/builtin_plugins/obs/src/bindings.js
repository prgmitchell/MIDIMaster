import { sourceFilterKey } from "./protocol.js";

/** bindings workflow. */
export function createBindings({
  ctx,
  discoverAudioInputs,
  queueDisconnectedFeedbackClear,
  refreshLists,
  sourceVisibilityKey,
  state,
  syncAllFeedback,
}) {
  function readBindings() {
    try {
      const all = ctx.bindings?.getAll?.();
      return Array.isArray(all) ? all : [];
    } catch {
      return [];
    }
  }

  function setBindings(next) {
    state.bindings = Array.isArray(next) ? next : [];
    rebuildBindingIndex();
    if (!state.connected) {
      queueDisconnectedFeedbackClear().catch(() => {});
    }
  }

  function notifyTargetOptionsChanged() {
    try {
      ctx.app?.invalidateBindingsUI?.();
    } catch {}
    try {
      window.dispatchEvent(
        new CustomEvent("midimaster:integration-targets-changed", {
          detail: { integrationId: "obs" },
        }),
      );
    } catch {}
  }

  function resetAudioInputDiscovery() {
    state.audioInputs = new Set();
    state.audioInputsReady = false;
    state.audioInputsDiscovering = false;
  }

  function scheduleListRefresh(reason = "") {
    if (!state.connected) return;
    if (state.listRefreshTimer) {
      clearTimeout(state.listRefreshTimer);
    }
    state.listRefreshTimer = setTimeout(
      () => {
        state.listRefreshTimer = null;
        (async () => {
          await refreshLists();
          resetAudioInputDiscovery();
          notifyTargetOptionsChanged();
          await discoverAudioInputs();
          notifyTargetOptionsChanged();
          await syncAllFeedback({ silent: true });
        })().catch(() => {});
      },
      reason === "connected" ? 0 : 250,
    );
  }

  function rebuildBindingIndex() {
    state.bindingsByInputVolume = new Map();
    state.bindingsByInputMute = new Map();
    state.bindingsBySourceVisibility = new Map();
    state.bindingsBySourceFilter = new Map();

    for (const b of state.bindings) {
      const t = b?.target?.Integration || b?.target?.integration;
      if (!t || t.integration_id !== "obs") continue;

      const action = b.action || "Volume";
      if (t.kind === "input") {
        const inputName = t.data?.input_name;
        if (!inputName) continue;
        if (action === "Volume") {
          if (!state.bindingsByInputVolume.has(inputName))
            state.bindingsByInputVolume.set(inputName, new Set());
          state.bindingsByInputVolume.get(inputName).add(b.id);
        }
        if (action === "ToggleMute") {
          if (!state.bindingsByInputMute.has(inputName)) state.bindingsByInputMute.set(inputName, new Set());
          state.bindingsByInputMute.get(inputName).add(b.id);
        }
      }
      if (t.kind === "source" && action === "ToggleMute") {
        const sceneName = t.data?.scene_name;
        const sourceName = t.data?.source_name;
        if (!sceneName || !sourceName) continue;
        const key = sourceVisibilityKey(sceneName, sourceName);
        if (!state.bindingsBySourceVisibility.has(key)) state.bindingsBySourceVisibility.set(key, new Set());
        state.bindingsBySourceVisibility.get(key).add(b.id);
      }
      if (t.kind === "source_filter" && (action === "ToggleMute" || action === "ToggleEffect")) {
        const sourceName = t.data?.source_name;
        const filterName = t.data?.filter_name;
        if (!sourceName || !filterName) continue;
        const key = sourceFilterKey(sourceName, filterName);
        if (!state.bindingsBySourceFilter.has(key)) state.bindingsBySourceFilter.set(key, new Map());
        state.bindingsBySourceFilter.get(key).set(b.id, action);
      }
    }
  }

  return {
    readBindings,
    setBindings,
    notifyTargetOptionsChanged,
    resetAudioInputDiscovery,
    scheduleListRefresh,
  };
}

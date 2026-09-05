import {
  clamp01,
  inputMuteFeedbackBindingIds,
  normalizeSourceFilters,
  sourceFilterKey,
  makeSourceFilterButtonAction,
} from "./protocol.js";

/** feedback workflow. */
export function createFeedback({ ctx, iconDataUrl, request, sourceVisibilityKey, state }) {
  function buttonEvent(payload) {
    const explicit = String(payload?.button_event || "").toLowerCase();
    if (explicit === "press" || explicit === "release") return explicit;
    if (payload?.momentary_trigger === false) return "release";
    if (payload?.momentary_trigger === true) return "press";
    return clamp01(payload?.value) > 0.0 ? "press" : "release";
  }

  async function setMomentaryFeedback(bindingId, action, active) {
    if (!bindingId) return;
    const value = active ? 1.0 : 0.0;
    await ctx.feedback.set(bindingId, value, action, { inputValue: value });
  }

  async function readStatefulActionValue(action) {
    try {
      if (action === "ToggleRecord") {
        const status = await request("GetRecordStatus");
        return Boolean(status?.outputActive);
      }
      if (action === "ToggleStream") {
        const status = await request("GetStreamStatus");
        return Boolean(status?.outputActive);
      }
      if (action === "ToggleVirtualCam") {
        const status = await request("GetVirtualCamStatus");
        return Boolean(status?.outputActive);
      }
      if (action === "ToggleReplayBuffer") {
        const status = await request("GetReplayBufferStatus");
        return Boolean(status?.outputActive);
      }
      if (action === "ToggleStudioMode") {
        const status = await request("GetStudioModeEnabled");
        return Boolean(status?.studioModeEnabled);
      }
    } catch {
      return null;
    }
    return null;
  }

  async function syncAllFeedback(opts = null) {
    if (!state.connected) return;
    const silent = opts && typeof opts === "object" ? Boolean(opts.silent) : true;

    // Only sync inputs that are bound in the active profile.
    const inputNames = new Set([
      ...Array.from(state.bindingsByInputVolume.keys()),
      ...Array.from(state.bindingsByInputMute.keys()),
    ]);

    for (const inputName of inputNames) {
      try {
        const [volRes, muteRes] = await Promise.all([
          request("GetInputVolume", { inputName }),
          request("GetInputMute", { inputName }),
        ]);
        const vol = clamp01(volRes?.inputVolumeMul);
        const muted = Boolean(muteRes?.inputMuted);
        state.knownVolumes.set(String(inputName), vol);
        state.knownMutes.set(String(inputName), muted);

        const volBindings = state.bindingsByInputVolume.get(inputName);
        if (volBindings) {
          for (const bid of volBindings) {
            await ctx.feedback.set(bid, vol, "Volume", { silent });
          }
        }
        const muteFeedbackBindings = inputMuteFeedbackBindingIds(
          state.bindingsByInputVolume,
          state.bindingsByInputMute,
          inputName,
        );
        for (const bid of muteFeedbackBindings) {
          await ctx.feedback.set(bid, muted ? 1.0 : 0.0, "ToggleMute", { silent });
        }
      } catch {
        // ignore
      }
    }

    const scenesWithVisibilityBindings = new Set(
      Array.from(state.bindingsBySourceVisibility.keys())
        .map((key) => key.split("\u0000")[0])
        .filter(Boolean),
    );
    for (const sceneName of scenesWithVisibilityBindings) {
      await syncSourceVisibilityForScene(sceneName, { silent });
    }

    const sourcesWithFilterBindings = new Set(
      Array.from(state.bindingsBySourceFilter.keys())
        .map((key) => key.split("\u0000")[0])
        .filter(Boolean),
    );
    for (const sourceName of sourcesWithFilterBindings) {
      await syncSourceFiltersForSource(sourceName, { silent });
    }
  }

  async function syncSourceVisibilityForScene(sceneName, opts = null) {
    if (!state.connected || !sceneName) return;
    const silent = opts && typeof opts === "object" ? Boolean(opts.silent) : true;
    try {
      const list = await request("GetSceneItemList", { sceneName });
      const items = Array.isArray(list.sceneItems) ? list.sceneItems : [];
      for (const item of items) {
        const sourceName = item?.sourceName;
        if (!sourceName) continue;
        const set = state.bindingsBySourceVisibility.get(sourceVisibilityKey(sceneName, sourceName));
        if (!set) continue;
        const enabled = Boolean(item.sceneItemEnabled);
        for (const bid of set) {
          await ctx.feedback.set(bid, enabled ? 1.0 : 0.0, "ToggleMute", { silent });
        }
      }
    } catch {
      // ignore
    }
  }

  async function syncSourceFiltersForSource(sourceName, opts = null) {
    if (!state.connected || !sourceName) return;
    const silent = opts && typeof opts === "object" ? Boolean(opts.silent) : true;
    try {
      const list = await request("GetSourceFilterList", { sourceName });
      const filters = normalizeSourceFilters(list?.filters);
      for (const filter of filters) {
        const set = state.bindingsBySourceFilter.get(sourceFilterKey(sourceName, filter.filterName));
        if (!set) continue;
        for (const [bid, action] of set.entries()) {
          await ctx.feedback.set(bid, filter.filterEnabled ? 1.0 : 0.0, action, { silent });
        }
      }
    } catch {
      // ignore
    }
  }

  async function loadSourceFilterButtonActions(sourceName) {
    if (!sourceName) return [];
    try {
      const filterList = await request("GetSourceFilterList", { sourceName: String(sourceName) });
      return normalizeSourceFilters(filterList?.filters).map((filter) =>
        makeSourceFilterButtonAction(String(sourceName), filter.filterName, iconDataUrl || null),
      );
    } catch {
      return [];
    }
  }

  return {
    buttonEvent,
    setMomentaryFeedback,
    readStatefulActionValue,
    syncAllFeedback,
    syncSourceVisibilityForScene,
    loadSourceFilterButtonActions,
  };
}

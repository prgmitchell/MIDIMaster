export function createProfileState({
  state,
  request,
  flushVolumeWrites,
  resetVolumeState,
}) {
  const outputActions = {
    ToggleRecord: "Record",
    ToggleStream: "Stream",
    ToggleVirtualCam: "VirtualCam",
    ToggleReplayBuffer: "ReplayBuffer",
  };
  async function flush() {
    const deadline = Date.now() + 2000;
    while (state.volumeFlushInFlight) {
      if (Date.now() >= deadline)
        throw new Error("OBS volume writes are still pending");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await flushVolumeWrites?.();
  }
  async function prepareStateCapture({ refresh }) {
    if (refresh && state.connected) await flush();
  }
  async function sourceItem(data) {
    const response = await request("GetSceneItemList", {
      sceneName: data.scene_name,
    });
    return response.sceneItems?.find(
      (item) => item.sourceName === data.source_name,
    );
  }
  async function captureTargetState({ kind, data }) {
    if (!state.connected) return null;
    if (kind === "action" && outputActions[data.action]) {
      const status = await request(`Get${outputActions[data.action]}Status`);
      return { enabled: status.outputActive };
    }
    if (kind === "action" && data.action === "ToggleStudioMode") {
      const status = await request("GetStudioModeEnabled");
      return { enabled: status.studioModeEnabled };
    }
    if (kind === "input") {
      const [volume, mute] = await Promise.all([
        request("GetInputVolume", { inputName: data.input_name }),
        request("GetInputMute", { inputName: data.input_name }),
      ]);
      return { volume: volume.inputVolumeMul, muted: mute.inputMuted };
    }
    if (kind === "source") {
      const item = await sourceItem(data);
      return item ? { enabled: item.sceneItemEnabled } : null;
    }
    if (kind === "source_filter") {
      const response = await request("GetSourceFilterList", {
        sourceName: data.source_name,
      });
      const filter = response.filters?.find(
        (filter) => filter.filterName === data.filter_name,
      );
      return filter ? { enabled: filter.filterEnabled } : null;
    }
    return null;
  }
  async function restoreTargetState({ kind, data }, saved) {
    if (!state.connected) return false;
    if (kind === "action" && typeof saved.enabled === "boolean") {
      if (outputActions[data.action]) {
        const output = outputActions[data.action];
        const current = await request(`Get${output}Status`);
        if (current.outputActive !== saved.enabled)
          await request(`${saved.enabled ? "Start" : "Stop"}${output}`);
      } else if (data.action === "ToggleStudioMode") {
        await request("SetStudioModeEnabled", {
          studioModeEnabled: saved.enabled,
        });
      } else return false;
      return true;
    }
    if (
      kind === "input" &&
      Number.isFinite(saved.volume) &&
      typeof saved.muted === "boolean"
    ) {
      await flush();
      await request("SetInputVolume", {
        inputName: data.input_name,
        inputVolumeMul: saved.volume,
      });
      await request("SetInputMute", {
        inputName: data.input_name,
        inputMuted: saved.muted,
      });
      resetVolumeState?.();
      state.knownVolumes?.set(data.input_name, saved.volume);
      state.knownMutes?.set(data.input_name, saved.muted);
    } else if (kind === "source" && typeof saved.enabled === "boolean") {
      const item = await sourceItem(data);
      if (!item) return false;
      await request("SetSceneItemEnabled", {
        sceneName: data.scene_name,
        sceneItemId: item.sceneItemId,
        sceneItemEnabled: saved.enabled,
      });
    } else if (kind === "source_filter" && typeof saved.enabled === "boolean") {
      await request("SetSourceFilterEnabled", {
        sourceName: data.source_name,
        filterName: data.filter_name,
        filterEnabled: saved.enabled,
      });
    } else return false;
    return true;
  }
  return { prepareStateCapture, captureTargetState, restoreTargetState };
}

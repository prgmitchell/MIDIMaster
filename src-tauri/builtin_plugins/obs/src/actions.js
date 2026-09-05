import { clamp01, rememberLocalMuteIntent, forgetLocalMuteIntent, sleep } from "./protocol.js";

/** actions workflow. */
export function createActions({
  applyObsVolumeBatch,
  buttonEvent,
  ctx,
  localMuteIntentByInput,
  obsActionKind,
  readStatefulActionValue,
  request,
  setMomentaryFeedback,
  state,
  statefulActionFeedback,
}) {
  async function handleObsBindingTrigger(payload) {
    const bindingId = payload?.binding_id;
    const action = payload?.action;
    const value = payload?.value;
    const isPrimaryTarget = payload?.is_primary_target !== false;
    const targetIndex = Number(payload?.target_index ?? 0);
    const targetCount = Number(payload?.target_count ?? 1);
    const target = payload?.target || {};
    const kind = target.kind;
    const data = target.data || {};

    if (!state.connected) return;

    if (kind === "input") {
      const inputName = data.input_name;
      if (!inputName) return;
      if (action === "Volume") {
        applyObsVolumeBatch({
          binding_id: bindingId,
          action,
          value,
          targets: [
            {
              target,
              target_index: targetIndex,
              target_count: targetCount,
              is_primary_target: isPrimaryTarget,
            },
          ],
        });
      } else if (action === "ToggleMute") {
        const muted = clamp01(value) > 0.5;
        rememberLocalMuteIntent(localMuteIntentByInput, inputName, muted);
        try {
          await request("SetInputMute", { inputName, inputMuted: muted });
        } catch (err) {
          forgetLocalMuteIntent(localMuteIntentByInput, inputName);
          throw err;
        }
        state.knownMutes.set(String(inputName), muted);
        if (bindingId) await ctx.feedback.set(bindingId, muted ? 1.0 : 0.0, action);
      }
      return;
    }

    if (kind === "action") {
      const a = data.action;
      if (!a) return;
      const stateful =
        String(data.action_kind || "").toLowerCase() === "stateful" ||
        String(payload?.button_action_kind || "").toLowerCase() === "stateful" ||
        obsActionKind(a) === "stateful";
      const eventKind = buttonEvent(payload);
      if (stateful) {
        if (eventKind !== "press") return;
      } else {
        if (eventKind === "release") {
          await setMomentaryFeedback(bindingId, action, false);
          return;
        }
        await setMomentaryFeedback(bindingId, action, true);
      }
      const map = {
        StartRecord: "StartRecord",
        StopRecord: "StopRecord",
        ToggleRecord: "ToggleRecord",
        ToggleStream: "ToggleStream",
        ToggleVirtualCam: "ToggleVirtualCam",
        ToggleReplayBuffer: "ToggleReplayBuffer",
      };
      let actionResponse = null;
      let expectedState = null;
      if (a === "ToggleStudioMode") {
        const cur = await request("GetStudioModeEnabled");
        expectedState = !Boolean(cur.studioModeEnabled);
        await request("SetStudioModeEnabled", { studioModeEnabled: expectedState });
      } else if (map[a]) {
        actionResponse = await request(map[a]);
      }
      if (stateful) {
        if (actionResponse && typeof actionResponse.outputActive === "boolean") {
          expectedState = actionResponse.outputActive;
        }
        if (expectedState == null) {
          await sleep(120);
        }
        const active = expectedState == null ? await readStatefulActionValue(a) : expectedState;
        const previous = bindingId ? statefulActionFeedback.get(bindingId) : undefined;
        const feedbackValue = active == null ? !Boolean(previous) : active;
        if (bindingId) statefulActionFeedback.set(bindingId, feedbackValue);
        if (bindingId) await ctx.feedback.set(bindingId, feedbackValue ? 1.0 : 0.0, action);
      }
      return;
    }

    if (kind === "scene") {
      const eventKind = buttonEvent(payload);
      if (eventKind === "release") {
        await setMomentaryFeedback(bindingId, action, false);
        return;
      }
      await setMomentaryFeedback(bindingId, action, true);
      const sceneName = data.scene_name;
      if (!sceneName) return;
      await request("SetCurrentProgramScene", { sceneName });
      state.currentScene = String(sceneName);
      return;
    }

    if (kind === "source") {
      const sceneName = data.scene_name;
      const sourceName = data.source_name;
      if (!sceneName || !sourceName) return;

      const list = await request("GetSceneItemList", { sceneName });
      const items = Array.isArray(list.sceneItems) ? list.sceneItems : [];
      const item = items.find((i) => i && i.sourceName === sourceName);
      if (!item) return;
      const enabled = clamp01(value) > 0.5;
      await request("SetSceneItemEnabled", {
        sceneName,
        sceneItemId: item.sceneItemId,
        sceneItemEnabled: enabled,
      });
      if (bindingId) await ctx.feedback.set(bindingId, enabled ? 1.0 : 0.0, action);
      return;
    }

    if (kind === "source_filter") {
      const sourceName = data.source_name;
      const filterName = data.filter_name;
      if (!sourceName || !filterName) return;

      const enabled = clamp01(value) > 0.5;
      await request("SetSourceFilterEnabled", {
        sourceName,
        filterName,
        filterEnabled: enabled,
      });
      if (bindingId) await ctx.feedback.set(bindingId, enabled ? 1.0 : 0.0, action);
      return;
    }

    if (kind === "media") {
      const eventKind = buttonEvent(payload);
      if (eventKind === "release") {
        await setMomentaryFeedback(bindingId, action, false);
        return;
      }
      await setMomentaryFeedback(bindingId, action, true);
      const inputName = data.source_name;
      const mediaAction = data.action;
      if (!inputName || !mediaAction) return;
      await request("TriggerMediaInputAction", { inputName, mediaAction });
    }
  }

  return { handleObsBindingTrigger };
}

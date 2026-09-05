/** targets workflow. */
export function createTargets({}) {
  function titleCaseAction(a) {
    const map = {
      ToggleRecord: "Toggle Recording",
      StartRecord: "Start Recording",
      StopRecord: "Stop Recording",
      ToggleStream: "Toggle Streaming",
      ToggleVirtualCam: "Toggle Virtual Camera",
      ToggleReplayBuffer: "Toggle Replay Buffer",
      ToggleStudioMode: "Toggle Studio Mode",
    };
    return map[a] || a;
  }

  function momentaryAction(label, value = "Volume") {
    return { label, value, behavior: "momentary" };
  }

  function statefulAction(label, value = "ToggleMute") {
    return { label, value, behavior: "stateful" };
  }

  function obsActionKind(action) {
    return String(action || "").startsWith("Toggle") ? "stateful" : "momentary";
  }

  function makeActionTarget(action) {
    return {
      Integration: {
        integration_id: "obs",
        kind: "action",
        data: { action, action_kind: obsActionKind(action) },
      },
    };
  }

  function makeSceneTarget(sceneName) {
    return {
      Integration: {
        integration_id: "obs",
        kind: "scene",
        data: { scene_name: String(sceneName), action_kind: "momentary" },
      },
    };
  }

  function makeSourceToggleTarget(sceneName, sourceName) {
    return {
      Integration: {
        integration_id: "obs",
        kind: "source",
        data: {
          scene_name: String(sceneName),
          source_name: String(sourceName),
          action_kind: "stateful",
        },
      },
    };
  }

  function sourceVisibilityKey(sceneName, sourceName) {
    return `${String(sceneName || "")}\u0000${String(sourceName || "")}`;
  }

  return {
    titleCaseAction,
    momentaryAction,
    statefulAction,
    obsActionKind,
    makeActionTarget,
    makeSceneTarget,
    makeSourceToggleTarget,
    sourceVisibilityKey,
  };
}

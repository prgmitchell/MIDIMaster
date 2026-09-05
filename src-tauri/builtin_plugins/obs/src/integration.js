/** integration workflow. */
export function createIntegration({
  applyObsVolumeBatch,
  ctx,
  discoverAudioInputs,
  handleObsBindingTrigger,
  iconDataUrl,
  loadSourceFilterButtonActions,
  makeActionTarget,
  makeSceneTarget,
  makeSourceToggleTarget,
  momentaryAction,
  normalizeBatchTargets,
  obsActionKind,
  pendingVolumeWrites,
  refreshLists,
  request,
  resetAudioInputDiscovery,
  state,
  statefulAction,
  titleCaseAction,
}) {
  function registerPluginIntegration() {
    ctx.registerIntegration({
      id: "obs",
      name: "OBS Studio",
      icon_data: iconDataUrl || null,
      buttonActions: [momentaryAction("Trigger", "Volume"), statefulAction("Toggle Mute", "ToggleMute")],
      describeTarget: (target) => {
        const t = target?.Integration || target?.integration;
        const data = t?.data || {};
        const icon_data =
          typeof data.icon_data === "string" && data.icon_data.trim() ? data.icon_data : iconDataUrl || null;

        let label = typeof data.label === "string" && data.label.trim() ? data.label : "";
        if (!label) {
          if (t?.kind === "input") label = String(data.input_name || "OBS Input");
          else if (t?.kind === "source") label = String(data.source_name || "Source");
          else if (t?.kind === "source_filter") {
            const sourceName = String(data.source_name || "Source");
            const filterName = String(data.filter_name || "Filter");
            label = `${sourceName} - ${filterName}`;
          } else if (t?.kind === "scene") label = String(data.scene_name || "OBS Scene");
          else if (t?.kind === "action") label = titleCaseAction(data.action || "Action");
          else label = "OBS Studio";
        }

        return { label: String(label), icon_data, ghost: !state.connected };
      },
      getTargetOptions: async (ctx2 = null) => {
        if (!state.connected) return [];
        const listChanged = await refreshLists();
        if (listChanged) {
          resetAudioInputDiscovery();
        }
        const controlType = ctx2 && typeof ctx2 === "object" ? ctx2.controlType : null;
        const nav = ctx2 && typeof ctx2 === "object" ? ctx2.nav : null;
        const opts = [];

        // Faders should only see volume-capable targets.
        if (controlType === "fader") {
          if (!state.audioInputsReady) {
            await discoverAudioInputs();
          }
          for (const input of state.inputList) {
            const name = input?.inputName;
            if (!name) continue;
            if (state.audioInputsReady && !state.audioInputs.has(String(name))) {
              continue;
            }
            opts.push({
              label: String(name),
              icon_data: iconDataUrl || null,
              target: {
                Integration: { integration_id: "obs", kind: "input", data: { input_name: String(name) } },
              },
            });
          }
          if (opts.length === 0) {
            return [
              {
                label: "No compatible targets found for this control.",
                kind: "placeholder",
                ghost: true,
                icon_data: iconDataUrl || null,
                category: "integrations",
                suppressUnavailableTag: true,
              },
            ];
          }
          return opts;
        }

        // Button navigation: Scenes -> Scene Items
        if (nav && nav.screen === "scene" && nav.sceneName) {
          const sceneName = String(nav.sceneName);

          opts.push({
            label: String(sceneName),
            icon_data: iconDataUrl || null,
            target: makeSceneTarget(sceneName),
            buttonActions: [momentaryAction("Switch Scene", "Volume")],
          });

          // Fetch scene items live so the list matches OBS state.
          // This is only used during target selection, so latency is OK.
          try {
            const list = await request("GetSceneItemList", { sceneName });
            const items = Array.isArray(list.sceneItems) ? list.sceneItems : [];
            for (const item of items) {
              const sourceName = item?.sourceName;
              if (!sourceName) continue;
              const buttonActions = [
                statefulAction("Toggle Visibility", "ToggleMute"),
                ...(await loadSourceFilterButtonActions(sourceName)),
              ];
              opts.push({
                label: String(sourceName),
                icon_data: iconDataUrl || null,
                target: makeSourceToggleTarget(sceneName, sourceName),
                buttonActions,
              });
            }
          } catch {
            // ignore
          }

          return opts;
        }

        opts.push({ kind: "divider", label: "Actions" });

        // Common actions
        const actions = [
          "ToggleRecord",
          "StartRecord",
          "StopRecord",
          "ToggleStream",
          "ToggleVirtualCam",
          "ToggleReplayBuffer",
          "ToggleStudioMode",
        ];
        for (const a of actions) {
          const actionKind = obsActionKind(a);
          opts.push({
            label: titleCaseAction(a),
            icon_data: iconDataUrl || null,
            target: makeActionTarget(a),
            buttonActions: [
              actionKind === "stateful"
                ? statefulAction(titleCaseAction(a), "Volume")
                : momentaryAction(titleCaseAction(a), "Volume"),
            ],
          });
        }

        opts.push({ kind: "divider", label: "Scenes" });

        // Scenes as a navigation list
        for (const scene of state.sceneList) {
          const name = scene?.sceneName;
          if (!name) continue;
          opts.push({
            label: String(name),
            icon_data: iconDataUrl || null,
            nav: { screen: "scene", sceneName: String(name) },
          });
        }

        opts.push({ kind: "divider", label: "Sources" });

        // Inputs
        for (const input of state.inputList) {
          const name = input?.inputName;
          if (!name) continue;
          opts.push({
            label: String(name),
            icon_data: iconDataUrl || null,
            target: {
              Integration: { integration_id: "obs", kind: "input", data: { input_name: String(name) } },
            },
            buttonActions: [
              statefulAction("Toggle Mute", "ToggleMute"),
              ...(await loadSourceFilterButtonActions(name)),
            ],
          });
        }

        // Scenes
        // (Scene switching now lives under scene navigation)

        return opts;
      },
      onBindingTriggeredBatch: async (payload) => {
        if (!state.connected) return;
        if (payload?.action !== "Volume") return;
        try {
          const batchTargets = normalizeBatchTargets(payload);
          const inputTargets = batchTargets.filter((entry) => entry.target?.kind === "input");
          const otherTargets = batchTargets.filter((entry) => entry.target?.kind !== "input");
          if (inputTargets.length > 0) {
            applyObsVolumeBatch({
              ...payload,
              targets: inputTargets.map((entry) => ({
                target: entry.target,
                target_index: entry.targetIndex,
                target_count: entry.targetCount,
                is_primary_target: entry.isPrimaryTarget,
                original_target_index: entry.originalTargetIndex,
              })),
            });
          }
          for (const entry of otherTargets) {
            await handleObsBindingTrigger({
              ...payload,
              target: entry.target,
              target_index: entry.targetIndex,
              target_count: entry.targetCount,
              is_primary_target: entry.isPrimaryTarget,
              original_target_index: entry.originalTargetIndex,
              momentary_trigger: entry.momentaryTrigger,
              button_event: entry.buttonEvent,
              button_action_kind: entry.buttonActionKind,
              button_input_active: entry.buttonInputActive,
            });
          }
        } catch {
          pendingVolumeWrites.clear();
        }
      },
      onBindingTriggered: async (payload) => {
        try {
          await handleObsBindingTrigger(payload);
        } catch (e) {
          // ignore
          pendingVolumeWrites.clear();
        }
      },
    });
  }

  return { registerPluginIntegration };
}

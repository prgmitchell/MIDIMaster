import {
  ID,
  innerTarget,
  targetValue,
  writesForTarget,
  describeLabel,
  targetOptions,
  bandsForGroup,
} from "./protocol.js";
import { createRuntime } from "./runtime.js";
import { createConnectionTab } from "./connection_tab.js";

export async function activate(ctx) {
  let icon = null;
  try {
    icon = await ctx.assets.readDataUrl("icon.svg", "image/svg+xml");
  } catch {
    /* optional icon */
  }
  const state = {
    snapshot: {
      installed: false,
      connected: false,
      status: null,
      detail: "Start FxSound, then connect",
    },
    settings: { auto_connect: false },
    disposed: false,
    disconnectedByUser: false,
  };
  // OSD windows need target metadata only; avoid duplicate native polls and writes.
  const osd =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location?.search || "").get("osd") === "1";
  let tab = null;
  const runtime = createRuntime({ ctx, state, updateUi: () => tab?.update() });
  ctx.registerIntegration({
    id: ID,
    name: "FxSound",
    icon_data: icon,
    buttonActions: [
      { label: "Set State", value: "ToggleEffect", behavior: "stateful" },
    ],
    describeTarget: (raw) => {
      const target = innerTarget(raw);
      const momentaryAvailable =
        target?.kind === "reset" ||
        (target?.kind === "preset" &&
          [
            ...(state.snapshot.status?.presets.built_in || []),
            ...(state.snapshot.status?.presets.user_defined || []),
          ].some((p) => p.name === target.data?.name));
      return {
        label: describeLabel(target, state.snapshot.status),
        icon_data: icon,
        ghost:
          !state.snapshot.connected ||
          (!momentaryAvailable &&
            targetValue(target, state.snapshot.status) === null),
      };
    },
    getTargetOptions: (args) => targetOptions(args, state.snapshot, icon),
    onBindingTriggered: runtime.trigger,
    prepareStateCapture: async ({ refresh }) => {
      if (refresh) {
        await runtime.flush();
        await runtime.poll(true);
      }
    },
    captureTargetState: (target) => {
      const value = state.snapshot.connected
        ? targetValue(target, state.snapshot.status)
        : null;
      if (value === null) return null;
      return target.kind === "group"
        ? {
            value,
            bands: bandsForGroup(state.snapshot.status, target.data.group).map(
              (band) => ({ ...band }),
            ),
          }
        : { value };
    },
    restoreTargetState: async (target, saved) => {
      if (
        !state.snapshot.connected ||
        !Number.isFinite(saved?.value) ||
        saved.value < 0 ||
        saved.value > 1
      )
        return false;
      let writes = writesForTarget(target, saved.value, state.snapshot.status);
      if (target.kind === "group" && Array.isArray(saved.bands)) {
        const current = bandsForGroup(state.snapshot.status, target.data.group);
        if (
          !current.length ||
          current.length !== saved.bands.length ||
          saved.bands.some(
            (band) =>
              !Number.isFinite(band.gain) ||
              band.gain < -12 ||
              band.gain > 12 ||
              !current.some(
                (b) =>
                  b.index === band.index &&
                  Math.abs(b.frequency - band.frequency) < 0.1,
              ),
          )
        )
          return false;
        writes = saved.bands.map((band) => ({
          kind: "band",
          index: band.index,
          value: band.gain,
        }));
      }
      if (!writes.length) return false;
      await runtime.write(writes);
      await runtime.flush();
      return true;
    },
  });
  if (osd) return;
  tab = createConnectionTab({ ctx, state, runtime, icon });
  const applyProfile = (event) => {
    const settings = event?.settings || event || {};
    state.settings = { auto_connect: settings.auto_connect ?? false };
    tab.update();
    runtime.clearFeedback();
    if (state.settings.auto_connect && !state.disconnectedByUser)
      runtime.poll(true).catch(() => {});
  };
  applyProfile(ctx.profile.get());
  ctx.profile.onChanged(applyProfile);
  ctx.bindings.onChanged(() => {
    runtime.clearFeedback();
    runtime.feedback(true).catch(() => {});
  });
  const timer = setInterval(() => runtime.poll().catch(() => {}), 1000);
  ctx.lifecycle.onDispose(() => {
    clearInterval(timer);
    runtime.dispose();
  });
  return { dispose: runtime.dispose };
}

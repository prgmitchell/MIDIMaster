import { integrationTargetKey } from "../../../core/target_core.js";

// Only integrations with an explicit state contract can be restored. Actions
// such as macros, shortcuts and media triggers never pass through this path.
export function createProfileTargetState({
  invoke,
  getActiveProfileName,
  getBindings,
  getPluginHost,
}) {
  let pending = new Map();
  let timer = null;
  let running = null;
  let suspended = true;
  let disposed = false;

  function targets() {
    const found = new Map();
    for (const binding of getBindings?.() || []) {
      if (
        !["Volume", "ToggleMute", "ToggleEffect"].includes(
          binding.action || "Volume",
        )
      )
        continue;
      for (const target of binding.targets?.length
        ? binding.targets
        : [binding.target]) {
        const integration = target?.Integration;
        if (integration) found.set(integrationTargetKey(integration), target);
      }
    }
    return found;
  }

  async function capture(refresh = false) {
    const entries = [];
    const prepared = new Set();
    const host = getPluginHost?.();
    for (const [key, target] of targets()) {
      if (pending.has(key)) continue;
      const integration = host?.getIntegration?.(
        target.Integration.integration_id,
      );
      if (!integration?.captureTargetState) continue;
      try {
        if (!prepared.has(integration)) {
          await integration.prepareStateCapture?.({ refresh });
          prepared.add(integration);
        }
        const state = await integration.captureTargetState(target.Integration);
        if (state && typeof state === "object") entries.push({ target, state });
      } catch (error) {
        console.warn("Profile target state capture failed", error);
      }
    }
    return entries;
  }

  async function checkpoint(leaveProfile = false) {
    const profileName = getActiveProfileName?.();
    if (!profileName) return;
    if (leaveProfile) {
      // Restore Solo first so a fresh mixer snapshot contains the original flags.
      await invoke("checkpoint_profile_state", {
        profileName,
        targetStates: [],
        leaveProfile: true,
      });
    }
    const targetStates = await capture(leaveProfile);
    await invoke("checkpoint_profile_state", { profileName, targetStates });
  }

  async function restore() {
    const current = targets();
    const host = getPluginHost?.();
    for (const [key, entry] of pending) {
      const target = current.get(key);
      if (!target) {
        pending.delete(key);
        continue;
      }
      const integration = host?.getIntegration?.(
        target.Integration.integration_id,
      );
      if (!integration?.restoreTargetState) continue;
      try {
        if (
          await integration.restoreTargetState(target.Integration, entry.state)
        )
          pending.delete(key);
      } catch (error) {
        console.warn("Profile target state restore failed", error);
      }
    }
  }

  async function tick() {
    if (running || suspended || disposed) return;
    running = (async () => {
      const allowed = await invoke("checkpoint_profile_state", {
        profileName: getActiveProfileName?.(),
        targetStates: [],
      });
      if (allowed === false) return;
      await restore();
      await checkpoint();
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  }

  async function beforeSwitch() {
    suspended = true;
    try {
      if (running) await running;
      await checkpoint(true);
    } catch (error) {
      suspended = false;
      throw error;
    }
  }

  function loaded(profile) {
    pending = new Map(
      (profile.target_states || [])
        .filter((entry) => entry.target?.Integration)
        .map((entry) => [
          integrationTargetKey(entry.target.Integration),
          entry,
        ]),
    );
    suspended = false;
    if (!timer && !disposed)
      timer = setInterval(() => tick().catch(console.warn), 1000);
    timer?.unref?.();
    return tick().catch((error) => console.warn("Profile state checkpoint failed", error));
  }

  async function dispose() {
    disposed = true;
    clearInterval(timer);
    if (running) await running;
    await checkpoint(true);
  }

  return {
    beforeSwitch,
    loaded,
    checkpoint,
    tick,
    dispose,
    resume: () => {
      suspended = false;
    },
  };
}

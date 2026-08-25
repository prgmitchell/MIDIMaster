import assert from "node:assert/strict";
import { createUpdaterController } from "../src/features/settings/updater_controller.js";

const controller = createUpdaterController({
  invoke: async (command) => {
    if (command === "check_for_updates") {
      return { available: true, current_version: "1.0.0", version: "1.1.0", body: "Notes" };
    }
    if (command === "get_app_version") return "1.0.0";
    return null;
  },
  listen: null,
  dom: {},
  translate: (key, params = {}) => `${key}${params.version ? `:${params.version}` : ""}`,
  getSettings: () => ({ autoCheckUpdates: true }),
});

assert.deepEqual(await controller.checkForUpdates(), {
  available: true,
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  body: "Notes",
});
assert.equal(controller.state.available, true);
controller.applyStatusEvent({ phase: "downloading", downloaded: 50, content_length: 100 });
assert.equal(controller.state.downloading, true);
controller.applyStatusEvent({ phase: "installed" });
assert.equal(controller.state.available, false);
assert.equal(controller.state.downloading, false);

console.log("Settings updater controller tests passed");

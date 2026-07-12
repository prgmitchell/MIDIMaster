import assert from "node:assert/strict";
import { pluginStoreTestUtils } from "../src/features/plugins/tabs.js";

const { compareSemver, eligibleUpdateIds, isUpdateAvailable, parseSemver } = pluginStoreTestUtils;

assert.ok(parseSemver("4.4.0"));
assert.ok(parseSemver("4.4.0-beta.2+build.7"));
assert.equal(parseSemver("4.4"), null);
assert.equal(compareSemver("1.0.0-beta.2", "1.0.0"), -1);
assert.equal(compareSemver("1.10.0", "1.9.9"), 1);
assert.equal(isUpdateAvailable("1.0.0", "1.1.0"), true);
assert.equal(isUpdateAvailable("2.0.0", "1.9.0"), false);
assert.deepEqual(eligibleUpdateIds([
  { id: "ready", hasUpdate: true, compatible: true, bundled: false },
  { id: "locked", hasUpdate: true, compatible: false, bundled: false },
  { id: "bundled", hasUpdate: true, compatible: true, bundled: true },
]), ["ready"]);

console.log("Plugin Store frontend tests passed");

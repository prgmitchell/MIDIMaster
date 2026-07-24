import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [defaultConfigSource, releaseConfigSource, releaseWorkflow] = await Promise.all([
  readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/tauri.release.conf.json", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
]);

const defaultConfig = JSON.parse(defaultConfigSource);
const releaseConfig = JSON.parse(releaseConfigSource);

assert.equal(defaultConfig.bundle.active, true, "ordinary builds must produce a bundle");
assert.deepEqual(defaultConfig.bundle.targets, ["nsis"], "ordinary Windows builds must produce NSIS");
assert.equal(
  defaultConfig.bundle.createUpdaterArtifacts,
  false,
  "ordinary builds must not require the private updater signing key",
);
assert.equal(
  releaseConfig.bundle.createUpdaterArtifacts,
  true,
  "release builds must generate signed updater artifacts",
);
assert.match(
  releaseWorkflow,
  /cargo tauri build --bundles nsis --config tauri\.release\.conf\.json/u,
  "the release workflow must opt into updater artifact generation",
);

console.log("Tauri bundle configuration tests passed");

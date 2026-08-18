import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [
  defaultConfigSource,
  releaseConfigSource,
  releaseWorkflow,
  signingDryRunWorkflow,
  artifactSigningScript,
  installedSignatureTest,
] = await Promise.all([
  readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/tauri.release.conf.json", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/signing-dry-run.yml", import.meta.url), "utf8"),
  readFile(new URL("./release/Sign-WithArtifactSigning.ps1", import.meta.url), "utf8"),
  readFile(new URL("./release/Test-NSISInstalledSignatures.ps1", import.meta.url), "utf8"),
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
  false,
  "release builds must defer updater signing until after Authenticode signing",
);
assert.equal(releaseConfig.bundle.windows.signCommand.cmd, "pwsh");
assert.ok(
  releaseConfig.bundle.windows.signCommand.args.includes("../scripts/release/Sign-WithArtifactSigning.ps1"),
  "Tauri must route generated uninstaller and installer signing through Artifact Signing",
);
assert.ok(releaseConfig.bundle.windows.signCommand.args.includes("%1"));
assert.match(artifactSigningScript, /Invoke-ArtifactSigning/u);
assert.match(artifactSigningScript, /ArtifactSigning.*0\.1\.17|0\.1\.17/u);
assert.match(artifactSigningScript, /Assert-Authenticode\.ps1/u);
assert.match(artifactSigningScript, /\^nst\[0-9a-f\]\+\\\.tmp\$/u, "signer must recognize NSIS temporary uninstallers");
assert.match(artifactSigningScript, /0x4D.*0x5A/su, "signer must require an MZ header for NSIS temporary uninstallers");
assert.match(installedSignatureTest, /uninstall\.exe/u);
assert.match(installedSignatureTest, /midimaster-virtual-audio-setup\.exe/u);

for (const [name, workflow] of [["release", releaseWorkflow], ["dry-run", signingDryRunWorkflow]]) {
  assert.match(workflow, /id-token:\s*write/u, `${name} workflow must permit secretless Azure OIDC`);
  assert.match(workflow, /environment:\s*windows-release/u, `${name} workflow must use the protected signing environment`);
  assert.match(workflow, /azure\/login@v3/u, `${name} workflow must authenticate to Azure with OIDC`);
  assert.match(workflow, /azure\/artifact-signing-action@v2/gu, `${name} workflow must use Azure Artifact Signing`);
  assert.match(workflow, /ArtifactSigning/u, `${name} workflow must install the pinned Tauri signing integration`);
  assert.match(workflow, /MITCHELL SOFTWARE SOLUTIONS LLC/u, `${name} workflow must enforce the verified publisher`);

  const buildIndex = workflow.indexOf("cargo tauri build --no-bundle --config tauri.release.conf.json");
  const innerSignIndex = workflow.indexOf("name: Sign MIDIMaster executables");
  const bundleIndex = workflow.indexOf("cargo tauri bundle --bundles nsis --config tauri.release.conf.json");
  const installTestIndex = workflow.indexOf("Test-NSISInstalledSignatures.ps1");
  const updaterSignIndex = workflow.indexOf("cargo tauri signer sign");
  const defenderScanIndex = workflow.indexOf("Invoke-DefenderArtifactScan.ps1");

  assert.ok(buildIndex >= 0, `${name} workflow must build without bundling first`);
  assert.ok(innerSignIndex > buildIndex, `${name} workflow must sign owned executables after building`);
  assert.ok(bundleIndex > innerSignIndex, `${name} workflow must bundle only after inner executable signing`);
  assert.ok(installTestIndex > bundleIndex, `${name} workflow must validate the signed installer and generated uninstaller`);
  assert.ok(updaterSignIndex > installTestIndex, `${name} workflow must generate the updater signature from the final signed installer bytes`);
  assert.ok(defenderScanIndex > updaterSignIndex, `${name} workflow must scan final signed artifacts before accepting them`);
  assert.doesNotMatch(workflow, /cargo tauri bundle[^\n]*--no-sign/u, `${name} workflow must let Tauri sign its generated uninstaller`);
  assert.doesNotMatch(workflow, /name: Sign NSIS installer/u, `${name} workflow must not leave uninstaller signing until after bundling`);

  for (const executable of [
    "midimaster.exe",
    "midimaster-virtual-audio-service.exe",
    "midimaster-virtual-audio-setup.exe",
  ]) {
    assert.match(workflow, new RegExp(executable.replaceAll(".", "\\."), "u"), `${name} workflow must sign ${executable}`);
  }
}

assert.doesNotMatch(
  releaseWorkflow,
  /cargo tauri build --bundles nsis --config tauri\.release\.conf\.json/u,
  "release workflow must not bundle before signing inner executables",
);
assert.match(releaseWorkflow, /Generate updater metadata \(latest\.json\)/u, "release workflow must publish updater metadata");
assert.match(releaseWorkflow, /MIDIMASTER_VIRTUAL_AUDIO_STRICT:\s*["']1["']/u, "release workflow must require an assigned public USB identity");
assert.match(signingDryRunWorkflow, /MIDIMASTER_VIRTUAL_AUDIO_STRICT:\s*["']0["']/u, "dry-run must use the development-only USB identity");
assert.doesNotMatch(signingDryRunWorkflow, /MIDIMASTER_RELEASE_USB_(?:VID|PID)/u, "dry-run must not require public USB identity variables");
assert.doesNotMatch(signingDryRunWorkflow, /softprops\/action-gh-release|Publish updater metadata/u, "dry-run must not publish");
assert.match(signingDryRunWorkflow, /actions\/upload-artifact@v4/u, "dry-run should retain signed artifacts for inspection");

console.log("Tauri bundle configuration tests passed");

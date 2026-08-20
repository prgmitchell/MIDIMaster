import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [configSource, hooks, manifestSource, workflow, buildScript, helperCargo, serviceCargo] =
  await Promise.all([
    read("src-tauri/tauri.conf.json"),
    read("src-tauri/windows/hooks.nsh"),
    read("src-tauri/windows/virtual-audio/vendor/usbip-win2-0.9.7.7.json"),
    read(".github/workflows/release.yml"),
    read("scripts/virtual-audio/Build-VirtualAudio.ps1"),
    read("virtual-audio/setup-helper/Cargo.toml"),
    read("virtual-audio/service/Cargo.toml"),
  ]);

const config = JSON.parse(configSource);
const manifest = JSON.parse(manifestSource);

assert.equal(manifest.version, "0.9.7.7");
assert.equal(manifest.size, 33_226_344);
assert.equal(
  manifest.sha256,
  "51620fa5f9f8be5932bc9d786deee557ce06d5407a99cab490dcfac71f185fea",
);
assert.equal(
  manifest.source,
  "https://github.com/vadimgrn/usbip-win2/releases/download/v.0.9.7.7/USBip-0.9.7.7-x64.exe",
);

assert.equal(config.bundle.resources["../virtual-audio/dist"], "virtual-audio");
assert.match(config.build.beforeBuildCommand, /Build-VirtualAudio\.ps1 -Configuration Release/u);
assert.match(hooks, /Install Virtual Audio \(recommended\)/u);
assert.match(hooks, /\$CMDLINE "\/UPDATE"/u);
assert.match(hooks, /\$CMDLINE "\/P"/u);
assert.match(hooks, /midimaster-virtual-audio-setup\.exe" "install --result-file/u);
assert.match(hooks, /midimaster-virtual-audio-setup\.exe" "remove --result-file/u);
assert.match(hooks, /FileRead \$2 \$0/u);
assert.match(hooks, /\$0 == 3010/u);

assert.match(workflow, /Download pinned usbip-win2 0\.9\.7\.7 payload/u);
assert.match(workflow, /MIDIMASTER_VIRTUAL_AUDIO_STRICT: "1"/u);
assert.match(workflow, /Test-UsbipPayload\.ps1/u);
assert.doesNotMatch(
  buildScript,
  /Invoke-WebRequest|\bcurl\b|\/latest\b/u,
  "local build scripts must never download a dependency",
);
assert.match(helperCargo, /name = "midimaster-virtual-audio-setup"/u);
assert.match(serviceCargo, /name = "midimaster-virtual-audio-service"/u);

const virtualAudioUi = await read("src/features/settings/virtual_audio.js");
const virtualAudioCommands = await read("src-tauri/src/commands/virtual_audio.rs");
assert.match(virtualAudioUi, /service_update_available/u);
assert.match(virtualAudioUi, /runAction\("repair_virtual_audio"\)/u);
assert.match(virtualAudioCommands, /bundled_service_path/u);
assert.match(virtualAudioCommands, /service_binary_update_available/u);
assert.match(
  virtualAudioCommands,
  /Start-Process[^\r\n]+-Verb RunAs -WindowStyle Hidden -Wait -PassThru/u,
  "the elevated setup helper must not expose an interactive console window",
);

console.log("Virtual Audio packaging tests passed");

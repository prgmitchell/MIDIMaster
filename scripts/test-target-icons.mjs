import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/features/targets/targets.js", import.meta.url), "utf8");
const hotkeyIconMatch = source.match(/const HOTKEY_ICON_DATA = ("[^"]+");/);
assert.ok(hotkeyIconMatch, "the built-in hotkey icon should be defined");
const hotkeyIconData = JSON.parse(hotkeyIconMatch[1]);
const moduleSource = source.replace(/^import .*;\r?\n/gm, "");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const { createTargetsFeature } = await import(moduleUrl);

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach((value) => this.values.add(value));
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this.innerHTML = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  replaceWith(replacement) {
    this.replacement = replacement;
  }
}

globalThis.document = {
  createElement: (tagName) => new FakeElement(tagName),
  createElementNS: (_namespace, tagName) => new FakeElement(tagName),
};
globalThis.iconDataForApplicationName = () => null;
globalThis.iconDataForSession = () => null;

const icons = {
  master: "master-icon",
  focus: "focus-icon",
  playPause: "play-pause-icon",
  next: "next-icon",
  previous: "previous-icon",
  stop: "stop-icon",
};
const feature = createTargetsFeature({
  masterIconData: icons.master,
  focusIconData: icons.focus,
  mediaPlayPauseIconData: icons.playPause,
  mediaNextTrackIconData: icons.next,
  mediaPrevTrackIconData: icons.previous,
  mediaStopIconData: icons.stop,
});

const master = feature.createTargetIcon({ label: "Master", icon_data: icons.master });
assert.equal(master.tagName, "svg");
assert.equal(master.classList.contains("target-icon--master"), true);

const brightness = feature.createTargetIcon({
  label: "Monitor Brightness",
  icon_kind: "monitor-brightness",
  kind: "monitor-brightness",
});
assert.equal(brightness.tagName, "svg");
assert.equal(brightness.classList.contains("target-icon--monitor-brightness"), true);

const faderOptions = feature.buildTargetOptions("MonitorBrightness", false);
assert.equal(faderOptions.options.filter((option) => option.kind === "monitor-brightness-root").length, 1);
assert.equal(faderOptions.options.some((option) => option.kind === "monitor-brightness"), false);
assert.equal(faderOptions.selectedKind, "monitor-brightness");
const buttonOptions = feature.buildTargetOptions("Master", true);
assert.equal(buttonOptions.options.some((option) => option.kind === "monitor-brightness-root"), false);

const monitorFeature = createTargetsFeature({
  invoke: async (command) => command === "list_monitors" ? [
    { stable_id: "DISPLAY\\ACR073A\\1", name: "XZ322QU", is_primary: true },
    { stable_id: "DISPLAY\\SAM7058\\2", name: "LC32G7xT", is_primary: false },
  ] : null,
});
await new Promise((resolve) => setTimeout(resolve, 0));
const individualOptions = monitorFeature.buildTargetOptions({
  MonitorBrightness: {
    monitor_id: "DISPLAY\\SAM7058\\2",
    display_name: "LC32G7xT",
  },
}, false);
assert.equal(individualOptions.options.filter((option) => option.kind === "monitor-brightness-root").length, 1);
assert.equal(individualOptions.selectedValue, "monitor-brightness:DISPLAY\\SAM7058\\2");
const monitorOptions = monitorFeature.buildMonitorBrightnessOptions();
assert.equal(monitorOptions.length, 3);
assert.deepEqual(
  monitorOptions.find((option) => option.value === individualOptions.selectedValue).target,
  {
    MonitorBrightness: {
      monitor_id: "DISPLAY\\SAM7058\\2",
      display_name: "LC32G7xT",
    },
  },
);
assert.deepEqual(
  monitorOptions.find((option) => option.value === "monitor-brightness:DISPLAY\\ACR073A\\1").title_tags,
  ["settings.primaryBadge"],
  "the primary monitor should render MAIN directly instead of collapsing multiple tags to +1",
);

const hotkey = feature.createTargetIcon({ label: "Hotkey", icon_data: hotkeyIconData });
assert.equal(hotkey.tagName, "svg");
assert.equal(hotkey.classList.contains("target-icon--hotkey"), true);

const suppliedDeviceIcon = feature.createTargetIcon({
  label: "Speakers",
  icon_data: "device-png",
  icon_kind: "playback-device",
  kind: "device",
});
assert.equal(suppliedDeviceIcon.tagName, "img", "a supplied Windows device icon should win over the fallback");

const playbackFallback = feature.createTargetIcon({
  label: "Voicemeeter Input",
  icon_data: null,
  icon_kind: "playback-device",
  kind: "device",
});
assert.equal(playbackFallback.tagName, "svg");
assert.equal(playbackFallback.classList.contains("target-icon--playback-device"), true);
assert.equal(playbackFallback.classList.contains("target-icon--device"), true);

const recordingFallback = feature.createTargetIcon({
  label: "Microphone",
  icon_data: null,
  value: "recording:microphone",
  kind: "device",
});
assert.equal(recordingFallback.classList.contains("target-icon--recording-device"), true);

suppliedDeviceIcon.classList.add("target-chip-icon");
suppliedDeviceIcon.listeners.get("error")();
assert.equal(suppliedDeviceIcon.replacement.classList.contains("target-icon--playback-device"), true);
assert.equal(suppliedDeviceIcon.replacement.classList.contains("target-chip-icon"), true);

const css = await readFile(new URL("../src/styles/bindings/setup.css", import.meta.url), "utf8");
assert.match(css, /body\[data-theme="light"\] \.target-icon--system\s*\{/);
assert.match(css, /--target-system-icon-background: var\(--accent-soft\)/);
assert.match(css, /--target-system-icon-foreground: var\(--accent-strong\)/);

console.log("Target icon tests passed");

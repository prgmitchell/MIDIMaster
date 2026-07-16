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

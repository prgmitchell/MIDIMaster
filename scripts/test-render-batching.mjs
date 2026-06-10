import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app/render_batching.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const batching = await import(moduleUrl);

function createManualFrameBatcher(options) {
  const frames = [];
  const flushed = [];
  const batcher = batching.createFrameBatcher({
    ...options,
    onFlush: (items) => flushed.push(items),
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  return { batcher, frames, flushed };
}

function flushNext(frames) {
  assert.ok(frames.length > 0, "expected a queued frame");
  frames.shift()();
}

function testContinuousMidiCollapsesToLatestPerControl() {
  const { batcher, frames, flushed } = createManualFrameBatcher({
    keyFor: batching.midiPayloadControlKey,
    shouldPreserve: batching.midiPayloadIsButtonLike,
  });

  batcher.queue({ device_id: "midi:0", channel: 0, controller: 7, msg_type: "ControlChange", value: 10 });
  batcher.queue({ device_id: "midi:0", channel: 0, controller: 7, msg_type: "ControlChange", value: 42 });
  batcher.queue({ device_id: "midi:0", channel: 0, controller: 7, msg_type: "ControlChange", value: 96 });
  flushNext(frames);

  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0].map((item) => item.value), [96]);
}

function testButtonMidiEventsArePreserved() {
  const { batcher, frames, flushed } = createManualFrameBatcher({
    keyFor: batching.midiPayloadControlKey,
    shouldPreserve: batching.midiPayloadIsButtonLike,
  });

  batcher.queue({ device_id: "midi:0", channel: 0, controller: 40, msg_type: "Note", value: 127 });
  batcher.queue({ device_id: "midi:0", channel: 0, controller: 40, msg_type: "Note", value: 0 });
  flushNext(frames);

  assert.deepEqual(flushed[0].map((item) => item.value), [127, 0]);
}

function testBackendVolumeUpdatesCollapseByBinding() {
  const { batcher, frames, flushed } = createManualFrameBatcher({
    keyFor: batching.volumePayloadKey,
  });

  batcher.queue({ binding_id: "fader-1", target: "Master", volume: 0.1 });
  batcher.queue({ binding_id: "fader-1", target: "Master", volume: 0.5 });
  batcher.queue({ binding_id: "fader-1", target: "Master", volume: 0.9 });
  flushNext(frames);

  assert.equal(flushed[0].length, 1);
  assert.equal(flushed[0][0].volume, 0.9);
}

function testBackendVolumeUpdatesKeepDistinctTargets() {
  const { batcher, frames, flushed } = createManualFrameBatcher({
    keyFor: batching.volumePayloadKey,
  });

  batcher.queue({ binding_id: "fader-1", target: "Master", volume: 0.2 });
  batcher.queue({ binding_id: "fader-1", target: "Focus", volume: 0.8 });
  flushNext(frames);

  assert.deepEqual(flushed[0].map((item) => item.target), ["Master", "Focus"]);
}

function testTargetVolumeKeyIsStableForMirroredSliders() {
  const left = batching.volumePayloadKey({
    target: { Integration: { data: { b: 2, a: 1 }, kind: "x", integration_id: "demo" } },
  });
  const right = batching.volumePayloadKey({
    target: { Integration: { integration_id: "demo", kind: "x", data: { a: 1, b: 2 } } },
  });

  assert.equal(left, right);
}

testContinuousMidiCollapsesToLatestPerControl();
testButtonMidiEventsArePreserved();
testBackendVolumeUpdatesCollapseByBinding();
testBackendVolumeUpdatesKeepDistinctTargets();
testTargetVolumeKeyIsStableForMirroredSliders();

console.log("Render batching tests passed");

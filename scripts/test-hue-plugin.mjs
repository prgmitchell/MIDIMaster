import assert from "node:assert/strict";
import {
  createHueWriteSchedulerForTests,
  hueTestUtils,
} from "../src-tauri/builtin_plugins/hue/plugin.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testLatestWinsBeforeFirstWrite() {
  const writes = [];
  const scheduler = createHueWriteSchedulerForTests({
    lightIntervalMs: 10,
    groupIntervalMs: 20,
    put: async (kind, id, body) => {
      writes.push({ kind, id, body });
    },
  });

  scheduler.enqueue("light", "1", { on: true, bri: 254 });
  scheduler.enqueue("light", "1", { on: false });
  scheduler.enqueue("light", "1", { on: true, bri: 200 });

  await scheduler.whenIdle();

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    kind: "light",
    id: "1",
    body: { on: true, bri: 200 },
  });
}

async function testSameTargetWritesDoNotOverlap() {
  const writes = [];
  let active = 0;
  let maxActive = 0;
  const scheduler = createHueWriteSchedulerForTests({
    lightIntervalMs: 5,
    groupIntervalMs: 20,
    put: async (kind, id, body) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      writes.push({ kind, id, body });
      await sleep(25);
      active -= 1;
    },
  });

  scheduler.enqueue("light", "2", { on: true, bri: 100 });
  await sleep(5);
  scheduler.enqueue("light", "2", { on: false });

  await scheduler.whenIdle();

  assert.equal(writes.length, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(writes[1], {
    kind: "light",
    id: "2",
    body: { on: false },
  });
}

async function testGlobalLightRateLimit() {
  const writes = [];
  const scheduler = createHueWriteSchedulerForTests({
    lightIntervalMs: 30,
    groupIntervalMs: 60,
    put: async (kind, id, body) => {
      writes.push({ kind, id, body, at: Date.now() });
    },
  });

  scheduler.enqueue("light", "1", { bri: 10 });
  scheduler.enqueue("light", "2", { bri: 20 });

  await scheduler.whenIdle();

  assert.equal(writes.length, 2);
  assert.ok(
    writes[1].at - writes[0].at >= 24,
    `expected light writes to be spaced, got ${writes[1].at - writes[0].at}ms`,
  );
}

async function testCancelledPendingWriteIsSkipped() {
  const writes = [];
  const scheduler = createHueWriteSchedulerForTests({
    lightIntervalMs: 50,
    groupIntervalMs: 60,
    put: async (kind, id, body) => {
      writes.push({ kind, id, body });
    },
  });

  scheduler.enqueue("light", "1", { bri: 10 });
  scheduler.enqueue("light", "2", { bri: 20 });
  scheduler.cancel("light", "2");

  await scheduler.whenIdle();

  assert.deepEqual(writes.map((write) => write.id), ["1"]);
}

function testBrightnessHelpers() {
  assert.equal(hueTestUtils.volumeToHueBri(0), 0);
  assert.equal(hueTestUtils.volumeToHueBri(1), 254);
  assert.equal(hueTestUtils.volumeToHueBri(0.5), 127);
  assert.equal(hueTestUtils.hueVolumeFromState({ on: false, bri: 254 }), 0);
  assert.equal(hueTestUtils.hueVolumeFromState({ on: true, bri: 254 }), 1);
}

await testLatestWinsBeforeFirstWrite();
await testSameTargetWritesDoNotOverlap();
await testGlobalLightRateLimit();
await testCancelledPendingWriteIsSkipped();
testBrightnessHelpers();

console.log("Hue plugin tests passed");

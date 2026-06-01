import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/features/bindings/value_sync.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const valueSync = await import(moduleUrl);

function testLiveTargetVolumeReplacesStaleCache() {
  const resolved = valueSync.resolveBindingVolumeValue({
    bindingId: "binding-1",
    targetVolume: 0.14,
    cachedVolume: 0.42,
    interactionTimes: {},
    now: 10_000,
  });

  assert.equal(resolved.value, 0.14);
  assert.equal(resolved.source, "target");
}

function testCacheIsPreservedWhenTargetVolumeUnavailable() {
  const resolved = valueSync.resolveBindingVolumeValue({
    bindingId: "binding-1",
    targetVolume: null,
    cachedVolume: 0.42,
    interactionTimes: {},
    now: 10_000,
  });

  assert.equal(resolved.value, 0.42);
  assert.equal(resolved.source, "cache");
}

function testRecentSliderMovementIsNotClobberedBySessionRefresh() {
  const resolved = valueSync.resolveBindingVolumeValue({
    bindingId: "binding-1",
    targetVolume: 0.14,
    cachedVolume: 0.42,
    interactionTimes: { "binding-1": 9_500 },
    now: 10_000,
  });

  assert.equal(resolved.value, 0.42);
  assert.equal(resolved.source, "cache");
  assert.equal(resolved.userActive, true);
}

function testTargetChangePrefersLiveVolume() {
  assert.equal(valueSync.resolveTargetChangeVolumeValue({
    targetVolume: 0.14,
    cachedVolume: 0.42,
  }), 0.14);
}

testLiveTargetVolumeReplacesStaleCache();
testCacheIsPreservedWhenTargetVolumeUnavailable();
testRecentSliderMovementIsNotClobberedBySessionRefresh();
testTargetChangePrefersLiveVolume();

console.log("Binding value sync tests passed");

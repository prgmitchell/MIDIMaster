import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/features/bindings/reorder.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { reorderVisibleBindings } = await import(moduleUrl);

function binding(id) {
  return { id };
}

function ids(bindings) {
  return bindings.map((item) => item.id);
}

function testAllListReorderMatchesCurrentBehavior() {
  const input = ["a", "b", "c", "d"].map(binding);
  const result = reorderVisibleBindings(input, ["a", "b", "c", "d"], "b", 2);

  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.bindings), ["a", "c", "b", "d"]);
  assert.deepEqual(ids(input), ["a", "b", "c", "d"]);
}

function testFilteredButtonsReorderOnlyVisibleSubset() {
  const input = ["fader-a", "button-a", "fader-b", "button-b"].map(binding);
  const result = reorderVisibleBindings(input, ["button-a", "button-b"], "button-b", 0);

  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.bindings), ["fader-a", "button-b", "fader-b", "button-a"]);
  assert.equal(result.bindings[0], input[0]);
  assert.equal(result.bindings[2], input[2]);
}

function testFilteredFadersReorderOnlyVisibleSubset() {
  const input = ["fader-a", "button-a", "fader-b", "button-b"].map(binding);
  const result = reorderVisibleBindings(input, ["fader-a", "fader-b"], "fader-a", 1);

  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.bindings), ["fader-b", "button-a", "fader-a", "button-b"]);
  assert.equal(result.bindings[1], input[1]);
  assert.equal(result.bindings[3], input[3]);
}

function testSearchResultReorderUsesSparseVisibleSlots() {
  const input = ["a", "b", "c", "d", "e"].map(binding);
  const result = reorderVisibleBindings(input, ["b", "d", "e"], "b", 2);

  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.bindings), ["a", "d", "c", "e", "b"]);
  assert.equal(result.bindings[0], input[0]);
  assert.equal(result.bindings[2], input[2]);
}

function testHiddenRowsRemainAtSameFullIndexes() {
  const hiddenStart = binding("hidden-start");
  const hiddenMiddle = binding("hidden-middle");
  const hiddenEnd = binding("hidden-end");
  const input = [hiddenStart, binding("visible-a"), hiddenMiddle, binding("visible-b"), hiddenEnd];
  const result = reorderVisibleBindings(input, ["visible-a", "visible-b"], "visible-a", 1);

  assert.equal(result.changed, true);
  assert.equal(result.bindings[0], hiddenStart);
  assert.equal(result.bindings[2], hiddenMiddle);
  assert.equal(result.bindings[4], hiddenEnd);
  assert.deepEqual(ids(result.bindings), ["hidden-start", "visible-b", "hidden-middle", "visible-a", "hidden-end"]);
}

function assertNoop(input, visibleIds, draggedId, destinationVisibleIndex) {
  const result = reorderVisibleBindings(input, visibleIds, draggedId, destinationVisibleIndex);
  assert.equal(result.changed, false);
  assert.equal(result.bindings, input);
}

function testNoopsForSamePositionAndInvalidInputs() {
  assertNoop(["a", "b", "c"].map(binding), ["a", "b", "c"], "b", 1);
  assertNoop(["a", "b", "c"].map(binding), ["a", "b", "c"], "missing", 0);
  assertNoop(["a", "b", "c"].map(binding), ["a", "missing", "c"], "a", 1);
  assertNoop(["a", "b", "c"].map(binding), ["a", "b", "b"], "a", 1);
  assertNoop([binding("a"), binding("a"), binding("b")], ["a", "b"], "a", 1);
  assertNoop(["a", "b", "c"].map(binding), ["a", "b", "c"], "a", -1);
  assertNoop(["a", "b", "c"].map(binding), ["a", "b", "c"], "a", 3);
}

testAllListReorderMatchesCurrentBehavior();
testFilteredButtonsReorderOnlyVisibleSubset();
testFilteredFadersReorderOnlyVisibleSubset();
testSearchResultReorderUsesSparseVisibleSlots();
testHiddenRowsRemainAtSameFullIndexes();
testNoopsForSamePositionAndInvalidInputs();

console.log("Binding reorder tests passed");

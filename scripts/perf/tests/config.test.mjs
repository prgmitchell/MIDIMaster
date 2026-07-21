import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("installed journeys form a deterministic, unique automation contract", async () => {
  const config = JSON.parse(await readFile(new URL("../config/installed-journeys.json", import.meta.url), "utf8"));
  assert.equal(config.schema_version, "1.0.0");
  assert.equal(new Set(config.journeys.map((journey) => journey.id)).size, config.journeys.length);
  for (const journey of config.journeys) {
    assert.ok(journey.steps.length > 0, `${journey.id} has steps`);
    assert.match(journey.measure, /^(startup|interaction|storage)\./);
  }
  assert.notEqual(config.windows.main.entry, config.windows.osd.entry);
  assert.notEqual(config.windows.main.entry, config.windows.update.entry);
  assert.equal(config.windows.main.ready_marker, "bindings-usable");
  assert.equal(config.windows.osd.ready_marker, "osd-ready");
  assert.equal(config.windows.update.ready_marker, "update-ready");
});

test("MIDI journey matrix matches the feature-gated command contract", async () => {
  const config = JSON.parse(await readFile(new URL("../config/midi-journeys.json", import.meta.url), "utf8"));
  assert.deepEqual(config.rates_per_second, [125, 500, 1000]);
  assert.deepEqual(config.control_counts, [1, 16]);
  assert.deepEqual(config.limits.message_kinds, ["continuous", "button", "action"]);
  assert.deepEqual(config.commands.invoke_keys, ["messageCount", "ratePerSecond", "controlCount", "messageKind"]);
});

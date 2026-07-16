import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/features/bindings/soundboard_editor.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const {
  clampSoundboardTrim,
  formatSoundboardTime,
  soundboardArrowStep,
  soundboardTimelineInterval,
} = await import(moduleUrl);

assert.deepEqual(clampSoundboardTrim(950, 960, 1000, "start"), { startMs: 950, endMs: 1000 });
assert.deepEqual(clampSoundboardTrim(40, 45, 1000, "end"), { startMs: 0, endMs: 45 });
assert.deepEqual(clampSoundboardTrim(-20, 2000, 1000), { startMs: 0, endMs: 1000 });
assert.deepEqual(clampSoundboardTrim(0, 20, 20), { startMs: 0, endMs: 20 });
assert.equal(soundboardArrowStep({ shiftKey: false }), 10);
assert.equal(soundboardArrowStep({ shiftKey: true }), 100);
assert.equal(formatSoundboardTime(65_004), "1:05.004");
assert.equal(soundboardTimelineInterval(8_000), 1_000);
assert.equal(soundboardTimelineInterval(25_000), 5_000);
assert.equal(soundboardTimelineInterval(90_000), 10_000);
assert.equal(soundboardTimelineInterval(240_000), 30_000);
assert.equal(soundboardTimelineInterval(600_000), 60_000);

console.log("Soundboard editor tests passed");

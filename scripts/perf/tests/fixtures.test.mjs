import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProfilesFixture, generateFixtureMatrix, SHAPE_TARGET_BYTES } from "../generate-fixtures.mjs";

test("icon-heavy profile fixtures hit their aggregate byte targets", () => {
  for (const shape of ["0.6mb", "5mb"]) {
    const fixture = createProfilesFixture({ bindingCount: 13, profileCount: 1, shape });
    assert.equal(fixture.bytes, SHAPE_TARGET_BYTES[shape]);
    assert.equal(Buffer.byteLength(fixture.text), fixture.bytes);
    assert.match(fixture.profiles[0].bindings[0].targets[0].Integration.data.icon_data, /^data:image\/svg\+xml;base64,/);
  }
});

test("zero-binding shapes stay semantically empty", () => {
  const fixture = createProfilesFixture({ bindingCount: 0, profileCount: 10, shape: "5mb" });
  assert.equal(fixture.iconCount, 0);
  assert.ok(fixture.profiles.every((profile) => profile.bindings.length === 0));
  assert.ok(fixture.bytes < fixture.targetBytes);
});

test("MIDI fixtures expose deterministic continuous, button, and action controls", () => {
  const fixture = createProfilesFixture({ bindingCount: 128, profileCount: 1, shape: "light" });
  const bindings = fixture.profiles[0].bindings;
  assert.equal(bindings[0].control.msg_type, "ProgramChange");
  assert.equal(bindings[0].control.channel, 0);
  assert.equal(bindings[4].control.msg_type, "Note");
  assert.equal(bindings[4].control.channel, 4);
  assert.equal(bindings[1].control.msg_type, "ControlChange");
  assert.equal(bindings[1].control.channel, 1);
  assert.equal(bindings[120].control.controller, 120);
  assert.equal(bindings[124].control.controller, 124);
  assert.equal(bindings[121].control.controller, 121);
});

test("matrix generation writes isolated app-data fixtures and disables online startup work", async () => {
  const root = await mkdtemp(join(tmpdir(), "midimaster-fixture-test-"));
  try {
    const fixtures = await generateFixtureMatrix({
      output: root,
      bindingCounts: [50],
      profileCounts: [1],
      shapes: ["light"],
      pluginModes: ["zero", "one", "all"],
    });
    assert.equal(fixtures.length, 3);
    const appSettings = JSON.parse(await readFile(join(root, "b50-p1-light-plugins-all", "app-data", "MIDIMaster", "app_settings.json"), "utf8"));
    assert.equal(appSettings.auto_check_updates, false);
    assert.equal(appSettings.midi_device_inventory_consent, "disabled");
    const zeroState = JSON.parse(await readFile(join(root, "b50-p1-light-plugins-zero", "app-data", "MIDIMaster", "plugins_state.json"), "utf8"));
    assert.equal(zeroState.disabled.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

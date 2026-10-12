import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { activate } from "../src-tauri/builtin_plugins/fxsound/plugin.mjs";
import {
  bandsForGroup,
  writesForTarget,
  targetValue,
} from "../src-tauri/builtin_plugins/fxsound/src/protocol.js";
import { createRuntime } from "../src-tauri/builtin_plugins/fxsound/src/runtime.js";
import { createAppDom } from "./lib/dom_fixture.mjs";

const original = JSON.parse(
  await readFile(
    new URL("./fixtures/fxsound-status.json", import.meta.url),
    "utf8",
  ),
);
const status = () => structuredClone(original);
const group = (name) => ({
  integration_id: "fxsound",
  kind: "group",
  data: { group: name, label: `EQ ${name}` },
});
assert.deepEqual(
  bandsForGroup(original, "low").map((b) => b.index),
  [0, 1, 2],
);
assert.deepEqual(
  bandsForGroup(original, "mid").map((b) => b.index),
  [3, 4, 5, 6],
);
assert.deepEqual(
  bandsForGroup(original, "high").map((b) => b.index),
  [7, 8, 9],
);
for (const name of ["low", "mid", "high"]) {
  assert.equal(targetValue(group(name), original), 0.5);
  assert.ok(
    writesForTarget(group(name), 0, original).every((w) => w.value === -12),
  );
  assert.ok(
    writesForTarget(group(name), 1, original).every((w) => w.value === 12),
  );
  assert.ok(
    writesForTarget(group(name), 0.5, original).every((w) => w.value === 0),
  );
}
assert.deepEqual(
  writesForTarget({ kind: "band", data: { index: 99 } }, 1, original),
  [],
);

await createAppDom();
const commands = [];
const feedback = [];
const cleanups = [];
let integration;
let tab;
let profileChanged;
const bindings = [
  { id: "low", action: "Volume", targets: [{ Integration: group("low") }] },
];
let remote = status();
const ctx = {
  assets: { readDataUrl: async () => null },
  registerIntegration: (value) => {
    integration = value;
  },
  connections: {
    registerTab: (value) => {
      tab = value;
    },
  },
  profile: {
    get: () => ({ auto_connect: false }),
    set: async () => {},
    onChanged: (handler) => {
      profileChanged = handler;
    },
  },
  bindings: { getAll: () => bindings, onChanged: () => {} },
  lifecycle: { onDispose: (handler) => cleanups.push(handler) },
  app: { invalidateBindingsUI: () => {} },
  feedback: { set: async (...args) => feedback.push(args) },
  tauri: {
    invoke: async (command, args = {}) => {
      commands.push({ command, args });
      if (command === "fxsound_snapshot")
        return {
          installed: true,
          connected: true,
          detail: "Connected",
          status: structuredClone(remote),
        };
      if (command === "fxsound_write") {
        for (const write of args.writes) {
          if (write.kind === "band")
            remote.equalizer.bands.find((b) => b.index === write.index).gain =
              write.value;
          if (write.kind === "power") remote.power = write.value;
        }
        return;
      }
      if (command === "fxsound_select_preset") {
        remote.selected_preset = args.name;
        return;
      }
      throw new Error(`Unexpected command ${command}`);
    },
  },
};

try {
  await activate(ctx);
  assert.equal(
    commands.length,
    0,
    "no native work before opting into connection",
  );
  const container = document.createElement("div");
  document.body.append(container);
  tab.mount(container);
  await container.querySelector('[data-role="connect"]').onclick();
  assert.equal(
    integration.describeTarget({ Integration: group("low") }).ghost,
    false,
  );
  assert.equal(
    integration
      .getTargetOptions({ controlType: "fader" })
      .filter((o) => o.target?.Integration.kind === "group").length,
    3,
  );
  assert.equal(
    container.querySelectorAll('input[type="range"], select').length,
    0,
    "plugin page has connection setup only",
  );
  assert.equal(
    container.querySelector('[data-role="power"]'),
    null,
    "processing belongs to bindings",
  );
  assert.equal(feedback[0][1], 0.5, "startup sync reads remote neutral gain");
  assert.equal(feedback[0][3].silent, true);

  const before = commands.filter((c) => c.command === "fxsound_write").length;
  for (const value of [0.1, 0.3, 0.7])
    await integration.onBindingTriggered({
      binding_id: "low",
      action: "Volume",
      value,
      target: group("low"),
    });
  await integration.prepareStateCapture({ refresh: true });
  const writes = commands
    .filter((c) => c.command === "fxsound_write")
    .slice(before);
  assert.equal(writes.length, 1, "rapid moves coalesce into one write");
  assert.equal(
    writes[0].args.writes.length,
    3,
    "all low bands are batched together",
  );
  assert.ok(
    writes[0].args.writes.every((w) => w.value === 4.8),
    "latest value wins",
  );
  assert.ok(
    Math.abs(integration.captureTargetState(group("low")).value - 0.7) <
      0.00001,
  );
  assert.equal(
    await integration.restoreTargetState(group("low"), { value: 0.5 }),
    true,
  );
  assert.ok(remote.equalizer.bands.slice(0, 3).every((b) => b.gain === 0));
  assert.equal(
    await integration.restoreTargetState(
      { kind: "reset", data: {} },
      { value: 1 },
    ),
    false,
  );
  remote.equalizer.bands[0].gain = 1;
  remote.equalizer.bands[1].gain = 2;
  remote.equalizer.bands[2].gain = 3;
  await integration.prepareStateCapture({ refresh: true });
  // Allow the local fader echo guard to expire before capturing external edits.
  await new Promise((resolve) => setTimeout(resolve, 1550));
  await integration.prepareStateCapture({ refresh: true });
  const varied = integration.captureTargetState(group("low"));
  assert.deepEqual(
    varied.bands.map((b) => b.gain),
    [1, 2, 3],
  );
  await integration.restoreTargetState(group("low"), { value: 0.5 });
  await integration.restoreTargetState(group("low"), varied);
  assert.deepEqual(
    remote.equalizer.bands.slice(0, 3).map((b) => b.gain),
    [1, 2, 3],
    "profile recall preserves unequal gains in a group",
  );

  const preset = {
    integration_id: "fxsound",
    kind: "preset",
    data: { name: "Bass Boost" },
  };
  await integration.onBindingTriggered({
    binding_id: "preset",
    action: "SetMainOutputDevice",
    value: 0,
    target: preset,
  });
  assert.equal(
    commands.some((c) => c.command === "fxsound_select_preset"),
    false,
    "button release never switches a preset",
  );
  await integration.onBindingTriggered({
    binding_id: "preset",
    action: "SetMainOutputDevice",
    value: 1,
    target: preset,
  });
  assert.equal(remote.selected_preset, "Bass Boost");
  assert.ok(
    feedback.some(
      (f) => f[0] === "preset" && f[1] === 0 && f[3].forceHardwareFeedback,
    ),
    "momentary buttons clear feedback",
  );
  const power = integration
    .getTargetOptions({ controlType: "button" })
    .find((option) => option.target?.Integration.kind === "power");
  assert.ok(power, "processing remains available through bindings");
  assert.ok(
    integration
      .getTargetOptions({ controlType: "button", nav: { section: "presets" } })
      .some((option) => option.target?.Integration.data.name === "General"),
    "presets remain available through bindings",
  );

  container.querySelector('[data-role="connect"]').onclick();
  const disconnectedCommands = commands.length;
  profileChanged({ settings: { auto_connect: false } });
  await integration.onBindingTriggered({
    binding_id: "low",
    action: "Volume",
    value: 1,
    target: group("low"),
  });
  assert.equal(
    commands.length,
    disconnectedCommands,
    "manual disconnect stops writes",
  );
  assert.equal(
    integration.describeTarget({ Integration: group("low") }).ghost,
    true,
  );
  tab.unmount();
} finally {
  cleanups.forEach((cleanup) => cleanup());
}

// A delayed native command must not cause unbounded overlapping launches or lose the final fader value.
let release;
let started;
const began = new Promise((resolve) => {
  started = resolve;
});
const delayedCommands = [];
const state = {
  snapshot: { installed: true, connected: true, status: status() },
  settings: { auto_connect: false },
  disposed: false,
};
const delayedCtx = {
  ...ctx,
  bindings: { getAll: () => [] },
  tauri: {
    invoke: async (command, args) => {
      delayedCommands.push(args);
      if (delayedCommands.length === 1) {
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
    },
  },
};
const runtime = createRuntime({ ctx: delayedCtx, state, updateUi: () => {} });
await runtime.write([{ kind: "band", index: 0, value: 1 }]);
const first = runtime.flush();
await began;
await runtime.write([{ kind: "band", index: 0, value: 2 }]);
await runtime.write([{ kind: "band", index: 0, value: 3 }]);
assert.equal(delayedCommands.length, 1);
release();
await first;
await runtime.flush();
assert.equal(delayedCommands.length, 2);
assert.deepEqual(delayedCommands[1].writes, [
  { kind: "band", index: 0, value: 3 },
]);
runtime.dispose();
await runtime.write([{ kind: "band", index: 0, value: 4 }]);
assert.equal(delayedCommands.length, 2, "disposed plugins never write");
console.log(
  "FxSound plugin targets, batching, feedback, UI, profiles, and disposal tests passed",
);

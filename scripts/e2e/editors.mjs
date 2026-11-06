import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./desktop.mjs";
import { targetDetails } from "./details.mjs";

function silenceWav() {
  const data = Buffer.alloc(44100 * 2 * 2),
    header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(88200, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export const editors = [
  [
    "profile export writes a reloadable file through the native command",
    async (app) => {
      const path = join(app.root, "exported-profile.json");
      await app.chooseFile(path);
      await app.click("#profile-toggle");
      await app.click("#profile-list .create button.icon-action:last-child");
      await app.shown("#alert-overlay");
      await app.click("#alert-ok");
      const exported = JSON.parse(await readFile(path, "utf8"));
      assert.equal(exported.name, "Performance Default");
      assert.equal(exported.bindings.length, 50);
      if (await app.visible("#profile-list"))
        await app.click("#profile-toggle");
    },
  ],
  [
    "profile import loads macros, soundboard and hotkey mappings",
    async (app) => {
      const source = await app.invoke("get_active_profile");
      const base = source.bindings[0];
      const audio = join(app.root, "silence.wav");
      await writeFile(audio, silenceWav());
      const profile = {
        ...source,
        name: "E2E Editors",
        target_states: [],
        bindings: [
          {
            ...base,
            id: "editor-macro",
            name: "Macro",
            targets: ["Macro"],
            action: "Macro",
            macro_steps: [{ kind: "wait", duration_ms: 100 }],
            device_id: "e2e-fixture",
            control: { channel: 0, controller: 1, msg_type: "Note" },
          },
          {
            ...base,
            id: "editor-sound",
            name: "Sound",
            targets: ["Soundboard"],
            action: "Soundboard",
            soundboard: {
              path: audio,
              display: "Silence",
              volume: 0,
              speed: 1,
            },
            device_id: "e2e-fixture",
            control: { channel: 0, controller: 2, msg_type: "Note" },
          },
          {
            ...base,
            id: "editor-hotkey",
            name: "Hotkey",
            targets: ["Hotkey"],
            action: "Hotkey",
            hotkey: { keys: ["CTRL", "F12"], display: "Ctrl + F12" },
            device_id: "e2e-fixture",
            control: { channel: 0, controller: 3, msg_type: "Note" },
          },
        ],
      };
      const path = join(app.root, "editors.json");
      await writeFile(path, JSON.stringify(profile));
      await app.chooseFile(path);
      await app.click("#profile-toggle");
      await app.click("#profile-list .create button.icon-action");
      await app.shown("#alert-overlay");
      assert.match(
        await app.query("#alert-message", "e.textContent"),
        /imported/i,
      );
      await app.click("#alert-ok");
      assert.equal(
        (await app.invoke("get_active_profile")).name,
        "E2E Editors",
      );
      assert.equal(
        await app.eval(
          "document.querySelectorAll('#bindings > [data-binding-id]').length",
        ),
        3,
      );
    },
  ],
  [
    "macro editor adds and saves a timed step",
    async (app) => {
      await app.click(
        "[data-binding-id='editor-macro'] .binding-macro-edit-button",
      );
      await app.shown(".binding-config-macro-add-actions");
      await app.clickText(
        ".binding-config-macro-add-actions button",
        "Add Wait",
      );
      await app.click("#binding-config-save");
      await app.hidden("#binding-config-panel");
      await eventually(
        async () =>
          (await app.invoke("get_active_profile")).bindings[0].macro_steps
            .length === 2,
        "macro step saved",
      );
    },
  ],
  [
    "soundboard decodes a real audio file and saves keyboard trim edits",
    async (app) => {
      await app.click(
        "[data-binding-id='editor-sound'] .binding-soundboard-edit-button",
      );
      await app.shown("#binding-config-soundboard-waveform");
      await eventually(
        () =>
          app.query("#binding-config-soundboard-end", "Number(e.max) === 2000"),
        "decoded waveform",
      );
      await app.click("#binding-config-soundboard-start");
      await app.key("Home", 36);
      await app.key("ArrowRight", 39);
      assert.equal(
        await app.query("#binding-config-soundboard-start", "Number(e.value)"),
        10,
      );
      await app.click("#binding-config-save");
      await app.hidden("#binding-config-panel");
      await eventually(
        async () =>
          (await app.invoke("get_active_profile")).bindings.find(
            (b) => b.id === "editor-sound",
          ).soundboard.trim_start_ms === 10,
        "soundboard trim saved",
      );
      assert.deepEqual(
        (await app.invoke("get_active_profile")).bindings.map((b) => b.id),
        ["editor-macro", "editor-sound", "editor-hotkey"],
        "editing preserves binding order",
      );
      await assert.rejects(
        app.invoke("analyze_soundboard_audio", {
          path: join(app.root, "missing.wav"),
        }),
      );
    },
  ],
  ...targetDetails,
  [
    "invalid profile imports preserve the active profile",
    async (app) => {
      const path = join(app.root, "invalid-profile.json");
      await writeFile(path, "{broken");
      await app.chooseFile(path);
      await app.click("#profile-toggle");
      await app.click("#profile-list .create button.icon-action");
      await app.shown("#alert-overlay");
      assert.match(
        await app.query("#alert-message", "e.textContent"),
        /Invalid profile JSON/,
      );
      await app.click("#alert-ok");
      assert.equal(
        (await app.invoke("get_active_profile")).name,
        "E2E Editors",
      );
      if (!(await app.visible("#profile-list")))
        await app.click("#profile-toggle");
      await app.click(
        "#profile-list [data-profile-name='Performance Default'] > button:first-child",
      );
      await app.hidden("#profile-list");
    },
  ],
];

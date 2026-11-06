import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./desktop.mjs";

const activeBinding = async (app, id) =>
  (await app.invoke("get_active_profile")).bindings.find((b) => b.id === id);
const configure = async (app, id) => {
  await app.click(
    `[data-binding-id='${id}'] .binding-actions .binding-action:not(.delete)`,
  );
  await app.shown("#binding-config-panel");
};
const save = async (app) => {
  await app.click("#binding-config-save");
  await app.hidden("#binding-config-panel");
};
const target = async (app, name) => {
  await app.click(
    "[data-binding-id='editor-hotkey'] .binding-target-dropdown > button > .caret",
  );
  await app.shown("#target-panel");
  await app.fill("#target-panel-search", name);
  await app.clickText("#target-panel-list .target-label", name);
};

export const faderDetails = [
  [
    "additional fader outputs save MIDI addresses and can be removed",
    async (app) => {
      await configure(app, "perf-binding-1");
      await app.click("#binding-config-output-add");
      await app.click("[data-output-kind='Led']");
      const extra =
        ".binding-config-output-row:not([data-output-id^='default-'])";
      await app.select(`${extra} [data-output-type]`, "ControlChange");
      await app.fill(`${extra} [data-output-channel]`, "");
      assert.equal(
        await app.query(`${extra} [data-output-channel]`, "e.value"),
        "",
        "clearing a number field must not insert a default before the next keystroke",
      );
      await app.fill(`${extra} [data-output-channel]`, "3");
      await app.fill(`${extra} [data-output-control]`, "20");
      await save(app);
      await eventually(
        async () =>
          (await activeBinding(app, "perf-binding-1")).additional_outputs?.[0]
            ?.control.controller === 20,
        "additional output persisted",
      );
      assert.equal(
        (await activeBinding(app, "perf-binding-1")).additional_outputs[0]
          .control.channel,
        2,
      );
      await configure(app, "perf-binding-1");
      await app.click(`${extra} [data-output-remove]`);
      await save(app);
      assert.equal(
        (await activeBinding(app, "perf-binding-1")).additional_outputs
          ?.length || 0,
        0,
      );
    },
  ],
  [
    "custom curve presets persist and button feedback settings save",
    async (app) => {
      await configure(app, "perf-binding-1");
      await app.click('[data-curve="Custom"]');
      await app.click("#binding-config-curve-preset-save");
      await app.fill("#binding-config-curve-preset-name", "E2E Curve");
      await app.click("#binding-config-curve-preset-form-save");
      await eventually(
        async () =>
          (await app.invoke("get_app_settings")).fader_curve_presets.some(
            (p) => p.name === "E2E Curve",
          ),
        "curve preset saved",
      );
      await app.click('[data-curve="Linear"]');
      await save(app);
      await configure(app, "perf-binding-0");
      await app.select("#binding-config-button-light-select", "Pressed");
      await save(app);
      assert.equal(
        (await activeBinding(app, "perf-binding-0")).button_light_mode,
        "Activity",
      );
      assert.equal(
        (await activeBinding(app, "perf-binding-0")).button_light_behavior,
        "Pressed",
      );
    },
  ],
];

export const targetDetails = [
  [
    "hotkey learning records keyboard input and cancellation preserves the draft",
    async (app) => {
      // Selecting an existing target removes it. Re-add it to start learning.
      await target(app, "Hotkey");
      await app.hidden("#target-panel");
      await target(app, "Hotkey");
      await app.shown("#learn-panel");
      await app.click("#learn-panel-cancel");
      await app.hidden("#learn-panel");
      assert.equal(
        (await activeBinding(app, "editor-hotkey"))?.hotkey ?? null,
        null,
      );
      await target(app, "Hotkey");
      await app.shown("#learn-panel");
      await app.key("F11", 122, 2);
      await app.hidden("#learn-panel");
      await eventually(
        async () =>
          (await activeBinding(app, "editor-hotkey")).hotkey?.keys.includes(
            "F11",
          ),
        "learned hotkey saved",
      );
    },
  ],
  [
    "application selection validates a real executable and preserves literal arguments",
    async (app) => {
      const executable = join(
        process.env.SystemRoot || "C:/Windows",
        "System32",
        "notepad.exe",
      );
      await app.chooseFile(executable);
      await target(app, "Open Application");
      await app.shown(".application-launch-editor");
      await app.click(".application-launch-path button");
      await eventually(
        () =>
          app.query(
            ".application-launch-actions [type='submit']",
            "!e.disabled",
          ),
        "native executable selection",
      );
      const args = '"a file.txt" & literal';
      await app.fill(
        ".application-launch-editor > label:nth-child(2) input",
        args,
      );
      await app.click(".application-launch-actions [type='submit']");
      await app.hidden("#target-panel");
      await eventually(
        async () =>
          (await activeBinding(app, "editor-hotkey")).open_application
            ?.arguments === args,
        "application parameters saved",
      );
      assert.equal(
        (await activeBinding(app, "editor-hotkey")).open_application.path,
        executable,
      );
    },
  ],
  [
    "AutoHotkey script selection saves the file without executing it",
    async (app) => {
      const script = join(app.root, "example.ahk");
      await writeFile(
        script,
        "; E2E selection fixture. Never executed.\nExitApp\n",
      );
      await app.chooseFile(script);
      await target(app, "AutoHotkey Script");
      await app.hidden("#target-panel");
      await eventually(
        async () =>
          (await activeBinding(app, "editor-hotkey")).autohotkey_script
            ?.path === script,
        "script selection saved",
      );
    },
  ],
];

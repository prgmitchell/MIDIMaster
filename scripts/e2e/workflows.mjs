import assert from "node:assert/strict";
import { eventually } from "./desktop.mjs";
import { midiCollectionExpression } from "../perf/lib/midi-collection.mjs";
import { validateMidiResult } from "../perf/lib/midi-validation.mjs";
import { faderDetails } from "./details.mjs";

const binding = (id) => `[data-binding-id='perf-binding-${id}']`;
async function configure(app, id) {
  await app.click(
    `${binding(id)} .binding-actions .binding-action:not(.delete)`,
  );
  await app.shown("#binding-config-panel");
}

export const workflows = [
  [
    "MIDI bursts reach native actions and visible values without dropped events",
    async (app) => {
      for (const messageKind of ["continuous", "button", "action"]) {
        const result = await app.eval(
          midiCollectionExpression({
            messageCount: 300,
            ratePerSecond: 500,
            controlCount: 6,
            messageKind,
          }),
        );
        validateMidiResult(result, {
          requireRenderer: messageKind === "continuous",
        });
        assert.equal(result.snapshot.queue.dropped, 0);
        assert.equal(result.snapshot.dispatched_value.mismatches, 0);
        assert.ok(
          result.snapshot.native_action.p95_us < 1_000_000,
          "MIDI p95 below one second in debug builds",
        );
        await app.json(`midi-${messageKind}.json`, result);
      }
    },
  ],
  [
    "fader curves and feedback controls save real binding configuration",
    async (app) => {
      await configure(app, 1);
      await app.click('[data-curve="Exponential"]');
      await app.click("#binding-config-save");
      await app.hidden("#binding-config-panel");
      await eventually(
        async () =>
          (await app.invoke("get_active_profile")).bindings.find(
            (b) => b.id === "perf-binding-1",
          ).fader_curve === "Exponential",
        "curve saved",
      );
      await configure(app, 1);
      assert.equal(
        await app.query(
          '[data-curve="Exponential"]',
          "e.getAttribute('aria-selected')",
        ),
        "true",
      );
      await app.click('[data-curve="Linear"]');
      await app.click("#binding-config-save");
      await app.hidden("#binding-config-panel");
    },
  ],
  [
    "MIDI route drafts can be cancelled without changing saved routing",
    async (app) => {
      const before = (await app.invoke("get_active_profile"))
        .midi_device_preference;
      await app.click(".midi-routes-button");
      await app.shown(".midi-routes-popover");
      await app.clickText(".midi-routes-popover button", "Add Route");
      await app.clickText(".midi-routes-popover button", "Cancel");
      await app.hidden(".midi-routes-popover");
      assert.deepEqual(
        (await app.invoke("get_active_profile")).midi_device_preference,
        before,
      );
    },
  ],
  ...faderDetails,
  [
    "profile creation escapes user text and persists independently",
    async (app) => {
      await app.click("#profile-toggle");
      await app.fill("#profile-list .create input", "E2E <b>profile</b>");
      await app.click("#profile-list .create button");
      await eventually(
        async () =>
          (await app.invoke("get_active_profile")).name ===
          "E2E <b>profile</b>",
        "created profile",
      );
      assert.equal(
        await app.query("#profile-current", "e.querySelector('b')"),
        null,
      );
      assert.ok(
        (await app.invoke("list_profiles")).some(
          (p) => p.name === "E2E <b>profile</b>",
        ),
      );
      await app.hidden("#profile-list");
      await app.click("#profile-toggle");
      await app.click(
        "#profile-list [data-profile-name='Performance Default'] > button:first-child",
      );
      await eventually(
        async () =>
          (await app.invoke("get_active_profile")).name ===
          "Performance Default",
        "return to original profile",
      );
      await app.hidden("#profile-list");
    },
  ],
  [
    "general settings and locale changes reach native storage and survive reload",
    async (app) => {
      await app.click("[data-page='settings']");
      await app.shown("#settings-panel");
      const before = (await app.invoke("get_app_settings")).minimize_to_tray;
      await app.click("#minimize-to-tray + span");
      await eventually(
        async () =>
          (await app.invoke("get_app_settings")).minimize_to_tray === !before,
        "tray preference",
      );
      await app.select("#language-select", "de");
      await eventually(
        () => app.eval("document.documentElement.lang === 'de'"),
        "German translation",
      );
      assert.equal((await app.invoke("get_app_settings")).language, "de");
      await app.select("#language-select", "en");
      await eventually(
        () => app.eval("document.documentElement.lang === 'en'"),
        "English translation",
      );
    },
  ],
  [
    "appearance presets and OSD preferences persist",
    async (app) => {
      await app.click("[data-settings-section='appearance']");
      await app.click("[data-appearance-preset='light']");
      await eventually(
        async () =>
          (await app.invoke("get_app_settings")).appearance.active_theme_id ===
          "light",
        "light appearance",
      );
      await app.click("[data-settings-section='osd']");
      const before = (await app.invoke("get_osd_settings")).enabled;
      await app.click("#osd-enabled + span");
      await eventually(
        async () => (await app.invoke("get_osd_settings")).enabled === !before,
        "OSD preference",
      );
      await app.click("#osd-enabled + span");
    },
  ],
  [
    "virtual audio status renders native installation state",
    async (app) => {
      await app.click("[data-settings-section='virtual-audio']");
      await app.shown("#virtual-audio-panel");
      await eventually(
        () =>
          app.query(
            "#virtual-audio-panel",
            "e.dataset.virtualAudioState !== 'loading'",
          ),
        "virtual audio state",
      );
      assert.ok(await app.invoke("get_virtual_audio_status"));
      await app.click("[data-page='bindings']");
    },
  ],
  [
    "bundled plugins can be disabled and re-enabled through the UI",
    async (app) => {
      await app.click("[data-page='plugins']");
      await app.shown(".connection-tab.active .plugins-browser");
      for (const id of ["obs", "hue", "wavelink", "voicemeeter", "fxsound"]) {
        await app.fill(
          ".connection-tab.active .plugins-browser [data-role='search']",
          id,
        );
        await eventually(
          () =>
            app.eval(
              `document.querySelectorAll('.connection-tab.active .plugins-browser-card').length === 1 && document.querySelector('.connection-tab.active .plugins-browser-card').textContent.toLowerCase().includes(${JSON.stringify(id)})`,
            ),
          `plugin ${id}`,
        );
        await eventually(
          () =>
            app.query(
              ".connection-tab.active .plugins-browser-card .plugins-toggle input",
              "e && !e.disabled && e.checked",
            ),
          `${id} toggle ready`,
        );
        await app.click(
          ".connection-tab.active .plugins-browser-card .plugins-toggle",
        );
        await eventually(
          async () =>
            !(await app.invoke("list_plugins")).find((p) => p.id === id)
              .enabled,
          `${id} disabled`,
        );
        await app.fill(
          ".connection-tab.active .plugins-browser [data-role='search']",
          id,
        );
        await eventually(
          () =>
            app.query(
              ".connection-tab.active .plugins-browser-card .plugins-toggle input",
              "e && !e.disabled && !e.checked",
            ),
          `${id} reload completed`,
        );
        await app.click(
          ".connection-tab.active .plugins-browser-card .plugins-toggle",
        );
        await eventually(
          async () =>
            (await app.invoke("list_plugins")).find((p) => p.id === id).enabled,
          `${id} enabled`,
        );
      }
      await app.fill(
        ".connection-tab.active .plugins-browser [data-role='search']",
        "",
      );
      await app.click("[data-page='bindings']");
    },
  ],
];

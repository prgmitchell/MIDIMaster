import assert from "node:assert/strict";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./desktop.mjs";

export const audioDevices = [
  [
    "one MIDI button switches audio devices in both directions and preserves its saved selection",
    async (app) => {
      const original = await app.invoke("get_active_profile");
      const fixturePath = join(app.data, "e2e-audio.json");
      const device = (id, display_name, is_default = false) => ({
        id,
        display_name,
        is_default,
        icon_data: null,
        volume: 0.5,
        is_muted: false,
      });
      const headphones = device("headphones", "E2E Headphones", true);
      const speakers = device("speakers", "E2E Speakers");
      const other = device("other", "E2E Other Output");
      const fixture = {
        playback: [headphones, speakers, other],
        recording: [
          device("mic", "E2E Microphone"),
          device("other-mic", "E2E Other Microphone", true),
        ],
      };
      const writeFixture = async () => {
        await writeFile(`${fixturePath}.tmp`, JSON.stringify(fixture));
        await rename(`${fixturePath}.tmp`, fixturePath);
      };
      const row = "[data-binding-id='e2e-device-switch']";
      const currentBinding = async () =>
        (await app.invoke("get_active_profile")).bindings[0];
      const selectDevice = async (name) => {
        await eventually(
          () =>
            app.eval(
              "window.__MIDIMASTER_PERF__.snapshot().entries.some(e => e.name === 'midi-ready')",
            ),
          "startup device discovery",
          60000,
        );
        await app.click(`${row} .binding-target-dropdown > button > .caret`);
        await app.fill("#target-panel-search", name);
        await app.clickText("#target-panel-list .target-label", name);
        await eventually(
          () =>
            app.query(
              "#target-panel-list",
              "e.textContent.includes('cycle through')",
            ),
          "device cycling hint",
        );
        await app.clickText(
          "#target-panel-list .target-label",
          "Set Default Device",
        );
        await app.hidden("#target-panel");
      };
      const defaultDevice = async (flow = "playback") =>
        (await app.invoke(`list_${flow}_devices`)).find(
          (entry) => entry.is_default,
        )?.id;
      const press = async (expected) => {
        await app.invoke("perf_audit_reset");
        await app.invoke("perf_audit_inject_midi", {
          messageCount: 2,
          ratePerSecond: 20,
          controlCount: 1,
          messageKind: "button",
        });
        await eventually(
          async () =>
            (await app.invoke("perf_audit_snapshot")).action_outcomes
              .processed === 2,
          "press and release processed",
        );
        assert.equal(
          await defaultDevice(),
          expected,
          "one switch per press; release does not switch again",
        );
        const { action_outcomes: outcomes } = await app.invoke(
          "perf_audit_snapshot",
        );
        assert.equal(outcomes.applied, 1);
        assert.equal(outcomes.errors, 0);
      };
      try {
        await writeFixture();
        await app.invoke("save_profile", {
          profile: {
            ...original,
            target_states: [],
            bindings: [
              {
                ...original.bindings[0],
                id: "e2e-device-switch",
                name: "Headphones / speakers",
                device_id: "perf-midi-input",
                control_kind: "Button",
                control: { channel: 4, controller: 4, msg_type: "Note" },
                target: "Unset",
                targets: [],
                action: "ToggleMute",
                debounce_ms: 0,
              },
            ],
          },
        });
        await app.stop();
        await app.start();
        await selectDevice("E2E Headphones");
        await selectDevice("E2E Speakers");
        const selected = [
          { Device: { device_id: "playback:headphones" } },
          { Device: { device_id: "playback:speakers" } },
        ];
        await eventually(
          async () => (await currentBinding()).targets.length === 2,
          "both outputs saved",
        );
        assert.equal((await currentBinding()).action, "SetDefaultDevice");
        assert.deepEqual((await currentBinding()).targets, selected);
        const stored = JSON.parse(
          await readFile(join(app.data, "profiles.json"), "utf8"),
        );
        assert.deepEqual(
          stored.find((profile) => profile.name === original.name).bindings[0]
            .targets,
          selected,
        );
        await press("speakers");
        await press("headphones");
        await app.stop();
        await app.start();
        assert.deepEqual((await currentBinding()).targets, selected);
        await press("speakers");

        // An external default change must take effect without an internal toggle counter.
        await writeFixture(); // headphones are the default again
        await press("speakers");
        fixture.playback = [
          { ...other, is_default: true },
          { ...headphones, is_default: false },
          speakers,
        ];
        await writeFixture();
        await press("headphones"); // outside the selection starts at its first device
        fixture.playback = [{ ...other, is_default: true }, speakers];
        await writeFixture();
        await press("speakers"); // unplugged headphones are skipped

        fixture.playback = [headphones, speakers, other];
        await writeFixture();
        await selectDevice("E2E Microphone");
        await eventually(
          async () => (await currentBinding()).targets.length === 3,
          "microphone saved",
        );
        await press("speakers");
        assert.equal(await defaultDevice("recording"), "mic");
        await app.click(
          `${row} .target-chip[data-index='1'] .target-chip-remove`,
        );
        await eventually(
          async () => (await currentBinding()).targets.length === 2,
          "single output saved",
        );
        await press("headphones");
        await press("headphones"); // single output retains Set Default behavior
      } catch (error) {
        await app.json("device-switch-failure.json", {
          playback: await app.invoke("list_playback_devices"),
          binding: await currentBinding(),
          page: await app.eval("document.body.innerText"),
          labels: await app.eval(
            "Array.from(document.querySelectorAll('#target-panel-list .target-label')).map(e => e.textContent)",
          ),
        });
        throw error;
      } finally {
        await app.invoke("save_profile", { profile: original });
        await app.stop();
        await unlink(fixturePath);
        await app.start();
      }
    },
  ],
];

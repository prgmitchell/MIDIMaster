import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { eventually, pause } from "./desktop.mjs";

export const stateTransitions = [
  [
    "checkpoints survive binding edits and retire when the target is removed",
    async (app) => {
      const profile = await app.invoke("get_active_profile");
      const integration = { integration_id: "e2e-checkpoint", kind: "channel", data: { id: "one", label: "Channel" } };
      const binding = {
        ...profile.bindings[0], id: "checkpoint-binding", device_id: "checkpoint-controller",
        action: "Volume", targets: [{ Integration: integration }],
      };
      const edit = (edits) => app.invoke("edit_profile_bindings", { expectedProfile: profile.name, edits });
      const entry = {
        target: { Integration: { ...integration, data: { id: "one", label: "Renamed channel" } } },
        state: { volume: 0.375 },
      };
      const checkpoint = () => app.invoke("checkpoint_profile_state", {
        profileName: profile.name, targetStates: [entry],
      });
      const storedCheckpoint = async () => {
        const profiles = JSON.parse(await readFile(join(app.data, "profiles.json"), "utf8"));
        const active = profiles.find((p) => p.name === profile.name);
        return active.target_states?.find((item) => item.target.Integration?.integration_id === integration.integration_id);
      };
      await edit({ upsert: [binding] });
      try {
        assert.equal(await checkpoint(), true);
        await edit({ upsert: [{ ...binding, name: "Updated binding" }] });
        assert.deepEqual((await storedCheckpoint())?.state, entry.state);
        await Promise.all([edit({ removeIds: [binding.id] }), checkpoint()]);
        assert.equal(await storedCheckpoint(), undefined);
      } finally {
        await edit({ removeIds: [binding.id] });
      }
    },
  ],
  [
    "binding transactions reject stale profiles and invalid batches without a partial save",
    async (app) => {
      const before = await app.invoke("get_active_profile");
      const [first] = before.bindings;
      const edit = (expectedProfile, edits) => app.invoke("edit_profile_bindings", { expectedProfile, edits });
      const upsert = [{ ...first, name: "Uncommitted rename" }];
      await assert.rejects(edit("Different profile", { upsert }), /Active profile changed/);
      await assert.rejects(edit(before.name, { upsert, order: [] }), /before reorder/);
      const duplicateControl = { ...first, id: first.id + "-duplicate" };
      await assert.rejects(edit(before.name, { upsert: [first, duplicateControl] }), /same MIDI control/);
      await assert.rejects(edit(before.name, { upsert: [duplicateControl, first] }), /same MIDI control/);
      const current = await app.invoke("get_active_profile");
      assert.deepEqual(current.bindings, before.bindings);
      const stored = JSON.parse(await readFile(join(app.data, "profiles.json"), "utf8"));
      assert.equal(stored.find((p) => p.name === before.name).bindings[0].name, first.name);
    },
  ],
  [
    "a binding edit and a preference update preserve each other's changes",
    async (app) => {
      const profile = await app.invoke("get_active_profile");
      const original = profile.bindings.slice(0, 2);
      assert.equal(original.length, 2);
      const changed = original.map((binding) => ({ ...binding, name: binding.name + " edited" }));
      const saveBindings = (upsert) => app.invoke("edit_profile_bindings", {
        expectedProfile: profile.name, edits: { upsert },
      });
      const savePreferences = (pluginSettings) => app.invoke("update_profile_preferences", {
        expectedProfile: profile.name, pluginSettings,
      });
      try {
        await Promise.all([
          saveBindings(changed),
          savePreferences({ ...profile.plugin_settings, e2e: { enabled: true } }),
        ]);
        const active = await app.invoke("get_active_profile");
        const stored = JSON.parse(await readFile(join(app.data, "profiles.json"), "utf8"));
        for (const saved of [active, stored.find((entry) => entry.name === profile.name)]) {
          assert.deepEqual(saved.bindings.slice(0, 2).map((b) => b.name), changed.map((b) => b.name));
          assert.equal(saved.plugin_settings.e2e.enabled, true);
          assert.deepEqual(saved.bindings.map((b) => b.id), profile.bindings.map((b) => b.id));
        }
      } finally {
        await saveBindings(original);
        await savePreferences(profile.plugin_settings);
      }
    },
  ],
  [
    "stale MIDI learning sessions cannot cancel or consume a replacement session",
    async (app) => {
      const stale = await app.invoke("start_midi_learn");
      const current = await app.invoke("start_midi_learn");
      assert.ok(Number.isInteger(stale) && current > stale);
      await app.invoke("cancel_midi_learn", { sessionId: stale });
      assert.equal(
        (await app.invoke("perf_audit_snapshot")).learn_pending,
        true,
      );
      await app.invoke("perf_audit_inject_midi", {
        messageCount: 1,
        ratePerSecond: 100,
        controlCount: 1,
        messageKind: "pitch_bend",
      });
      await eventually(
        async () => !(await app.invoke("perf_audit_snapshot")).learn_pending,
        "replacement session ready",
      );
      assert.equal(
        await app.invoke("consume_learned_control", { sessionId: stale }),
        null,
      );
      assert.equal(
        (await app.invoke("consume_learned_control", { sessionId: current }))
          .msg_type,
        "PitchBend",
      );
      assert.equal(
        await app.invoke("consume_learned_control", { sessionId: current }),
        null,
      );
    },
  ],
  [
    "mapping learn can cancel, restart, preview and roll back without stealing input",
    async (app) => {
      const before = (await app.invoke("get_active_profile")).bindings;
      await app.click(
        `[data-binding-id='${before[0].id}'] .binding-action:not(.delete)`,
      );
      const learn = (await app.visible("#binding-config-button-learn-button"))
        ? "#binding-config-button-learn-button"
        : "#binding-config-preview-learn-button";
      await app.click(learn);
      await app.click("#learn-panel-close");
      await app.click(learn);
      await eventually(
        async () => (await app.invoke("perf_audit_snapshot")).learn_pending,
        "restarted mapping learn",
      );
      await app.invoke("perf_audit_inject_midi", {
        messageCount: 1,
        ratePerSecond: 100,
        controlCount: 1,
        messageKind: "pitch_bend",
      });
      await app.hidden("#learn-panel");
      await eventually(
        async () =>
          (await app.invoke("get_active_profile")).bindings[0].control
            .msg_type === "PitchBend",
        "mapping preview applied",
      );
      await app.click("#binding-config-cancel");
      await app.hidden("#binding-config-panel");
      // The renderer canonicalizes an empty custom curve on persistence.
      const mappings = (bindings) =>
        bindings.map(({ custom_curve, ...binding }) => binding);
      assert.deepEqual(
        mappings((await app.invoke("get_active_profile")).bindings),
        mappings(before),
      );
      assert.equal(
        (await app.invoke("perf_audit_snapshot")).learn_pending,
        false,
      );
    },
  ],
  [
    "MIDI learn cancellation discards pending and completed input before restart",
    async (app) => {
      const inject = (messageKind) =>
        app.invoke("perf_audit_inject_midi", {
          messageCount: 1,
          ratePerSecond: 100,
          controlCount: 1,
          messageKind,
        });
      for (const kind of ["button", "pitch_bend"]) {
        await app.invoke("start_midi_learn");
        assert.equal(await app.invoke("consume_learned_control"), null);
        assert.equal(
          (await app.invoke("perf_audit_snapshot")).learn_pending,
          true,
        );
        await inject(kind);
        if (kind === "pitch_bend")
          await eventually(
            async () =>
              !(await app.invoke("perf_audit_snapshot")).learn_pending,
            "learned result published",
          );
        await app.invoke("cancel_midi_learn");
        await pause(250);
        assert.equal(await app.invoke("consume_learned_control"), null);
        assert.equal(
          (await app.invoke("perf_audit_snapshot")).learn_pending,
          false,
        );
      }
      await app.invoke("start_midi_learn");
      await inject("pitch_bend");
      let learned;
      await eventually(
        async () => (learned = await app.invoke("consume_learned_control")),
        "new learning session completes",
      );
      assert.equal(learned.msg_type, "PitchBend");
      assert.equal(await app.invoke("consume_learned_control"), null);
    },
  ],
  [
    "Hue pairing cancellation ignores a late successful bridge response",
    async (app) => {
      let pairResponse;
      const bridge = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.method === "POST" && request.url === "/api")
          pairResponse = response;
        else response.end("{}");
      });
      await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
      const pane = ".connection-tab.active";
      try {
        await app.stop();
        await app.start("online");
        await app.click("[data-page='plugins']");
        await app.click("button[data-tab='plugin:hue']");
        await app.click(`${pane} [data-role='mode-manual']`);
        await app.fill(
          `${pane} [data-role='bridge-ip']`,
          `127.0.0.1:${bridge.address().port}`,
        );
        await app.click(`${pane} [data-role='pair-action']`);
        await app.shown("#hue-pair-panel");
        await eventually(() => pairResponse, "bridge received pairing request");
        await app.click("#hue-pair-panel [data-role='cancel']");
        pairResponse.end(
          JSON.stringify([{ success: { username: "cancelled-e2e-key" } }]),
        );
        await eventually(
          () => app.query(`${pane} [data-role='pair-action']`, "!e.disabled"),
          "pairing request settled",
        );
        await pause(300);
        assert.match(
          await app.query(`${pane} [data-role='pair-action']`, "e.textContent"),
          /Start pairing/,
        );
        assert.equal(
          (await app.invoke("get_active_profile")).plugin_settings?.hue
            ?.username || "",
          "",
        );
        await app.hidden("#hue-pair-panel");
        // Reload the actual plugin; the shared dialog must use its new owner's handlers.
        await app.click("button[data-tab='installed']");
        await app.fill(`${pane} [data-role='search']`, "hue");
        for (const enabled of [false, true]) {
          await app.click(`${pane} .plugins-browser-card .plugins-toggle`);
          await eventually(
            async () =>
              (await app.invoke("list_plugins")).find((p) => p.id === "hue")
                .enabled === enabled,
            "Hue enabled state persisted",
          );
          await eventually(
            () =>
              app.query(`${pane} .plugins-toggle input`, "e && !e.disabled"),
            "plugin reload completed",
          );
        }
        await app.click("button[data-tab='plugin:hue']");
        await app.click(`${pane} [data-role='mode-manual']`);
        pairResponse = null;
        await app.click(`${pane} [data-role='pair-action']`);
        await eventually(() => pairResponse, "reloaded plugin started pairing");
        await app.click("#hue-pair-panel [data-role='cancel']");
        pairResponse.end(
          JSON.stringify([{ success: { username: "stale-owner-key" } }]),
        );
        await eventually(
          () => app.query(`${pane} [data-role='pair-action']`, "!e.disabled"),
          "reloaded cancellation settled",
        );
        assert.match(
          await app.query(`${pane} [data-role='pair-action']`, "e.textContent"),
          /Start pairing/,
        );
        assert.equal(
          (await app.invoke("get_active_profile")).plugin_settings?.hue
            ?.username || "",
          "",
        );

        // A fresh session still completes normally after the cancelled sessions.
        pairResponse = null;
        await app.click(`${pane} [data-role='pair-action']`);
        await eventually(() => pairResponse, "fresh pairing request");
        pairResponse.end(
          JSON.stringify([{ success: { username: "accepted-e2e-key" } }]),
        );
        await eventually(
          () =>
            app.query(
              `${pane} [data-role='pair-action']`,
              "!e.disabled && e.textContent === 'Unpair'",
            ),
          "new pairing succeeded",
        );
        assert.equal(
          (await app.invoke("get_active_profile")).plugin_settings.hue.username,
          "accepted-e2e-key",
        );
        await app.click(`${pane} [data-role='pair-action']`);
        await eventually(
          async () =>
            !(await app.invoke("get_active_profile")).plugin_settings?.hue
              ?.username,
          "fixture unpaired",
        );
      } finally {
        pairResponse?.end();
        bridge.closeAllConnections();
        await new Promise((resolve) => bridge.close(resolve));
        await app.stop();
        await app.start();
      }
    },
  ],
];

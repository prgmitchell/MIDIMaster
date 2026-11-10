import assert from "node:assert/strict";
import { readFile, writeFile, readdir, mkdir, rename, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./desktop.mjs";

export const lifecycle = [
  [
    "profile deletion cancels safely and removes only the confirmed profile",
    async (app) => {
      const original = (await app.invoke("get_active_profile")).name;
      await app.click("#profile-toggle");
      await app.fill("#profile-list .create input", "E2E Delete");
      await app.click("#profile-list .create button");
      await app.hidden("#profile-list");
      await app.click("#profile-toggle");
      await app.click(
        `#profile-list [data-profile-name='${original}'] > button:first-child`,
      );
      await app.hidden("#profile-list");
      await app.click("#profile-toggle");
      const item = "#profile-list [data-profile-name='E2E Delete']";
      await app.click(`${item} .delete`);
      await app.click(`${item} .secondary`);
      assert.ok(
        (await app.invoke("list_profiles")).some(
          (p) => p.name === "E2E Delete",
        ),
      );
      await app.click(`${item} .delete`);
      await app.click(`${item} .delete.confirm`);
      await eventually(
        async () =>
          !(await app.invoke("list_profiles")).some(
            (p) => p.name === "E2E Delete",
          ),
        "confirmed profile deleted",
      );
      assert.equal((await app.invoke("get_active_profile")).name, original);
      if (await app.visible("#profile-list"))
        await app.click("#profile-toggle");
    },
  ],
  [
    "native theme export and import preserve values and reject oversized files",
    async (app) => {
      const before = (await app.invoke("get_app_settings")).appearance;
      const path = join(app.root, "theme.json");
      await app.chooseFile(path);
      await app.invoke("export_appearance_theme", {
        theme: {
          id: "e2e-theme",
          name: "E2E Theme",
          scheme: "dark",
          base_preset_id: "dark",
          accent_color: "#0099ff",
        },
      });
      assert.equal(
        JSON.parse(await readFile(path, "utf8")).theme.accent_color,
        "#0099ff",
      );
      await app.chooseFile(path);
      const imported = await app.invoke("import_appearance_theme");
      assert.ok(
        imported.custom_themes.some(
          (t) => t.name === "E2E Theme" && t.accent_color === "#0099ff",
        ),
      );
      await writeFile(path, "x".repeat(256 * 1024 + 1));
      await app.chooseFile(path);
      await assert.rejects(app.invoke("import_appearance_theme"), /too large/);
      assert.deepEqual(
        (await app.invoke("get_app_settings")).appearance,
        imported,
      );
      await app.invoke("update_appearance_settings", { appearance: before });
    },
  ],
  [
    "cancelling MIDI learn clears native polling state",
    async (app) => {
      const count = (await app.invoke("get_active_profile")).bindings.length;
      await app.click("#binding-add-footer-button");
      await app.shown("#learn-panel");
      assert.equal(
        (await app.invoke("perf_audit_snapshot")).learn_pending,
        true,
      );
      await app.click("#learn-panel-close");
      await eventually(
        async () => !(await app.invoke("perf_audit_snapshot")).learn_pending,
        "native learn cancelled",
      );
      assert.equal(
        (await app.invoke("get_active_profile")).bindings.length,
        count,
      );
    },
  ],
  [
    "MIDI learn creates a fader through the native input queue and target picker",
    async (app) => {
      const before = (await app.invoke("get_active_profile")).bindings;
      await app.click("#binding-add-footer-button");
      await app.shown("#learn-panel");
      await app.invoke("perf_audit_inject_midi", {
        messageCount: 24,
        ratePerSecond: 120,
        controlCount: 1,
        messageKind: "pitch_bend",
      });
      await app.shown("#target-panel");
      await app.click("#target-panel-close");
      await app.hidden("#learn-panel");
      const after = (await app.invoke("get_active_profile")).bindings;
      assert.equal(after.length, before.length + 1);
      assert.equal(after.at(-1).control.msg_type, "PitchBend");
      assert.equal(after.at(-1).control_kind, "Continuous");
      assert.equal(
        (await app.invoke("perf_audit_snapshot")).learn_pending,
        false,
      );
    },
  ],
  [
    "pointer drag reorders bindings and persists the visible order",
    async (app) => {
      const before = (await app.invoke("get_active_profile")).bindings.map(
        (b) => b.id,
      );
      assert.ok(before.length >= 3);
      await app.query("#bindings", "e.scrollTop = 0");
      await app.drag(
        `[data-binding-id='${before[0]}'] .binding-drag`,
        `[data-binding-id='${before[2]}'] .binding-drag`,
      );
      const visible = await app.eval(
        "Array.from(document.querySelectorAll('#bindings > [data-binding-id]'), e => e.dataset.bindingId)",
      );
      assert.notDeepEqual(visible, before);
      assert.deepEqual([...visible].sort(), [...before].sort());
      await eventually(
        async () =>
          JSON.stringify(
            (await app.invoke("get_active_profile")).bindings.map((b) => b.id),
          ) === JSON.stringify(visible),
        "reordered profile saved",
      );
    },
  ],
  [
    "binding deletion requires confirmation and survives a restart",
    async (app) => {
      const profile = await app.invoke("get_active_profile");
      const id = profile.bindings.at(-1).id;
      await app.fill("#binding-search", profile.bindings.at(-1).name);
      await app.click(`[data-binding-id='${id}'] .binding-action.delete`);
      await app.click("#alert-cancel");
      assert.ok(
        (await app.invoke("get_active_profile")).bindings.some(
          (b) => b.id === id,
        ),
      );
      await app.click(`[data-binding-id='${id}'] .binding-action.delete`);
      await app.click("#alert-ok");
      await eventually(
        async () =>
          !(await app.invoke("get_active_profile")).bindings.some(
            (b) => b.id === id,
          ),
        "binding removed",
      );
      await app.fill("#binding-search", "");
      await app.stop();
      await app.start();
      assert.equal(
        (await app.invoke("get_active_profile")).bindings.length,
        profile.bindings.length - 1,
      );
      assert.equal(await app.visible(`[data-binding-id='${id}']`), false);
    },
  ],
  [
    "unreadable profile storage reports an error without replacing data with a backup",
    async (app) => {
      const before = await app.invoke("list_profiles");
      const profile = await app.invoke("get_active_profile");
      const path = join(app.data, "profiles.json");
      const preserved = join(app.root, "preserved-profiles.json");
      const marker = join(path, "preserve.txt");
      const original = await readFile(path);
      await rename(path, preserved);
      await mkdir(path);
      await writeFile(marker, "original data");
      const filesBefore = await readdir(app.data);
      try {
        await assert.rejects(app.invoke("list_profiles"), /Failed reading/);
        await assert.rejects(app.invoke("save_profile", { profile }), /Failed reading/);
        assert.equal(await readFile(marker, "utf8"), "original data");
        assert.deepEqual(
          (await readdir(app.data)).filter(name => name.includes(".corrupt-")),
          filesBefore.filter(name => name.includes(".corrupt-")),
        );
      } finally {
        await unlink(marker);
        await rmdir(path);
        await rename(preserved, path);
      }
      assert.deepEqual(await readFile(path), original);
      assert.deepEqual(await app.invoke("list_profiles"), before);
    },
  ],
  [
    "corrupt profiles and plugin preferences recover from disk backups",
    async (app) => {
      const before = (await app.invoke("get_active_profile")).bindings.map(
        (b) => [b.id, b.name],
      );
      await app.invoke("set_plugin_enabled", {
        pluginId: "obs",
        enabled: false,
      });
      await app.stop();
      for (const name of ["profiles.json", "plugins_state.json"]) {
        const path = join(app.data, name);
        await writeFile(`${path}.bak`, await readFile(path));
        await writeFile(path, "{interrupted-write");
      }
      await app.start();
      assert.deepEqual(
        (await app.invoke("get_active_profile")).bindings.map((b) => [
          b.id,
          b.name,
        ]),
        before,
      );
      assert.equal(
        (await app.invoke("list_plugins")).find((p) => p.id === "obs").enabled,
        false,
      );
      await app.shown("#alert-overlay");
      assert.match(
        await app.query("#alert-message", "e.textContent"),
        /restored|backup/i,
      );
      await app.click("#alert-ok");
      const files = await readdir(app.data);
      assert.ok(files.some((f) => f.startsWith("profiles.json.corrupt-")));
      assert.ok(files.some((f) => f.startsWith("plugins_state.json.corrupt-")));
      await app.json("storage-recovery.json", {
        quarantined: files.filter((f) => f.includes("corrupt-")),
        binding_count: before.length,
      });
    },
  ],
];

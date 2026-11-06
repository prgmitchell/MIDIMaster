import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./desktop.mjs";
import { workflows } from "./workflows.mjs";
import { security } from "./security.mjs";
import { editors } from "./editors.mjs";
import { network } from "./network.mjs";
import { virtualAudio } from "./virtual-audio.mjs";
import { lifecycle } from "./lifecycle.mjs";

const row = (id) => `[data-binding-id='perf-binding-${id}']`;
const configure = async (app, id) => {
  await app.click(`${row(id)} .binding-actions .binding-action:not(.delete)`);
  await app.shown("#binding-config-panel");
};
const persisted = async (app) =>
  JSON.parse(await readFile(join(app.data, "profiles.json"), "utf8"));

export const scenarios = [
  [
    "startup loads the real backend, all bindings and bundled plugins",
    async (app) => {
      assert.equal(
        (await app.invoke("get_active_profile")).bindings.length,
        50,
      );
      assert.equal(
        await app.eval(
          "document.querySelectorAll('#bindings > [data-binding-id]').length",
        ),
        50,
      );
      assert.deepEqual(
        (await app.invoke("list_plugins")).map((p) => p.id).sort(),
        ["fxsound", "hue", "obs", "voicemeeter", "wavelink"],
      );
    },
  ],
  [
    "search and type filters return matching bindings",
    async (app) => {
      await app.fill("#binding-search", "Performance binding 49");
      await eventually(
        () =>
          app.eval(
            "document.querySelectorAll('#bindings > [data-binding-id]').length === 1",
          ),
        "search result",
      );
      await app.fill("#binding-search", "");
      await app.click("#binding-type-filter [data-filter='buttons']");
      await eventually(
        () =>
          app.eval(
            "document.querySelectorAll('#bindings > [data-binding-id]').length === 13",
          ),
        "button filter",
      );
      await app.click("#binding-type-filter [data-filter='all']");
    },
  ],
  [
    "binding edits persist through UI save and process restart",
    async (app) => {
      await configure(app, 0);
      await app.fill("#binding-config-name", "E2E renamed binding");
      await app.click("#binding-config-save");
      await app.hidden("#binding-config-panel");
      await eventually(
        async () =>
          (await persisted(app)).find((p) => p.name === "Performance Default")
            .bindings[0].name === "E2E renamed binding",
        "durable binding save",
      );
      await app.stop();
      await app.start();
      assert.equal(
        (await app.invoke("get_active_profile")).bindings[0].name,
        "E2E renamed binding",
      );
      assert.match(
        await app.query(row(0), "e.textContent"),
        /E2E renamed binding/,
      );
    },
  ],
  [
    "cancelled binding edits leave saved state intact",
    async (app) => {
      await configure(app, 0);
      await app.fill("#binding-config-name", "Discard me");
      await app.click("#binding-config-cancel");
      await app.hidden("#binding-config-panel");
      assert.equal(
        (await app.invoke("get_active_profile")).bindings[0].name,
        "E2E renamed binding",
      );
    },
  ],
  [
    "binding density persists in application settings",
    async (app) => {
      await app.click("#binding-density-toggle [data-density='compact']");
      await eventually(
        async () =>
          (await app.invoke("get_app_settings")).compact_bindings === true,
        "compact settings",
      );
      assert.equal(
        await app.query("#main-screen", "e.dataset.bindingsDensity"),
        "compact",
      );
      await app.click("#binding-density-toggle [data-density='comfortable']");
      await eventually(
        async () =>
          (await app.invoke("get_app_settings")).compact_bindings === false,
        "comfortable settings",
      );
    },
  ],
  [
    "profile switching restores separate binding state",
    async (app) => {
      await app.click("#profile-toggle");
      await app.click(
        "#profile-list [data-profile-name='Performance 2'] > button:first-child",
      );
      await eventually(
        async () =>
          (await app.invoke("get_active_profile")).name === "Performance 2",
        "profile switch",
      );
      await app.hidden("#profile-list");
      assert.equal(
        (await app.invoke("get_active_profile")).bindings[0].name,
        "Performance binding 0",
      );
      await app.click("#profile-toggle");
      await app.click(
        "#profile-list [data-profile-name='Performance Default'] > button:first-child",
      );
      await eventually(
        async () =>
          (await app.invoke("get_active_profile")).name ===
          "Performance Default",
        "profile return",
      );
      await app.hidden("#profile-list");
    },
  ],
  [
    "plugin filesystem commands reject directory escapes and reserved names",
    async (app) => {
      for (const pluginId of [
        "..",
        ".",
        ".backup",
        "bad.",
        "CON",
        "NUL.txt",
        "foo/bar",
      ]) {
        await assert.rejects(app.invoke("uninstall_plugin", { pluginId }));
        await assert.rejects(
          app.invoke("read_plugin_text", {
            pluginId,
            relPath: "app_settings.json",
          }),
        );
      }
      for (const relPath of [
        "../app_settings.json",
        "C:app_settings.json",
        "plugin.mjs:stream",
        "CON",
        "foo/../plugin.mjs",
      ]) {
        await assert.rejects(
          app.invoke("read_plugin_text", { pluginId: "obs", relPath }),
        );
      }
      assert.equal((await app.invoke("list_plugins")).length, 5);
      assert.ok((await persisted(app)).length >= 2);
    },
  ],
  ...workflows,
  ...security,
  ...editors,
  ...network,
  ...virtualAudio,
  ...lifecycle,
];

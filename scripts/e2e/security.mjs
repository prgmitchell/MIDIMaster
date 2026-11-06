import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pluginPackage } from "./packages.mjs";
import { eventually } from "./desktop.mjs";

export const security = [
  [
    "plugin archive attacks are rejected without corrupting an installed plugin",
    async (app) => {
      const install = (bytes) =>
        app.invoke("install_plugin_package", {
          filename: "test.midimaster",
          bytesBase64: bytes.toString("base64"),
        });
      assert.equal((await install(pluginPackage())).manifest.id, "e2e-plugin");
      const original = await readFile(
        join(app.data, "plugins", "e2e-plugin", "plugin.mjs"),
        "utf8",
      );
      for (const name of [
        "../../escaped.txt",
        "C:escaped.txt",
        "payload:stream",
        "NUL",
        "nested/../escaped.txt",
      ]) {
        await assert.rejects(install(pluginPackage([[name, "bad"]])), /path/i);
      }
      await assert.rejects(
        install(pluginPackage([["PLUGIN.MJS", "duplicate"]])),
        /duplicate/i,
      );
      await assert.rejects(
        install(pluginPackage([["large.bin", Buffer.alloc(21 * 1024 * 1024)]])),
        /too large/i,
      );
      await assert.rejects(
        install(pluginPackage([], { description: "x".repeat(70 * 1024) })),
        /manifest is too large/i,
      );
      await assert.rejects(install(pluginPackage([], { id: ".." })), /id/i);
      await assert.rejects(
        install(pluginPackage([], { id: "obs" })),
        /reserved/i,
      );
      assert.equal(
        await readFile(
          join(app.data, "plugins", "e2e-plugin", "plugin.mjs"),
          "utf8",
        ),
        original,
      );
      assert.deepEqual(
        await readdir(join(app.data, "plugins", ".installing")),
        [],
      );
      await app.invoke("uninstall_plugin", { pluginId: "e2e-plugin" });
    },
  ],
  [
    "local plugin installation activates real code and uninstall removes it",
    async (app) => {
      const path = join(app.root, "example.midimaster");
      await writeFile(path, pluginPackage());
      await app.click("[data-page='plugins']");
      await app.shown(".connection-tab.active .plugins-browser");
      // File inputs are native browser controls; CDP supplies the selected file
      // without opening a machine-dependent OS chooser.
      await app.session.send("DOM.enable");
      await app.session.send("Page.setInterceptFileChooserDialog", {
        enabled: true,
      });
      await app.click(
        ".connection-tab.active .plugins-browser [data-role='install-file']",
      );
      const { root } = await app.session.send("DOM.getDocument");
      const { nodeId } = await app.session.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "input[type='file'][accept='.midimaster']",
      });
      assert.ok(nodeId, "plugin package input exists");
      await app.session.send("DOM.setFileInputFiles", {
        nodeId,
        files: [path],
      });
      await eventually(
        () =>
          app.eval("document.documentElement.dataset.e2ePlugin === 'active'"),
        "plugin activated",
      );
      await app.fill(
        ".connection-tab.active .plugins-browser [data-role='search']",
        "E2E Plugin",
      );
      await app.click(
        ".connection-tab.active .plugins-browser-card .plugins-browser-icon-button.is-danger",
      );
      await app.click("#alert-ok");
      await eventually(
        async () =>
          !(await app.invoke("list_plugins")).some(
            (p) => p.id === "e2e-plugin",
          ),
        "plugin uninstalled",
      );
      await eventually(
        () => app.eval("!document.documentElement.dataset.e2ePlugin"),
        "plugin disposed",
      );
      await app.click("[data-page='bindings']");
    },
  ],
  [
    "plugin remounts do not accumulate global dropdown listeners",
    async (app) => {
      const listeners = async () =>
        (
          await app.session.send("Runtime.evaluate", {
            expression:
              "(getEventListeners(window).resize?.length || 0) + (getEventListeners(window).scroll?.length || 0)",
            includeCommandLineAPI: true,
            returnByValue: true,
          })
        ).result.value;
      const before = await listeners();
      for (let i = 0; i < 8; i++) {
        await app.click("[data-page='plugins']");
        await app.shown(".connection-tab.active .plugins-browser");
        await app.click("[data-page='bindings']");
      }
      assert.equal(await listeners(), before);
    },
  ],
];

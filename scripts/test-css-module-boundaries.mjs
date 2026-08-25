import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readCssBundle } from "./css_bundle.mjs";

const entrypoints = [
  {
    path: "../src/styles/settings.css",
    imports: [
      "./settings/shell-and-virtual-audio.css",
      "./settings/controls-and-osd.css",
      "./settings/appearance.css",
      "./settings/theme-overrides.css",
    ],
  },
  {
    path: "../src/styles/bindings/config-panel.css",
    imports: [
      "./config-panel/base-and-macro.css",
      "./config-panel/soundboard.css",
      "./config-panel/feedback-controls.css",
      "./config-panel/curves.css",
      "./config-panel/preview-and-layout.css",
      "./config-panel/theme-and-responsive.css",
    ],
  },
];

for (const entrypoint of entrypoints) {
  const entryUrl = new URL(entrypoint.path, import.meta.url);
  const source = await readFile(entryUrl, "utf8");
  const imports = [...source.matchAll(/@import url\("([^"]+)"\);/g)].map((match) => match[1]);
  assert.deepEqual(imports, entrypoint.imports, `${entrypoint.path} should preserve its cascade order`);
  assert.equal(
    source.replace(/@import url\("[^"]+"\);/g, "").trim(),
    "",
    `${entrypoint.path} should remain an import-only entrypoint`,
  );

  for (const importPath of imports) {
    const moduleSource = await readFile(new URL(importPath, entryUrl), "utf8");
    assert.ok(moduleSource.trim(), `${importPath} should not be empty`);
    assert.ok(moduleSource.split(/\r?\n/u).length <= 1500, `${importPath} should remain a focused stylesheet module`);
  }

  const bundle = await readCssBundle(entryUrl);
  assert.equal((bundle.match(/{/g) ?? []).length, (bundle.match(/}/g) ?? []).length, `${entrypoint.path} should have balanced blocks`);
}

console.log("CSS module boundary tests passed");

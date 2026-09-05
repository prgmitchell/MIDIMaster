import { readdir, readFile } from "node:fs/promises";

/** Bundled packages are discovered from their manifests, never from a copied ID list. */
export async function bundledPlugins() {
  const root = new URL("../../src-tauri/builtin_plugins/", import.meta.url);
  const entries = await readdir(root, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = new URL(`${entry.name}/`, root);
    const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
    if (manifest.id !== entry.name || manifest.api_version !== "1" || manifest.entry !== "plugin.mjs") {
      throw new Error(`Invalid bundled plugin manifest: ${entry.name}`);
    }
    plugins.push({ ...manifest, directory });
  }
  return plugins;
}

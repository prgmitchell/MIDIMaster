import { readFile } from "node:fs/promises";
import { FEATURE_TEMPLATES } from "../../src/app/feature_templates.js";
/** Full authored markup for static accessibility/style contracts; production mounts these same templates. */
export async function readAppHtml() {
  const html = await readFile(new URL("../../src/index.html", import.meta.url), "utf8");
  return html.replace(
    /<template data-feature-template="([^"]+)"><\/template>/g,
    (_, feature) => FEATURE_TEMPLATES[feature],
  );
}

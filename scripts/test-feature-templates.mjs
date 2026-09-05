import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { mountFeatureTemplates } from "../src/app/feature_templates.js";
const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const { document } = parseHTML(html);
const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/template-contracts.json", import.meta.url), "utf8"),
);
mountFeatureTemplates(document);
for (const [feature, { id, sha256 }] of Object.entries(fixtures)) {
  const node = document.getElementById(id);
  assert.ok(node, feature);
  assert.equal(
    createHash("sha256").update(node.outerHTML).digest("hex"),
    sha256,
    `${feature} preserves the previous DOM hierarchy, text and attributes`,
  );
}
const before = document.toString();
mountFeatureTemplates(document);
assert.equal(document.toString(), before, "mounting twice leaves the document unchanged");
const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
assert.equal(ids.length, new Set(ids).size, "templates do not duplicate DOM IDs");
console.log("Feature template DOM compatibility tests passed");

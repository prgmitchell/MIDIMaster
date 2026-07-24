import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const updateHtml = await readFile(new URL("../src/update.html", import.meta.url), "utf8");
const updateStyles = await readFile(
  new URL("../src/update_notification.css", import.meta.url),
  "utf8",
);
const themeStyles = await readFile(
  new URL("../src/styles/base/app-shell.css", import.meta.url),
  "utf8",
);

const stylesheetHrefs = Array.from(
  updateHtml.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/giu),
  (match) => match[1],
);
const themeStylesheetIndex = stylesheetHrefs.indexOf("styles/base/app-shell.css");
const updateStylesheetIndex = stylesheetHrefs.indexOf("update_notification.css");

assert.notEqual(
  themeStylesheetIndex,
  -1,
  "the standalone updater must load the shared application theme tokens",
);
assert.notEqual(
  updateStylesheetIndex,
  -1,
  "the standalone updater must load its component stylesheet",
);
assert.ok(
  themeStylesheetIndex < updateStylesheetIndex,
  "shared theme tokens must load before updater-specific styles",
);

const referencedThemeTokens = new Set(
  Array.from(updateStyles.matchAll(/var\(\s*(--[\w-]+)/gu), (match) => match[1]),
);
const definedThemeTokens = new Set(
  Array.from(themeStyles.matchAll(/(--[\w-]+)\s*:/gu), (match) => match[1]),
);
const missingThemeTokens = [...referencedThemeTokens]
  .filter((token) => !definedThemeTokens.has(token))
  .sort();

assert.deepEqual(
  missingThemeTokens,
  [],
  `updater styles reference undefined shared theme tokens: ${missingThemeTokens.join(", ")}`,
);

console.log("Update notification stylesheet tests passed");

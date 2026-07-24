import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const shellStyles = await readFile(
  new URL("../src/styles/connections/shell.css", import.meta.url),
  "utf8",
);

const updateLayoutRule = shellStyles.match(
  /body\[data-theme\]\s+\.topbar\.has-update\s*\{(?<body>[\s\S]*?)\}/u,
);
assert.ok(updateLayoutRule, "the active-update topbar layout rule must exist");

const gridTemplate = updateLayoutRule.groups.body.match(
  /grid-template-columns\s*:\s*(?<value>[^;]+);/u,
);
assert.ok(gridTemplate, "the active-update topbar must define its grid columns");

const dividerTracks = gridTemplate.groups.value.match(/\b1px\b/gu) ?? [];
assert.equal(
  dividerTracks.length,
  1,
  "the topbar grid must have only the divider represented by its DOM; an extra divider track makes the update action overlap MIDI routes",
);
assert.match(
  gridTemplate.groups.value,
  /\bauto\s*$/u,
  "the update action must have its own final auto-sized grid track",
);

console.log("Topbar update layout tests passed");

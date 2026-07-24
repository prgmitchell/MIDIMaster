import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const updateCommands = await readFile(
  new URL("../src-tauri/src/commands/updates.rs", import.meta.url),
  "utf8",
);

const builderStart = updateCommands.indexOf("let window = WebviewWindowBuilder::new(");
const buildCall = updateCommands.indexOf(".build()", builderStart);
const hiddenBuilder = updateCommands.indexOf(".visible(false)", builderStart);

assert.notEqual(builderStart, -1, "the standalone updater window builder must exist");
assert.ok(
  hiddenBuilder > builderStart && hiddenBuilder < buildCall,
  "the standalone updater must be created hidden to prevent a default-position flash",
);

const newWindowSequence = updateCommands.slice(buildCall);
const centerCall = newWindowSequence.indexOf("let _ = window.center();");
const showCall = newWindowSequence.indexOf("let _ = window.show();");

assert.ok(centerCall !== -1 && showCall > centerCall, "the updater must be centered before it is shown");

console.log("Update notification window tests passed");

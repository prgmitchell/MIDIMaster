import assert from "node:assert/strict";
import { muteIconSvg } from "../src/features/bindings/icons.js";

assert.match(muteIconSvg(true), /m18 9-4 6M14 9l4 6/);
assert.match(muteIconSvg(false), /M16 8\.5a5 5 0 0 1 0 7/);
assert.notEqual(muteIconSvg(true), muteIconSvg(false));

console.log("Binding icon tests passed");

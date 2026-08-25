import assert from "node:assert/strict";
import { findPlaceholderVisibleIndex } from "../src/features/bindings/binding_drag.js";

function child(classes, bindingId = "") {
  return {
    classList: { contains: (name) => classes.includes(name) },
    dataset: { bindingId },
  };
}

const children = [
  child(["binding-item"], "hidden"),
  child(["binding-item"], "first"),
  child(["binding-placeholder"]),
  child(["binding-item"], "second"),
];

assert.equal(findPlaceholderVisibleIndex(children, ["first", "second"]), 1);
assert.equal(findPlaceholderVisibleIndex([child(["binding-item"], "first")], ["first"]), null);

console.log("Binding drag tests passed");

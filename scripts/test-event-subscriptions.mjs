import assert from "node:assert/strict";
import { createEventSubscriptions } from "../src/app/event_subscriptions.js";

const disposed = [];
const subscriptions = createEventSubscriptions({
  listen: async (eventName) => () => disposed.push(eventName),
});

await subscriptions.subscribe("first", () => {});
await subscriptions.subscribe("second", () => {});
assert.equal(subscriptions.size(), 2);
await subscriptions.dispose();
assert.deepEqual(disposed.sort(), ["first", "second"]);
assert.equal(subscriptions.size(), 0);
await subscriptions.dispose();
await assert.rejects(() => subscriptions.subscribe("late", () => {}), /disposed/);

console.log("Event subscription tests passed");

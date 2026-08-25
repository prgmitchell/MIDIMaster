import assert from "node:assert/strict";
import { parseEventPayload } from "../src/app/event_payload.js";

const payload = { state: "connected" };
assert.equal(parseEventPayload({ payload }), payload);
assert.deepEqual(parseEventPayload({ payload: '{"state":"connected"}' }), payload);
assert.equal(parseEventPayload({ payload: "not-json" }), null);
assert.deepEqual(parseEventPayload({ payload: "not-json" }, {}), {});
assert.equal(parseEventPayload({ payload: 42 }), null);
assert.equal(parseEventPayload(null), null);

console.log("Event payload tests passed");

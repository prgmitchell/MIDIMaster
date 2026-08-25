import assert from "node:assert/strict";
import { createSessionRefreshScheduler } from "../src/features/midi/session_refresh_scheduler.js";

const timers = new Map();
const delays = [];
let nextTimer = 1;
const documentRef = {
  hidden: false,
  addEventListener() {},
};
const scheduler = createSessionRefreshScheduler({
  documentRef,
  setTimer: (callback, delay) => {
    const id = nextTimer++;
    timers.set(id, callback);
    delays.push(delay);
    return id;
  },
  clearTimer: (id) => timers.delete(id),
  visibleIntervalMs: 10,
  hiddenIntervalMs: 20,
});

let refreshes = 0;
scheduler.start(async () => { refreshes += 1; }, { classList: { contains: () => false } });
assert.equal(delays[0], 10);
const first = timers.get(1);
timers.delete(1);
await first();
assert.equal(refreshes, 1);

documentRef.hidden = true;
const second = timers.get(2);
timers.delete(2);
await second();
assert.equal(refreshes, 1);
assert.equal(delays.at(-1), 20);
scheduler.stop();

console.log("MIDI session refresh tests passed");

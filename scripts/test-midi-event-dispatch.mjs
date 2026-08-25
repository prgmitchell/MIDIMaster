import assert from "node:assert/strict";
import { createMidiEventDispatch } from "../src/app/midi_event_dispatch.js";

const dispatch = createMidiEventDispatch({
  shouldPreserve: () => false,
  applyEvent: () => {},
  maxPendingPerfEvents: 2,
});
const control = { device_id: "midi-1", channel: 0, controller: 7, msg_type: "ControlChange" };
dispatch.queuePerformance({ ...control, value: 1 });
dispatch.queuePerformance({ ...control, value: 2 });
dispatch.queuePerformance({ ...control, value: 3 });
assert.equal(dispatch.takePerformance(control).value, 2);
assert.equal(dispatch.takePerformance(control).value, 3);
assert.equal(dispatch.takePerformance(control), null);

dispatch.queuePerformance({ ...control, value: 4 });
dispatch.clearPerformance();
assert.equal(dispatch.takePerformance(control), null);

console.log("MIDI event dispatch tests passed");

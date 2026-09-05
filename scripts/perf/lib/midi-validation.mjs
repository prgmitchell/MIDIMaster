import { midiQueueSettled } from "./midi-collection.mjs";
import { matchesRenderedBindingValue } from "../../../src/app/performance_rendered_value.js";

const PROFILE_MUTATING_COMMANDS = new Set([
  "save_profile", "load_profile", "delete_profile", "add_binding", "remove_binding",
  "stop_midi_device", "stop_midi_route", "start_midi_device", "start_midi_device_routes",
]);

function validateStableProfile(frontend) {
  if (!Array.isArray(frontend?.entries)) {
    throw new Error("Profile stability verification requires captured frontend entries");
  }
  // The collector resets frontend entries before injection. IPC entries are
  // written on completion, including requests that began before that reset.
  // Failed mutations may have partially changed state and also invalidate an
  // isolated sample, regardless of whether its final toggle parity is correct.
  const mutations = frontend.entries.filter(entry =>
    entry?.kind === "ipc" && PROFILE_MUTATING_COMMANDS.has(entry.name));
  if (mutations.length) {
    const commands = [...new Set(mutations.map(entry => entry.name))].join(", ");
    throw new Error(`Profile or MIDI connection mutation overlapped the isolated MIDI sample: ${commands}`);
  }
}

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Missing or invalid ${name}`);
  return value;
}

/** Expected outputs for generate-fixtures.mjs and the native audit injector. */
export function expectedSyntheticTargets(injection) {
  const { message_count: messages, control_count: controls, message_kind: kind } = injection;
  if (count(messages, "message_count") < 1 || count(controls, "control_count") < 1 || controls > 16) {
    throw new Error("Synthetic MIDI validation requires positive messages and 1–16 controls");
  }
  if (!["continuous", "button", "action"].includes(kind)) throw new Error(`Unsupported synthetic MIDI kind: ${kind}`);
  return Array.from({ length: Math.min(controls, messages) }, (_, control) => {
    const events = Math.floor((messages - control - 1) / controls) + 1;
    const presses = kind === "button" ? Math.ceil(events / 2) : events;
    const controller = control * 8 + (kind === "button" ? 4 : kind === "action" ? 0 : 1);
    const lastAppliedEvent = kind === "button" ? (presses - 1) * 2 : events - 1;
    return {
      binding_id: `perf-binding-${controller}`,
      target_id: `channel-${controller}`,
      action: kind === "continuous" ? "Volume" : "ToggleEffect",
      value: kind === "continuous" ? ((events - 1) % 126 + 1) / 127 : presses % 2,
      sequence: control + lastAppliedEvent * controls,
      control,
      applied: presses,
      noop: kind === "button" ? Math.floor(events / 2) : 0,
    };
  });
}

function validateDurationSample(sample, name) {
  const samples = count(sample?.samples, `${name}.samples`);
  for (const percentile of ["p50_us", "p95_us", "p99_us", "max_us"]) {
    const value = sample[percentile];
    if (samples === 0) {
      if (value != null) throw new Error(`${name}.${percentile} must be unavailable with zero samples`);
    } else if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Missing or invalid ${name}.${percentile}`);
    }
  }
  if (samples > 0 && !(sample.p50_us <= sample.p95_us && sample.p95_us <= sample.p99_us && sample.p99_us <= sample.max_us)) {
    throw new Error(`${name} percentiles are out of order`);
  }
  return samples;
}

function validateConvergence(value, controls, name) {
  if (count(value?.controls, `${name}.controls`) !== controls) throw new Error(`${name} control coverage differs from the injection`);
  if (count(value?.mismatches, `${name}.mismatches`) > controls || value.converged !== (controls > 0 && value.mismatches === 0)) {
    throw new Error(`${name} convergence is inconsistent`);
  }
}

function validateSynthetic(snapshot, injection) {
  if (snapshot.synthetic_targets_enabled !== true) throw new Error("Synthetic target sink was not enabled");
  const expected = expectedSyntheticTargets(injection);
  const targets = snapshot.synthetic_targets;
  if (!Array.isArray(targets) || targets.length !== expected.length) throw new Error("Synthetic target coverage differs from the fixture");
  const byBinding = new Map(targets.map(target => [target.binding_id, target]));
  if (byBinding.size !== expected.length) throw new Error("Synthetic target results contain duplicate bindings");
  for (const desired of expected) {
    const target = byBinding.get(desired.binding_id);
    if (!target || target.target_id !== desired.target_id || target.action !== desired.action) {
      throw new Error(`Synthetic target identity/action mismatch: ${desired.binding_id}`);
    }
    if (!Number.isFinite(target.value) || Math.abs(target.value - desired.value) > 0.000001) {
      throw new Error(`Synthetic target value mismatch: ${desired.binding_id}`);
    }
    const input = target.input;
    const sequence = count(input?.sequence, `synthetic input sequence: ${desired.binding_id}`);
    if (sequence > desired.sequence || sequence % injection.control_count !== desired.control || input.value_14 !== null) {
      throw new Error(`Synthetic target input identity mismatch: ${desired.binding_id}`);
    }
    const inputValue = injection.message_kind === "continuous" ? Math.floor(sequence / injection.control_count) % 126 + 1 : 127;
    if (input.value !== inputValue || (injection.message_kind === "continuous"
      ? Math.abs(target.value - inputValue / 127) > 0.000001 : sequence !== desired.sequence)) {
      throw new Error(`Synthetic target applied input mismatch: ${desired.binding_id}`);
    }
  }
  const outcomes = snapshot.action_outcomes;
  if (outcomes.dispatched !== 0 || outcomes.dispatched_targets !== 0 || outcomes.applied_targets !== outcomes.applied) {
    throw new Error("Synthetic actions must be verified applications to one target per binding");
  }
  if (injection.message_kind !== "continuous") {
    const applied = expected.reduce((sum, target) => sum + target.applied, 0);
    const noop = expected.reduce((sum, target) => sum + target.noop, 0);
    if (outcomes.applied !== applied || outcomes.noop !== noop) throw new Error("Synthetic press/release action counts differ from the fixture");
  }
  if (outcomes.applied < expected.length) throw new Error("Synthetic controls did not each apply an action");
  return expected;
}

/** Returns checked coverage, or throws. Dispatch completion never proves target application. */
export function validateMidiResult(result, { requireSynthetic = result?.snapshot?.synthetic_targets_enabled === true, requireRenderer = false, requireStableProfile = false } = {}) {
  const { snapshot, injection, frontend } = result || {};
  if (!injection || count(injection.message_count, "message_count") < 1) throw new Error("MIDI injection did not contain messages");
  const controls = Math.min(count(injection.control_count, "control_count"), injection.message_count);
  if (controls < 1 || injection.control_count > 16) throw new Error("MIDI injection requires 1–16 controls");
  if (count(injection.rate_per_second, "rate_per_second") < 1) throw new Error("MIDI injection rate must be positive");
  if (!midiQueueSettled(snapshot, injection.message_count)) throw new Error("MIDI queue/action processing has not settled");
  const queue = snapshot.queue;
  if (queue.enqueued !== queue.drained + queue.coalesced + queue.dropped) throw new Error("MIDI queue accounting does not balance");
  if (queue.dropped !== 0) throw new Error("MIDI queue dropped events");
  if (["button", "action"].includes(injection.message_kind) && queue.coalesced !== 0) throw new Error("Preserved MIDI events were coalesced");
  const outcomes = snapshot.action_outcomes;
  const resultKinds = ["applied", "dispatched", "noop", "errors", "unverified"];
  for (const name of [...resultKinds, "applied_targets", "dispatched_targets", "failed_targets"]) count(outcomes[name], `action_outcomes.${name}`);
  if (resultKinds.reduce((sum, name) => sum + outcomes[name], 0) !== outcomes.processed) throw new Error("MIDI action outcome counts do not balance");
  if (outcomes.errors !== 0 || outcomes.failed_targets !== 0 || outcomes.unverified !== 0) throw new Error("MIDI actions failed or could not be verified");
  const samples = validateDurationSample(snapshot.native_action, "native_action");
  for (const name of ["native_processing", "queue_dispatch"]) {
    const retained = validateDurationSample(snapshot[name], name);
    if ((retained > 0) !== (outcomes.processed > 0) || retained > outcomes.processed) throw new Error(`${name} samples do not match processed outcomes`);
  }
  if ((samples > 0) !== (outcomes.applied > 0) || samples > outcomes.applied) throw new Error("Applied latency samples do not match applied outcomes");
  validateConvergence(snapshot.dispatched_value, controls, "dispatched_value");
  if (!snapshot.dispatched_value.converged) throw new Error("MIDI final inputs did not reach the dispatcher");
  validateConvergence(snapshot.latest_value, controls, "latest_value");
  const expected = requireSynthetic ? validateSynthetic(snapshot, injection) : [];
  if (requireSynthetic && injection.message_kind === "continuous" && !snapshot.latest_value.converged) {
    throw new Error("Synthetic continuous applied-input values did not converge");
  }
  if (requireStableProfile) validateStableProfile(frontend);
  let rendererControls = 0;
  if (requireRenderer) {
    if (!requireSynthetic || injection.message_kind !== "continuous") throw new Error("Renderer value verification requires the continuous synthetic fixture");
    if (result.renderer_frames_completed !== true) throw new Error("Renderer completion frames were not collected");
    const rendered = new Map((frontend?.renderedValues || []).map(value => [value.bindingId, value]));
    for (const desired of expected) {
      const actual = rendered.get(desired.binding_id);
      const target = snapshot.synthetic_targets.find(value => value.binding_id === desired.binding_id);
      if (!actual || actual.sequence !== target.input.sequence || !matchesRenderedBindingValue(actual.value, desired.value)) {
        throw new Error(`Renderer final value did not complete: ${desired.binding_id}`);
      }
    }
    rendererControls = expected.length;
  }
  return { processed: outcomes.processed, applied: outcomes.applied, dispatched: outcomes.dispatched,
    synthetic_targets_checked: expected.length, renderer_controls_checked: rendererControls,
    ...(requireStableProfile ? { profile_stability_checked: true } : {}) };
}

import {
  getFaderModifiers,
  modifierField,
  getControlMapping,
} from "./fader_modifiers.js";
/** A MIDI address; controller is retained for legacy note/program encodings. */
export function primaryControlMapping(binding) {
  return {
    device_id: binding?.device_id,
    channel: binding?.control?.channel,
    controller: binding?.control?.controller,
    msg_type: binding?.control?.msg_type || "ControlChange",
  };
}

export function controlsEqual(left, right) {
  if (!left || !right) return false;
  return (
    String(left.device_id || "") === String(right.device_id || "") &&
    Number(left.channel) === Number(right.channel) &&
    Number(left.controller) === Number(right.controller) &&
    String(left.msg_type || "ControlChange") ===
      String(right.msg_type || "ControlChange")
  );
}

/** Find the first owner, preserving primary/mute/assign/indicator priority and editor self-transfer rules. */
export function findControlConflict(
  bindings,
  mapping,
  { bindingId, field } = {},
) {
  for (const binding of bindings || []) {
    if (!binding) continue;
    if (
      binding.id === bindingId &&
      field !== "control" &&
      controlsEqual(getControlMapping(binding, field), mapping)
    )
      continue;
    const checkingOwnModifier =
      field?.startsWith("modifier:") ||
      ["mute_control", "assign_control"].includes(field);
    if (
      !(binding.id === bindingId && !checkingOwnModifier) &&
      controlsEqual(primaryControlMapping(binding), mapping)
    )
      return { binding, field: "control" };
    for (const modifier of getFaderModifiers(binding)) {
      const modifierSlot = modifierField(modifier.id);
      if (binding.id === bindingId && modifierSlot === field) continue;
      if (controlsEqual(modifier.control, mapping)) {
        const legacyField = !Array.isArray(binding.modifiers)
          ? modifier.kind === "Mute"
            ? "mute_control"
            : "assign_control"
          : modifierSlot;
        return { binding, field: legacyField };
      }
    }
    for (const auxiliaryField of ["indicator_control"]) {
      if (controlsEqual(binding[auxiliaryField], mapping))
        return { binding, field: auxiliaryField };
    }
  }
  return null;
}

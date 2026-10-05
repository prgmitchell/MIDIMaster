// An explicit list is authoritative, including an empty list. Old profiles only
// contribute the auxiliary controls that were actually mapped.
export function getFaderModifiers(binding) {
  if (Array.isArray(binding?.modifiers)) return binding.modifiers;
  const modifiers = [];
  if (binding?.mute_control?.device_id) {
    modifiers.push({
      id: "legacy-mute",
      kind: "Mute",
      control: {
        ...binding.mute_control,
        mute_behavior:
          binding.mute_control.mute_behavior ||
          binding.mute_behavior ||
          "ToggleOnPress",
      },
      assign_mode: "Add",
    });
  }
  if (binding?.assign_control?.device_id) {
    modifiers.push({
      id: "legacy-assign",
      kind: "Assign",
      control: binding.assign_control,
      assign_mode: binding.assign_mode || "Add",
    });
  }
  return modifiers;
}

export function ensureFaderModifiers(binding) {
  if (!Array.isArray(binding.modifiers))
    binding.modifiers = getFaderModifiers(binding);
  binding.mute_control = null;
  binding.assign_control = null;
  return binding.modifiers;
}

export function modifierField(id) {
  return `modifier:${id}`;
}

export function modifierForField(binding, field) {
  if (!field?.startsWith("modifier:")) return null;
  return (
    getFaderModifiers(binding).find(
      (modifier) => modifierField(modifier.id) === field,
    ) || null
  );
}

export function getControlMapping(binding, field) {
  if (field?.startsWith("output:"))
    return binding?.additional_outputs?.find((output) => `output:${output.id}` === field)?.control;
  return field?.startsWith("modifier:")
    ? modifierForField(binding, field)?.control
    : binding?.[field];
}

export function setControlMapping(binding, field, mapping) {
  if (field?.startsWith("output:")) {
    const output = binding.additional_outputs?.find((item) => `output:${item.id}` === field);
    if (output) {
      if (mapping) output.control = { ...mapping, control_kind: "Continuous" };
      output.enabled = Boolean(mapping);
    }
    return;
  }
  if (field?.startsWith("modifier:")) {
    const modifier = ensureFaderModifiers(binding).find(
      (item) => modifierField(item.id) === field,
    );
    if (modifier) {
      if (mapping)
        mapping.mute_behavior =
          modifier.control?.mute_behavior ||
          modifier.mute_behavior ||
          mapping.mute_behavior;
      modifier.control = mapping;
    }
  } else {
    binding[field] = mapping;
    if (
      Array.isArray(binding.modifiers) &&
      ["mute_control", "assign_control"].includes(field)
    ) {
      const id = field === "mute_control" ? "legacy-mute" : "legacy-assign";
      const modifier = binding.modifiers.find((item) => item.id === id);
      if (modifier) modifier.control = mapping;
    }
  }
}

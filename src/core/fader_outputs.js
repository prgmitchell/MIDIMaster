import { controlsEqual, primaryControlMapping } from "./control_mapping.js";

export const outputField = (id) => `output:${id}`;
export const outputForField = (binding, field) =>
  (binding?.additional_outputs || []).find(
    (output) => outputField(output.id) === field,
  );

export function getOutputOrder(binding) {
  const ids = [
    "default-feedback",
    "default-led",
    ...(binding.additional_outputs || []).map((output) => output.id),
  ];
  return [
    ...new Set([
      ...(Array.isArray(binding.output_order) ? binding.output_order : []),
      ...ids,
    ]),
  ].filter((id) => ids.includes(id));
}

export function normalizeFaderOutputs(outputs, normalizeMapping) {
  const ids = new Set(["default-feedback", "default-led"]);
  return (Array.isArray(outputs) ? outputs : []).flatMap((output, index) => {
    if (!output || !["Feedback", "Led"].includes(output.kind)) return [];
    const control = normalizeMapping(output.control, {
      indicator: true,
      allowPitchBendIndicator: output.kind === "Feedback",
      led: output.kind === "Led",
    });
    if (!control) return [];
    let id = String(output.id || `output-${index}`);
    while (ids.has(id)) id = `output-${index}-${id}`;
    ids.add(id);
    return [
      {
        id,
        kind: output.kind,
        control: { ...control, control_kind: "Continuous" },
        enabled: output.enabled !== false,
        feedback_mode:
          output.feedback_mode === "AudioReactive"
            ? "AudioReactive"
            : "FollowValue",
      },
    ];
  });
}

export function createFaderOutput(binding, kind, id = crypto.randomUUID()) {
  const primary = primaryControlMapping(binding);
  const used = [
    primary,
    binding.indicator_control,
    binding.led_control,
    ...(binding.additional_outputs || []).map((output) => output.control),
    ...(binding.modifiers || []).map((modifier) => modifier.control),
  ];
  const msg_type =
    kind === "Feedback" && primary.msg_type === "PitchBend"
      ? "PitchBend"
      : "ControlChange";
  // Choose a free, editable address rather than duplicating an existing output.
  for (let offset = 1; offset <= 2048; offset++) {
    const address =
      ((primary.channel || 0) * 128 + (primary.controller || 0) + offset) %
      2048;
    const control = {
      device_id: binding.device_id,
      msg_type,
      channel: Math.floor(address / 128),
      controller: msg_type === "PitchBend" ? 0 : address % 128,
      control_kind: "Continuous",
      mode: "Absolute",
      deadzone: 0,
      debounce_ms: 0,
      mute_behavior: "ToggleOnPress",
    };
    if (!used.some((other) => controlsEqual(control, other)))
      return { id, kind, control, enabled: true, feedback_mode: "FollowValue" };
  }
  return null;
}

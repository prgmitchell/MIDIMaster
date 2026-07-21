function messageType(value) {
  return String(value || "ControlChange");
}

function controlKey(deviceId, channel, controller, msgType) {
  return `${String(deviceId || "")}\u0000${Number(channel)}\u0000${Number(controller)}\u0000${messageType(msgType)}`;
}

function legacyControlKey(channel, controller, msgType) {
  return `${Number(channel)}\u0000${Number(controller)}\u0000${messageType(msgType)}`;
}

export function createBindingLookupIndex(bindings = []) {
  const exact = new Map();
  const fallback = new Map();

  (Array.isArray(bindings) ? bindings : []).forEach((binding) => {
    if (!binding?.control) return;
    const control = binding.control;
    const exactKey = controlKey(
      binding.device_id,
      control.channel,
      control.controller,
      control.msg_type || control.msgType,
    );
    if (!exact.has(exactKey)) exact.set(exactKey, binding);

    const fallbackKey = legacyControlKey(control.channel, control.controller, control.msg_type || control.msgType);
    fallback.set(fallbackKey, fallback.has(fallbackKey) ? null : binding);
  });

  function find(payload, { allowLegacyFallback = true } = {}) {
    if (!payload || typeof payload !== "object") return null;
    const match = exact.get(controlKey(
      payload.device_id || payload.deviceId,
      payload.channel,
      payload.controller,
      payload.msg_type || payload.msgType,
    ));
    if (match || !allowLegacyFallback) return match || null;
    return fallback.get(legacyControlKey(
      payload.channel,
      payload.controller,
      payload.msg_type || payload.msgType,
    )) || null;
  }

  return { find, size: exact.size };
}

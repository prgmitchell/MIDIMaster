export function createFrameBatcher({
  keyFor,
  onFlush,
  shouldPreserve = () => false,
  requestFrame = null,
} = {}) {
  if (typeof keyFor !== "function") {
    throw new Error("createFrameBatcher: keyFor is required");
  }
  if (typeof onFlush !== "function") {
    throw new Error("createFrameBatcher: onFlush is required");
  }

  const scheduleFrame = typeof requestFrame === "function"
    ? requestFrame
    : ((callback) => {
        if (typeof requestAnimationFrame === "function") {
          return requestAnimationFrame(callback);
        }
        return setTimeout(callback, 16);
      });

  const latestByKey = new Map();
  const preserved = [];
  let sequence = 0;
  let queued = false;

  function flush() {
    queued = false;
    const entries = [
      ...preserved.splice(0),
      ...Array.from(latestByKey.values()),
    ].sort((left, right) => left.sequence - right.sequence);
    latestByKey.clear();

    if (entries.length === 0) return;
    onFlush(entries.map((entry) => entry.item));
  }

  function schedule() {
    if (queued) return;
    queued = true;
    scheduleFrame(flush);
  }

  function queue(item) {
    if (!item || typeof item !== "object") return;
    const entry = { item, sequence: sequence++ };
    if (shouldPreserve(item)) {
      preserved.push(entry);
    } else {
      latestByKey.set(String(keyFor(item)), entry);
    }
    schedule();
  }

  return {
    queue,
    flush,
    pendingCount: () => preserved.length + latestByKey.size,
  };
}

export function midiPayloadControlKey(payload = {}) {
  return [
    String(payload.device_id || payload.deviceId || ""),
    Number(payload.channel ?? 0),
    Number(payload.controller ?? 0),
    String(payload.msg_type || payload.msgType || "ControlChange"),
  ].join(":");
}

export function midiPayloadIsButtonLike(payload = {}) {
  const msgType = String(payload.msg_type || payload.msgType || "");
  return msgType === "Note" || msgType === "ProgramChange";
}

export function volumePayloadKey(payload = {}) {
  if (payload.binding_id != null) {
    return `binding:${String(payload.binding_id)}:target:${stableKey(payload.target)}`;
  }
  return `target:${stableKey(payload.target)}`;
}

export function stableKey(value) {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`)
    .join(",")}}`;
}

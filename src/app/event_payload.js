/**
 * Normalizes Tauri event payloads, which may arrive as objects or JSON strings.
 * Non-object and malformed payloads resolve to the caller-provided fallback.
 *
 * @template T
 * @param {{ payload?: unknown } | null | undefined} event
 * @param {T} [fallback]
 * @returns {Record<string, unknown> | T}
 */
export function parseEventPayload(event, fallback = null) {
  let payload = event?.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return fallback;
    }
  }
  return payload && typeof payload === "object" ? payload : fallback;
}

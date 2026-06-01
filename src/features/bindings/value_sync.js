export const BINDING_VOLUME_USER_ACTIVE_MS = 1000;

export function coerceNormalizedVolume(value) {
  if (value == null) return null;
  const next = Number(value);
  if (!Number.isFinite(next)) return null;
  return Math.min(1, Math.max(0, next));
}

export function bindingHasRecentVolumeInput(
  bindingId,
  interactionTimes = {},
  now = Date.now(),
  activeMs = BINDING_VOLUME_USER_ACTIVE_MS,
) {
  if (bindingId == null) return false;
  const lastInteraction = Number(interactionTimes?.[bindingId] || 0);
  return lastInteraction > 0 && (Number(now) - lastInteraction) < activeMs;
}

export function resolveBindingVolumeValue({
  bindingId,
  targetVolume,
  cachedVolume,
  interactionTimes = {},
  now = Date.now(),
  activeMs = BINDING_VOLUME_USER_ACTIVE_MS,
} = {}) {
  const live = coerceNormalizedVolume(targetVolume);
  const cached = coerceNormalizedVolume(cachedVolume);
  const userActive = bindingHasRecentVolumeInput(bindingId, interactionTimes, now, activeMs);

  if (live != null && (!userActive || cached == null)) {
    return { value: live, source: "target", userActive };
  }
  if (cached != null) {
    return { value: cached, source: "cache", userActive };
  }
  if (live != null) {
    return { value: live, source: "target", userActive };
  }
  return { value: null, source: "none", userActive };
}

export function resolveTargetChangeVolumeValue({ targetVolume, cachedVolume } = {}) {
  const live = coerceNormalizedVolume(targetVolume);
  if (live != null) return live;
  return coerceNormalizedVolume(cachedVolume);
}

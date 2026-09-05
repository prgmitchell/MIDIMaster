/** Canonical frontend relative midi rules. Rust validates persisted/runtime data. */
export function normalizeRelativeFormat(raw) {
  const value = String(raw || "Auto");
  if (
    value === "Auto" ||
    value === "TwosComplement" ||
    value === "BinaryOffset" ||
    value === "SignMagnitude"
  ) {
    return value;
  }
  return "Auto";
}

export function decodeRelativeTwosComplement(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return value;
  if (value >= 65 && value <= 127) return value - 128;
  return null;
}

export function decodeRelativeBinaryOffset(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return -(64 - value);
  if (value >= 65 && value <= 127) return value - 64;
  return null;
}

export function decodeRelativeSignMagnitude(value) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 63) return value;
  if (value >= 65 && value <= 127) return -(value - 64);
  return null;
}

function coerceRelativeAutoState(previousState) {
  if (previousState && typeof previousState === "object") {
    const previousFormat = normalizeRelativeFormat(previousState.format);
    return {
      format: previousFormat === "Auto" ? null : previousFormat,
      seenMidpoint: Boolean(previousState.seenMidpoint),
      seenSignBand: Boolean(previousState.seenSignBand),
      seenHighNegative: Boolean(previousState.seenHighNegative),
      seenLowNegativeHint: Boolean(previousState.seenLowNegativeHint),
    };
  }
  const previousFormat = normalizeRelativeFormat(previousState);
  return {
    format: previousFormat === "Auto" ? null : previousFormat,
    seenMidpoint: false,
    seenSignBand: false,
    seenHighNegative: false,
    seenLowNegativeHint: false,
  };
}

export function updateRelativeAutoDetection(value, previousState = null) {
  const state = coerceRelativeAutoState(previousState);
  if (!state.format) {
    if (value === 63) state.seenLowNegativeHint = true;
    if (value === 64) state.seenMidpoint = true;
    if (value >= 65 && value <= 95) state.seenSignBand = true;
    if (value >= 96 && value <= 127) state.seenHighNegative = true;

    if (state.seenHighNegative) {
      state.format = "TwosComplement";
    } else if (state.seenLowNegativeHint) {
      state.format = "BinaryOffset";
    } else if (state.seenMidpoint && state.seenSignBand) {
      state.format = "BinaryOffset";
    } else if (state.seenSignBand) {
      state.format = "SignMagnitude";
    }
  }
  return state;
}

export function detectRelativeFormatAuto(value, previousState) {
  return updateRelativeAutoDetection(value, previousState).format;
}

export function decodeRelativeDeltaAutoFallback(value, sawMidpoint = false) {
  if (value === 0 || value === 64) return 0;
  if (value >= 1 && value <= 62) return value;
  if (value === 63) return -1;
  if (value >= 96 && value <= 127) return value - 128;
  if (value >= 65 && value <= 95 && sawMidpoint) return value - 64;
  if (value >= 65 && value <= 95) return -(value - 64);
  return null;
}

export function decodeRelativeDelta(binding, value, autoFormatByBinding = null) {
  const configured = normalizeRelativeFormat(binding?.relative_format);
  let format = configured;
  let autoState = null;
  if (format === "Auto") {
    const key = String(binding?.id || "");
    const previousState = key && autoFormatByBinding ? autoFormatByBinding.get(key) : null;
    autoState = updateRelativeAutoDetection(value, previousState);
    if (key && autoFormatByBinding) {
      autoFormatByBinding.set(key, autoState);
    }
    format = autoState.format || "Auto";
  }

  if (format === "TwosComplement") return decodeRelativeTwosComplement(value);
  if (format === "BinaryOffset") return decodeRelativeBinaryOffset(value);
  if (format === "SignMagnitude") return decodeRelativeSignMagnitude(value);
  if (format === "Auto") return decodeRelativeDeltaAutoFallback(value, autoState?.seenMidpoint);
  return null;
}

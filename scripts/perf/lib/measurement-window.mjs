/** Reject interrupted idle/endurance runs instead of treating suspended time as coverage. */
export function validateMeasurementWindow({ started, finished, sampledAt, requestedSeconds, maximumGapMs = 90000 }) {
  const times = [started, ...sampledAt, finished];
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0 ||
      times.some(time => !Number.isFinite(time))) throw new Error("Invalid measurement window");
  if (!sampledAt.length) throw new Error("Measurement window contains no resource samples");
  let largestGapMs = 0;
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1];
    if (gap < 0) throw new Error("Measurement clock moved backwards");
    largestGapMs = Math.max(largestGapMs, gap);
  }
  const elapsedSeconds = (finished - started) / 1000;
  if (elapsedSeconds < requestedSeconds) throw new Error("Measurement ended before the requested duration");
  if (largestGapMs > maximumGapMs) {
    throw new Error(`Measurement interrupted: ${Math.round(largestGapMs / 1000)} seconds without a sample`);
  }
  return { elapsedSeconds, samples: sampledAt.length, largestGapMs };
}

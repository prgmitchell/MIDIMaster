export const SOUNDBOARD_MIN_SELECTION_MS = 50;

export function clampSoundboardTrim(startMs, endMs, durationMs, changed = "start") {
  const duration = Math.max(0, Math.round(Number(durationMs) || 0));
  const minimum = Math.min(SOUNDBOARD_MIN_SELECTION_MS, duration);
  let start = Math.max(0, Math.min(duration, Math.round(Number(startMs) || 0)));
  let end = Math.max(0, Math.min(duration, Math.round(Number(endMs) || duration)));
  if (end - start < minimum) {
    if (changed === "end") start = Math.max(0, end - minimum);
    else end = Math.min(duration, start + minimum);
  }
  return { startMs: start, endMs: end };
}

export function soundboardArrowStep(event) {
  return event?.shiftKey ? 100 : 10;
}

export function formatSoundboardTime(milliseconds) {
  const total = Math.max(0, Math.round(Number(milliseconds) || 0));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function soundboardTimelineInterval(durationMs) {
  const duration = Math.max(0, Number(durationMs) || 0);
  if (duration <= 10_000) return 1_000;
  if (duration <= 30_000) return 5_000;
  if (duration <= 120_000) return 10_000;
  if (duration <= 300_000) return 30_000;
  return 60_000;
}

export function waveformTimeFromPointer(event, canvas, durationMs) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  return Math.round((x / Math.max(1, rect.width)) * Math.max(0, durationMs));
}

export function drawSoundboardWaveform(canvas, peaks, durationMs, startMs, endMs, colors = {}, playbackMs = null) {
  const context = canvas?.getContext?.("2d");
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  const timelineHeight = 30;
  const plotBottom = height - timelineHeight;
  const middle = plotBottom / 2;
  context.clearRect(0, 0, width, height);
  context.fillStyle = colors.background || "#111827";
  context.fillRect(0, 0, width, height);
  context.fillStyle = colors.waveform || "#9edcff";
  const samples = Array.isArray(peaks) ? peaks : [];
  samples.forEach((peak, index) => {
    const x = Math.floor((index / Math.max(1, samples.length)) * width);
    const nextX = Math.max(x + 1, Math.ceil(((index + 1) / Math.max(1, samples.length)) * width));
    const min = Math.max(-1, Math.min(1, Number(peak?.min) || 0));
    const max = Math.max(-1, Math.min(1, Number(peak?.max) || 0));
    const top = middle - (max * middle * 0.78);
    const bottom = middle - (min * middle * 0.78);
    context.fillRect(x, top, nextX - x, Math.max(1, bottom - top));
  });
  const duration = Math.max(1, durationMs);
  const tickInterval = soundboardTimelineInterval(durationMs);
  context.strokeStyle = colors.grid || "rgba(158, 220, 255, .16)";
  context.fillStyle = colors.label || "rgba(224, 236, 255, .72)";
  context.lineWidth = 1;
  context.font = "22px system-ui, sans-serif";
  context.textBaseline = "bottom";
  for (let time = 0; time <= durationMs; time += tickInterval) {
    if (time > 0 && durationMs - time < tickInterval * 0.55 && durationMs % tickInterval !== 0) {
      continue;
    }
    const x = (time / duration) * width;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, plotBottom);
    context.stroke();
    const label = formatSoundboardTime(time).replace(/\.000$/, "");
    context.textAlign = time === 0 ? "left" : "center";
    context.fillText(label, Math.max(3, Math.min(width - 3, x)), height - 2);
  }
  if (durationMs % tickInterval !== 0) {
    context.textAlign = "right";
    context.fillText(formatSoundboardTime(durationMs).replace(/\.000$/, ""), width - 3, height - 2);
  }
  const startX = (startMs / duration) * width;
  const endX = (endMs / duration) * width;
  context.fillStyle = colors.excluded || "rgba(3, 7, 18, .68)";
  context.fillRect(0, 0, startX, plotBottom);
  context.fillRect(endX, 0, width - endX, plotBottom);
  context.strokeStyle = colors.handle || "#66d9ff";
  context.lineWidth = 4;
  [startX, endX].forEach((x) => {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, plotBottom);
    context.stroke();
  });
  const playhead = Number(playbackMs);
  if (Number.isFinite(playhead) && playhead >= startMs && playhead <= endMs) {
    const x = (playhead / duration) * width;
    context.strokeStyle = colors.playhead || "#ffffff";
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, plotBottom);
    context.stroke();
  }
}

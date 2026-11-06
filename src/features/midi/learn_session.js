/** A cancellable owner for one native learn session. Polls never overlap. */
export function createMidiLearnSession({
  invoke,
  intervalMs = 50,
  onLearned,
  onError,
}) {
  let phase = "starting";
  let sessionId = null;
  let timer = null;
  const active = () => phase === "starting" || phase === "listening";
  const cancelNative = () =>
    invoke("cancel_midi_learn", { sessionId }).catch((error) =>
      console.error("Failed to cancel MIDI learning", error),
    );

  function cancel() {
    if (!active()) return;
    phase = "cancelled";
    clearTimeout(timer);
    timer = null;
    if (sessionId !== null) void cancelNative();
  }

  function fail(error) {
    if (!active()) return;
    phase = "failed";
    if (sessionId !== null) void cancelNative();
    onError?.(error);
  }

  async function poll() {
    timer = null;
    if (phase !== "listening") return;
    try {
      const learned = await invoke("consume_learned_control", { sessionId });
      if (phase !== "listening") return;
      if (!learned) {
        timer = setTimeout(poll, intervalMs);
        return;
      }
      phase = "completed";
      await onLearned(learned);
    } catch (error) {
      if (phase === "completed") onError?.(error);
      else fail(error);
    }
  }

  void Promise.resolve().then(async () => {
    try {
      sessionId = await invoke("start_midi_learn");
      if (phase === "cancelled") {
        await cancelNative();
        return;
      }
      phase = "listening";
      timer = setTimeout(poll, intervalMs);
    } catch (error) {
      fail(error);
    }
  });

  return {
    cancel,
    get active() {
      return active();
    },
    get phase() {
      return phase;
    },
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

/** Shared retry scheduling; each protocol owns its connection and failure handling. */
export function createReconnectController({
  state,
  initialDelay,
  maximumDelay,
  idleDelay,
  hasConnection,
  connect,
  onFailure = () => {},
}) {
  const reset = () => {
    state.reconnectDelayMs = initialDelay;
  };
  const grow = () => {
    state.reconnectDelayMs = Math.min(maximumDelay, state.reconnectDelayMs * 2);
  };
  async function run() {
    while (!state.disposed) {
      let delay = idleDelay;
      if (
        !hasConnection() &&
        !state.connecting &&
        !state.disconnectedByUser &&
        (state.autoConnect || state.manualConnectRequested)
      ) {
        try {
          const connected = await connect();
          if (connected || hasConnection()) reset();
          else grow();
        } catch {
          if (state.disposed) return;
          state.connecting = false;
          onFailure();
          grow();
        }
        delay = state.reconnectDelayMs;
      } else {
        reset();
      }
      await sleep(delay);
    }
  }
  return { reset, grow, run };
}

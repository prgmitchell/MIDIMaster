export function createSessionRefreshScheduler({
  documentRef = document,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  visibleIntervalMs = 3_000,
  hiddenIntervalMs = 15_000,
} = {}) {
  let timer = null;
  let refresh = null;
  let mainScreen = null;
  let visibilityListenerBound = false;
  let generation = 0;
  let running = null;

  function isHidden() {
    return Boolean(documentRef.hidden || mainScreen?.classList.contains("hidden"));
  }

  function delay() {
    return isHidden() ? hiddenIntervalMs : visibleIntervalMs;
  }

  function schedule(delayMs) {
    if (!refresh) return;
    const scheduledGeneration = generation;
    timer = setTimer(async () => {
      timer = null;
      if (running) await running;
      if (scheduledGeneration !== generation || !refresh) return;
      if (!isHidden()) {
        const operation = Promise.resolve().then(refresh).catch((error) => {
          console.error("Failed to refresh audio sessions", error);
        });
        running = operation;
        await operation;
        if (running === operation) running = null;
      }
      if (scheduledGeneration === generation) schedule(delay());
    }, delayMs);
  }

  function restart(delayMs = 0) {
    if (!refresh) return;
    generation++;
    if (timer !== null) clearTimer(timer);
    timer = null;
    schedule(delayMs);
  }

  function ensureVisibilityListener() {
    if (visibilityListenerBound) return;
    visibilityListenerBound = true;
    documentRef.addEventListener("visibilitychange", onVisibilityChange);
  }

  function onVisibilityChange() {
    if (!documentRef.hidden) restart(0);
  }

  function start(refreshFn, mainScreenEl) {
    const wasActive = Boolean(refresh);
    refresh = refreshFn;
    mainScreen = mainScreenEl;
    ensureVisibilityListener();
    if (!wasActive) restart(delay());
  }

  function stop() {
    generation++;
    if (timer !== null) clearTimer(timer);
    timer = null;
    refresh = null;
    mainScreen = null;
    if (visibilityListenerBound) {
      documentRef.removeEventListener("visibilitychange", onVisibilityChange);
      visibilityListenerBound = false;
    }
  }

  return { start, stop, restart };
}

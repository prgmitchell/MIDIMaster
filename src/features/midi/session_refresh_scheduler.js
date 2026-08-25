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

  function isHidden() {
    return Boolean(documentRef.hidden || mainScreen?.classList.contains("hidden"));
  }

  function delay() {
    return isHidden() ? hiddenIntervalMs : visibleIntervalMs;
  }

  function schedule(delayMs) {
    if (!refresh) return;
    timer = setTimer(async () => {
      timer = null;
      if (!isHidden()) await refresh();
      schedule(delay());
    }, delayMs);
  }

  function restart(delayMs = 0) {
    if (!refresh) return;
    if (timer) clearTimer(timer);
    timer = null;
    schedule(delayMs);
  }

  function ensureVisibilityListener() {
    if (visibilityListenerBound) return;
    visibilityListenerBound = true;
    documentRef.addEventListener("visibilitychange", () => {
      if (!documentRef.hidden) restart(0);
    });
  }

  function start(refreshFn, mainScreenEl) {
    refresh = refreshFn;
    mainScreen = mainScreenEl;
    ensureVisibilityListener();
    if (!timer) schedule(delay());
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
    refresh = null;
    mainScreen = null;
  }

  return { start, stop, restart };
}

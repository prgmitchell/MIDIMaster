export function createMidiConnectionStatusHandler({
  normalizeRoutes,
  setActiveRouteCount,
  showMain,
  statusElement,
  translate,
} = {}) {
  if (typeof normalizeRoutes !== "function") {
    throw new Error("createMidiConnectionStatusHandler: normalizeRoutes is required");
  }
  const t = typeof translate === "function" ? translate : (key) => key;

  function handle(payload) {
    if (!payload || typeof payload !== "object" || !statusElement) return;
    const routes = normalizeRoutes({ routes: payload.routes || [] });
    const routeCount = Number(payload.routeCount ?? payload.route_count ?? routes.length);
    if (Number.isFinite(routeCount)) setActiveRouteCount?.(Math.max(0, routeCount));

    const first = routes[0] || {};
    if (payload.state === "disconnected") {
      if (routes.length > 0) {
        showMain?.(
          first.inputDeviceName || first.inputDeviceId,
          first.outputDeviceName || first.outputDeviceId,
          { routeCount: routes.length, routes },
        );
      } else {
        statusElement.textContent = t("midi.disconnected");
      }
    } else if (payload.state === "reconnecting") {
      statusElement.textContent = t("midi.searchingDevices");
    } else if (payload.state === "failed") {
      statusElement.textContent = t("midi.connectFailed", {
        message: payload.reason || "MIDI connection failed",
      });
    } else if (payload.state === "connected") {
      if (routes.length > 0) {
        showMain?.(
          first.inputDeviceName || first.inputDeviceId,
          first.outputDeviceName || first.outputDeviceId,
          { routeCount: routes.length, routes },
        );
      } else {
        statusElement.textContent = t("midi.connected");
      }
    }
  }

  return { handle };
}

import { createTauriBridge, scheduleRetry } from "./app/bootstrap.js";
import { initializePerformanceAudit, performanceAudit } from "./app/performance_audit_api.js";
import { setupUpdateNotificationWindow } from "./update_notification.js";

const bridge = createTauriBridge();
let started = false;

function start() {
  if (started) return;
  if (!bridge.bind()) {
    scheduleRetry(start, 50);
    return;
  }
  started = true;
  setupUpdateNotificationWindow({
    params: new URLSearchParams(window.location.search),
    invoke: bridge.invoke,
    listen: bridge.listen,
  });
  performanceAudit.mark("update-ready");
}

async function boot() {
  await initializePerformanceAudit();
  performanceAudit.mark("bootstrap-start", { entry: "update" });
  start();
}

boot();

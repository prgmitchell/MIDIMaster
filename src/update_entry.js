import { createTauriBridge, scheduleRetry } from "./app/bootstrap.js";
import { initI18n } from "./app/i18n.js";
import { initializePerformanceAudit, performanceAudit } from "./app/performance_audit_api.js";
import { setupUpdateNotificationWindow } from "./update_notification.js";

const bridge = createTauriBridge();
let started = false;

async function start() {
  if (started) return;
  if (!bridge.bind()) {
    scheduleRetry(start, 50);
    return;
  }
  started = true;
  const settings = await bridge.invoke("get_app_settings").catch(() => null);
  await initI18n(settings?.language || "en").catch((error) => {
    console.warn("Unable to load the update window language", error);
  });
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

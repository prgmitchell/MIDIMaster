/** brightness workflow. */
export function createBrightness({ callInvoke, discovery, t }) {
  async function refreshBrightnessMonitors() {
    if (!callInvoke) return discovery.brightnessMonitors;
    if (discovery.brightnessMonitorRequest) return discovery.brightnessMonitorRequest;
    discovery.brightnessMonitorRequest = (async () => {
      try {
        const monitors = await callInvoke("list_monitors");
        discovery.brightnessMonitors = (Array.isArray(monitors) ? monitors : [])
          .map((monitor) => ({
            id: String(monitor?.stable_id || monitor?.stableId || "").trim(),
            name: String(monitor?.name || "").trim(),
            isPrimary: Boolean(monitor?.is_primary ?? monitor?.isPrimary),
          }))
          .filter((monitor) => monitor.id);
      } catch {
        // Keep the last successful list so saved targets remain usable offline.
      } finally {
        discovery.brightnessMonitorRequest = null;
      }
      return discovery.brightnessMonitors;
    })();
    return discovery.brightnessMonitorRequest;
  }

  function buildMonitorBrightnessOptions() {
    return [
      {
        value: "monitor-brightness",
        label: t("targets.allMonitors"),
        icon_kind: "monitor-brightness",
        kind: "monitor-brightness",
        target: { MonitorBrightness: {} },
      },
      ...discovery.brightnessMonitors.map((monitor) => ({
        value: `monitor-brightness:${monitor.id}`,
        label: monitor.name || t("settings.monitor"),
        icon_kind: "monitor-brightness",
        kind: "monitor-brightness",
        title_tags: monitor.isPrimary ? [t("settings.primaryBadge")] : [],
        target: {
          MonitorBrightness: {
            monitor_id: monitor.id,
            display_name: monitor.name || null,
          },
        },
      })),
    ];
  }

  return { refreshBrightnessMonitors, buildMonitorBrightnessOptions };
}

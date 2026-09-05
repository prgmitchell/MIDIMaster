import { renderLabelWithBadges } from "../../ui/dropdown_badges.js";
import { createSelectDropdownShell, renderNativeSelectDropdown } from "../../ui/dropdown_select.js";

/** monitors workflow. */
export function createMonitors({
  lifetime,
  closeMonitorDropdown,
  elements,
  formatMonitorOptionLabel,
  getOsdSettings,
  invoke,
  monitorView,
  resolveEffectiveMonitor,
  setMonitorOptions,
  setOsdSettings,
  t,
}) {
  function renderMonitorDisplay(option) {
    if (!monitorView.monitorDisplayEl) return;
    renderLabelWithBadges(monitorView.monitorDisplayEl, {
      text: option?.label || t("settings.monitor"),
      badges: option?.isPrimary ? [{ text: t("settings.primaryBadge"), kind: "neutral" }] : [],
      truncate: true,
    });
  }

  function ensureMonitorDropdown() {
    if (!elements.osdMonitorSelect) return;

    if (monitorView.monitorDropdownEl && monitorView.monitorDropdownEl.isConnected) {
      return;
    }

    const entry = createSelectDropdownShell({
      selectEl: elements.osdMonitorSelect,
      rootClass: "settings-monitor-dropdown",
      title: t("settings.monitor"),
    });
    if (!entry) return;
    monitorView.monitorDropdownEl = entry.root;
    monitorView.monitorMenuEl = entry.menu;
    monitorView.monitorDisplayEl = entry.display;

    if (!monitorView.monitorDocClickBound) {
      monitorView.monitorDocClickBound = true;
      lifetime.listen(document, "click", (event) => {
        if (!monitorView.monitorDropdownEl) return;
        if (monitorView.monitorDropdownEl.contains(event.target)) return;
        closeMonitorDropdown();
      });
    }
  }

  function renderMonitorDropdownOptions(monitors) {
    ensureMonitorDropdown();
    if (!monitorView.monitorMenuEl || !elements.osdMonitorSelect) return;
    const list = Array.isArray(monitors) ? monitors : [];
    renderNativeSelectDropdown({
      entry: {
        root: monitorView.monitorDropdownEl,
        menu: monitorView.monitorMenuEl,
        display: monitorView.monitorDisplayEl,
      },
      selectEl: elements.osdMonitorSelect,
      fallbackText: t("settings.monitor"),
      closeDropdowns: closeMonitorDropdown,
      formatOptionText: (opt) => opt.textContent || "",
      getOptionBadges: (opt) =>
        opt.dataset.isPrimary === "true" ? [{ text: t("settings.primaryBadge"), kind: "neutral" }] : [],
      onOptionSelected: (opt) => {
        renderMonitorDisplay({
          value: String(opt.value || "0"),
          label: opt.textContent || t("settings.monitor"),
          isPrimary: opt.dataset.isPrimary === "true",
        });
      },
      truncateMenuLabels: false,
      truncateDisplayLabel: true,
    });

    if (list.length === 0) {
      renderMonitorDisplay({ value: "0", label: t("settings.monitor"), isPrimary: true });
    }
  }

  async function loadMonitorOptions() {
    let next = [];
    try {
      const monitors = await invoke("list_monitors");
      next = Array.isArray(monitors) ? monitors : [];
    } catch (error) {
      next = [];
      console.error("Failed to load monitors", error);
    }
    if (typeof setMonitorOptions === "function") {
      setMonitorOptions(next);
    }

    // Update dropdown if it exists
    if (elements.osdMonitorSelect) {
      const current = typeof getOsdSettings === "function" ? getOsdSettings() || {} : {};
      elements.osdMonitorSelect.innerHTML = "";
      next.forEach((monitor, index) => {
        const option = document.createElement("option");
        option.value = String(monitor.index ?? index);
        option.dataset.rawName = monitor.name || "";
        option.dataset.stableId = monitor.stable_id || "";
        option.dataset.isPrimary = monitor.is_primary ? "true" : "false";
        option.textContent = formatMonitorOptionLabel(monitor, index);
        elements.osdMonitorSelect.appendChild(option);
      });
      if (next.length === 0) {
        const option = document.createElement("option");
        option.value = "0";
        option.textContent = t("settings.primaryMonitor");
        elements.osdMonitorSelect.appendChild(option);
        elements.osdMonitorSelect.value = "0";
      } else {
        // Mirror backend monitor resolution: prefer stable_id match, else primary monitor.
        const effective = resolveEffectiveMonitor(next, current);
        const fallbackIndex = Math.max(0, Number(current.monitorIndex ?? 0));
        const effectiveValue = String(effective?.index ?? fallbackIndex);
        elements.osdMonitorSelect.value = effectiveValue;

        if (typeof setOsdSettings === "function" && effective) {
          setOsdSettings({
            ...current,
            monitorIndex: Number(effectiveValue),
            monitorName: effective.name || null,
            monitorId: effective.stable_id || null,
          });
        }
      }
      renderMonitorDropdownOptions(next);
    }
  }

  return { renderMonitorDropdownOptions, loadMonitorOptions };
}

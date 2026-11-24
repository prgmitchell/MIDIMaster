import {
  normalizeOsdAnchor,
  normalizeOsdAppearance,
  normalizeOsdStyle,
  toOsdCommandSettings,
  fromOsdSettings,
  DEFAULT_OSD_SETTINGS,
} from "../../../core/osd_settings.js";

/** osd settings workflow. */
export function createOsdSettings({
  elements,
  getOsdSettings,
  invoke,
  renderSettingsSelectDropdown,
  setOsdSettings,
  syncOsdAppearanceControls,
  syncOsdAppearanceUi,
  viewState,
}) {
  function scheduleOsdAppearanceSync() {
    if (viewState.osdAppearanceRaf) {
      cancelAnimationFrame(viewState.osdAppearanceRaf);
    }
    viewState.osdAppearanceRaf = requestAnimationFrame(() => {
      viewState.osdAppearanceRaf = 0;
      syncOsdAppearanceControls();
    });
  }

  function updateOsdPositionSelection(anchor) {
    if (!elements.osdPositionPicker) return;
    const selectedAnchor = normalizeOsdAnchor(anchor);
    elements.osdPositionPicker.dataset.anchor = selectedAnchor;
    elements.osdPositionPicker.querySelectorAll(".osd-position-dot").forEach((dot) => {
      dot.classList.toggle("selected", dot.dataset.anchor === selectedAnchor);
    });
  }

  function syncOsdPositionUi(settings = {}) {
    const current = typeof getOsdSettings === "function" ? getOsdSettings() || {} : {};
    const anchor = normalizeOsdAnchor(settings.anchor ?? current.anchor);
    if (typeof setOsdSettings === "function") {
      setOsdSettings({ ...current, ...(settings || {}), anchor });
    }
    updateOsdPositionSelection(anchor);
    document.body.setAttribute("data-anchor", anchor);
  }

  function syncOsdSettingsUi(settings = {}) {
    const current = typeof getOsdSettings === "function" ? getOsdSettings() || {} : {};
    const merged = {
      ...current,
      ...(settings || {}),
      anchor: normalizeOsdAnchor(settings.anchor ?? current.anchor),
    };

    if (elements.osdEnabledToggle) {
      if (elements.osdEnabledToggle.type === "checkbox") {
        elements.osdEnabledToggle.checked = Boolean(merged.enabled);
        elements.osdEnabledToggle.classList.remove("hidden");
      } else {
        elements.osdEnabledToggle.value = merged.enabled ? "enabled" : "disabled";
        renderSettingsSelectDropdown(elements.osdEnabledToggle);
      }
    }
    if (elements.osdMonitorSelect) {
      elements.osdMonitorSelect.value = String(merged.monitorIndex ?? 0);
    }
    if (elements.osdLabelModeSelect) {
      elements.osdLabelModeSelect.value = merged.showBindingName ? "binding" : "target";
      renderSettingsSelectDropdown(elements.osdLabelModeSelect);
    }
    const previewLabel = elements.osdPositionPicker?.querySelector?.(".settings-osd-preview-label");
    if (previewLabel) {
      previewLabel.textContent = merged.showBindingName ? "Fader Group 1" : "MIDIMaster";
    }

    syncOsdAppearanceUi(merged);
    syncOsdPositionUi(merged);
  }

  async function applyOsdSettings(nextSettings) {
    const current = typeof getOsdSettings === "function" ? getOsdSettings() || {} : {};
    const requestedEnabledChange = Boolean(
      nextSettings && Object.prototype.hasOwnProperty.call(nextSettings, "enabled"),
    );
    const shouldPreviewAfterSave =
      requestedEnabledChange && !Boolean(current.enabled) && Boolean(nextSettings.enabled);
    const merged = {
      ...current,
      ...(nextSettings || {}),
      anchor: normalizeOsdAnchor(nextSettings?.anchor ?? current.anchor),
    };
    if (typeof setOsdSettings === "function") {
      setOsdSettings(merged);
    }

    syncOsdSettingsUi(merged);

    try {
      await invoke("update_osd_settings", toOsdCommandSettings(merged));
      if (shouldPreviewAfterSave) {
        await invoke("preview_osd");
      }
    } catch (error) {
      console.error("Failed to update OSD settings", error);
    }
  }

  async function loadOsdSettings() {
    try {
      const settings = await invoke("get_osd_settings");
      if (settings) {
        const next = toOsdCommandSettings(
          fromOsdSettings(settings, { ...DEFAULT_OSD_SETTINGS, enabled: false }),
        );
        syncOsdSettingsUi(next);
      }
    } catch (error) {
      console.error("Failed to load OSD settings", error);
    }
  }

  function formatMonitorName(name) {
    if (!name) return "Monitor";
    return String(name)
      .trim()
      .replace(/^\\\\\.\\/, "");
  }

  function formatMonitorOptionLabel(monitor, index) {
    const base = formatMonitorName(monitor?.name) || `Monitor ${index + 1}`;
    return base;
  }

  function resolveEffectiveMonitor(monitors, currentSettings) {
    const list = Array.isArray(monitors) ? monitors : [];
    if (list.length === 0) return null;

    const requestedId = String(currentSettings?.monitorId || "").trim();
    if (requestedId) {
      const byId = list.find((monitor) => String(monitor?.stable_id || "").trim() === requestedId);
      if (byId) return byId;
    }

    return list.find((monitor) => Boolean(monitor?.is_primary)) || list[0];
  }

  function bindUi({ lifetime, getMonitorOptions, renderMonitorDropdownOptions }) {
    const panel = elements.settingsPanel;
    lifetime.listen(window, "resize", scheduleOsdAppearanceSync);
    if (panel && "ResizeObserver" in window && elements.osdPositionPicker) {
      const observer = new ResizeObserver(scheduleOsdAppearanceSync);
      viewState.osdPreviewResizeObserver = observer;
      observer.observe(elements.osdPositionPicker);
      const screen = elements.osdPositionPicker.querySelector(".settings-osd-preview-screen");
      if (screen) observer.observe(screen);
    }
    lifetime.listen(panel, "click", (event) => {
      const button = event.target.closest("[data-osd-style-option]");
      if (button && panel.contains(button) && elements.osdStyleSelect) {
        elements.osdStyleSelect.value = normalizeOsdStyle(button.dataset.osdStyleOption);
        elements.osdStyleSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    lifetime.listen(elements.osdStyleSelect, "change", () => {
      applyOsdSettings({ style: normalizeOsdStyle(elements.osdStyleSelect.value) });
    });
    for (const [key, input] of [["opacity", elements.osdTransparencyInput], ["scale", elements.osdScaleInput]]) {
      const patch = () => ({ [key]: normalizeOsdAppearance({ [key]: Number(input.value) / 100 })[key] });
      lifetime.listen(input, "input", () => syncOsdAppearanceUi({ ...getOsdSettings(), ...patch() }));
      lifetime.listen(input, "change", () => applyOsdSettings(patch()));
    }
    if (elements.osdEnabledToggle) {
      lifetime.listen(elements.osdEnabledToggle, "change", () => {
        const enabled =
          elements.osdEnabledToggle.type === "checkbox"
            ? elements.osdEnabledToggle.checked
            : elements.osdEnabledToggle.value === "enabled";
        applyOsdSettings({ enabled });
      });
    }

    if (elements.osdMonitorSelect) {
      lifetime.listen(elements.osdMonitorSelect, "change", () => {
        const nextIndex = Number(elements.osdMonitorSelect.value || 0);
        const selectedOption = elements.osdMonitorSelect.options[elements.osdMonitorSelect.selectedIndex];
        const monitorName = selectedOption?.dataset?.rawName || null;
        const monitorId = selectedOption?.dataset?.stableId || null;
        applyOsdSettings({ monitorIndex: nextIndex, monitorName, monitorId });
        const currentMonitors = typeof getMonitorOptions === "function" ? getMonitorOptions() || [] : [];
        renderMonitorDropdownOptions(currentMonitors);
      });
    }

    if (elements.osdLabelModeSelect) {
      lifetime.listen(elements.osdLabelModeSelect, "change", () => {
        applyOsdSettings({ showBindingName: elements.osdLabelModeSelect.value === "binding" });
      });
    }

    if (elements.osdPositionPicker) {
      lifetime.listen(elements.osdPositionPicker, "click", (event) => {
        const dot = event.target.closest(".osd-position-dot");
        if (!dot) return;
        const anchor = dot.dataset.anchor || "top-right";
        applyOsdSettings({ anchor });
      });
    }
  }

  return {
    bindUi,
    scheduleOsdAppearanceSync,
    syncOsdSettingsUi,
    applyOsdSettings,
    loadOsdSettings,
    formatMonitorOptionLabel,
    resolveEffectiveMonitor,
  };
}
